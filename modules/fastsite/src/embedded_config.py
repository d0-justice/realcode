"""Load build-time embedded database configuration when present."""

from __future__ import annotations

import importlib
import importlib.machinery
from pathlib import Path
from typing import Any


class EmbeddedConfigError(RuntimeError):
    """Raised when an embedded configuration module cannot be used."""


def load_embedded_database_config() -> dict[str, dict[str, Any]] | None:
    """Return the encrypted build configuration, or None for source/development runs."""
    package_dir = Path(__file__).parent
    suffixes = tuple(importlib.machinery.EXTENSION_SUFFIXES)
    candidates = [
        path for path in package_dir.iterdir()
        if path.name.startswith("_compiled_config") and path.suffix in suffixes
    ]
    if not candidates:
        return None
    if len(candidates) != 1:
        raise EmbeddedConfigError("multiple embedded configuration modules found")
    module_name = candidates[0].name.split(".")[0]
    try:
        module = importlib.import_module(f"fastsite.{module_name}")
        config = module.get_database_configurations()
    except Exception as error:
        raise EmbeddedConfigError("failed loading embedded database configuration") from error
    if not isinstance(config, dict):
        raise EmbeddedConfigError("embedded database configuration is invalid")
    return config
