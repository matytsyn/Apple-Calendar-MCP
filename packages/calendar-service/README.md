# Calendar Service Package

Owns TypeScript business logic for Apple Calendar MCP.

Responsibilities:

- read tools and EventKit range chunking
- permission and allowlist enforcement
- duplicate and conflict checks
- write preview and confirmation flow
- idempotency handling
- rollback, audit, and change-feed coordination
- compact snapshot creation and retrieval
- explainability and diagnostic responses

This package must not expose blocked calendars or bypass write safety gates.
EventKit remains behind the Swift helper boundary.
