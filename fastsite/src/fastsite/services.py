"""Worker-local, lazily created shared services for extensions."""

from __future__ import annotations

import logging
import queue
import threading
from collections.abc import Callable, Generator
from contextlib import contextmanager
from typing import Any

from dbutils.pooled_db import PooledDB

from .settings import WebCoreSettings


LOGGER = logging.getLogger("fastsite.services")


class ServiceUnavailableError(RuntimeError):
    """Raised when a shared service cannot provide a resource in time."""


def _close_quietly(connection: Any) -> None:
    try:
        connection.close()
    except Exception:
        LOGGER.warning("failed closing pooled connection", exc_info=True)


class DbApiConnectionPool:
    """Small standard-library DB-API pool for custom host-provided resources."""

    def __init__(self, factory: Callable[[], Any], max_size: int, acquire_timeout_seconds: int) -> None:
        self._factory = factory
        self._max_size = max_size
        self._acquire_timeout_seconds = acquire_timeout_seconds
        self._available: queue.LifoQueue[Any] = queue.LifoQueue(maxsize=max_size)
        self._lock = threading.Lock()
        self._created = 0
        self._closed = False

    def _create_connection(self) -> Any:
        try:
            return self._factory()
        except Exception as error:
            with self._lock:
                self._created -= 1
            raise ServiceUnavailableError("failed creating pooled connection") from error

    def acquire(self) -> Any:
        if self._closed:
            raise ServiceUnavailableError("connection pool is closed")
        try:
            return self._available.get_nowait()
        except queue.Empty:
            pass
        with self._lock:
            if self._closed:
                raise ServiceUnavailableError("connection pool is closed")
            create_new = self._created < self._max_size
            if create_new:
                self._created += 1
        if create_new:
            return self._create_connection()
        try:
            return self._available.get(timeout=self._acquire_timeout_seconds)
        except queue.Empty as error:
            raise ServiceUnavailableError("connection pool is exhausted") from error

    def release(self, connection: Any) -> None:
        with self._lock:
            closed = self._closed
        if closed:
            self.discard(connection)
            return
        try:
            self._available.put_nowait(connection)
        except queue.Full:
            self.discard(connection)

    def discard(self, connection: Any) -> None:
        _close_quietly(connection)
        with self._lock:
            self._created = max(0, self._created - 1)

    @contextmanager
    def connection(self) -> Generator[Any, None, None]:
        connection = self.acquire()
        try:
            yield connection
        except BaseException:
            self.discard(connection)
            raise
        else:
            self.release(connection)

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        while True:
            try:
                connection = self._available.get_nowait()
            except queue.Empty:
                return
            self.discard(connection)


class DbUtilsConnectionPool:
    """DBUtils pool with the same parameters used by production dbfactory."""

    def __init__(
        self,
        factory: Callable[[], Any],
        pool_size: int,
        pool_max_overflow: int,
        pool_wait_timeout_seconds: int,
    ) -> None:
        self._factory = factory
        self._pool_size = pool_size
        self._pool_max_overflow = pool_max_overflow
        self._pool_wait_timeout_seconds = pool_wait_timeout_seconds
        self._pool: PooledDB | None = None
        self._slots = (
            threading.BoundedSemaphore(pool_size + pool_max_overflow)
            if pool_size > 0 and pool_wait_timeout_seconds > 0
            else None
        )
        self._lock = threading.Lock()
        self._closed = False

    def _get_pool(self) -> PooledDB | None:
        if self._pool_size == 0:
            return None
        if self._pool is not None:
            return self._pool
        with self._lock:
            if self._closed:
                raise ServiceUnavailableError("connection pool is closed")
            if self._pool is None:
                self._pool = PooledDB(
                    creator=self._factory,
                    mincached=min(2, self._pool_size),
                    maxconnections=self._pool_size + self._pool_max_overflow,
                    # The semaphore provides a bounded wait before DBUtils is called.
                    blocking=self._slots is None,
                    ping=1,
                )
            return self._pool

    @contextmanager
    def connection(self) -> Generator[Any, None, None]:
        if self._closed:
            raise ServiceUnavailableError("connection pool is closed")
        pool = self._get_pool()
        slot_acquired = False
        try:
            if self._slots is not None:
                slot_acquired = self._slots.acquire(timeout=self._pool_wait_timeout_seconds)
                if not slot_acquired:
                    raise ServiceUnavailableError("database connection pool is exhausted")
            connection = pool.connection() if pool is not None else self._factory()
        except ServiceUnavailableError:
            if slot_acquired:
                self._slots.release()
            raise
        except Exception as error:
            if slot_acquired:
                self._slots.release()
            raise ServiceUnavailableError("failed acquiring database connection") from error
        try:
            yield connection
        finally:
            # DBUtils proxy close() returns the connection to PooledDB.
            _close_quietly(connection)
            if slot_acquired:
                self._slots.release()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            pool = self._pool
        if pool is not None:
            pool.close()


class WebCoreServices:
    """Registry of worker-local shared services available to all extensions."""

    def __init__(self, settings: WebCoreSettings) -> None:
        self.settings = settings
        self._lock = threading.Lock()
        self._pools: dict[str, DbApiConnectionPool | DbUtilsConnectionPool] = {}
        self._closed = False

    @staticmethod
    def _validate_pool_name(name: str) -> None:
        if not name or not name.isascii() or not name.replace("_", "").isalnum():
            raise ValueError("service pool name must contain only letters, digits, and underscores")

    def register_dbapi_pool(
        self,
        name: str,
        factory: Callable[[], Any],
        *,
        max_size: int = 4,
        acquire_timeout_seconds: int = 15,
    ) -> None:
        """Register a named standard-library pool before extensions load."""
        self._validate_pool_name(name)
        if not callable(factory):
            raise TypeError("service pool factory must be callable")
        if max_size < 1 or acquire_timeout_seconds < 1:
            raise ValueError("pool size and acquire timeout must be positive")
        with self._lock:
            if self._closed:
                raise ServiceUnavailableError("service registry is closed")
            if name in self._pools:
                raise ValueError(f"service pool already registered: {name}")
            self._pools[name] = DbApiConnectionPool(factory, max_size, acquire_timeout_seconds)

    def register_dbutils_pool(
        self,
        name: str,
        factory: Callable[[], Any],
        *,
        pool_size: int,
        pool_max_overflow: int,
        pool_wait_timeout_seconds: int = 15,
    ) -> None:
        """Register a lazy DBUtils pool using dbfactory-compatible settings."""
        self._validate_pool_name(name)
        if not callable(factory):
            raise TypeError("service pool factory must be callable")
        if pool_size < 0 or pool_max_overflow < 0 or pool_wait_timeout_seconds < 0:
            raise ValueError("pool size, overflow, and wait timeout cannot be negative")
        with self._lock:
            if self._closed:
                raise ServiceUnavailableError("service registry is closed")
            if name in self._pools:
                raise ValueError(f"service pool already registered: {name}")
            self._pools[name] = DbUtilsConnectionPool(
                factory,
                pool_size,
                pool_max_overflow,
                pool_wait_timeout_seconds,
            )

    @contextmanager
    def connection(self, name: str) -> Generator[Any, None, None]:
        """Borrow a connection from a named core-managed DB-API pool."""
        try:
            pool = self._pools[name]
        except KeyError as error:
            raise ServiceUnavailableError(f"service pool is not registered: {name}") from error
        with pool.connection() as connection:
            yield connection

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            pools = tuple(self._pools.values())
        for pool in pools:
            pool.close()
