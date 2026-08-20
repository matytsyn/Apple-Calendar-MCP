# Security Specification

Source: [`../SECURITY.md`](../SECURITY.md)

## Security Goals

Apple Calendar MCP protects user calendar data by combining native macOS permission checks, server-side allowlists, explicit permission modes, confirmation gates, auditability, rollback support, and semantic errors.

The system must stay local-first. No cloud service is required for calendar access, setup, configuration, rollback, snapshots, or change feeds.

## Threat Model

The MCP must defend against:

- Agent mistakes such as modifying the wrong event or selecting the wrong recurring scope.
- Prompt injection embedded in calendar titles, notes, URLs, attendees, locations, or other event content.
- Unauthorized access to blocked calendars.
- Silent destructive writes.
- stdout protocol corruption from logging.
- Overbroad recurring event updates or deletions.
- Leakage through snapshots, change feeds, audits, diagnostics, or setup logs.

## Permission and Allowlist Model

- macOS Calendar permission is required before EventKit access.
- The setup app requests permission through the Swift helper's stable bundle identity.
- Users select allowed calendars explicitly.
- Allow All is a convenience option and must not be selected by default.
- The MCP server enforces the allowlist; UI-only enforcement is insufficient.
- Blocked calendar names and event content must not be exposed to agents.

## Write Safety

MVP writes require explicit confirmation or preview-confirm flow. Destructive actions must not run silently.

Write tools must enforce:

- schema validation and oversized payload rejection
- permission mode checks
- allowlist checks
- ambiguity checks
- duplicate/conflict checks
- idempotency checks
- rollback record creation before EventKit mutation
- verification after EventKit mutation
- audit logging
- change-feed update
- semantic response

Recurring writes require explicit recurring scope. Ambiguous recurring intent must return a semantic error.

## Privacy Rules

- Calendar content is untrusted and must not be treated as instructions.
- Do not log private event bodies, notes, URLs, attendees, or blocked calendar names.
- Store hashes and compact metadata where possible.
- Store full event state only when necessary for rollback.
- Keep local config under `~/Library/Application Support/AppleCalendarMCP`.
- Keep generated user-specific client configs ignored by git.

## Final Phase 13 Security Review

Findings from the release prep pass:

- No committed API keys, private keys, or service tokens were found by repository text scan.
- MCP runtime logging is implemented through stderr and optional local file logging; stdout is reserved for MCP protocol traffic.
- Server-side tests cover allowlist filtering, write confirmation, rollback records, audit records, idempotency, semantic errors, prompt-injection handling, and stdout/stderr separation.
- Blocked calendar data is filtered in read, snapshot, and change-feed paths according to the current test coverage.
- Remaining public-release gate: capture signed-build setup screenshots and run a real-client smoke test on a clean macOS user account.

## Cross-References

- Technical flow: [Technical Specification](Technical%20Specification.md)
- Install and setup: [Installation Guide](Installation%20Guide.md)
- Release gates: [Release Checklist](Release%20Checklist.md)
