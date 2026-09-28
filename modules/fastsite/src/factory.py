"""dbfactory-compatible direct and pooled database access for Python scripts."""

from __future__ import annotations

from typing import Any

from dbutils.pooled_db import PooledDB

from .connectors.mysql import DatabaseConnectionError
from .database import get_database_config, load_configured_pymysql_databases
from .exceptions import ConnectionFailedError, PoolExhaustedError


def list_databases() -> list[str]:
    """List configured MySQL/Doris database names."""
    return sorted(config.name for config in load_configured_pymysql_databases())


def create_connection(
    database_name: str,
    connect_timeout: int | None = None,
    read_timeout: int | None = None,
) -> Any:
    """Create one native PyMySQL connection for a short-lived script operation."""
    config = get_database_config(
        database_name,
        connect_timeout=connect_timeout,
        read_timeout=read_timeout,
    )
    try:
        return config.connect()
    except DatabaseConnectionError as error:
        raise ConnectionFailedError(str(error)) from error


class ConnectionFactory:
    """A script-local DBUtils pool with the same behavior as dbfactory.ConnectionFactory."""

    def __init__(
        self,
        database_name: str,
        pool_size: int | None = None,
        connect_timeout: int | None = None,
        read_timeout: int | None = None,
    ) -> None:
        self._config = get_database_config(
            database_name,
            connect_timeout=connect_timeout,
            read_timeout=read_timeout,
        )
        self._pool_size = self._config.pool_size if pool_size is None else pool_size
        if self._pool_size < 0:
            raise ValueError("pool_size cannot be negative")
        self._pool: PooledDB | None = None
        if self._pool_size > 0:
            self._pool = PooledDB(
                creator=self._config.connect,
                mincached=min(2, self._pool_size),
                maxconnections=self._pool_size + self._config.pool_max_overflow,
                blocking=True,
                ping=1,
            )

    def get_connection(self) -> Any:
        """Borrow a connection. Call close() to return a pooled connection."""
        try:
            return self._pool.connection() if self._pool is not None else self._config.connect()
        except DatabaseConnectionError as error:
            raise ConnectionFailedError(str(error)) from error
        except Exception as error:
            raise PoolExhaustedError(f"database connection pool is exhausted: {self._config.name}") from error

    def close_all(self) -> None:
        """Close all idle connections owned by this script-local factory."""
        if self._pool is not None:
            self._pool.close()

    @property
    def pool_size(self) -> int:
        return self._pool_size
