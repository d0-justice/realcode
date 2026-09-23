"""Flight-route plugin routes for paged sortie summaries and lazy-loaded tracks."""
from __future__ import annotations

import math
import logging
import os
import re
from time import perf_counter
from urllib.parse import parse_qs
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any, Callable, Literal

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field, model_validator

COORD_SCALE = 10_000_000.0
MAX_RANGE_DAYS = int(os.getenv("FLIGHT_API_MAX_RANGE_DAYS", "31"))
# List pages query only fp_id values and cache completed pages in SQLite. A natural-day
# slice keeps Doris aggregation bounded without multiplying a one-day request into four
# independent scans.
LIST_CHUNK_HOURS = min(24, max(1, int(os.getenv("FLIGHT_API_LIST_CHUNK_HOURS", "24"))))
MAX_TRACK_SOURCE_POINTS = int(os.getenv("FLIGHT_API_MAX_TRACK_SOURCE_POINTS", "20000"))
MAX_TRACK_RESPONSE_POINTS = int(os.getenv("FLIGHT_API_MAX_TRACK_RESPONSE_POINTS", "1000"))
SOURCE_TABLE = os.getenv("FLIGHT_API_SOURCE_TABLE", "t_flight_dynamic_report")
READ_TIMEOUT = int(os.getenv("FLIGHT_API_READ_TIMEOUT_SECONDS", "120"))
PAGE_SIZE = 50
logger = logging.getLogger(__name__)

if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", SOURCE_TABLE):
    raise RuntimeError("FLIGHT_API_SOURCE_TABLE is invalid")


class FlightQueryRequest(BaseModel):
    query_mode: Literal["enterprise", "order_id", "fp_id"] = "enterprise"
    model: str = Field(default="", max_length=120, description="Exact uav_model value")
    enterprise: str = Field(default="", max_length=180)
    order_id: str = Field(default="", max_length=180)
    fp_id: str = Field(default="", max_length=180)
    start: date
    end: date
    page: int = Field(default=1, ge=1)
    after_fp_id: str = Field(default="", max_length=180)

    @model_validator(mode="after")
    def validate_range(self) -> "FlightQueryRequest":
        if self.end < self.start:
            raise ValueError("end must be on or after start")
        if (self.end - self.start).days + 1 > MAX_RANGE_DAYS:
            raise ValueError(f"time range cannot exceed {MAX_RANGE_DAYS} days")
        if self.query_mode == "order_id" and not self.order_id.strip():
            raise ValueError("order_id is required")
        if self.query_mode == "fp_id" and not self.fp_id.strip():
            raise ValueError("fp_id is required")
        return self


class FlightTrackRequest(FlightQueryRequest):
    selected_fp_id: str = Field(min_length=1, max_length=180)


@dataclass(frozen=True)
class QueryContext:
    model: str
    start_ts: str
    end_ts: str
    query_type: str = ""
    query_value: str = ""


def _history() -> Any:
    try:
        return history
    except NameError as error:
        raise RuntimeError("flight-route history store is not configured") from error


def text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def valid_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number not in {-999999.0, -99999.9} else None


def timestamp_bounds(start: date, end: date) -> tuple[str, str]:
    start_dt = datetime.combine(start, time.min)
    end_dt = datetime.combine(end + timedelta(days=1), time.min)
    return start_dt.strftime("%Y%m%d%H%M%S"), end_dt.strftime("%Y%m%d%H%M%S")


def create_query_context(
    query_mode: str, model: str, enterprise: str, order_id: str, fp_id: str, start: date, end: date,
) -> QueryContext:
    if end < start or (end - start).days + 1 > MAX_RANGE_DAYS:
        raise ValueError(f"time range cannot exceed {MAX_RANGE_DAYS} days")
    start_ts, end_ts = timestamp_bounds(start, end)
    if query_mode == "enterprise":
        value = enterprise.strip()
        normalized_model = model.strip()
    if query_mode == "order_id":
        value = order_id.strip()
        normalized_model = ""
    elif query_mode == "fp_id":
        value = fp_id.strip()
        normalized_model = ""
    elif query_mode != "enterprise":
        raise ValueError("unsupported query mode")
    if query_mode != "enterprise" and not value:
        raise ValueError(f"{query_mode} is required")
    return QueryContext(
        model=normalized_model,
        start_ts=start_ts,
        end_ts=end_ts,
        query_type=query_mode,
        query_value=value,
    )


