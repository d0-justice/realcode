"""Base contract for database connectors."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BaseConnector(ABC):
    """Creates a native DB-API connection from one validated configuration."""

    @abstractmethod
    def connect(self) -> Any:
        """Return one ready-to-use native database connection."""
