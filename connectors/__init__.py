"""Connecteurs de sources de données externes."""

from .data_gouv import DataGouvConnector, DataGouvConnectorError

__all__ = ["DataGouvConnector", "DataGouvConnectorError"]
