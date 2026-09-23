"""Register the flight-report plugin and its report modules."""

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
    {"path": "/flight-analysis-topic", "methods": ("GET",)},
    {"path": "/daily-topic", "methods": ("GET",)},
    {"path": "/static/guangdong-daily/{report_date}", "methods": ("GET",)},
    {"path": "/static/guangdong-monthly/{report_month}", "methods": ("GET",)},
    {"path": "/api/guangdong-daily/{report_date}", "methods": ("PUT",)},
    {"path": "/api/guangdong-monthly/{report_month}", "methods": ("PUT",)},
    {"path": "/high-altitude-topic", "methods": ("GET",)},
    {"path": "/static/high-altitude-daily/{report_date}", "methods": ("GET",)},
    {"path": "/static/high-altitude-range/{range_key}", "methods": ("GET",)},
    {"path": "/api/high-altitude-daily/{report_date}", "methods": ("PUT",)},
    {"path": "/api/high-altitude-range/{range_key}", "methods": ("PUT",)},
)


def _load_module(name: str, source: Path) -> ModuleType:
    specification = importlib.util.spec_from_file_location(name, source)
    if specification is None or specification.loader is None:
        raise RuntimeError("cannot load flight-report plugin")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    try:
        specification.loader.exec_module(module)
    except Exception:
        sys.modules.pop(specification.name, None)
        raise
    return module


def _public_base_url() -> str:
    """Read the single configured browser-facing service origin."""
    value = os.getenv("PUBLIC_BASE_URL")
    if not value:
        raise RuntimeError("PUBLIC_BASE_URL must be configured for flight-report browser URLs")
    return value.rstrip("/")


def register_routes(router: APIRouter, context: ExtensionContext) -> None:
    report_dir = context.extension_dir / "flight-analysis-report"
    report_module = _load_module("flight_report_plugin_analysis", report_dir / "flight_analysis_report.py")
    report_module.configure(_public_base_url(), report_dir / "reports")
    router.include_router(report_module.router)

    altitude_dir = context.extension_dir / "high-altitude-analysis-report"
    altitude_module = _load_module("flight_report_plugin_high_altitude", altitude_dir / "high_altitude_report.py")
    altitude_module.configure(_public_base_url(), altitude_dir / "reports")
    router.include_router(altitude_module.router)