def time_chunks(start_ts: str, end_ts: str, hours: int = 6) -> list[tuple[str, str]]:
    current = datetime.strptime(start_ts, "%Y%m%d%H%M%S")
    end = datetime.strptime(end_ts, "%Y%m%d%H%M%S")
    result = []
    while current < end:
        next_value = min(current + timedelta(hours=hours), end)
        result.append((current.strftime("%Y%m%d%H%M%S"), next_value.strftime("%Y%m%d%H%M%S")))
        current = next_value
    return result


def duration_seconds(start_ts: str, end_ts: str) -> int:
    try:
        return max(0, int((datetime.strptime(end_ts, "%Y%m%d%H%M%S") - datetime.strptime(start_ts, "%Y%m%d%H%M%S")).total_seconds()))
    except ValueError:
        return 0


def parse_point(value: Any) -> tuple[float | None, float | None]:
    parts = str(value or "").split("|")
    if len(parts) != 3:
        return None, None
    lng, lat = valid_number(parts[1]), valid_number(parts[2])
    if lng is None or lat is None:
        return None, None
    lng, lat = lng / COORD_SCALE, lat / COORD_SCALE
    if not (109 <= lng <= 118 and 20 <= lat <= 26):
        return None, None
    return round(lng, 7), round(lat, 7)


