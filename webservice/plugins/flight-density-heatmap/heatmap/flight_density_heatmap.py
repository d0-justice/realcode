"""Static Guangdong daily flight-density heatmap publishing and viewing routes."""

from __future__ import annotations

import calendar
import gzip
import json
import re
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import FileResponse, HTMLResponse
from jinja2 import Environment, FileSystemLoader, select_autoescape


router = APIRouter()
MODULE_DIR = Path(__file__).resolve().parent
TEMPLATES = Environment(
    loader=FileSystemLoader(MODULE_DIR / "templates"),
    autoescape=select_autoescape(["html", "xml"]),
    auto_reload=False,
)
_public_base_url: str | None = None
_map_dir: Path | None = None
ADMIN_ASSETS_DIR = MODULE_DIR.parent / "assets" / "admin-layers"
ADMIN_BASE_FILE = ADMIN_ASSETS_DIR / "base.json"
MAP_FILE_RE = re.compile(r"^guangdong_daily_(\d{8})\.html$")
MONTHLY_MAP_FILE_RE = re.compile(r"^guangdong_monthly_(\d{6})\.html$")
RANGE_MAP_FILE_RE = re.compile(r"^guangdong_range_(\d{8}-\d{8})\.html$")
MAX_MAP_BYTES = 120 * 1024 * 1024
MAX_ADMIN_LAYERS_BYTES = 8 * 1024 * 1024


def configure(public_base_url: str, map_dir: Path) -> None:
    global _public_base_url, _map_dir
    normalized_base_url = public_base_url.rstrip("/")
    if not normalized_base_url:
        raise RuntimeError("PUBLIC_BASE_URL must be configured for flight-density-heatmap browser URLs")
    _public_base_url = normalized_base_url
    _map_dir = map_dir.resolve()


def _public_url(path: str) -> str:
    if _public_base_url is None:
        raise RuntimeError("PUBLIC_BASE_URL is not configured")
    return f"{_public_base_url}{path}"


def _day_key(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) != 8:
        raise ValueError("map date must be YYYYMMDD or YYYY-MM-DD")
    datetime.strptime(digits, "%Y%m%d")
    return digits


def _path(day: str) -> Path:
    if _map_dir is None:
        raise RuntimeError("heatmap directory is not configured")
    return _map_dir / f"guangdong_daily_{_day_key(day)}.html"


def _month_key(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) != 6:
        raise ValueError("map month must be YYYYMM or YYYY-MM")
    datetime.strptime(digits, "%Y%m")
    return digits


def _monthly_path(month: str) -> Path:
    if _map_dir is None:
        raise RuntimeError("heatmap directory is not configured")
    return _map_dir / f"guangdong_monthly_{_month_key(month)}.html"


def _range_key(value: str) -> str:
    match = re.fullmatch(r"(\d{8})-(\d{8})", value or "")
    if match is None:
        raise ValueError("range key must be YYYYMMDD-YYYYMMDD")
    start, end = _day_key(match.group(1)), _day_key(match.group(2))
    if end < start:
        raise ValueError("range end must not be before start")
    return f"{start}-{end}"


def _range_path(range_key: str) -> Path:
    if _map_dir is None:
        raise RuntimeError("heatmap directory is not configured")
    return _map_dir / f"guangdong_range_{_range_key(range_key)}.html"


def _maps() -> dict[str, Path]:
    if _map_dir is None or not _map_dir.is_dir():
        return {}
    result: dict[str, Path] = {}
    for path in _map_dir.iterdir():
        match = MAP_FILE_RE.fullmatch(path.name)
        if match and path.is_file():
            result[match.group(1)] = path
    return result


def _monthly_maps() -> dict[str, Path]:
    if _map_dir is None or not _map_dir.is_dir():
        return {}
    result: dict[str, Path] = {}
    for path in _map_dir.iterdir():
        match = MONTHLY_MAP_FILE_RE.fullmatch(path.name)
        if match and path.is_file():
            result[match.group(1)] = path
    return result


