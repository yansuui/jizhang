"""Bounded, short-lived job registry for the single CPU inference worker."""
from __future__ import annotations

import logging
import shutil
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Literal

from .engine import CandidateFile, CutoutCancelled, CutoutEngine, Sam2CutoutEngine
from .image_io import ImageInputError, normalize_image
from .settings import Settings

LOGGER = logging.getLogger("jizhang.cutout.jobs")
JobState = Literal["queued", "running", "ready", "failed", "cancelled"]


class CutoutServiceError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


@dataclass
class Job:
    job_id: str
    folder: Path
    source_path: Path
    state: JobState = "queued"
    message: str = "已接收图片，等待抠图…"
    created_at: float = field(default_factory=time.monotonic)
    updated_at: float = field(default_factory=time.monotonic)
    candidates: list[CandidateFile] = field(default_factory=list)
    cancel_event: threading.Event = field(default_factory=threading.Event)
    timed_out: bool = False
    delete_requested: bool = False
    # Scheduler-owned Future: waiting jobs are not submitted to the executor.
    future: Future[None] | None = None


class JobManager:
    def __init__(
        self,
        settings: Settings,
        engine_factory: Callable[[Settings], CutoutEngine] = Sam2CutoutEngine,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.settings = settings
        self._engine_factory = engine_factory
        self._clock = clock
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._engine: CutoutEngine | None = None
        self._executor: ThreadPoolExecutor | None = None
        self._active_job: Job | None = None
        self._waiting_job: Job | None = None
        self._ready = False

    @property
    def ready(self) -> bool:
        return self._ready and self._engine is not None and self._executor is not None

    def start(self) -> None:
        if self.settings.temp_dir.is_symlink():
            raise RuntimeError("The configured transient job directory must not be a symlink.")
        self.settings.temp_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.settings.temp_dir.chmod(0o700)
        self._remove_stale_temp_dirs()
        # Loading is deliberately synchronous at service startup. The app health endpoint
        # is independent, so a model failure does not take down bookkeeping.
        self._engine = self._engine_factory(self.settings)
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cutout")
        self._ready = True

    def shutdown(self) -> None:
        self._ready = False
        with self._lock:
            for job in self._jobs.values():
                job.cancel_event.set()
                if job.future is not None:
                    job.future.cancel()
            self._waiting_job = None
        if self._executor is not None:
            self._executor.shutdown(wait=True, cancel_futures=True)
            self._executor = None
        with self._lock:
            for job in self._jobs.values():
                self._remove_job_files(job)
            self._jobs.clear()
        self._engine = None

    def create(self, data: bytes, content_type: str) -> dict[str, str]:
        self.sweep()
        if not self.ready:
            raise CutoutServiceError(503, "CUTOUT_NOT_READY", "AI 抠图服务正在启动，请稍后重试。")
        with self._lock:
            # Physical slots, not public states: a timed-out/deleted inference still runs.
            live = int(self._active_job is not None) + int(self._waiting_job is not None)
            if live >= self.settings.max_live_jobs or len(self._jobs) >= self.settings.max_retained_jobs:
                raise CutoutServiceError(429, "CUTOUT_BUSY", "抠图服务正忙，请稍后重试。")

            job_id = uuid.uuid4().hex
            folder = self.settings.temp_dir / f"job-{job_id}"
            folder.mkdir(mode=0o700)
            source_path = folder / "source.png"
            try:
                normalize_image(data, content_type, source_path, self.settings)
            except ImageInputError as error:
                shutil.rmtree(folder, ignore_errors=True)
                status = 413 if len(data) > self.settings.max_input_bytes else 400
                code = "CUTOUT_IMAGE_TOO_LARGE" if status == 413 else "CUTOUT_INVALID_IMAGE"
                raise CutoutServiceError(status, code, str(error)) from error

            now = self._clock()
            job = Job(
                job_id=job_id, folder=folder, source_path=source_path,
                created_at=now, updated_at=now, future=Future(),
            )
            self._jobs[job_id] = job
            executor = self._executor
            if executor is None:
                self._remove_job_files(job)
                del self._jobs[job_id]
                raise CutoutServiceError(503, "CUTOUT_NOT_READY", "AI 抠图服务正在启动，请稍后重试。")
            if self._active_job is None:
                self._start_job(job)
            else:
                # Never submit waiting work to ThreadPoolExecutor's unbounded queue.
                # Cancelling this Future releases the single waiting slot immediately.
                self._waiting_job = job
        return {"jobId": job_id}

    def _start_job(self, job: Job) -> None:
        executor = self._executor
        future = job.future
        if executor is None or future is None or not future.set_running_or_notify_cancel():
            return
        self._active_job = job
        executor.submit(self._run_and_finish, job)

    def _run_and_finish(self, job: Job) -> None:
        try:
            self._run(job)
        finally:
            with self._lock:
                if job.future is not None:
                    job.future.set_result(None)
                if job.delete_requested:
                    self._remove_job_files(job)
                    self._jobs.pop(job.job_id, None)
                self._active_job = None
                waiting = self._waiting_job
                self._waiting_job = None
                if self.ready and waiting is not None:
                    self._start_job(waiting)

    def status(self, job_id: str) -> dict[str, object]:
        self.sweep()
        with self._lock:
            job = self._require_job(job_id)
            return self._public_job(job)

    def cancel(self, job_id: str) -> dict[str, bool]:
        self.sweep()
        with self._lock:
            job = self._require_job(job_id)
            job.cancel_event.set()
            future = job.future
            if future is not None and not future.done() and not future.cancel():
                # A running Future cannot be preempted, even when its public state is failed.
                # Retain its files and slot until _run_and_finish observes actual completion.
                job.delete_requested = True
                if not job.timed_out:
                    job.message = "正在停止抠图…"
            else:
                if self._waiting_job is job:
                    self._waiting_job = None
                del self._jobs[job_id]
                self._remove_job_files(job)
        return {"ok": True}

    def candidate_bytes(self, job_id: str, candidate_id: str, *, preview: bool) -> tuple[bytes, str]:
        self.sweep()
        with self._lock:
            job = self._require_job(job_id)
            if job.state != "ready":
                raise CutoutServiceError(409, "CUTOUT_NOT_READY", "抠图候选还没有准备好。")
            candidate = next((item for item in job.candidates if item.candidate_id == candidate_id), None)
            if candidate is None:
                raise CutoutServiceError(404, "CUTOUT_CANDIDATE_NOT_FOUND", "抠图候选不存在或已过期。")
            path = candidate.preview_path if preview else candidate.image_path
            if not path.is_file() or path.stat().st_size == 0:
                raise CutoutServiceError(404, "CUTOUT_CANDIDATE_NOT_FOUND", "抠图候选不存在或已过期。")
            return path.read_bytes(), "image/webp" if preview else "image/png"

    def sweep(self) -> None:
        now = self._clock()
        with self._lock:
            for job_id, job in tuple(self._jobs.items()):
                age = now - job.created_at
                if job.state in ("queued", "running") and age > self.settings.job_timeout_seconds:
                    job.timed_out = True
                    job.cancel_event.set()
                    job.state = "failed"
                    job.message = "抠图处理超时，请重试或使用原图。"
                    job.updated_at = now
                    if job.future is not None and job.future.cancel():
                        if self._waiting_job is job:
                            self._waiting_job = None
                        self._remove_job_files(job)
                worker_unfinished = job.future is not None and not job.future.done()
                if (
                    job.state not in ("queued", "running")
                    and not worker_unfinished
                    and now - job.updated_at > self.settings.job_ttl_seconds
                ):
                    self._remove_job_files(job)
                    del self._jobs[job_id]

    def _run(self, job: Job) -> None:
        with self._lock:
            if job.timed_out:
                job.state = "failed"
                job.message = "抠图处理超时，请重试或使用原图。"
                job.updated_at = self._clock()
                self._remove_job_files(job)
                return
            if job.cancel_event.is_set():
                job.state = "cancelled"
                job.message = "抠图已取消。"
                job.updated_at = self._clock()
                self._remove_job_files(job)
                return
            job.state = "running"
            job.message = "正在分析图片并生成透明候选…"
            job.updated_at = self._clock()

        try:
            engine = self._engine
            if engine is None:
                raise RuntimeError("Inference engine unavailable.")
            candidates = engine.generate(
                job.source_path,
                job.folder,
                job.cancel_event,
                lambda message: self._set_message(job, message),
            )
            with self._lock:
                if job.timed_out:
                    self._remove_job_files(job)
                    return
                if job.cancel_event.is_set():
                    job.state = "cancelled"
                    job.message = "抠图已取消。"
                    self._remove_job_files(job)
                elif candidates:
                    job.candidates = candidates
                    job.state = "ready"
                    job.message = f"已生成 {len(candidates)} 个透明候选，请选择一张。"
                    job.updated_at = self._clock()
                    job.source_path.unlink(missing_ok=True)
                else:
                    job.state = "ready"
                    job.message = "没有找到合适的透明候选，请使用原图或重试。"
                    job.updated_at = self._clock()
                    job.source_path.unlink(missing_ok=True)
        except CutoutCancelled:
            with self._lock:
                job.state = "cancelled"
                job.message = "抠图已取消。"
                job.updated_at = self._clock()
                self._remove_job_files(job)
        except Exception as error:
            # Error strings/tracebacks may contain temporary paths; log only a type and job id.
            LOGGER.error(
                "Item cutout job failed (job_id=%s, error_type=%s)",
                job.job_id,
                type(error).__name__,
            )
            with self._lock:
                job.state = "failed"
                job.message = "本次抠图失败，请重试或使用原图。"
                job.updated_at = self._clock()
                self._remove_job_files(job)

    def _set_message(self, job: Job, message: str) -> None:
        with self._lock:
            if job.state == "running" and not job.cancel_event.is_set():
                # Engine messages are fixed user-facing stages, never exception text.
                job.message = message

    def _require_job(self, job_id: str) -> Job:
        if len(job_id) != 32 or any(ch not in "0123456789abcdef" for ch in job_id):
            raise CutoutServiceError(404, "CUTOUT_JOB_NOT_FOUND", "抠图任务不存在或已过期。")
        job = self._jobs.get(job_id)
        if job is None:
            raise CutoutServiceError(404, "CUTOUT_JOB_NOT_FOUND", "抠图任务不存在或已过期。")
        return job

    @staticmethod
    def _public_job(job: Job) -> dict[str, object]:
        return {
            "jobId": job.job_id,
            "state": job.state,
            "message": job.message,
            "candidates": [
                {"id": item.candidate_id, "width": item.width, "height": item.height}
                for item in job.candidates
            ]
            if job.state == "ready"
            else [],
        }

    @staticmethod
    def _remove_job_files(job: Job) -> None:
        shutil.rmtree(job.folder, ignore_errors=True)

    def _remove_stale_temp_dirs(self) -> None:
        root = self.settings.temp_dir
        try:
            for child in root.iterdir():
                if child.is_symlink():
                    child.unlink(missing_ok=True)
                elif child.is_dir() and child.name.startswith("job-"):
                    shutil.rmtree(child, ignore_errors=True)
                elif child.is_file() and child.name.startswith("job-"):
                    child.unlink(missing_ok=True)
        except FileNotFoundError:
            return
