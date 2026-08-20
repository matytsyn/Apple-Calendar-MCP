# Shared Package

Owns cross-package schemas and shared TypeScript contracts.

Responsibilities:

- MCP request and response schemas
- normalized calendar and event schemas
- local configuration schemas
- audit, rollback, idempotency, snapshot, and change-feed record schemas
- semantic error codes and validation limits

Keep this package free of runtime dependencies on EventKit, SQLite, or MCP
transport code.