def _topic_page(requested_day: str | None, requested_month: str | None) -> str:
    maps = _maps()
    monthly_maps = _monthly_maps()
    selected_month = requested_month if requested_month in monthly_maps else ""
    selected_day = "" if selected_month else (requested_day if requested_day in maps else max(maps, default=""))
    visible_months = (
        {f"{day[:4]}-{day[4:6]}" for day in maps}
        | {f"{month[:4]}-{month[4:6]}" for month in monthly_maps}
    )
    if requested_day:
        visible_months.add(f"{requested_day[:4]}-{requested_day[4:6]}")
    if requested_month:
        visible_months.add(f"{requested_month[:4]}-{requested_month[4:6]}")
    months = []
    for month in sorted(visible_months, reverse=True):
        current = datetime.strptime(month, "%Y-%m")
        weeks = []
        for week in calendar.monthcalendar(current.year, current.month):
            days = []
            for number in week:
                if not number:
                    days.append(None)
                    continue
                day = f"{current:%Y%m}{number:02d}"
                days.append({
                    "number": number,
                    "day": day,
                    "ready": day in maps,
                    "url": f"/flight-density-heatmaps/static/guangdong-daily/{day}",
                })
            weeks.append(days)
        month_key = f"{current:%Y%m}"
        months.append({
            "year": current.year,
            "month": current.month,
            "weeks": weeks,
            "month_key": month_key,
            "monthly_ready": month_key in monthly_maps,
            "monthly_url": f"/flight-density-heatmaps/static/guangdong-monthly/{month_key}",
        })
    initial_url = "about:blank"
    if selected_month:
        initial_url = f"/flight-density-heatmaps/static/guangdong-monthly/{selected_month}"
    elif selected_day:
        initial_url = f"/flight-density-heatmaps/static/guangdong-daily/{selected_day}"
    return TEMPLATES.get_template("flight_density_topic.html").render(
        months=months,
        selected_day=selected_day,
        selected_month=selected_month,
        initial_url=initial_url,
        weekdays=("一", "二", "三", "四", "五", "六", "日"),
    )


def _error(error: Exception) -> HTTPException:
    if isinstance(error, ValueError):
        return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error))
    if isinstance(error, FileNotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="daily heatmap was not published")
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error))


async def _publish_html_body(request: Request) -> bytes:
    content = await request.body()
    if request.headers.get("content-encoding", "").lower().strip() == "gzip":
        try:
            content = gzip.decompress(content)
        except OSError as error:
            raise ValueError("gzip heatmap body is invalid") from error
    if not content or len(content) > MAX_MAP_BYTES:
        raise ValueError(f"heatmap HTML must be between 1 and {MAX_MAP_BYTES} bytes")
    return content


@router.get("/", response_class=HTMLResponse)
@router.get("/topic", response_class=HTMLResponse)
def heatmap_topic(day: str | None = None, month: str | None = None) -> HTMLResponse:
    try:
        return HTMLResponse(_topic_page(
            _day_key(day) if day else None,
            _month_key(month) if month else None,
        ))
    except Exception as error:
        raise _error(error) from error


@router.get("/static/guangdong-daily/{map_date}")
def static_heatmap(map_date: str):
    try:
        path = _path(map_date)
        if not path.is_file():
            raise FileNotFoundError(path)
        return FileResponse(path, media_type="text/html; charset=utf-8")
    except Exception as error:
        raise _error(error) from error


@router.get("/static/guangdong-monthly/{map_month}")
def static_monthly_heatmap(map_month: str):
    try:
        path = _monthly_path(map_month)
        if not path.is_file():
            raise FileNotFoundError(path)
        return FileResponse(path, media_type="text/html; charset=utf-8")
    except Exception as error:
        raise _error(error) from error


@router.get("/static/guangdong-range/{range_key}")
def static_range_heatmap(range_key: str):
    try:
        path = _range_path(range_key)
        if not path.is_file():
            raise FileNotFoundError(path)
        return FileResponse(path, media_type="text/html; charset=utf-8")
    except Exception as error:
        raise _error(error) from error


