"""Environment-backed configuration for the fastsite host."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


MAX_REQUEST_BYTES = 128 * 1024 * 1024


def _boolean(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _csv(name: str, default: str = "") -> tuple[str, ...]:
    return tuple(item.strip() for item in os.getenv(name, default).split(",") if item.strip())


def _public_base_url() -> str | None:
    value = os.getenv("PUBLIC_BASE_URL", "").strip()
    if not value:
        return None
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("PUBLIC_BASE_URL must be an http(s) origin without query or fragment")
    if parsed.path not in {"", "/"}:
        raise ValueError("PUBLIC_BASE_URL must not contain a path")
    return value.rstrip("/")


@dataclass(frozen=True)
class WebCoreSettings:
    extensions_dir: Path
    extension_strict: bool
    max_request_bytes: int
    trusted_hosts: tuple[str, ...]
    public_base_url: str | None
    docs_enabled: bool
    database_config_file: Path | None

    @classmethod
    def from_environment(cls) -> "WebCoreSettings":
        raw_dir = os.getenv("FASTSITE_EXTENSIONS_DIR", "extensions/current")
        return cls(
            extensions_dir=Path(raw_dir).resolve(),
            extension_strict=_boolean("FASTSITE_EXTENSION_STRICT", True),
            max_request_bytes=MAX_REQUEST_BYTES,
            trusted_hosts=_csv("FASTSITE_TRUSTED_HOSTS", "localhost,127.0.0.1"),
            public_base_url=_public_base_url(),
            docs_enabled=_boolean("FASTSITE_DOCS_ENABLED", False),
            database_config_file=(
                Path(os.environ["FASTSITE_DATABASE_CONFIG"]).resolve()
                if os.getenv("FASTSITE_DATABASE_CONFIG")
                else None
            ),
        )
