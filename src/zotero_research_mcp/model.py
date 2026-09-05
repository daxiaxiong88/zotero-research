"""Model adapter contract.

The reading and analysis builders accept an optional model client so the MCP
surface stays extensible, but this release ships no implementation: without a
configured model the tools return deterministic evidence excerpts, and the
sidebar workflow sends evidence to the user's own web AI instead.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol


class ModelClient(Protocol):
    """Minimal model seam used by the reading-card and analysis builders."""

    name: str
    is_local: bool

    def complete_json(self, prompt: str) -> Mapping[str, Any]:
        """Return one JSON object for the supplied grounded prompt."""


class ModelResponseError(RuntimeError):
    """Raised when a model endpoint returns unusable structured output."""