@router.get("/assets/admin-layers/base")
def admin_layers_base_asset():
    if not ADMIN_BASE_FILE.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="admin boundary asset was not published")
    return FileResponse(
        ADMIN_BASE_FILE,
        media_type="application/json; charset=utf-8",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/assets/admin-layers/cities/{city_adcode}")
def admin_layers_city_asset(city_adcode: str):
    if not re.fullmatch(r"\d{6}", city_adcode):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="city adcode is invalid")
    path = ADMIN_ASSETS_DIR / "cities" / f"{city_adcode}.json"
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="city admin boundary asset was not published")
    return FileResponse(
        path,
        media_type="application/json; charset=utf-8",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.put("/api/guangdong-daily/{map_date}", status_code=status.HTTP_201_CREATED)
async def publish_heatmap(map_date: str, request: Request) -> dict[str, str]:
    try:
        day = _day_key(map_date)
        content = await _publish_html_body(request)
        decoded = content.decode("utf-8")
        if "<html" not in decoded.lower() or "</html>" not in decoded.lower():
            raise ValueError("heatmap body must be a complete HTML document")
        path = _path(day)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".html.tmp")
        temporary.write_bytes(content)
        temporary.replace(path)
        static_path = f"/flight-density-heatmaps/static/guangdong-daily/{day}"
        topic_path = f"/flight-density-heatmaps/topic?day={day}"
        return {
            "map_date": day,
            "map_url": _public_url(static_path),
            "topic_url": _public_url(topic_path),
        }
    except Exception as error:
        raise _error(error) from error


@router.put("/api/guangdong-monthly/{map_month}", status_code=status.HTTP_201_CREATED)
async def publish_monthly_heatmap(map_month: str, request: Request) -> dict[str, str]:
    try:
        month = _month_key(map_month)
        content = await _publish_html_body(request)
        decoded = content.decode("utf-8")
        if "<html" not in decoded.lower() or "</html>" not in decoded.lower():
            raise ValueError("heatmap body must be a complete HTML document")
        path = _monthly_path(month)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".html.tmp")
        temporary.write_bytes(content)
        temporary.replace(path)
        static_path = f"/flight-density-heatmaps/static/guangdong-monthly/{month}"
        topic_path = f"/flight-density-heatmaps/topic?month={month}"
        return {
            "map_month": month,
            "map_url": _public_url(static_path),
            "topic_url": _public_url(topic_path),
        }
    except Exception as error:
        raise _error(error) from error


@router.put("/api/guangdong-range/{range_key}", status_code=status.HTTP_201_CREATED)
async def publish_range_heatmap(range_key: str, request: Request) -> dict[str, str]:
    try:
        key = _range_key(range_key)
        content = await _publish_html_body(request)
        decoded = content.decode("utf-8")
        if "<html" not in decoded.lower() or "</html>" not in decoded.lower():
            raise ValueError("heatmap body must be a complete HTML document")
        path = _range_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".html.tmp")
        temporary.write_bytes(content)
        temporary.replace(path)
        static_path = f"/flight-density-heatmaps/static/guangdong-range/{key}"
        return {"range_key": key, "map_url": _public_url(static_path)}
    except Exception as error:
        raise _error(error) from error


@router.put("/api/admin-layers", status_code=status.HTTP_201_CREATED)
async def publish_admin_layers(request: Request) -> dict[str, str]:
    try:
        content = await request.body()
        if not content or len(content) > MAX_ADMIN_LAYERS_BYTES:
            raise ValueError(f"admin boundary JSON must be between 1 and {MAX_ADMIN_LAYERS_BYTES} bytes")
        payload = json.loads(content.decode("utf-8"))
        if not isinstance(payload, dict) or not payload.get("base_chunk") or not isinstance(payload.get("chunks"), dict):
            raise ValueError("admin boundary JSON is invalid")
        ADMIN_ASSETS_DIR.mkdir(parents=True, exist_ok=True)
        chunks = payload.pop("chunks")
        base_content = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        temporary = ADMIN_BASE_FILE.with_suffix(".json.tmp")
        temporary.write_bytes(base_content)
        temporary.replace(ADMIN_BASE_FILE)
        city_dir = ADMIN_ASSETS_DIR / "cities"
        city_dir.mkdir(parents=True, exist_ok=True)
        for adcode, chunk in chunks.items():
            if not re.fullmatch(r"\d{6}", str(adcode)) or not isinstance(chunk, str):
                raise ValueError("admin boundary city chunk is invalid")
            path = city_dir / f"{adcode}.json"
            city_content = json.dumps({"adcode": adcode, "chunk": chunk}, separators=(",", ":")).encode("utf-8")
            city_temporary = path.with_suffix(".json.tmp")
            city_temporary.write_bytes(city_content)
            city_temporary.replace(path)
        return {
            "asset_url": _public_url("/flight-density-heatmaps/assets/admin-layers/base"),
            "source_digest": str(payload.get("source_digest") or ""),
        }
    except Exception as error:
        raise _error(error) from error
