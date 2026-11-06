from __future__ import annotations

import io
import sys
import threading
import time
import types
from contextlib import nullcontext
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.engine import CandidateFile, Sam2CutoutEngine
from app.jobs import CutoutServiceError, JobManager
from app.main import create_app
from app.settings import Settings


def webp_bytes(size: tuple[int, int] = (64, 48)) -> bytes:
    image = Image.new("RGBA", size, (30, 120, 210, 255))
    output = io.BytesIO()
    image.save(output, format="WEBP", lossless=True)
    image.close()
    return output.getvalue()


class FakeEngine:
    def generate(
        self,
        source_path: Path,
        output_dir: Path,
        cancelled,
        progress,
    ) -> list[CandidateFile]:
        assert source_path.is_file()
        progress("正在准备透明候选…")
        if cancelled.is_set():
            return []
        full = Image.new("RGBA", (28, 28), (0, 0, 0, 0))
        for x in range(6, 22):
            for y in range(6, 22):
                full.putpixel((x, y), (220, 20, 40, 255))
        image_path = output_dir / "candidate-0.png"
        preview_path = output_dir / "candidate-0-preview.webp"
        full.save(image_path, format="PNG")
        preview = full.copy()
        preview.save(preview_path, format="WEBP", lossless=True)
        full.close()
        preview.close()
        return [CandidateFile("0", 28, 28, preview_path, image_path)]


def settings(temp_dir: Path, **changes: object) -> Settings:
    values: dict[str, object] = {
        "checkpoint": temp_dir / "not-loaded-by-fake.pt",
        "model_config": "unused-by-fake",
        "temp_dir": temp_dir / "jobs",
    }
    values.update(changes)
    return Settings(**values)  # type: ignore[arg-type]


def wait_until_ready(client: TestClient, job_id: str) -> dict[str, object]:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        response = client.get(f"/jobs/{job_id}")
        assert response.status_code == 200
        body = response.json()
        if body["state"] not in ("queued", "running"):
            return body
        time.sleep(0.01)
    raise AssertionError("cutout job did not finish within the test deadline")


def test_generates_unlabelled_candidates_and_serves_private_images(tmp_path: Path) -> None:
    app = create_app(settings(tmp_path), lambda _settings: FakeEngine())
    with TestClient(app) as client:
        assert client.get("/health/live").status_code == 200
        assert client.get("/health/ready").json() == {"status": "ready"}

        created = client.post("/jobs", content=webp_bytes(), headers={"content-type": "image/webp"})
        assert created.status_code == 202
        assert created.headers["cache-control"] == "no-store"
        job_id = created.json()["jobId"]

        status = client.get(f"/jobs/{job_id}")
        assert status.headers["cache-control"] == "no-store"
        job = wait_until_ready(client, job_id)
        assert job["state"] == "ready"
        assert job["message"] == "已生成 1 个透明候选，请选择一张。"
        assert job["candidates"] == [{"id": "0", "width": 28, "height": 28}]
        assert "path" not in job and "folder" not in job

        preview = client.get(f"/jobs/{job_id}/candidates/0/preview")
        assert preview.status_code == 200
        assert preview.headers["content-type"].startswith("image/webp")
        assert preview.headers["cache-control"] == "no-store"
        assert preview.headers["x-content-type-options"] == "nosniff"

        full = client.get(f"/jobs/{job_id}/candidates/0/image")
        assert full.status_code == 200
        assert full.headers["content-type"].startswith("image/png")
        decoded = Image.open(io.BytesIO(full.content)).convert("RGBA")
        assert decoded.getpixel((0, 0))[3] == 0
        assert decoded.getpixel((10, 10))[3] == 255

        assert client.delete(f"/jobs/{job_id}").status_code == 204
        assert client.get(f"/jobs/{job_id}").status_code == 404
        assert not (tmp_path / "jobs" / f"job-{job_id}").exists()


@pytest.mark.parametrize(("image_format", "mime"), [("PNG", "image/png"), ("JPEG", "image/jpeg")])
def test_accepts_native_photo_formats_with_existing_normalization(tmp_path: Path, image_format: str, mime: str) -> None:
    output = io.BytesIO()
    Image.new("RGB", (64, 48), "red").save(output, format=image_format)
    app = create_app(settings(tmp_path), lambda _settings: FakeEngine())
    with TestClient(app) as client:
        response = client.post("/jobs", content=output.getvalue(), headers={"content-type": mime})
        assert response.status_code == 202
        job_id = response.json()["jobId"]
        assert wait_until_ready(client, job_id)["state"] == "ready"
        assert client.delete(f"/jobs/{job_id}").status_code == 204


def test_rejects_mislabeled_native_photo(tmp_path: Path) -> None:
    output = io.BytesIO()
    Image.new("RGB", (64, 48), "red").save(output, format="JPEG")
    app = create_app(settings(tmp_path), lambda _settings: FakeEngine())
    with TestClient(app) as client:
        response = client.post("/jobs", content=output.getvalue(), headers={"content-type": "image/png"})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "CUTOUT_INVALID_IMAGE"
        assert str(tmp_path) not in response.text