class FlightRepository:
    def __init__(self, borrow_connection: Callable[[], Any]) -> None:
        self.borrow_connection = borrow_connection

    def index_day(self, day: date) -> list[dict[str, Any]]:
        """Read one natural day once and return compact per-sortie index rows."""
        start_ts, end_ts = timestamp_bounds(day, day)
        sql = f"""
          SELECT fp_id,
                 ANY_VALUE(order_id) AS order_id,
                 ANY_VALUE(upic_msn) AS sn,
                 ANY_VALUE(uav_model) AS model,
                 ANY_VALUE(JSON_EXTRACT_STRING(CAST(uav_auth_info AS JSON), '$.uavUnit.unitName')) AS enterprise,
                 MIN(time_stamp) AS started_at,
                 MAX(time_stamp) AS ended_at,
                 COUNT(*) AS point_count,
                 MAX(CASE WHEN height IS NULL OR height = -999999 THEN NULL ELSE height END) / 10.0 AS max_height_m,
                 MIN(CASE WHEN longitude IS NOT NULL AND latitude IS NOT NULL
                           AND longitude NOT IN (0, -10000000) AND latitude NOT IN (0, -10000000)
                          THEN CONCAT(time_stamp, '|', CAST(longitude AS STRING), '|', CAST(latitude AS STRING)) END) AS first_point,
                 MAX(CASE WHEN longitude IS NOT NULL AND latitude IS NOT NULL
                           AND longitude NOT IN (0, -10000000) AND latitude NOT IN (0, -10000000)
                          THEN CONCAT(time_stamp, '|', CAST(longitude AS STRING), '|', CAST(latitude AS STRING)) END) AS last_point
          FROM {SOURCE_TABLE}
          WHERE CHAR_LENGTH(TRIM(time_stamp)) = 14
            AND time_stamp >= %s AND time_stamp < %s
            AND time_stamp <> '19691231235959'
            AND fp_id IS NOT NULL AND fp_id <> ''
          GROUP BY fp_id
        """
        with self.borrow_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(sql, [start_ts, end_ts])
                rows = cursor.fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            fp_id = text(row[0])
            if not fp_id:
                continue
            start_lng, start_lat = parse_point(row[9])
            end_lng, end_lat = parse_point(row[10])
            result.append({
                "fp_id": fp_id, "order_id": text(row[1]), "sn": text(row[2]),
                "model": text(row[3]), "enterprise": text(row[4]),
                "started_at": text(row[5]), "ended_at": text(row[6]),
                "point_count": int(row[7] or 0), "max_height_m": valid_number(row[8]),
                "start_lng": start_lng, "start_lat": start_lat,
                "end_lng": end_lng, "end_lat": end_lat,
            })
        return result

    def sortie_page(self, model: str, start_ts: str, end_ts: str, query_type: str, query_value: str, after_fp_id: str) -> tuple[list[dict[str, Any]], str, bool]:
        """Return deduplicated sortie IDs; detailed data is loaded only for a selected track."""
        started = perf_counter()
        candidates: set[str] = set()
        chunks = time_chunks(start_ts, end_ts, hours=LIST_CHUNK_HOURS)
        with self.borrow_connection() as conn:
            for chunk_start, chunk_end in chunks:
                candidates.update(self._candidate_fp_ids(
                    conn, model, chunk_start, chunk_end, query_type, query_value, after_fp_id,
                ))
        ordered = sorted(candidates)
        selected = ordered[:PAGE_SIZE]
        has_next = len(ordered) > PAGE_SIZE
        logger.info(
            "flight-route list query type=%s chunks=%d candidates=%d elapsed_ms=%d",
            query_type or "all", len(chunks), len(candidates), int((perf_counter() - started) * 1000),
        )
        if not selected:
            return [], "", False
        return [{"fp_id": fp_id} for fp_id in selected], selected[-1], has_next

    def _filters(self, model: str, start_ts: str, end_ts: str, query_type: str, query_value: str) -> tuple[list[str], list[Any]]:
        filters = ["time_stamp >= %s", "time_stamp < %s", "fp_id IS NOT NULL", "fp_id <> ''"]
        params: list[Any] = [start_ts, end_ts]
        if model:
            filters.append("uav_model = %s")
            params.append(model)
        if query_type == "order_id":
            filters.append("order_id = %s")
            params.append(query_value)
        elif query_type == "fp_id":
            filters.append("fp_id = %s")
            params.append(query_value)
        elif query_type == "enterprise":
            if query_value:
                filters.append("uav_auth_info LIKE %s")
                params.append(f"%{query_value}%")
        elif query_type:
            raise ValueError("unsupported query type")
        return filters, params

    def _candidate_fp_ids(self, conn: Any, model: str, start_ts: str, end_ts: str, query_type: str, query_value: str, after_fp_id: str) -> list[str]:
        filters, params = self._filters(model, start_ts, end_ts, query_type, query_value)
        if after_fp_id:
            filters.append("fp_id > %s")
            params.append(after_fp_id)
        sql = f"""
          SELECT fp_id
          FROM {SOURCE_TABLE}
          WHERE {" AND ".join(filters)}
          GROUP BY fp_id
          ORDER BY fp_id
          LIMIT {PAGE_SIZE + 1}
        """
        with conn.cursor() as cursor:
            cursor.execute(sql, params)
            rows = cursor.fetchall()
        return [text(row[0]) for row in rows if text(row[0])]

    def _summary_chunk_for_fp_ids(self, model: str, start_ts: str, end_ts: str, query_type: str, query_value: str, fp_ids: list[str]) -> list[dict[str, Any]]:
        filters, params = self._filters(model, start_ts, end_ts, query_type, query_value)
        placeholders = ", ".join(["%s"] * len(fp_ids))
        filters.append(f"fp_id IN ({placeholders})")
        params.extend(fp_ids)
        sql = f"""
          SELECT fp_id, ANY_VALUE(upic_msn) AS sn, ANY_VALUE(uav_model) AS model,
                 MIN(time_stamp) AS started_at, MAX(time_stamp) AS ended_at, COUNT(*) AS point_count,
                 MAX(CASE WHEN height IS NULL OR height = -999999 THEN NULL ELSE height END) / 10.0 AS max_height_m,
                 MIN(CASE WHEN longitude IS NOT NULL AND latitude IS NOT NULL
                           AND longitude NOT IN (0, -10000000) AND latitude NOT IN (0, -10000000)
                          THEN CONCAT(time_stamp, '|', CAST(longitude AS STRING), '|', CAST(latitude AS STRING)) END) AS first_point,
                 MAX(CASE WHEN longitude IS NOT NULL AND latitude IS NOT NULL
                           AND longitude NOT IN (0, -10000000) AND latitude NOT IN (0, -10000000)
                          THEN CONCAT(time_stamp, '|', CAST(longitude AS STRING), '|', CAST(latitude AS STRING)) END) AS last_point
          FROM {SOURCE_TABLE}
          WHERE {" AND ".join(filters)}
          GROUP BY fp_id
        """
        with self.borrow_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(sql, params)
                rows = cursor.fetchall()
        return [{
            "fp_id": text(row[0]), "sn": text(row[1]), "model": text(row[2]), "started_at": text(row[3]), "ended_at": text(row[4]),
            "point_count": int(row[5] or 0), "max_height_m": valid_number(row[6]), "first_point": row[7], "last_point": row[8],
        } for row in rows if text(row[0])]

    def _result_rows(self, merged: dict[str, dict[str, Any]], model: str) -> list[dict[str, Any]]:
        result = []
        for row in merged.values():
            start_lng, start_lat = parse_point(row.pop("first_point"))
            end_lng, end_lat = parse_point(row.pop("last_point"))
            result.append({
                "fp_id": row["fp_id"], "sn": row["sn"], "model": row["model"] or model,
                "started_at": row["started_at"], "ended_at": row["ended_at"],
                "duration_seconds": duration_seconds(row["started_at"], row["ended_at"]),
                "point_count": row["point_count"], "max_height_m": row["max_height_m"],
                "start_lng": start_lng, "start_lat": start_lat, "end_lng": end_lng, "end_lat": end_lat,
            })
        return sorted(result, key=lambda item: item["fp_id"])

    def _summary_chunk(self, model: str, start_ts: str, end_ts: str, query_type: str, query_value: str) -> list[dict[str, Any]]:
        filters = ["CHAR_LENGTH(TRIM(time_stamp)) = 14", "time_stamp >= %s", "time_stamp < %s", "time_stamp <> '19691231235959'", "fp_id IS NOT NULL", "fp_id <> ''"]
        params: list[Any] = [start_ts, end_ts]
        if model:
            filters.append("uav_model = %s")
            params.append(model)
        if query_type == "order_id":
            filters.append("order_id = %s")
            params.append(query_value)
        elif query_type == "fp_id":
            filters.append("fp_id = %s")
            params.append(query_value)
        elif query_type == "enterprise":
            if query_value:
                filters.append("JSON_EXTRACT_STRING(CAST(uav_auth_info AS JSON), '$.uavUnit.unitName') = %s")
                params.append(query_value)
        elif query_type:
            raise ValueError("unsupported query type")
        sql = f"""
          SELECT fp_id, ANY_VALUE(upic_msn) AS sn, ANY_VALUE(uav_model) AS model,
                 MIN(time_stamp) AS started_at, MAX(time_stamp) AS ended_at, COUNT(*) AS point_count,
                 MAX(CASE WHEN height IS NULL OR height = -999999 THEN NULL ELSE height END) / 10.0 AS max_height_m,
                 MIN(CASE WHEN longitude IS NOT NULL AND latitude IS NOT NULL
                           AND longitude NOT IN (0, -10000000) AND latitude NOT IN (0, -10000000)
                          THEN CONCAT(time_stamp, '|', CAST(longitude AS STRING), '|', CAST(latitude AS STRING)) END) AS first_point,
                 MAX(CASE WHEN longitude IS NOT NULL AND latitude IS NOT NULL
                           AND longitude NOT IN (0, -10000000) AND latitude NOT IN (0, -10000000)
                          THEN CONCAT(time_stamp, '|', CAST(longitude AS STRING), '|', CAST(latitude AS STRING)) END) AS last_point
          FROM {SOURCE_TABLE}
          WHERE {" AND ".join(filters)}
          GROUP BY fp_id
        """
        with self.borrow_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(sql, params)
                rows = cursor.fetchall()
        return [{
            "fp_id": text(row[0]), "sn": text(row[1]), "model": text(row[2]), "started_at": text(row[3]), "ended_at": text(row[4]),
            "point_count": int(row[5] or 0), "max_height_m": valid_number(row[6]), "first_point": row[7], "last_point": row[8],
        } for row in rows if text(row[0])]

    def track(self, session: QueryContext, fp_id: str) -> dict[str, Any]:
        sql = f"""
          SELECT time_stamp, longitude / 10000000.0 AS lng, latitude / 10000000.0 AS lat,
                 coordinate, CASE WHEN height IS NULL OR height = -999999 THEN NULL ELSE height / 10.0 END AS height_m
          FROM {SOURCE_TABLE}
          WHERE time_stamp >= %s AND time_stamp < %s
            AND time_stamp <> '19691231235959'
            AND fp_id = %s
            {"AND uav_model = %s" if session.model else ""}
            {"AND order_id = %s" if session.query_type == "order_id" else ""}
            {"AND JSON_EXTRACT_STRING(CAST(uav_auth_info AS JSON), '$.uavUnit.unitName') LIKE %s" if session.query_type == "enterprise" and session.query_value else ""}
            AND longitude IS NOT NULL AND latitude IS NOT NULL
            AND longitude NOT IN (0, -10000000) AND latitude NOT IN (0, -10000000)
          ORDER BY time_stamp
          LIMIT {MAX_TRACK_SOURCE_POINTS + 1}
        """
        with self.borrow_connection() as conn:
            with conn.cursor() as cursor:
                params = [session.start_ts, session.end_ts, fp_id]
                if session.model:
                    params.append(session.model)
                if session.query_type == "order_id":
                    params.append(session.query_value)
                if session.query_type == "enterprise" and session.query_value:
                    params.append(f"%{session.query_value}%")
                cursor.execute(sql, params)
                rows = cursor.fetchall()
        truncated = len(rows) > MAX_TRACK_SOURCE_POINTS
        rows = rows[:MAX_TRACK_SOURCE_POINTS]
        points = []
        coordinates = set()
        for row in rows:
            lng, lat = valid_number(row[1]), valid_number(row[2])
            if lng is None or lat is None or not (109 <= lng <= 118 and 20 <= lat <= 26):
                continue
            coordinates.add(int(row[3]) if row[3] is not None else 0)
            points.append({"time_stamp": text(row[0]), "lng": round(lng, 7), "lat": round(lat, 7), "height_m": valid_number(row[4])})
        sampled = decimate(points, MAX_TRACK_RESPONSE_POINTS)
        coordinate = "WGS84" if coordinates == {1} else "CGCS2000" if coordinates == {2} else "UNKNOWN"
        return {"fp_id": fp_id, "coordinate": coordinate, "source_point_count": len(points), "response_point_count": len(sampled), "source_truncated": truncated, "points": sampled}


