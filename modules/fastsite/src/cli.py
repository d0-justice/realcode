"""Operational CLI for database access and controlled Gunicorn reloads."""

from __future__ import annotations

import argparse
import json
import os
import signal
import time
import traceback
from dataclasses import replace
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

from fastapi import FastAPI

from .extensions import load_extensions
from .factory import create_connection, list_databases
from .services import WebCoreServices
from .scheduler import JobRegistry
from .settings import WebCoreSettings


class ReloadError(RuntimeError):
    """Raised when a validated reload cannot reach a ready replacement Worker."""


def _validate_plugins(extensions_dir: Path | None) -> dict[str, object]:
    settings = WebCoreSettings.from_environment()
    if extensions_dir is not None:
        settings = replace(settings, extensions_dir=extensions_dir.resolve())
    if not settings.extensions_dir.is_dir():
        raise ReloadError(f"plugin directory does not exist: {settings.extensions_dir}")
    # Preflight rejects every bad plugin even when a development host is lenient.
    settings = replace(settings, extension_strict=True)
    services = WebCoreServices(settings)
    scheduler = JobRegistry(settings.extensions_dir.parent / "data" / "fastsite_scheduler.db")
    try:
        app = FastAPI()
        extensions = load_extensions(app, settings, services, scheduler)
        return {
            "ok": True,
            "extensions_dir": str(settings.extensions_dir),
            "extensions": [extension.as_dict() for extension in extensions],
            "scheduled_jobs": scheduler.as_dict(),
        }
    finally:
        services.close()


def _get_json(url: str) -> dict[str, Any]:
    request = Request(url, headers={"Accept": "application/json"})
    with urlopen(request, timeout=5) as response:  # nosec B310: operator-supplied local status URL
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ReloadError(f"status endpoint returned a non-object response: {url}")
    return payload


def _read_pid(pid_file: Path) -> int:
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip())
    except (OSError, ValueError) as error:
        raise ReloadError(f"cannot read Gunicorn PID file: {pid_file}") from error
    if pid < 1:
        raise ReloadError(f"Gunicorn PID is invalid: {pid}")
    return pid


def _expected_hashes(preflight: dict[str, object]) -> dict[str, str]:
    raw_extensions = preflight["extensions"]
    assert isinstance(raw_extensions, list)
    result: dict[str, str] = {}
    for extension in raw_extensions:
        assert isinstance(extension, dict)
        extension_id, plugin_hash = extension["id"], extension["plugin_sha256"]
        assert isinstance(extension_id, str) and isinstance(plugin_hash, str)
        result[extension_id] = plugin_hash
    return result


def _ready_worker(status: dict[str, Any], old_boot_id: str, expected_hashes: dict[str, str], expected_jobs: list[dict[str, object]]) -> tuple[bool, str]:
    worker = status.get("worker")
    if not isinstance(worker, dict) or worker.get("boot_id") == old_boot_id:
        return False, "waiting_for_new_worker"
    raw_extensions = status.get("extensions")
    if not isinstance(raw_extensions, list):
        return False, "new_worker_invalid_status"
    actual_hashes = {
        item.get("id"): item.get("plugin_sha256")
        for item in raw_extensions
        if isinstance(item, dict) and isinstance(item.get("id"), str) and isinstance(item.get("plugin_sha256"), str)
    }
    if actual_hashes != expected_hashes:
        return False, "new_worker_plugin_version_mismatch"
    if status.get("scheduled_jobs") != expected_jobs:
        return False, "new_worker_scheduled_jobs_mismatch"
    return True, "ready"


def _reload(
    preflight: dict[str, object],
    pid_file: Path,
    status_url: str,
    timeout_seconds: int,
    poll_interval_seconds: float,
    previous_boot_id: str | None = None,
) -> dict[str, object]:
    status_url = status_url.rstrip("/")
    old_boot_id = previous_boot_id
    if old_boot_id is None:
        before = _get_json(f"{status_url}/readyz")
        worker = before.get("worker")
        if not isinstance(worker, dict) or not isinstance(worker.get("boot_id"), str):
            raise ReloadError("readyz response does not contain worker.boot_id")
        old_boot_id = worker["boot_id"]
    expected_hashes = _expected_hashes(preflight)
    expected_jobs = preflight.get("scheduled_jobs", [])
    assert isinstance(expected_jobs, list)
    pid = _read_pid(pid_file)
    if not hasattr(signal, "SIGHUP"):
        raise ReloadError("Gunicorn HUP reload is only supported on POSIX hosts")
    os.kill(pid, signal.SIGHUP)

    deadline = time.monotonic() + timeout_seconds
    last_phase = "reload_requested"
    while time.monotonic() < deadline:
        try:
            status = _get_json(f"{status_url}/readyz")
            ready, phase = _ready_worker(status, old_boot_id, expected_hashes, expected_jobs)
            last_phase = phase
            if ready:
                return {
                    "ok": True,
                    "phase": "ready",
                    "message": "新 Worker 已就绪，目标插件版本和路由声明已确认",
                    "previous_boot_id": old_boot_id,
                    "worker": status["worker"],
                    "extensions": status["extensions"],
                    "scheduled_jobs": status.get("scheduled_jobs", []),
                }
        except Exception as error:
            last_phase = f"status_unavailable: {type(error).__name__}"
        time.sleep(poll_interval_seconds)
    raise ReloadError(f"reload did not become ready within {timeout_seconds}s; last_phase={last_phase}")


def _print_error(phase: str, error: Exception) -> None:
    print(
        json.dumps(
            {
                "ok": False,
                "phase": phase,
                "error": {
                    "type": type(error).__name__,
                    "message": str(error),
                    "traceback": traceback.format_exception(error),
                },
            },
            ensure_ascii=False,
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser(prog="fastsite-cli")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list")
    test = commands.add_parser("test")
    test.add_argument("database")
    validate = commands.add_parser("validate-plugins")
    validate.add_argument("--extensions-dir", type=Path)
    reload = commands.add_parser("reload")
    reload.add_argument("--extensions-dir", type=Path)
    reload.add_argument("--pid-file", type=Path, required=True)
    reload.add_argument("--status-url", default=os.getenv("FASTSITE_STATUS_URL", "http://127.0.0.1:3003"))
    reload.add_argument("--timeout-seconds", type=int, default=90)
    reload.add_argument("--poll-interval-seconds", type=float, default=0.5)
    reload.add_argument("--previous-boot-id", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.command == "list":
        print("\n".join(list_databases()))
        return 0
    if args.command == "test":
        connection = create_connection(args.database)
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
        finally:
            connection.close()
        print(f"{args.database}: ok")
        return 0
    if args.command == "validate-plugins":
        try:
            print(json.dumps(_validate_plugins(args.extensions_dir), ensure_ascii=False))
            return 0
        except Exception as error:
            _print_error("preflight_failed", error)
            return 2
    if args.timeout_seconds < 1 or args.poll_interval_seconds <= 0:
        _print_error("invalid_arguments", ReloadError("timeout and poll interval must be positive"))
        return 2
    try:
        preflight = _validate_plugins(args.extensions_dir)
    except Exception as error:
        _print_error("preflight_failed", error)
        return 2
    try:
        print(
            json.dumps(
                _reload(
                    preflight,
                    args.pid_file,
                    args.status_url,
                    args.timeout_seconds,
                    args.poll_interval_seconds,
                    args.previous_boot_id,
                ),
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as error:
        _print_error("reload_failed", error)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
