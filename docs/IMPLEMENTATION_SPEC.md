# Zotero Research MCP — MVP Implementation Spec

This file records the implementation boundary approved in the conversation that created this
repository.

The Zotero 10 / 0.2 continuation is specified in [COMPLETE_DESIGN.md](COMPLETE_DESIGN.md).
It adds the native sidebar/highlights and three MCP tools (12 total), removes any MCP local-client
disclosure bypass, permits explicit alternate loopback ports for isolated tests, and makes an
opted-in, required heavy parse fail explicitly when its local dependencies are missing. The older
default-off heavy-parser recommendation remains valid. The deferred list below is historical,
not the current delivery status; see [VALIDATION_ZOTERO10.md](VALIDATION_ZOTERO10.md).

## Goal

Deliver a runnable, safety-first MCP server that lets a local agent search a Zotero library, read
PDF evidence, build a structured reading card, and create a child-note only through a preview-first
workflow.

## Required public tools

The MCP server must expose:

1. `health_check`
2. `search_items`
3. `get_item_context`
4. `extract_pdf`
5. `retrieve_evidence`
6. `generate_reading_card`
7. `preview_child_note`
8. `request_write_authorization`
9. `write_child_note`

It must not expose a delete or arbitrary-file-read tool.

## Safety requirements

- Never read or write `zotero.sqlite`; use Zotero's official Local API on loopback port `23119`.
- Treat PDF full text as sensitive by default.
- Sensitive full text may only be passed to a model endpoint explicitly classified as local.
- Public full text may be sent to an external model only with per-call cloud opt-in.
- Resolve PDFs from Zotero attachment keys; do not accept arbitrary filesystem paths from MCP.
- Render child-note content as safe HTML and preview the exact payload before writing.
- Bind writes to the preview using a digest, expiration, one-time token, and explicit user-confirmed
  flag. Reject mismatches and replay before issuing the HTTP write.
- Use Zotero's native local-write authorization and Local API writes only where supported. Zotero 9
  and earlier must remain preview-only; never fall back to SQLite.
- Do not modify the user's real Zotero library during implementation tests or smoke checks.

## PDF and evidence requirements

- Use PyMuPDF as the fast parser.
- Return page-addressable text and deterministic evidence IDs.
- Detect insufficient selectable text, empty pages, and encoding damage.
- Heavy parsing must be opt-in and restricted to a configured local parser. If none is configured,
  return a recommendation rather than silently uploading the document.

## Reading-card requirements

- Cover research question, methods, key findings, and limitations.
- Preserve a closed set of evidence IDs so generated claims can be traced to page excerpts.
- Remain useful without a second model by returning deterministic evidence excerpts.
- Reject model output that cites evidence IDs outside the supplied set.

## Deferred work

- Zotero reader sidebar UI.
- Native PDF highlight/annotation creation inside Zotero's JavaScript runtime.
- Bundled MinerU installation or model downloads.
- Group-library writes and destructive/batch operations.

## Acceptance checks

- Unit tests cover each public seam and each write/privacy guard.
- Ruff and strict mypy pass.
- A real read-only health/search/context/PDF smoke test succeeds against the running Zotero.
- A complete MCP stdio initialize/list-tools handshake succeeds.
- The server is registered in the local Codex MCP configuration with write-aware approvals.
