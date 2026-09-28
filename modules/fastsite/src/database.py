"""PyMySQL database configuration and pool registration."""

from __future__ import annotations

import os
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import pymysql

from .connectors.mysql import PyMySqlConnector
from .embedded_config import load_embedded_database_config
from .exceptions import ConfigurationError, UnsupportedDatabaseError
from .services import WebCoreServices


class DatabaseConfigError(ValueError):
    """Raised when the external database configuration is invalid."""


@dataclass(frozen=True)
class PyMySqlDatabaseConfig:
    name: str
    db_type: str
    host: str
    port: int
    user: str
    password_env: str | None
    password: str | None
    database: str
    charset: str
    connect_timeout_seconds: int
    read_timeout_seconds: int
    write_timeout_seconds: int
    pool_size: int
    pool_max_overflow: int
    pool_wait_timeout_seconds: int
    ssl_ca: str | None
    ssl_verify_cert: bool
    ssl_verify_identity: bool

    def connect(self) -> pymysql.connections.Connection:
        password = self.password
        if password is None:
            if self.password_env is None:
                raise DatabaseConfigError(f"database password is missing: {self.name}")
            password = os.getenv(self.password_env)
            if password is None:
                raise DatabaseConfigError(f"database password environment variable is missing: {self.password_env}")
        return PyMySqlConnector(self, password).connect()


def _required_string(raw: Mapping[str, Any], name: str, database_name: str) -> str:
    value = raw.get(name)
    if not isinstance(value, str) or not value.strip():
        raise DatabaseConfigError(f"databases.{database_name}.{name} must be a non-empty string")
    return value.strip()


def _positive_int(raw: Mapping[str, Any], name: str, database_name: str, default: int) -> int:
    value = raw.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise DatabaseConfigError(f"databases.{database_name}.{name} must be a positive integer")
    return value


def _nonnegative_int(raw: Mapping[str, Any], name: str, database_name: str, default: int) -> int:
    value = raw.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise DatabaseConfigError(f"databases.{database_name}.{name} must be a non-negative integer")
    return value


def _boolean(raw: Mapping[str, Any], name: str, database_name: str, default: bool) -> bool:
    value = raw.get(name, default)
    if not isinstance(value, bool):
        raise DatabaseConfigError(f"databases.{database_name}.{name} must be a boolean")
    return value


def _optional_string(raw: Mapping[str, Any], name: str, database_name: str) -> str | None:
    value = raw.get(name)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise DatabaseConfigError(f"databases.{database_name}.{name} must be a non-empty string")
    return value.strip()


def load_pymysql_databases(config_path: Path) -> tuple[PyMySqlDatabaseConfig, ...]:
    try:
        raw = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise DatabaseConfigError(f"cannot read database config: {config_path}") from error
    databases = raw.get("databases")
    if not isinstance(databases, dict) or not databases:
        raise DatabaseConfigError("database config must contain at least one [databases.<name>] section")

    configs: list[PyMySqlDatabaseConfig] = []
    for database_name, value in databases.items():
        if (
            not isinstance(database_name, str)
            or not database_name.isascii()
            or not database_name.replace("_", "").isalnum()
        ):
            raise DatabaseConfigError("database names may contain only letters, digits, and underscores")
        if not isinstance(value, dict):
            raise DatabaseConfigError(f"databases.{database_name} must be a table")
        db_type = _required_string(value, "db_type", database_name).lower()
        if db_type not in {"mysql", "doris"}:
            raise DatabaseConfigError(f"databases.{database_name}.db_type must be mysql or doris")
        ssl_ca = _optional_string(value, "ssl_ca", database_name)
        ssl_verify_cert = _boolean(value, "ssl_verify_cert", database_name, ssl_ca is not None)
        ssl_verify_identity = _boolean(value, "ssl_verify_identity", database_name, ssl_ca is not None)
        if ssl_verify_identity and not ssl_verify_cert:
            raise DatabaseConfigError(
                f"databases.{database_name}.ssl_verify_identity requires ssl_verify_cert = true"
            )
        configs.append(
            PyMySqlDatabaseConfig(
                name=database_name,
                db_type=db_type,
                host=_required_string(value, "host", database_name),
                port=_positive_int(value, "port", database_name, 3306),
                user=_required_string(value, "user", database_name),
                password_env=_required_string(value, "password_env", database_name),
                password=None,
                database=_required_string(value, "database", database_name),
                charset=str(value.get("charset", "utf8mb4")),
                connect_timeout_seconds=_positive_int(value, "connect_timeout_seconds", database_name, 5),
                read_timeout_seconds=_positive_int(value, "read_timeout_seconds", database_name, 120),
                write_timeout_seconds=_positive_int(value, "write_timeout_seconds", database_name, 30),
                pool_size=_nonnegative_int(value, "pool_size", database_name, 0),
                pool_max_overflow=_nonnegative_int(value, "pool_max_overflow", database_name, 5),
                pool_wait_timeout_seconds=_nonnegative_int(
                    value, "pool_wait_timeout_seconds", database_name, 15
                ),
                ssl_ca=ssl_ca,
                ssl_verify_cert=ssl_verify_cert,
                ssl_verify_identity=ssl_verify_identity,
            )
        )
    return tuple(configs)


