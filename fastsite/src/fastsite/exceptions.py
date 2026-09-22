"""Database-factory exceptions with messages suitable for callers and logs."""

from __future__ import annotations


class FastsiteError(Exception):
    """Base exception for database functionality exposed by fastsite."""

    def __init__(self, message: str = "", user_message: str | None = None) -> None:
        super().__init__(message)
        self.user_message = user_message or message


class ConfigurationError(FastsiteError):
    """Raised when database configuration is absent or invalid."""


class UnsupportedDatabaseError(FastsiteError):
    """Raised when a requested named database is not configured."""


class ConnectionFailedError(FastsiteError):
    """Raised when a database connection cannot be established."""


class PoolExhaustedError(FastsiteError):
    """Raised when a script-local connection pool cannot provide a connection."""


class QueryExecutionError(FastsiteError):
    """Reserved for callers that wrap database query failures consistently."""
