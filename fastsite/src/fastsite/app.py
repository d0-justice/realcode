"""FastAPI application factory for the stable fastsite host."""

from __future__ import annotations

import logging
import os
import time
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .database import register_embedded_pymysql_databases, register_pymysql_databases
from .extensions import load_extensions
from .reload_endpoint import ReloadEndpointConfig, authorized, run_reload
from .settings import WebCoreSettings
from .services import WebCoreServices
from .scheduler import JobRegistry


LOGGER = logging.getLogger("fastsite.request")
CORE_VERSION = "0.2.1"


class RequestBodyTooLargeError(RuntimeError):
    """Raised internally when streamed HTTP request data exceeds the configured limit."""


class RequestBodyLimitMiddleware:
    """Apply a byte limit to both Content-Length and chunked request bodies."""

    def __init__(self, app, max_request_bytes: int) -> None:
        self.app = app
        self.max_request_bytes = max_request_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        received_bytes = 0
        response_started = False

        async def limited_receive():
            nonlocal received_bytes
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > self.max_request_bytes:
                    raise RequestBodyTooLargeError()
            return message

        async def tracked_send(message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except RequestBodyTooLargeError:
            if not response_started:
                response = JSONResponse({"detail": "request body is too large"}, status_code=413)
                await response(scope, receive, send)


def create_app(
    settings: WebCoreSettings | None = None,
    configure_services: Callable[[WebCoreServices], None] | None = None,
) -> FastAPI:
    settings = settings or WebCoreSettings.from_environment()
    services = WebCoreServices(settings)
    scheduler = JobRegistry(settings.extensions_dir.parent / "data" / "fastsite_scheduler.db")
    reload_config = ReloadEndpointConfig.from_environment()
    if settings.database_config_file is not None:
        register_pymysql_databases(services, settings.database_config_file)
    else:
        register_embedded_pymysql_databases(services)
    if configure_services is not None:
        configure_services(services)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        scheduler_started = False
        try:
            scheduler.start()
            scheduler_started = True
            yield
        finally:
            try:
                if scheduler_started:
                    scheduler.shutdown()
            finally:
                services.close()

    boot_id = uuid.uuid4().hex
    started_at = time.time()
    app = FastAPI(
        title="Fastsite",
        version=CORE_VERSION,
        docs_url="/docs" if settings.docs_enabled else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.docs_enabled else None,
        lifespan=lifespan,
    )
    app.add_middleware(RequestBodyLimitMiddleware, max_request_bytes=settings.max_request_bytes)
    if settings.trusted_hosts:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.trusted_hosts))

    @app.middleware("http")
    async def protect_and_log(request: Request, call_next) -> Response:
        content_length = request.headers.get("content-length")
        if content_length and content_length.isdigit() and int(content_length) > settings.max_request_bytes:
            return JSONResponse({"detail": "request body is too large"}, status_code=413)

        request_id = uuid.uuid4().hex
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            LOGGER.exception("request_failed id=%s method=%s path=%s", request_id, request.method, request.url.path)
            raise
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Cache-Control"] = "no-store"
        LOGGER.info(
            "request_completed id=%s method=%s path=%s status=%s duration_ms=%d",
            request_id,
            request.method,
            request.url.path,
            response.status_code,
            (time.perf_counter() - started) * 1000,
        )
        return response

    @app.get("/healthz")
    def healthz() -> dict[str, object]:
        return {"status": "ok", "core_version": CORE_VERSION}

    @app.get("/readyz")
    def readyz() -> dict[str, object]:
        extensions = [extension.as_dict() for extension in app.state.service_extensions]
        return {
            "status": "ready",
            "core_version": CORE_VERSION,
            "worker": {
                "pid": os.getpid(),
                "boot_id": boot_id,
                "started_at_unix": started_at,
            },
            "extensions": extensions,
            "scheduled_jobs": scheduler.as_dict(),
            "database_pools": len(app.state.service_services._pools),
        }

    @app.get("/reload-status")
    def reload_status(
        previous_boot_id: str | None = None,
        expected_extension: str | None = None,
        expected_plugin_sha256: str | None = None,
        expected_entry_sha256: str | None = None,
    ) -> dict[str, object]:
        _validate_optional_query(previous_boot_id, "previous_boot_id", 128)
        _validate_optional_query(expected_extension, "expected_extension", 63)
        _validate_optional_query(expected_plugin_sha256, "expected_plugin_sha256", 64, exact_length=True)
        _validate_optional_query(expected_entry_sha256, "expected_entry_sha256", 64, exact_length=True)
        extensions = [extension.as_dict() for extension in app.state.service_extensions]
        matching_extension = next(
            (extension for extension in app.state.service_extensions if extension.extension_id == expected_extension),
            None,
        )
        phase = "ready"
        ready = True
        message = "新 Worker 已就绪，目标插件已加载并完成路由挂载"
        if previous_boot_id == boot_id:
            phase, ready = "waiting_for_new_worker", False
            message = "正在等待新 Worker 启动并加载插件"
        elif expected_extension and matching_extension is None:
            phase, ready = "new_worker_missing_plugin", False
            message = "新 Worker 已启动，但目标插件尚未加载"
        elif expected_plugin_sha256 and matching_extension and matching_extension.plugin_sha256 != expected_plugin_sha256:
            phase, ready = "new_worker_plugin_version_mismatch", False
            message = "新 Worker 已启动，但目标插件版本与发布版本不一致"
        elif expected_entry_sha256 and matching_extension and matching_extension.entry_sha256 != expected_entry_sha256:
            phase, ready = "new_worker_plugin_version_mismatch", False
            message = "新 Worker 已启动，但目标插件入口版本不一致"
        return {
            "phase": phase,
            "ready": ready,
            "message": message,
            "worker": {"pid": os.getpid(), "boot_id": boot_id, "started_at_unix": started_at},
            "extensions": extensions,
        }

    @app.post("/internal/reload")
    def reload_from_sandbox(request: Request) -> JSONResponse:
        if reload_config.token is None:
            return JSONResponse({"ok": False, "message": "Fastsite HTTP reload is not configured"}, status_code=503)
        if not authorized(request.headers.get("authorization"), reload_config.token):
            return JSONResponse({"ok": False, "message": "Unauthorized"}, status_code=401)
        status, payload = run_reload(reload_config, boot_id)
        return JSONResponse(payload, status_code=status)

    app.state.service_settings = settings
    app.state.service_services = services
    app.state.service_scheduler = scheduler
    app.state.service_extensions = load_extensions(app, settings, services, scheduler)
    return app


def _validate_optional_query(value: str | None, name: str, max_length: int, *, exact_length: bool = False) -> None:
    if value is None:
        return
    valid = len(value) == max_length if exact_length else 1 <= len(value) <= max_length
    if not valid:
        expectation = f"exactly {max_length}" if exact_length else f"between 1 and {max_length}"
        raise HTTPException(status_code=422, detail=f"{name} length must be {expectation}")