def test_rejects_wrong_content_type_and_oversized_bytes(tmp_path: Path) -> None:
    app = create_app(settings(tmp_path, max_input_bytes=8), lambda _settings: FakeEngine())
    with TestClient(app) as client:
        wrong_type = client.post("/jobs", content=b"x", headers={"content-type": "image/png"})
        assert wrong_type.status_code == 400
        assert wrong_type.json()["error"]["code"] == "CUTOUT_INVALID_IMAGE"

        too_large = client.post(
            "/jobs", content=webp_bytes(), headers={"content-type": "image/webp"}
        )
        assert too_large.status_code == 413
        assert too_large.json()["error"]["code"] == "CUTOUT_IMAGE_TOO_LARGE"


def test_rejects_corrupt_webp_without_leaking_a_path(tmp_path: Path) -> None:
    app = create_app(settings(tmp_path), lambda _settings: FakeEngine())
    with TestClient(app) as client:
        response = client.post(
            "/jobs", content=b"not an image", headers={"content-type": "image/webp"}
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "CUTOUT_INVALID_IMAGE"
        assert str(tmp_path) not in response.text


def test_rejects_image_over_the_pixel_limit(tmp_path: Path) -> None:
    app = create_app(settings(tmp_path, max_source_pixels=100), lambda _settings: FakeEngine())
    with TestClient(app) as client:
        response = client.post(
            "/jobs", content=webp_bytes(), headers={"content-type": "image/webp"}
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "CUTOUT_INVALID_IMAGE"


def test_bounds_live_jobs_and_runs_only_one_inference_at_a_time(tmp_path: Path) -> None:
    entered = threading.Event()
    release = threading.Event()

    class BlockingEngine(FakeEngine):
        def generate(self, source_path: Path, output_dir: Path, cancelled, progress):
            entered.set()
            assert release.wait(3)
            return super().generate(source_path, output_dir, cancelled, progress)

    app = create_app(
        settings(tmp_path, max_live_jobs=2, max_retained_jobs=3),
        lambda _settings: BlockingEngine(),
    )
    with TestClient(app) as client:
        try:
            headers = {"content-type": "image/webp"}
            first = client.post("/jobs", content=webp_bytes(), headers=headers)
            assert first.status_code == 202
            first_id = first.json()["jobId"]
            assert entered.wait(1)

            second = client.post("/jobs", content=webp_bytes(), headers=headers)
            assert second.status_code == 202
            second_id = second.json()["jobId"]
            assert client.get(f"/jobs/{second_id}").json()["state"] == "queued"

            full = client.post("/jobs", content=webp_bytes(), headers=headers)
            assert full.status_code == 429
            assert full.json()["error"]["code"] == "CUTOUT_BUSY"
        finally:
            release.set()

        assert wait_until_ready(client, first_id)["state"] == "ready"
        assert wait_until_ready(client, second_id)["state"] == "ready"


def test_timed_out_inference_still_occupies_its_worker_slot(tmp_path: Path) -> None:
    entered = threading.Event()
    release = threading.Event()
    now = time.monotonic()

    class BlockingEngine(FakeEngine):
        def generate(self, source_path: Path, output_dir: Path, cancelled, progress):
            entered.set()
            assert release.wait(3)
            return []

    class Clock:
        value = now

        def __call__(self) -> float:
            return self.value

    clock = Clock()
    manager = JobManager(
        settings(tmp_path, max_live_jobs=1),
        lambda _settings: BlockingEngine(),
        clock,
    )
    manager.start()
    try:
        job_id = manager.create(webp_bytes(), "image/webp")["jobId"]
        assert entered.wait(1)
        clock.value += 180
        assert manager.status(job_id)["state"] == "failed"
        try:
            manager.create(webp_bytes(), "image/webp")
        except CutoutServiceError as error:
            assert error.status_code == 429
        else:
            raise AssertionError("a physically running timed-out job must retain its worker slot")
    finally:
        release.set()
        manager.shutdown()


@pytest.mark.parametrize("expire_waiting", [False, True])
def test_timeout_delete_and_retries_keep_one_active_and_one_waiting_slot(
    tmp_path: Path, monkeypatch, expire_waiting: bool,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    executions: list[str] = []
    now = [time.monotonic()]

    class BlockingEngine:
        def generate(self, source_path, output_dir, cancelled, progress):
            executions.append(output_dir.name)
            if len(executions) == 1:
                entered.set()
                assert release.wait(10)
                # DELETE must not remove files still owned by the running inference.
                assert source_path.is_file()
            return []

    manager = JobManager(settings(tmp_path), lambda _settings: BlockingEngine(), lambda: now[0])
    manager.start()
    executor = manager._executor
    assert executor is not None
    submit = executor.submit
    submissions = []

    def counted_submit(*args, **kwargs):
        submissions.append(args)
        return submit(*args, **kwargs)

    monkeypatch.setattr(executor, "submit", counted_submit)
    try:
        first_id = manager.create(webp_bytes(), "image/webp")["jobId"]
        first = manager._jobs[first_id]
        assert entered.wait(1)
        now[0] += 121
        assert manager.status(first_id)["state"] == "failed"
        manager.cancel(first_id)
        # Neither DELETE nor TTL may free a physically occupied worker slot.
        now[0] += 601
        manager.sweep()
        assert first.source_path.is_file()
        assert first.future is not None and first.future.running()

        for _ in range(6):
            queued_id = manager.create(webp_bytes(), "image/webp")["jobId"]
            queued = manager._jobs[queued_id]
            assert manager.status(queued_id)["state"] == "queued"
            with pytest.raises(CutoutServiceError) as busy:
                manager.create(webp_bytes(), "image/webp")
            assert busy.value.status_code == 429
            if expire_waiting:
                now[0] += 121
                assert manager.status(queued_id)["state"] == "failed"
                assert queued.future is not None and queued.future.cancelled()
                assert not queued.folder.exists()
            manager.cancel(queued_id)
            assert queued.future is not None and queued.future.cancelled()
            assert not queued.folder.exists()
            assert len(submissions) == 1, "cancelled waiting jobs must never enter the executor queue"

        last_id = manager.create(webp_bytes(), "image/webp")["jobId"]
        last = manager._jobs[last_id]
        release.set()
        assert first.future is not None
        first.future.result(timeout=3)
        assert last.future is not None
        last.future.result(timeout=3)
        assert manager.status(last_id)["state"] == "ready"
        assert executions == [first.folder.name, last.folder.name]
        assert len(submissions) == 2
        assert not first.folder.exists()
        with pytest.raises(CutoutServiceError) as missing:
            manager.status(first_id)
        assert missing.value.status_code == 404
    finally:
        release.set()
        manager.shutdown()


def test_rejects_unknown_or_malformed_job_and_candidate_ids(tmp_path: Path) -> None:
    app = create_app(settings(tmp_path), lambda _settings: FakeEngine())
    with TestClient(app) as client:
        assert client.get("/jobs/not-a-job").status_code == 404
        assert client.get("/jobs/" + "a" * 32 + "/candidates/0/image").status_code == 404
        assert client.delete("/jobs/not-a-job").status_code == 404


def test_mask_compositing_preserves_transparency_from_the_source_photo(
    tmp_path: Path, monkeypatch
) -> None:
    mask = np.zeros((40, 40), dtype=bool)
    mask[5:35, 5:35] = True

    def fake_rle_to_mask(_segmentation):
        return mask

    sam2 = types.ModuleType("sam2")
    sam2.__path__ = []
    utils = types.ModuleType("sam2.utils")
    utils.__path__ = []
    amg = types.ModuleType("sam2.utils.amg")
    amg.rle_to_mask = fake_rle_to_mask
    monkeypatch.setitem(sys.modules, "sam2", sam2)
    monkeypatch.setitem(sys.modules, "sam2.utils", utils)
    monkeypatch.setitem(sys.modules, "sam2.utils.amg", amg)

    class FakeTorch:
        @staticmethod
        def inference_mode():
            return nullcontext()

    class FakeGenerator:
        def generate(self, rgb):
            assert tuple(rgb[15, 15]) == (255, 255, 255)
            return [
                {
                    "area": int(mask.sum()),
                    "predicted_iou": 0.95,
                    "stability_score": 0.95,
                    "segmentation": {"fake": True},
                }
            ]

    engine = Sam2CutoutEngine.__new__(Sam2CutoutEngine)
    engine._torch = FakeTorch()
    engine._generator = FakeGenerator()
    engine._max_candidates = 8
    engine._min_area_ratio = 0.002
    engine._max_area_ratio = 0.94
    engine._max_candidate_bytes = 16 * 1024 * 1024
    engine._max_preview_bytes = 2 * 1024 * 1024
    engine._max_total_output_bytes = 128 * 1024 * 1024

    source = Image.new("RGBA", (40, 40), (30, 120, 210, 255))
    source.putpixel((15, 15), (30, 120, 210, 0))
    source_path = tmp_path / "source.png"
    source.save(source_path)
    source.close()

    candidates = engine.generate(
        source_path,
        tmp_path / "result",
        threading.Event(),
        lambda _message: None,
    )
    assert len(candidates) == 1
    assert candidates[0].preview_path.stat().st_size <= 2 * 1024 * 1024
    with Image.open(candidates[0].image_path) as result:
        rgba = result.convert("RGBA")
        assert rgba.getpixel((16, 16))[3] == 0
        assert rgba.getpixel((13, 13))[3] == 255
        rgba.close()

    engine._max_preview_bytes = 1
    oversized_preview = engine.generate(
        source_path,
        tmp_path / "oversized-preview",
        threading.Event(),
        lambda _message: None,
    )
    assert oversized_preview == []
    assert list((tmp_path / "oversized-preview").iterdir()) == []
