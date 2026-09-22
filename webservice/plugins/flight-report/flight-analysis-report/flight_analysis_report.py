"""Static Guangdong daily flight report publishing and viewing routes."""

from __future__ import annotations

import calendar
import re
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
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
REPORT_FILE_RE = re.compile(r"^guangdong_daily_(\d{8})\.html$")
MONTHLY_REPORT_FILE_RE = re.compile(r"^guangdong_monthly_(\d{6})\.html$")
MAX_REPORT_BYTES = 15 * 1024 * 1024


def configure(public_base_url: str, report_dir: Path) -> None:
    global _public_base_url, _report_dir
    normalized_base_url = public_base_url.rstrip("/")
    if not normalized_base_url:
        raise RuntimeError("PUBLIC_BASE_URL must be configured for flight-report browser URLs")
    _public_base_url = normalized_base_url
    _report_dir = report_dir.resolve()


def _public_url(path: str) -> str:
    if _public_base_url is None:
        raise RuntimeError("PUBLIC_BASE_URL is not configured")
    return f"{_public_base_url}{path}"


def _topic_url(day: str | None = None, month: str | None = None) -> str:
    query = f"?month={month}" if month else f"?day={day}" if day else ""
    return _public_url(f"/flight-reports/flight-analysis-topic{query}")


def _report_url(path: str) -> str:
    """Keep topic-page child iframes on the origin that served the topic page."""
    return path


def _day_key(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) != 8:
        raise ValueError("report date must be YYYYMMDD or YYYY-MM-DD")
    datetime.strptime(digits, "%Y%m%d")
    return digits


def _path(day: str) -> Path:
    if _report_dir is None:
        raise RuntimeError("daily report directory is not configured")
    return _report_dir / f"guangdong_daily_{_day_key(day)}.html"


def _month_key(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) != 6:
        raise ValueError("report month must be YYYYMM or YYYY-MM")
    datetime.strptime(digits, "%Y%m")
    return digits


def _monthly_path(month: str) -> Path:
    if _report_dir is None:
        raise RuntimeError("daily report directory is not configured")
    return _report_dir / f"guangdong_monthly_{_month_key(month)}.html"


def _report_days() -> dict[str, Path]:
    if _report_dir is None or not _report_dir.is_dir():
        return {}
    reports: dict[str, Path] = {}
    for path in _report_dir.iterdir():
        match = REPORT_FILE_RE.fullmatch(path.name)
        if match and path.is_file():
            reports[match.group(1)] = path
    return reports


def _report_months() -> dict[str, Path]:
    if _report_dir is None or not _report_dir.is_dir():
        return {}
    reports: dict[str, Path] = {}
    for path in _report_dir.iterdir():
        match = MONTHLY_REPORT_FILE_RE.fullmatch(path.name)
        if match and path.is_file():
            reports[match.group(1)] = path
    return reports


def _topic_page(requested_day: str | None = None, requested_month: str | None = None) -> str:
    reports = _report_days()
    monthly_reports = _report_months()
    selected_month = requested_month if requested_month in monthly_reports else ""
    unavailable_month = requested_month if requested_month and requested_month not in monthly_reports else ""
    selected_day = "" if selected_month else (requested_day if requested_day in reports else max(reports, default=""))
    initial_url = "about:blank"
    if selected_month:
        initial_url = _report_url(f"/flight-reports/static/guangdong-monthly/{selected_month}")
    elif selected_day:
        initial_url = _report_url(f"/flight-reports/static/guangdong-daily/{selected_day}")
    months = []
    available_months = {f"{day[:4]}-{day[4:6]}" for day in reports} | {f"{month[:4]}-{month[4:6]}" for month in monthly_reports}
    if unavailable_month:
        available_months.add(f"{unavailable_month[:4]}-{unavailable_month[4:6]}")
    for month in sorted(available_months, reverse=True):
        current = datetime.strptime(month, "%Y-%m")
        weeks = []
        for week in calendar.monthcalendar(current.year, current.month):
            days = []
            for number in week:
                if not number:
                    days.append(None)
                    continue
                day = f"{current:%Y%m}{number:02d}"
                days.append({"number": number, "day": day, "ready": day in reports, "url": _report_url(f"/flight-reports/static/guangdong-daily/{day}")})
            weeks.append(days)
        month_key = f"{current:%Y%m}"
        months.append({
            "year": current.year,
            "month": current.month,
            "weeks": weeks,
            "monthly_ready": month_key in monthly_reports,
            "monthly_url": _report_url(f"/flight-reports/static/guangdong-monthly/{month_key}"),
            "month_key": month_key,
        })
    return TEMPLATES.get_template("flight_analysis_topic.html").render(
        months=months,
        selected_day=selected_day,
        selected_month=selected_month,
        unavailable_month=unavailable_month,
        initial_url=initial_url,
        weekdays=("一", "二", "三", "四", "五", "六", "日"),
    )


def _error(error: Exception) -> HTTPException:
    if isinstance(error, ValueError):
        return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error))
    if isinstance(error, FileNotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="daily report was not published")
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error))


@router.get("/", response_class=HTMLResponse)
@router.get("/flight-analysis-topic", response_class=HTMLResponse)
def flight_analysis_topic(day: str | None = None, month: str | None = None) -> HTMLResponse:
    try:
        requested_day = _day_key(day) if day else None
        requested_month = _month_key(month) if month else None
        return HTMLResponse(_topic_page(requested_day, requested_month))
    except Exception as error:
        raise _error(error) from error


@router.get("/daily-topic", include_in_schema=False)
def legacy_daily_topic(day: str | None = None, month: str | None = None) -> RedirectResponse:
    return RedirectResponse(url=_topic_url(day=day, month=month), status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@router.get("/static/guangdong-daily/{report_date}")
def static_report(report_date: str):
    try:
        path = _path(report_date)
        if not path.is_file():
            raise FileNotFoundError(path)
        return FileResponse(path, media_type="text/html; charset=utf-8")
    except Exception as error:
        raise _error(error) from error


@router.get("/static/guangdong-monthly/{report_month}")
def static_monthly_report(report_month: str):
    try:
        path = _monthly_path(report_month)
        if not path.is_file():
            raise FileNotFoundError(path)
        return FileResponse(path, media_type="text/html; charset=utf-8")
    except Exception as error:
        raise _error(error) from error


@router.put("/api/guangdong-daily/{report_date}", status_code=status.HTTP_201_CREATED)
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
        return {
            "report_date": day,
            "report_url": _public_url(f"/flight-reports/static/guangdong-daily/{day}"),
            "topic_url": _topic_url(day=day),
        }
    except Exception as error:
        raise _error(error) from error


@router.put("/api/guangdong-monthly/{report_month}", status_code=status.HTTP_201_CREATED)
async def publish_monthly_report(report_month: str, request: Request) -> dict[str, str]:
    try:
        month = _month_key(report_month)
        content = await request.body()
        if not content or len(content) > MAX_REPORT_BYTES:
            raise ValueError(f"report HTML must be between 1 and {MAX_REPORT_BYTES} bytes")
        decoded = content.decode("utf-8")
        if "<html" not in decoded.lower() or "</html>" not in decoded.lower():
            raise ValueError("report body must be a complete HTML document")
        path = _monthly_path(month)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".html.tmp")
        temporary.write_bytes(content)
        temporary.replace(path)
        return {
            "report_month": month,
            "report_url": _public_url(f"/flight-reports/static/guangdong-monthly/{month}"),
            "topic_url": _topic_url(month=month),
        }
    except Exception as error:
        raise _error(error) from error
