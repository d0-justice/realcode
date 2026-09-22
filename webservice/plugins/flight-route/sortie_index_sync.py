"""Daily create_time incremental sync for the flight-route SQLite sortie index."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta
from typing import Any, Callable


SYNC_NAME = "flight_route_sortie_index"
SOURCE_TABLE = os.getenv("FLIGHT_API_SOURCE_TABLE", "t_flight_dynamic_report")
BOOTSTRAP_DAYS = int(os.getenv("FLIGHT_ROUTE_INDEX_BOOTSTRAP_DAYS", "2"))
CHUNK_HOURS = int(os.getenv("FLIGHT_ROUTE_INDEX_SYNC_CHUNK_HOURS", "1"))
DATETIME_FORMAT = "%Y-%m-%d %H:%M:%S"
COORD_SCALE = 10_000_000.0

if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", SOURCE_TABLE):
    raise RuntimeError("FLIGHT_API_SOURCE_TABLE is invalid")
if BOOTSTRAP_DAYS < 1 or CHUNK_HOURS < 1:
    raise RuntimeError("flight-route index sync intervals must be positive")


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _enterprise(value: Any) -> str:
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="ignore")
    if isinstance(value, str):
        if "|" in value:
            value = value.split("|", 1)[1]
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return ""
    if not isinstance(value, dict):
        return ""
    unit = value.get("uavUnit")
    return _text(unit.get("unitName")) if isinstance(unit, dict) else ""


def _point(value: Any) -> tuple[float | None, float | None]:
    parts = _text(value).split("|")
    if len(parts) != 3:
        return None, None
    try:
        lng, lat = float(parts[1]) / COORD_SCALE, float(parts[2]) / COORD_SCALE
    except (TypeError, ValueError):
        return None, None
    if not (109 <= lng <= 118 and 20 <= lat <= 26):
        return None, None
    return round(lng, 7), round(lat, 7)


class SortieIndexSyncJob:
    def __init__(self, history_store: Any, borrow_connection: Callable[[], Any]) -> None:
        self.history_store = history_store
        self.borrow_connection = borrow_connection

    def run(self) -> None:
        stored = self.history_store.sync_watermark(SYNC_NAME)
        watermark = stored or ""
        coverage_start_date = self.history_store.sync_coverage_start(SYNC_NAME) or ""
        try:
            with self.borrow_connection() as connection:
                cutoff = self._database_now(connection)
                start = datetime.strptime(stored, DATETIME_FORMAT) if stored else cutoff - timedelta(days=BOOTSTRAP_DAYS)
                coverage_start_date = coverage_start_date or start.strftime("%Y%m%d")
                watermark = start.strftime(DATETIME_FORMAT)
                self.history_store.save_sync_state(SYNC_NAME, watermark, "running", coverage_start_date=coverage_start_date)
                current = start
                while current < cutoff:
                    chunk_end = min(current + timedelta(hours=CHUNK_HOURS), cutoff)
                    rows = self._fetch_chunk(connection, current, chunk_end)
                    self.history_store.upsert_sortie_index(rows)
                    current = chunk_end
            self.history_store.save_sync_state(SYNC_NAME, cutoff.strftime(DATETIME_FORMAT), "success", coverage_start_date=coverage_start_date)
        except Exception as error:
            if watermark:
                self.history_store.save_sync_state(SYNC_NAME, watermark, "failed", f"{type(error).__name__}: {error}", coverage_start_date)
            raise

    @staticmethod
    def _database_now(connection: Any) -> datetime:
        with connection.cursor() as cursor:
            cursor.execute("SELECT NOW()")
            row = cursor.fetchone()
        value = row[0] if row else None
        if isinstance(value, datetime):
            return value.replace(microsecond=0)
        return datetime.strptime(_text(value).split(".", 1)[0], DATETIME_FORMAT)

    def _fetch_chunk(self, connection: Any, start: datetime, end: datetime) -> list[tuple[Any, ...]]:
        sql = f"""
          SELECT LEFT(time_stamp, 8) AS flight_date,
                 fp_id,
                 ANY_VALUE(order_id) AS order_id,
                 ANY_VALUE(upic_msn) AS sn,
                 ANY_VALUE(uav_model) AS model,
                 MAX(CASE
                   WHEN uav_auth_info IS NOT NULL AND LENGTH(TRIM(CAST(uav_auth_info AS STRING))) > 2
                   THEN CONCAT(CAST(create_time AS STRING), '|', CAST(uav_auth_info AS STRING))
                 END) AS latest_uav_auth_info,
                 MIN(time_stamp) AS first_time_stamp,
                 MAX(time_stamp) AS last_time_stamp,
                 MIN(CONCAT(time_stamp, '|', COALESCE(CAST(longitude AS STRING), ''), '|', COALESCE(CAST(latitude AS STRING), ''))) AS first_point,
                 MAX(CONCAT(time_stamp, '|', COALESCE(CAST(longitude AS STRING), ''), '|', COALESCE(CAST(latitude AS STRING), ''))) AS last_point,
                 MAX(create_time) AS last_create_time
          FROM {SOURCE_TABLE}
          WHERE create_time >= %s AND create_time < %s
            AND time_stamp <> '19691231235959'
            AND fp_id IS NOT NULL AND fp_id <> ''
          GROUP BY LEFT(time_stamp, 8), fp_id
        """
        with connection.cursor() as cursor:
            cursor.execute(sql, (start, end))
            source_rows = cursor.fetchall()
        result = []
        for row in source_rows:
            flight_date, fp_id = _text(row[0]), _text(row[1])
            if len(flight_date) != 8 or not flight_date.isdigit() or not fp_id:
                continue
            start_lng, start_lat = _point(row[8])
            end_lng, end_lat = _point(row[9])
            create_time = row[10].strftime(DATETIME_FORMAT) if hasattr(row[10], "strftime") else _text(row[10])
            result.append((
                flight_date, fp_id, _text(row[2]), _text(row[3]), _text(row[4]), _enterprise(row[5]),
                _text(row[6]), _text(row[7]), start_lng, start_lat, end_lng, end_lat, create_time,
            ))
        return result
