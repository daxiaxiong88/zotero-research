"""Hard privacy gates for model-bound metadata and full text."""

from __future__ import annotations

from .models import DocumentSensitivity


class PrivacyViolation(PermissionError):
    """Raised before protected content can cross a disallowed boundary."""


class PrivacyPolicy:
    """Default-deny policy for sending PDF full text to model endpoints."""

    def authorize_full_text(
        self,
        *,
        model_is_local: bool,
        sensitivity: DocumentSensitivity,
        allow_cloud: bool,
    ) -> None:
        if model_is_local:
            return
        if sensitivity == "sensitive":
            raise PrivacyViolation(
                "Sensitive full text can only be processed by a model marked as local."
            )
        if not allow_cloud:
            raise PrivacyViolation(
                "External processing of public full text requires explicit allow_cloud=true."
            )
