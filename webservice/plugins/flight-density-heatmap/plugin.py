"""Register the static flight-density heatmap publishing plugin."""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType

from fastapi import APIRouter
from fastsite import ExtensionContext


ROUTES = (
    {"path": "/", "methods": ("GET",)},
    {"path": "/topic", "methods": ("GET",)},
    {"path": "/static/guangdong-daily/{map_date}", "methods": ("GET",)},
    {"path": "/static/guangdong-monthly/{map_month}", "methods": ("GET",)},
    {"path": "/static/guangdong-range/{range_key}", "methods": ("GET",)},
    {"path": "/assets/admin-layers/base", "methods": ("GET",)},
    {"path": "/assets/admin-layers/cities/{city_adcode}", "methods": ("GET",)},
    {"path": "/api/guangdong-daily/{map_date}", "methods": ("PUT",)},
    {"path": "/api/guangdong-monthly/{map_month}", "methods": ("PUT",)},
    {"path": "/api/guangdong-range/{range_key}", "methods": ("PUT",)},
    {"path": "/api/admin-layers", "methods": ("PUT",)},
)


def _load_module(name: str, source: Path) -> ModuleType:
    specification = importlib.util.spec_from_file_location(name, source)
    if specification is None or specification.loader is None:
        raise RuntimeError("cannot load flight-density-heatmap plugin")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    try:
        specification.loader.exec_module(module)
    except Exception:
        sys.modules.pop(specification.name, None)
        raise
    return module


def _public_base_url() -> str:
    value = os.getenv("PUBLIC_BASE_URL")
    if not value:
        raise RuntimeError("PUBLIC_BASE_URL must be configured for flight-density-heatmap browser URLs")
    return value.rstrip("/")


def register_routes(router: APIRouter, context: ExtensionContext) -> None:
    module_dir = context.extension_dir / "heatmap"
    module = _load_module("flight_density_heatmap_plugin", module_dir / "flight_density_heatmap.py")
    default_map_dir = context.extension_dir.parent.parent / "data" / "flight-density-heatmaps"
    map_dir = Path(os.getenv("FLIGHT_DENSITY_MAPS_DIR", str(default_map_dir))).resolve()
    module.configure(_public_base_url(), map_dir)
    router.include_router(module.router)