def load_embedded_pymysql_databases() -> tuple[PyMySqlDatabaseConfig, ...]:
    """Load credentials and connection settings from _compiled_config.so."""
    databases = load_embedded_database_config()
    if databases is None:
        return ()
    configs: list[PyMySqlDatabaseConfig] = []
    for database_name, value in databases.items():
        if not isinstance(database_name, str) or not isinstance(value, dict):
            raise DatabaseConfigError("embedded database configuration is invalid")
        db_type = _required_string(value, "db_type", database_name).lower()
        if db_type not in {"mysql", "doris"}:
            raise DatabaseConfigError(f"databases.{database_name}.db_type must be mysql or doris")
        ssl_ca = _optional_string(value, "ssl_ca", database_name)
        ssl_verify_cert = _boolean(value, "ssl_verify_cert", database_name, ssl_ca is not None)
        ssl_verify_identity = _boolean(value, "ssl_verify_identity", database_name, ssl_ca is not None)
        configs.append(
            PyMySqlDatabaseConfig(
                name=database_name,
                db_type=db_type,
                host=_required_string(value, "host", database_name),
                port=_positive_int(value, "port", database_name, 3306),
                user=_required_string(value, "user", database_name),
                password_env=None,
                password=_required_string(value, "password", database_name),
                database=_required_string(value, "database", database_name),
                charset=str(value.get("charset", "utf8mb4")),
                connect_timeout_seconds=_positive_int(value, "connect_timeout_seconds", database_name, 5),
                read_timeout_seconds=_positive_int(value, "read_timeout_seconds", database_name, 120),
                write_timeout_seconds=_positive_int(value, "write_timeout_seconds", database_name, 30),
                pool_size=_nonnegative_int(value, "pool_size", database_name, 0),
                pool_max_overflow=_nonnegative_int(value, "pool_max_overflow", database_name, 5),
                pool_wait_timeout_seconds=_nonnegative_int(
                    value, "pool_wait_timeout_seconds", database_name, 15
                ),
                ssl_ca=ssl_ca,
                ssl_verify_cert=ssl_verify_cert,
                ssl_verify_identity=ssl_verify_identity,
            )
        )
    return tuple(configs)


def load_configured_pymysql_databases() -> tuple[PyMySqlDatabaseConfig, ...]:
    """Load the selected development TOML or the production embedded configuration."""
    config_path = os.getenv("FASTSITE_DATABASE_CONFIG")
    if config_path:
        return load_pymysql_databases(Path(config_path).resolve())
    return load_embedded_pymysql_databases()


def get_database_config(
    database_name: str,
    *,
    connect_timeout: int | None = None,
    read_timeout: int | None = None,
) -> PyMySqlDatabaseConfig:
    """Return one configured database by case-insensitive name."""
    normalized = database_name.strip().lower()
    if not normalized:
        raise UnsupportedDatabaseError("database name is empty")
    configs = {config.name.lower(): config for config in load_configured_pymysql_databases()}
    if not configs:
        raise ConfigurationError("no embedded database configuration or FASTSITE_DATABASE_CONFIG is available")
    try:
        config = configs[normalized]
    except KeyError as error:
        raise UnsupportedDatabaseError(f"database is not configured: {database_name}") from error
    if connect_timeout is not None and connect_timeout < 1:
        raise ConfigurationError("connect_timeout must be positive")
    if read_timeout is not None and read_timeout < 1:
        raise ConfigurationError("read_timeout must be positive")
    return replace(
        config,
        connect_timeout_seconds=connect_timeout or config.connect_timeout_seconds,
        read_timeout_seconds=read_timeout or config.read_timeout_seconds,
    )


def register_pymysql_databases(services: WebCoreServices, config_path: Path) -> tuple[str, ...]:
    """Load TOML configuration and register lazy named PyMySQL pools."""
    configs = load_pymysql_databases(config_path)
    for config in configs:
        services.register_dbutils_pool(
            config.name,
            config.connect,
            pool_size=config.pool_size,
            pool_max_overflow=config.pool_max_overflow,
            pool_wait_timeout_seconds=config.pool_wait_timeout_seconds,
        )
    return tuple(config.name for config in configs)


def register_embedded_pymysql_databases(services: WebCoreServices) -> tuple[str, ...]:
    configs = load_embedded_pymysql_databases()
    for config in configs:
        services.register_dbutils_pool(
            config.name,
            config.connect,
            pool_size=config.pool_size,
            pool_max_overflow=config.pool_max_overflow,
            pool_wait_timeout_seconds=config.pool_wait_timeout_seconds,
        )
    return tuple(config.name for config in configs)
