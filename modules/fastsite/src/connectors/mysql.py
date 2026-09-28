"""PyMySQL connector shared by MySQL and Doris."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pymysql

from .base import BaseConnector

if TYPE_CHECKING:
    from fastsite.database import PyMySqlDatabaseConfig


class DatabaseConnectionError(RuntimeError):
    """Raised when PyMySQL cannot establish a database connection."""


class PyMySqlConnector(BaseConnector):
    """Create a MySQL-wire-protocol connection for MySQL or Doris."""

    def __init__(self, config: "PyMySqlDatabaseConfig", password: str) -> None:
        self._config = config
        self._password = password

    def connect(self) -> pymysql.connections.Connection:
        options = {
            "host": self._config.host,
            "port": self._config.port,
            "user": self._config.user,
            "password": self._password,
            "database": self._config.database,
            "charset": self._config.charset,
            "connect_timeout": self._config.connect_timeout_seconds,
            "read_timeout": self._config.read_timeout_seconds,
            "write_timeout": self._config.write_timeout_seconds,
            "autocommit": True,
        }
        if self._config.ssl_ca is not None:
            options["ssl"] = {"ca": self._config.ssl_ca}
            options["ssl_verify_cert"] = self._config.ssl_verify_cert
            options["ssl_verify_identity"] = self._config.ssl_verify_identity
        try:
            return pymysql.connect(**options)
        except pymysql.MySQLError as error:
            raise DatabaseConnectionError(
                f"failed connecting {self._config.db_type} database at "
                f"{self._config.host}:{self._config.port}"
            ) from error
