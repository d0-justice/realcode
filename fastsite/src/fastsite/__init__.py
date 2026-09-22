"""Web host and dbfactory-compatible database access for fastsite."""

from .app import create_app
from .database import DatabaseConfigError, PyMySqlDatabaseConfig
from .exceptions import (
    ConfigurationError,
    ConnectionFailedError,
    FastsiteError,
    PoolExhaustedError,
    QueryExecutionError,
    UnsupportedDatabaseError,
)
from .extensions import ExtensionContext
from .factory import ConnectionFactory, create_connection, list_databases
from .services import DbApiConnectionPool, DbUtilsConnectionPool, ServiceUnavailableError, WebCoreServices

__all__ = [
    "DatabaseConfigError",
    "DbApiConnectionPool",
    "DbUtilsConnectionPool",
    "ExtensionContext",
    "FastsiteError",
    "ConfigurationError",
    "ConnectionFailedError",
    "PoolExhaustedError",
    "QueryExecutionError",
    "UnsupportedDatabaseError",
    "ConnectionFactory",
    "PyMySqlDatabaseConfig",
    "ServiceUnavailableError",
    "WebCoreServices",
    "create_connection",
    "create_app",
    "list_databases",
]