def decimate(points: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    if len(points) <= limit:
        return points
    # Preserve the first and last location while uniformly reducing browser payload size.
    indices = [round(index * (len(points) - 1) / (limit - 1)) for index in range(limit)]
    return [points[index] for index in indices]

repository: FlightRepository | None = None
router = APIRouter()
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))


def configure(history_store: Any, borrow_connection: Callable[[], Any]) -> None:
    global history, repository
    history = history_store
    repository = FlightRepository(borrow_connection)


def _repository() -> FlightRepository:
    if repository is None:
        raise RuntimeError("flight-route Doris repository is not configured")
    return repository


def list_page(session: QueryContext, after_fp_id: str) -> tuple[list[dict[str, Any]], bool, str]:
    after_fp_id = after_fp_id.strip()
    indexed = _history().index_page(
        session.start_ts[:8],
        (datetime.strptime(session.end_ts, "%Y%m%d%H%M%S") - timedelta(days=1)).strftime("%Y%m%d"),
        session.query_type,
        session.query_value,
        session.model,
        after_fp_id,
        PAGE_SIZE + 1,
    )
    if indexed is None:
        rows, next_fp_id, has_next = _repository().sortie_page(
            session.model, session.start_ts, session.end_ts, session.query_type, session.query_value, after_fp_id
        )
        return rows, has_next, next_fp_id
    selected = indexed[:PAGE_SIZE]
    return (
        [{"fp_id": fp_id} for fp_id in selected],
        len(indexed) > PAGE_SIZE,
        selected[-1] if selected else "",
    )


