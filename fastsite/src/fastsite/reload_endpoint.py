"""Authenticated bridge from a Fastsite HTTP request to the existing reload CLI."""

from __future__ import annotations

import hmac
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - production is POSIX
    fcntl = None


@dataclass(frozen=True)
class ReloadEndpointConfig:
    token: str | None
    extensions_dir: Path
    pid_file: Path | None
    status_url: str
    lock_file: Path
    request_timeout_seconds: int
    reload_timeout_seconds: int

    @classmethod
    def from_environment(cls) -> "ReloadEndpointConfig":
        token = os.getenv("FASTSITE_RELOAD_TOKEN", "").strip() or None
        pid_file = os.getenv("FASTSITE_PID_FILE", "").strip()
        return cls(
            token=token,
            extensions_dir=Path(os.getenv("FASTSITE_EXTENSIONS_DIR", "extensions/current")).resolve(),
            pid_file=Path(pid_file).resolve() if pid_file else None,
            status_url=os.getenv("FASTSITE_STATUS_URL", "http://127.0.0.1:3003").rstrip("/"),
            lock_file=Path(os.getenv("FASTSITE_RELOAD_LOCK_FILE", "/app/data/fastsite/reload.lock")).resolve(),
            request_timeout_seconds=_positive_int("FASTSITE_RELOAD_REQUEST_TIMEOUT_SECONDS", 120),
            reload_timeout_seconds=_positive_int("FASTSITE_RELOAD_TIMEOUT_SECONDS", 90),
        )


def _positive_int(name: str, default: int) -> int:
    value = int(os.getenv(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def authorized(header: str | None, token: str | None) -> bool:
    if token is None or len(token) < 32 or not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header.removeprefix("Bearer "), token)


def reload_command(config: ReloadEndpointConfig, previous_boot_id: str) -> list[str]:
    if config.pid_file is None:
        raise RuntimeError("FASTSITE_PID_FILE is required for HTTP reload")
    return [
        sys.executable,
        "-m",
        "fastsite.cli",
        "reload",
        "--extensions-dir",
        str(config.extensions_dir),
        "--pid-file",
        str(config.pid_file),
        "--status-url",
        config.status_url,
        "--timeout-seconds",
        str(config.reload_timeout_seconds),
        "--previous-boot-id",
        previous_boot_id,
    ]


def run_reload(config: ReloadEndpointConfig, previous_boot_id: str) -> tuple[int, dict[str, Any]]:
    if fcntl is None:
        return 501, {"ok": False, "phase": "unsupported_platform", "message": "Fastsite reload requires POSIX"}
    config.lock_file.parent.mkdir(parents=True, exist_ok=True)
    with config.lock_file.open("a+", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 409, {"ok": False, "phase": "reload_in_progress", "message": "A reload is already running"}
        try:
            result = subprocess.run(
                reload_command(config, previous_boot_id),
                check=False,
                capture_output=True,
                text=True,
                timeout=config.request_timeout_seconds,
            )
        except subprocess.TimeoutExpired:
            return 504, {"ok": False, "phase": "request_timeout", "message": "Fastsite reload timed out"}
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return 502, {
            "ok": False,
            "phase": "invalid_cli_response",
            "message": "fastsite.cli reload did not return valid JSON",
        }
    if not isinstance(payload, dict):
        return 502, {"ok": False, "phase": "invalid_cli_response", "message": "fastsite.cli returned non-object JSON"}
    return (200 if result.returncode == 0 and payload.get("ok") is True else 422), payload
