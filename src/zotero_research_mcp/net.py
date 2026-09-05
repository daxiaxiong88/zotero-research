"""Shared loopback hostname checks for local-only endpoints."""

from __future__ import annotations

import ipaddress
from urllib.parse import urlparse


def is_loopback_hostname(hostname: str | None) -> bool:
    """Return True only for ``localhost`` or a literal loopback IP address."""

    if hostname is None:
        return False
    if hostname.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def is_loopback_url(url: str) -> bool:
    """Return True when ``url`` resolves to a loopback host."""

    return is_loopback_hostname(urlparse(url).hostname)