def render_flight_routes(
    request: Request, *, form: dict[str, str], session: QueryContext | None = None,
    sorties: list[dict[str, Any]] | None = None, error: str = "", page: int = 1,
    total: int | None = None, page_count: int = 1, has_next: bool = False
) -> HTMLResponse:
    sorties = sorties or []
    return templates.TemplateResponse(request, "flight_routes.html", {
        "form": form,
        "auto_submit": bool(form.get("auto_submit")),
        "query_ready": session is not None,
        "active_query": form if session else None,
        "sorties": sorties,
        "total": len(sorties) if total is None else total,
        "page": page,
        "page_count": page_count,
        "has_next": has_next,
        "error": error,
        "amap_jsapi_key": os.getenv("AMAP_JSAPI_KEY", ""),
        "amap_security_js_code": os.getenv("AMAP_SECURITY_JS_CODE", ""),
    })


@router.get("/flight-routes", response_class=HTMLResponse)
def flight_routes_page(request: Request) -> HTMLResponse:
    today = date.today().isoformat()
    query = request.query_params
    requested_mode = query.get("query_mode", "")
    if not requested_mode:
        requested_mode = "order_id" if query.get("order_id") else "fp_id" if query.get("fp_id") else "enterprise"
    identifier_start = (date.today() - timedelta(days=30)).isoformat()
    initial = {
        "query_mode": requested_mode,
        "order_id": query.get("order_id", ""),
        "fp_id": query.get("fp_id", ""),
        "enterprise": query.get("enterprise", ""),
        "model": query.get("model", ""),
        "start": query.get("start", identifier_start if requested_mode in {"order_id", "fp_id"} else today),
        "end": query.get("end", today),
    }
    if any(initial[key] for key in ("order_id", "fp_id", "enterprise", "model")) or query.get("query_mode") == "enterprise":
        initial["auto_submit"] = "1"
        return render_flight_routes(request, form=initial)
    initial.pop("auto_submit", None)
    return render_flight_routes(request, form=initial)


