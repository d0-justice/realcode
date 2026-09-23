"""Register the UAV flight-route page as a fastsite plugin."""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType

from fastapi import APIRouter
from fastsite import ExtensionContext


ROUTES = (
    {"path": "/flight-routes", "methods": ("GET",)},
    {"path": "/flight-routes/search", "methods": ("POST",)},
    {"path": "/api/flight-queries", "methods": ("POST",)},
    {"path": "/api/flight-queries/track", "methods": ("POST",)},
)

_sortie_index_job = None


def _load_module(name: str, source: Path) -> ModuleType:
    specification = importlib.util.spec_from_file_location(name, source)
    if specification is None or specification.loader is None:
        raise RuntimeError("cannot load flight-route plugin")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    try:
        specification.loader.exec_module(module)
    except Exception:
        sys.modules.pop(specification.name, None)
        raise
    return module


def register_routes(router: APIRouter, context: ExtensionContext) -> None:
    global _sortie_index_job
    history_module = _load_module("flight_route_plugin_history", context.extension_dir / "route_history.py")
    module = _load_module("flight_route_plugin_business", context.extension_dir / "flight_route.py")
    sync_module = _load_module("flight_route_plugin_sortie_index_sync", context.extension_dir / "sortie_index_sync.py")
    history_path = (
        os.getenv("FLIGHT_ROUTE_DB")
        or str(context.extension_dir / "data" / "flight_route_index.db")
    )
    history_store = history_module.RouteHistoryStore(
        Path(history_path).resolve(),
    )
    history_store.purge_retired_cache_tables()
    module.configure(
        history_store,
        lambda: context.services.connection("doris"),
    )
    _sortie_index_job = sync_module.SortieIndexSyncJob(
        history_store,
        lambda: context.services.connection("doris"),
    )
    router.include_router(module.router)


def register_jobs(registry, context: ExtensionContext) -> None:
    if _sortie_index_job is None:
        raise RuntimeError("flight-route sortie index job is not configured")
    registry.add_cron(
        extension_id=context.extension_id,
        name="daily_sortie_index_sync",
        func=_sortie_index_job.run,
        hour=6,
        minute=0,
        lease_seconds=6 * 60 * 60,
        misfire_grace_time=60 * 60,
    )
