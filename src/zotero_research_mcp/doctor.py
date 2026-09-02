"""Read-only command-line health probe."""

from __future__ import annotations

import sys

from .config import build_service


def main() -> None:
    """Print a machine-readable health report without modifying Zotero."""

    service = build_service()
    try:
        report = service.health_check()
        print(report.model_dump_json(indent=2))
    finally:
        service.close()
    if report.status != "ok":
        sys.exit(1)
