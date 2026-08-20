# SQLite Store Package

Owns local SQLite persistence for configuration, snapshots, change feeds,
rollback records, audit logs, idempotency keys, confirmation tokens, and
migrations.

Phase 4 provides:

- versioned migrations
- config store
- calendar cache
- snapshots and snapshot events
- change feed
- rollback operations
- audit log
- idempotency keys
- confirmation tokens

The default database path is:

```text
~/Library/Application Support/AppleCalendarMCP/state.sqlite
```

Apple Calendar remains the source of truth. This package stores only local
supporting state for safety, rollback, auditability, snapshots, change feeds,
idempotency, and configuration.

Default retention periods are:

- audit log: 90 days
- rollback operations: 30 days
- idempotency keys: 7 days
- snapshots: 30 days
- change feed: 30 days
- confirmation tokens: expire by timestamp

Reset helpers clear local MCP state only. They never delete Apple Calendar
events.
