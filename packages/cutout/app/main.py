"""Private HTTP surface for short-lived item-photo cutout jobs."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from typing import Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from .engine import CutoutEngine, Sam2CutoutEngine
from .jobs import CutoutServiceError, JobManager
from .settings import Settings

LOGGER = logging.getLogger("jizhang.cutout")


async def _read_limited(request: Request, limit: int) -> bytes:
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > limit:
            raise CutoutServiceError(413, "CUTOUT_IMAGE_TOO_LARGE", "图片不能超过 2 MiB。")
    return bytes(content)


def create_app(
    settings: Settings | None = None,
    engine_factory: Callable[[Settings], CutoutEngine] = Sam2CutoutEngine,
) -> FastAPI:
    service_settings = settings or Settings.from_env()
    jobs = JobManager(service_settings, engine_factory)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        jobs.start()

        async def sweep_loop() -> None:
            while True:
                await asyncio.sleep(30)
                await asyncio.to_thread(jobs.sweep)

        sweeper = asyncio.create_task(sweep_loop(), name="cutout-job-sweeper")
        LOGGER.info("Cutout model ready; transient job limits enabled.")
        try:
            yield
        finally:
            sweeper.cancel()
            with suppress(asyncio.CancelledError):
                await sweeper
            jobs.shutdown()

    app = FastAPI(
        title="Jizhang private item cutout",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.jobs = jobs

    @app.exception_handler(CutoutServiceError)
    async def cutout_error_handler(_request: Request, error: CutoutServiceError) -> JSONResponse:
        return JSONResponse(
            content={"error": {"code": error.code, "message": error.message}},
            status_code=error.status_code,
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    @app.get("/health/live")
    async def liveness() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/ready")
    async def readiness() -> Response:
        if not jobs.ready:
            return Response(
                content='{"status":"not-ready"}',
                status_code=503,
                media_type="application/json",
                headers={"Cache-Control": "no-store"},
            )
        return Response(
            content='{"status":"ready"}',
            media_type="application/json",
            headers={"Cache-Control": "no-store"},
        )

    @app.post("/jobs", status_code=202)
    async def create_job(request: Request) -> Response:
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type not in ("image/webp", "image/jpeg", "image/png"):
            raise CutoutServiceError(400, "CUTOUT_INVALID_IMAGE", "抠图请求必须发送 JPEG、PNG 或 WebP 图片。")
        data = await _read_limited(request, service_settings.max_input_bytes)
        return JSONResponse(
            content=jobs.create(data, content_type),
            status_code=202,
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/jobs/{job_id}")
    async def get_job(job_id: str) -> Response:
        return JSONResponse(
            content=jobs.status(job_id),
            headers={"Cache-Control": "no-store"},
        )

    @app.delete("/jobs/{job_id}", status_code=204)
    async def delete_job(job_id: str) -> Response:
        jobs.cancel(job_id)
        return Response(status_code=204, headers={"Cache-Control": "no-store"})

    @app.get("/jobs/{job_id}/candidates/{candidate_id}/preview")
    async def candidate_preview(job_id: str, candidate_id: str) -> Response:
        data, content_type = jobs.candidate_bytes(job_id, candidate_id, preview=True)
        return Response(
            content=data,
            media_type=content_type,
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    @app.get("/jobs/{job_id}/candidates/{candidate_id}/image")
    async def candidate_image(job_id: str, candidate_id: str) -> Response:
        data, content_type = jobs.candidate_bytes(job_id, candidate_id, preview=False)
        return Response(
            content=data,
            media_type=content_type,
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": "inline; filename=\"item-cutout.png\"",
            },
        )

    return app


app = create_app()
