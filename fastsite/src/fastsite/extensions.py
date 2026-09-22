"""Validated extension discovery for the fastsite host."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import logging
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

from fastapi import APIRouter

from .settings import WebCoreSettings
from .services import WebCoreServices
from .scheduler import JobRegistry


LOGGER = logging.getLogger("fastsite.extensions")
EXTENSION_ID = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
ENTRY_FILE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\.py$")
API_VERSION = 1


class ExtensionError(RuntimeError):
    """Raised when a trusted extension does not satisfy the core contract."""


@dataclass(frozen=True)
class ExtensionManifest:
    extension_id: str
    entry_file: str
    mount_path: str


@dataclass(frozen=True)
class LoadedExtension:
    """The extension state observed by the Worker that loaded it."""

    extension_id: str
    mount_path: str
    manifest_sha256: str
    entry_sha256: str
    plugin_sha256: str
    routes: tuple[dict[str, object], ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "id": self.extension_id,
            "mount_path": self.mount_path,
            "manifest_sha256": self.manifest_sha256,
            "entry_sha256": self.entry_sha256,
            "plugin_sha256": self.plugin_sha256,
            "routes": list(self.routes),
        }


@dataclass(frozen=True)
class ExtensionContext:
    extension_id: str
    extension_dir: Path
    settings: WebCoreSettings
    services: WebCoreServices
    scheduler: JobRegistry


def _inside_root(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def read_manifest(manifest_path: Path, root: Path) -> ExtensionManifest:
    extension_dir = manifest_path.parent.resolve()
    if not _inside_root(extension_dir, root):
        raise ExtensionError("extension directory escapes the configured root")
    try:
        raw: dict[str, Any] = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ExtensionError(f"invalid manifest: {manifest_path}") from error

    allowed = {"id", "api_version", "entry", "mount_path"}
    if not set(raw).issubset(allowed) or not {"id", "api_version", "entry"}.issubset(raw):
        raise ExtensionError(f"manifest may contain only: {', '.join(sorted(allowed))}")
    extension_id = raw.get("id")
    entry_file = raw.get("entry")
    if not isinstance(extension_id, str) or not EXTENSION_ID.fullmatch(extension_id):
        raise ExtensionError("extension id is invalid")
    if raw.get("api_version") != API_VERSION:
        raise ExtensionError("extension API version is unsupported")
    if not isinstance(entry_file, str) or not ENTRY_FILE.fullmatch(entry_file):
        raise ExtensionError("extension entry must be a Python filename in the extension root")
    mount_path = raw.get("mount_path", f"/extensions/{extension_id}")
    if not isinstance(mount_path, str):
        raise ExtensionError("extension mount_path must be a string")
    if mount_path and (
        not mount_path.startswith("/")
        or mount_path.endswith("/")
        or "//" in mount_path
        or any(part in {".", ".."} for part in mount_path.split("/"))
    ):
        raise ExtensionError("extension mount_path is invalid")
    return ExtensionManifest(extension_id=extension_id, entry_file=entry_file, mount_path=mount_path)


def load_module(module_name: str, source_file: Path) -> ModuleType:
    specification = importlib.util.spec_from_file_location(module_name, source_file)
    if specification is None or specification.loader is None:
        raise ExtensionError(f"cannot load extension source: {source_file.name}")
    module = importlib.util.module_from_spec(specification)
    sys.modules[module_name] = module
    try:
        specification.loader.exec_module(module)
    except Exception:
        sys.modules.pop(module_name, None)
        raise
    return module


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _plugin_sha256(extension_dir: Path) -> str:
    """Hash all release files while ignoring Python runtime caches."""
    digest = hashlib.sha256()
    for path in sorted(extension_dir.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts or path.suffix in {".pyc", ".pyo", ".db", ".sqlite", ".sqlite3"} or path.name.endswith((".db-wal", ".db-shm")):
            continue
        relative = path.relative_to(extension_dir).as_posix().encode("utf-8")
        digest.update(relative)
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _declared_routes(module: ModuleType) -> tuple[dict[str, object], ...]:
    if not hasattr(module, "ROUTES"):
        raise ExtensionError("extension must declare ROUTES")
    raw_routes = module.ROUTES
    if not isinstance(raw_routes, (list, tuple)):
        raise ExtensionError("extension ROUTES must be a list or tuple")
    result: list[dict[str, object]] = []
    for route in raw_routes:
        if not isinstance(route, dict) or set(route) != {"path", "methods"}:
            raise ExtensionError("each extension ROUTES item must contain path and methods")
        path, methods = route["path"], route["methods"]
        if not isinstance(path, str) or not path.startswith("/") or "//" in path:
            raise ExtensionError("extension route path is invalid")
        if not isinstance(methods, (list, tuple)) or not methods or any(
            not isinstance(method, str) or not method.isupper() for method in methods
        ):
            raise ExtensionError("extension route methods are invalid")
        result.append({"path": path, "methods": sorted(set(methods))})
    return tuple(result)


def load_extensions(app: Any, settings: WebCoreSettings, services: WebCoreServices, scheduler: JobRegistry) -> tuple[LoadedExtension, ...]:
    root = settings.extensions_dir
    if not root.exists():
        LOGGER.info("extension root does not exist: %s", root)
        return ()
    if not root.is_dir():
        raise ExtensionError("configured extension root is not a directory")

    loaded: list[LoadedExtension] = []
    seen_ids: set[str] = set()
    for manifest_path in sorted(root.glob("*/manifest.json")):
        try:
            manifest = read_manifest(manifest_path, root)
            if manifest.extension_id in seen_ids:
                raise ExtensionError(f"duplicate extension id: {manifest.extension_id}")
            extension_dir = manifest_path.parent.resolve()
            source_file = (extension_dir / manifest.entry_file).resolve()
            if not _inside_root(source_file, extension_dir) or not source_file.is_file():
                raise ExtensionError("extension entry does not exist inside its directory")
            module = load_module(f"service_extension_{manifest.extension_id.replace('-', '_')}", source_file)
            register_routes: Callable[[APIRouter, ExtensionContext], None] | None = getattr(module, "register_routes", None)
            if not callable(register_routes):
                raise ExtensionError("extension must define register_routes(router, context)")

            router = APIRouter(prefix=manifest.mount_path)
            context = ExtensionContext(manifest.extension_id, extension_dir, settings, services, scheduler)
            register_routes(router, context)
            register_jobs = getattr(module, "register_jobs", None)
            if register_jobs is not None:
                if not callable(register_jobs):
                    raise ExtensionError("extension register_jobs must be callable")
                register_jobs(scheduler, context)
            app.include_router(router)
            seen_ids.add(manifest.extension_id)
            extension = LoadedExtension(
                extension_id=manifest.extension_id,
                mount_path=manifest.mount_path,
                manifest_sha256=_sha256(manifest_path),
                entry_sha256=_sha256(source_file),
                plugin_sha256=_plugin_sha256(extension_dir),
                routes=_declared_routes(module),
            )
            loaded.append(extension)
            LOGGER.info(
                "extension_loaded id=%s mount_path=%s routes=%s manifest_sha256=%s entry_sha256=%s plugin_sha256=%s",
                extension.extension_id,
                extension.mount_path or "/",
                len(extension.routes),
                extension.manifest_sha256,
                extension.entry_sha256,
                extension.plugin_sha256,
            )
        except Exception as error:
            if settings.extension_strict:
                raise ExtensionError(f"failed loading {manifest_path}: {error}") from error
            LOGGER.exception("skipped invalid extension manifest=%s", manifest_path)
    return tuple(loaded)
