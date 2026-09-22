"""Static high-altitude flight report publishing and calendar viewing routes."""

from __future__ import annotations

import calendar
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
_report_dir: Path | None = None
REPORT_FILE_RE = re.compile(r"^high_altitude_daily_(\d{8})\.html$")
RANGE_REPORT_FILE_RE = re.compile(r"^high_altitude_range_(\d{8}-\d{8})\.html$")
MAX_REPORT_BYTES = 25 * 1024 * 1024


def configure(public_base_url: str, report_dir: Path) -> None:
    global _public_base_url, _report_dir
    normalized_base_url = public_base_url.rstrip("/")
    if not normalized_base_url:
        raise RuntimeError("PUBLIC_BASE_URL must be configured for high-altitude browser URLs")
    _public_base_url = normalized_base_url
    _report_dir = report_dir.resolve()


def _public_url(path: str) -> str:
    if _public_base_url is None:
        raise RuntimeError("PUBLIC_BASE_URL is not configured")
    return f"{_public_base_url}{path}"


def _day_key(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) != 8:
        raise ValueError("report date must be YYYYMMDD or YYYY-MM-DD")
    datetime.strptime(digits, "%Y%m%d")
    return digits


def _path(day: str) -> Path:
    if _report_dir is None:
        raise RuntimeError("high-altitude report directory is not configured")
    return _report_dir / f"high_altitude_daily_{_day_key(day)}.html"


def _range_key(value: str) -> str:
    match = re.fullmatch(r"(\d{8})-(\d{8})", value or "")
    if match is None:
        raise ValueError("range key must be YYYYMMDD-YYYYMMDD")
    start, end = _day_key(match.group(1)), _day_key(match.group(2))
    if end < start:
        raise ValueError("range end must not be before start")
    return f"{start}-{end}"


def _range_path(range_key: str) -> Path:
    if _report_dir is None:
        raise RuntimeError("high-altitude report directory is not configured")
    return _report_dir / f"high_altitude_range_{_range_key(range_key)}.html"


def _reports() -> dict[str, Path]:
    if _report_dir is None or not _report_dir.is_dir():
        return {}
    result: dict[str, Path] = {}
    for path in _report_dir.iterdir():
        match = REPORT_FILE_RE.fullmatch(path.name)
        if match and path.is_file():
            result[match.group(1)] = path
    return result


def _topic_page(requested_day: str | None) -> str:
    reports = _reports()
    selected_day = requested_day if requested_day in reports else max(reports, default="")
    visible_months = {f"{day[:4]}-{day[4:6]}" for day in reports}
    if requested_day:
        visible_months.add(f"{requested_day[:4]}-{requested_day[4:6]}")
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
                    "ready": day in reports,
                    "url": f"/flight-reports/static/high-altitude-daily/{day}",
                })
            weeks.append(days)
        months.append({"year": current.year, "month": current.month, "weeks": weeks})
    initial_url = (
        f"/flight-reports/static/high-altitude-daily/{selected_day}"
        if selected_day else "about:blank"
    )
    return TEMPLATES.get_template("high_altitude_topic.html").render(
        months=months,
        selected_day=selected_day,
        initial_url=initial_url,
        weekdays=("一", "二", "三", "四", "五", "六", "日"),
    )


def _error(error: Exception) -> HTTPException:
    if isinstance(error, ValueError):
        return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error))
    if isinstance(error, FileNotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="high-altitude report was not published")
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error))


@router.get("/high-altitude-topic", response_class=HTMLResponse)
def high_altitude_topic(day: str | None = None) -> HTMLResponse:
    try:
        return HTMLResponse(_topic_page(_day_key(day) if day else None))
    except Exception as error:
        raise _error(error) from error


@router.get("/static/high-altitude-daily/{report_date}")
def static_report(report_date: str):
    try:
        path = _path(report_date)
        if not path.is_file():
            raise FileNotFoundError(path)
        return FileResponse(path, media_type="text/html; charset=utf-8")
    except Exception as error:
        raise _error(error) from error


@router.get("/static/high-altitude-range/{range_key}")
def static_range_report(range_key: str):
    try:
        path = _range_path(range_key)
        if not path.is_file():
            raise FileNotFoundError(path)
        return FileResponse(path, media_type="text/html; charset=utf-8")
    except Exception as error:
        raise _error(error) from error


@router.put("/api/high-altitude-daily/{report_date}", status_code=status.HTTP_201_CREATED)
async def publish_report(report_date: str, request: Request) -> dict[str, str]:
    try:
        day = _day_key(report_date)
        content = await request.body()
        if not content or len(content) > MAX_REPORT_BYTES:
            raise ValueError(f"report HTML must be between 1 and {MAX_REPORT_BYTES} bytes")
        decoded = content.decode("utf-8")
        if "<html" not in decoded.lower() or "</html>" not in decoded.lower():
            raise ValueError("report body must be a complete HTML document")
        path = _path(day)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".html.tmp")
        temporary.write_bytes(content)
        temporary.replace(path)
        static_path = f"/flight-reports/static/high-altitude-daily/{day}"
        topic_path = f"/flight-reports/high-altitude-topic?day={day}"
        return {
            "report_date": day,
            "report_url": _public_url(static_path),
            "topic_url": _public_url(topic_path),
        }
    except Exception as error:
        raise _error(error) from error


@router.put("/api/high-altitude-range/{range_key}", status_code=status.HTTP_201_CREATED)
async def publish_range_report(range_key: str, request: Request) -> dict[str, str]:
    try:
        key = _range_key(range_key)
        content = await request.body()
        if not content or len(content) > MAX_REPORT_BYTES:
            raise ValueError(f"report HTML must be between 1 and {MAX_REPORT_BYTES} bytes")
        decoded = content.decode("utf-8")
        if "<html" not in decoded.lower() or "</html>" not in decoded.lower():
            raise ValueError("report body must be a complete HTML document")
        path = _range_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".html.tmp")
        temporary.write_bytes(content)
        temporary.replace(path)
        static_path = f"/flight-reports/static/high-altitude-range/{key}"
        return {"range_key": key, "report_url": _public_url(static_path)}
    except Exception as error:
        raise _error(error) from error