@router.post("/flight-routes/search", response_class=HTMLResponse)
async def flight_routes_search(request: Request) -> HTMLResponse:
    raw_form = parse_qs((await request.body()).decode("utf-8"), keep_blank_values=True)
    form = {key: values[-1].strip() if values else "" for key, values in raw_form.items()}
    try:
        mode = form.get("query_mode", "default")
        model = form.get("model", "")
        order_id = form.get("order_id", "")
        fp_id = form.get("fp_id", "")
        enterprise = form.get("enterprise", "")
        today = date.today()
        start = date.fromisoformat(form.get("start", "") or (today - timedelta(days=30)).isoformat())
        end = date.fromisoformat(form.get("end", "") or today.isoformat())
        session = create_query_context(mode, model, enterprise, order_id, fp_id, start, end)
        response_form = {"query_mode": mode, "order_id": order_id, "fp_id": fp_id, "enterprise": enterprise, "model": model, "start": start.isoformat(), "end": end.isoformat()}
        page_sorties, has_next, _ = list_page(session, "")
        return render_flight_routes(request, form=response_form, session=session, sorties=page_sorties, total=len(page_sorties), has_next=has_next)
    except (ValueError, TypeError) as error:
        return render_flight_routes(request, form=form, error=str(error))
    except Exception as error:
        logger.exception("flight-route search Doris query failed")
        detail = str(error).strip() if error else "unknown error"
        return render_flight_routes(request, form=form, error=f"Doris 查询失败：{type(error).__name__}: {detail[:240]}")


@router.post("/api/flight-queries", status_code=status.HTTP_201_CREATED)
def create_query(request: FlightQueryRequest) -> dict[str, Any]:
    try:
        session = create_query_context(
            request.query_mode, request.model, request.enterprise, request.order_id, request.fp_id,
            request.start, request.end,
        )
        sorties, has_next, next_fp_id = list_page(session, request.after_fp_id)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Doris query is unavailable") from error
    return {"page": request.page, "page_size": PAGE_SIZE, "items": sorties, "has_next": has_next, "next_fp_id": next_fp_id}


@router.post("/api/flight-queries/track")
def get_track(request: FlightTrackRequest) -> dict[str, Any]:
    try:
        session = create_query_context(
            request.query_mode, request.model, request.enterprise, request.order_id, request.fp_id,
            request.start, request.end,
        )
        return _repository().track(session, request.selected_fp_id.strip())
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Doris track query is unavailable") from error
