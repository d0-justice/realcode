"""Gunicorn configuration for the fastsite extension host."""

from __future__ import annotations

import os
from pathlib import Path


HOST_DIR = Path(__file__).resolve().parent
PROJECT_DIR = HOST_DIR.parent
chdir = str(HOST_DIR)
os.environ.setdefault("FASTSITE_EXTENSIONS_DIR", str(PROJECT_DIR / "webservice" / "plugins"))

wsgi_app = "fastsite.host:app"
bind = os.getenv("FASTSITE_BIND", "127.0.0.1:3003")

# Query sessions live in plugin memory; keep one worker until Redis is introduced.
workers = 1
worker_class = "uvicorn.workers.UvicornWorker"
preload_app = False
timeout = int(os.getenv("FASTSITE_TIMEOUT_SECONDS", "180"))
graceful_timeout = int(os.getenv("FASTSITE_GRACEFUL_TIMEOUT_SECONDS", "240"))
keepalive = 5

accesslog = "-"
errorlog = "-"
loglevel = os.getenv("FASTSITE_LOG_LEVEL", "info")
capture_output = True
pidfile = os.getenv("FASTSITE_PID_FILE", "") or None
