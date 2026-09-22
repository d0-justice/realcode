"""Worker-local APScheduler registry with a SQLite lease lock per job."""

from __future__ import annotations

import inspect
import asyncio
import logging
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger


LOGGER = logging.getLogger("fastsite.scheduler")


class JobRegistry:
    def __init__(self, lock_path: Path) -> None:
        self._scheduler = BackgroundScheduler(timezone="Asia/Shanghai")
        self._lock_path = lock_path
        self._jobs: list[dict[str, object]] = []

    def add_cron(self, *, extension_id: str, name: str, func: Callable[[], Any], hour: int, minute: int = 0, misfire_grace_time: int = 3600, lease_seconds: int = 3600) -> None:
        if not name or not name.replace("_", "").isalnum() or not callable(func):
            raise ValueError("scheduled job name or function is invalid")
        job_id = f"{extension_id}:{name}"
        if any(item["id"] == job_id for item in self._jobs):
            raise ValueError(f"duplicate scheduled job: {job_id}")

        def run() -> None:
            owner_id = uuid.uuid4().hex
            if not self._acquire(job_id, owner_id, max(60, lease_seconds)):
                return
            stopped = threading.Event()
            heartbeat = threading.Thread(
                target=self._heartbeat,
                args=(job_id, owner_id, max(60, lease_seconds), stopped),
                daemon=True,
            )
            heartbeat.start()
            try:
                result = func()
                if inspect.isawaitable(result):
                    asyncio.run(result)
            finally:
                stopped.set()
                heartbeat.join(timeout=2)
                self._release(job_id, owner_id)

        self._scheduler.add_job(
            run,
            trigger=CronTrigger(hour=hour, minute=minute),
            id=job_id,
            replace_existing=True,
            max_instances=1,
            coalesce=True,
            misfire_grace_time=misfire_grace_time,
        )
        self._jobs.append({"id": job_id, "hour": hour, "minute": minute})

    def start(self) -> None:
        self._scheduler.start()

    def shutdown(self) -> None:
        if self._scheduler.running:
            self._scheduler.shutdown(wait=True)

    def as_dict(self) -> list[dict[str, object]]:
        return list(self._jobs)

    def _connect(self) -> sqlite3.Connection:
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self._lock_path, timeout=10)
        connection.execute("CREATE TABLE IF NOT EXISTS fastsite_job_lock (job_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL)")
        columns = {row[1] for row in connection.execute("PRAGMA table_info(fastsite_job_lock)")}
        if "owner_id" not in columns:
            connection.execute("ALTER TABLE fastsite_job_lock ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''")
            connection.commit()
        return connection

    def _acquire(self, job_id: str, owner_id: str, lease_seconds: int) -> bool:
        now = int(time.time())
        connection = self._connect()
        try:
            connection.execute("DELETE FROM fastsite_job_lock WHERE expires_at <= ?", (now,))
            try:
                connection.execute("INSERT INTO fastsite_job_lock(job_id, owner_id, expires_at) VALUES (?, ?, ?)", (job_id, owner_id, now + lease_seconds))
            except sqlite3.IntegrityError:
                return False
            connection.commit()
        finally:
            connection.close()
        return True

    def _renew(self, job_id: str, owner_id: str, lease_seconds: int) -> bool:
        connection = self._connect()
        try:
            cursor = connection.execute(
                "UPDATE fastsite_job_lock SET expires_at = ? WHERE job_id = ? AND owner_id = ?",
                (int(time.time()) + lease_seconds, job_id, owner_id),
            )
            connection.commit()
            return cursor.rowcount == 1
        finally:
            connection.close()

    def _heartbeat(self, job_id: str, owner_id: str, lease_seconds: int, stopped: threading.Event) -> None:
        interval = max(10, lease_seconds // 3)
        while not stopped.wait(interval):
            try:
                if not self._renew(job_id, owner_id, lease_seconds):
                    LOGGER.warning("scheduled job lease ownership lost: %s", job_id)
                    return
            except sqlite3.Error:
                LOGGER.warning("scheduled job lease renewal failed: %s", job_id, exc_info=True)

    def _release(self, job_id: str, owner_id: str) -> None:
        connection = self._connect()
        try:
            connection.execute("DELETE FROM fastsite_job_lock WHERE job_id = ? AND owner_id = ?", (job_id, owner_id))
            connection.commit()
        finally:
            connection.close()
