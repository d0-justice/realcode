"""Persistent SQLite history store for flight-route results."""

from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class RouteHistoryStore:
    """Keep completed Doris query results until explicitly refreshed."""

    def __init__(self, path: Path, *, read_only: bool = False) -> None:
        self.path = path
        self.read_only = read_only
        self._schema_initialized = read_only
        if not read_only:
            connection = self._connect()
            try:
                connection.commit()
            finally:
                connection.close()

    def _connect(self) -> sqlite3.Connection:
        if self.read_only:
            if not self.path.is_file():
                raise FileNotFoundError(f"route history database does not exist: {self.path}")
            connection = sqlite3.connect(f"file:{self.path.as_posix()}?mode=ro", uri=True, timeout=15)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA busy_timeout=15000")
            return connection
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=15000")
        connection.execute("PRAGMA synchronous=NORMAL")
        if self._schema_initialized:
            return connection
        connection.execute("PRAGMA journal_mode=WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS route_sortie_index_fp_v1 (
                flight_date TEXT NOT NULL,
                fp_id TEXT NOT NULL,
                order_id TEXT NOT NULL DEFAULT '',
                sn TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                enterprise_name TEXT NOT NULL DEFAULT '',
                first_time_stamp TEXT NOT NULL,
                last_time_stamp TEXT NOT NULL,
                start_lng REAL,
                start_lat REAL,
                end_lng REAL,
                end_lat REAL,
                last_create_time TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (flight_date, fp_id)
            );
            CREATE INDEX IF NOT EXISTS idx_route_sortie_date_fp ON route_sortie_index_fp_v1(flight_date, fp_id);
            CREATE INDEX IF NOT EXISTS idx_route_sortie_date_order ON route_sortie_index_fp_v1(flight_date, order_id, fp_id);
            CREATE INDEX IF NOT EXISTS idx_route_sortie_date_model ON route_sortie_index_fp_v1(flight_date, model, fp_id);
            CREATE TABLE IF NOT EXISTS route_sortie_sync_state_v1 (
                sync_name TEXT PRIMARY KEY,
                last_create_time TEXT NOT NULL,
                coverage_start_date TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                message TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL
            );
            """
        )
        sync_columns = {row[1] for row in connection.execute("PRAGMA table_info(route_sortie_sync_state_v1)")}
        if "coverage_start_date" not in sync_columns:
            connection.execute("ALTER TABLE route_sortie_sync_state_v1 ADD COLUMN coverage_start_date TEXT NOT NULL DEFAULT ''")
        index_columns = {row[1] for row in connection.execute("PRAGMA table_info(route_sortie_index_fp_v1)")}
        for column in ("start_lng", "start_lat", "end_lng", "end_lat"):
            if column not in index_columns:
                connection.execute(f"ALTER TABLE route_sortie_index_fp_v1 ADD COLUMN {column} REAL")
        self._schema_initialized = True
        return connection

    @contextmanager
    def _managed_connection(self):
        connection = self._connect()
        try:
            yield connection
            if not self.read_only:
                connection.commit()
        except Exception:
            if not self.read_only:
                connection.rollback()
            raise
        finally:
            connection.close()

    def _require_write(self) -> None:
        if self.read_only:
            raise RuntimeError("route history store is read-only")

    def purge_retired_cache_tables(self) -> None:
        """Remove retired summary, session, page, and coordinate-track cache tables."""
        self._require_write()
        with self._managed_connection() as connection:
            connection.execute("DROP INDEX IF EXISTS idx_route_track_cache_key")
            connection.execute("DROP TABLE IF EXISTS route_track_history_fp_v2")
            connection.execute("DROP TABLE IF EXISTS route_query_history_fp_v2")
            connection.execute("DROP INDEX IF EXISTS idx_route_session_cache_key")
            connection.execute("DROP TABLE IF EXISTS route_query_session_fp_v2")
            connection.execute("DROP INDEX IF EXISTS idx_route_page_query_id")
            connection.execute("DROP TABLE IF EXISTS route_query_page_fp_v1")
            connection.execute("DROP INDEX IF EXISTS idx_route_page_cache_key")
            connection.execute("DROP TABLE IF EXISTS route_query_page_cache_fp_v2")

    def sync_watermark(self, sync_name: str) -> str | None:
        with self._managed_connection() as connection:
            row = connection.execute(
                "SELECT last_create_time FROM route_sortie_sync_state_v1 WHERE sync_name = ?",
                (sync_name,),
            ).fetchone()
        return str(row[0]) if row else None

    def sync_coverage_start(self, sync_name: str) -> str | None:
        with self._managed_connection() as connection:
            row = connection.execute(
                "SELECT coverage_start_date FROM route_sortie_sync_state_v1 WHERE sync_name = ?",
                (sync_name,),
            ).fetchone()
        return str(row[0]) if row and row[0] else None

    def save_sync_state(self, sync_name: str, watermark: str, status: str, message: str = "", coverage_start_date: str = "") -> None:
        self._require_write()
        with self._managed_connection() as connection:
            connection.execute(
                """
                INSERT INTO route_sortie_sync_state_v1(sync_name, last_create_time, coverage_start_date, status, message, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(sync_name) DO UPDATE SET last_create_time=excluded.last_create_time,
                  coverage_start_date=CASE WHEN excluded.coverage_start_date <> '' THEN excluded.coverage_start_date ELSE coverage_start_date END,
                  status=excluded.status, message=excluded.message, updated_at=excluded.updated_at
                """,
                (sync_name, watermark, coverage_start_date, status, message[:500], int(time.time())),
            )

    def upsert_sortie_index(self, rows: list[tuple[Any, ...]]) -> None:
        if not rows:
            return
        self._require_write()
        now = int(time.time())
        with self._managed_connection() as connection:
            connection.executemany(
                """
                INSERT INTO route_sortie_index_fp_v1(
                  flight_date, fp_id, order_id, sn, model, enterprise_name,
                  first_time_stamp, last_time_stamp, start_lng, start_lat,
                  end_lng, end_lat, last_create_time, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(flight_date, fp_id) DO UPDATE SET
                  order_id=CASE WHEN excluded.order_id <> '' THEN excluded.order_id ELSE order_id END,
                  sn=CASE WHEN excluded.sn <> '' THEN excluded.sn ELSE sn END,
                  model=CASE WHEN excluded.model <> '' THEN excluded.model ELSE model END,
                  enterprise_name=CASE WHEN excluded.enterprise_name <> '' THEN excluded.enterprise_name ELSE enterprise_name END,
                  start_lng=CASE
                    WHEN excluded.first_time_stamp < first_time_stamp THEN excluded.start_lng
                    WHEN excluded.first_time_stamp = first_time_stamp AND start_lng IS NULL THEN excluded.start_lng
                    ELSE start_lng END,
                  start_lat=CASE
                    WHEN excluded.first_time_stamp < first_time_stamp THEN excluded.start_lat
                    WHEN excluded.first_time_stamp = first_time_stamp AND start_lat IS NULL THEN excluded.start_lat
                    ELSE start_lat END,
                  end_lng=CASE
                    WHEN excluded.last_time_stamp > last_time_stamp THEN excluded.end_lng
                    WHEN excluded.last_time_stamp = last_time_stamp AND end_lng IS NULL THEN excluded.end_lng
                    ELSE end_lng END,
                  end_lat=CASE
                    WHEN excluded.last_time_stamp > last_time_stamp THEN excluded.end_lat
                    WHEN excluded.last_time_stamp = last_time_stamp AND end_lat IS NULL THEN excluded.end_lat
                    ELSE end_lat END,
                  first_time_stamp=MIN(first_time_stamp, excluded.first_time_stamp),
                  last_time_stamp=MAX(last_time_stamp, excluded.last_time_stamp),
                  last_create_time=MAX(last_create_time, excluded.last_create_time),
                  updated_at=excluded.updated_at
                """,
                [(*row, now) for row in rows],
            )

    def index_page(self, start_date: str, end_date: str, query_type: str, query_value: str, model: str, after_fp_id: str, limit: int) -> list[str] | None:
        with self._managed_connection() as connection:
            state = connection.execute("SELECT coverage_start_date FROM route_sortie_sync_state_v1 LIMIT 1").fetchone()
            if state is None or not state[0] or start_date < str(state[0]):
                return None
            bounds = connection.execute("SELECT MIN(flight_date), MAX(flight_date) FROM route_sortie_index_fp_v1").fetchone()
            if not bounds or not bounds[0] or start_date < str(bounds[0]) or end_date > str(bounds[1]):
                return None
            filters = ["flight_date >= ?", "flight_date <= ?", "fp_id > ?"]
            params: list[object] = [start_date, end_date, after_fp_id]
            if model:
                filters.append("model = ?")
                params.append(model)
            if query_type == "order_id":
                filters.append("order_id = ?")
                params.append(query_value)
            elif query_type == "fp_id":
                filters.append("fp_id = ?")
                params.append(query_value)
            elif query_type == "enterprise" and query_value:
                filters.append("instr(enterprise_name, ?) > 0")
                params.append(query_value)
            params.append(limit)
            rows = connection.execute(
                f"SELECT fp_id FROM route_sortie_index_fp_v1 WHERE {' AND '.join(filters)} GROUP BY fp_id ORDER BY fp_id LIMIT ?",
                params,
            ).fetchall()
        return [str(row[0]) for row in rows]
