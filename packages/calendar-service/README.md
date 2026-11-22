# Calendar Service Package

Owns TypeScript business logic for Apple Calendar MCP.

Responsibilities:

- read tools and EventKit range chunking
- permission and allowlist enforcement
- duplicate and conflict checks. Overlap conflicts are reported for previews and diagnostics, while valid parallel events may be created in the same calendar. Duplicate and idempotency checks continue to guard against accidental repeated writes.
- write preview and confirmation flow
- idempotency handling
- rollback, audit, and change-feed coordination
- compact snapshot creation and retrieval
- explainability and diagnostic responses

This package must not expose blocked calendars or bypass write safety gates.
EventKit remains behind the Swift helper boundary.
