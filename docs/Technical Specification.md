# Technical Specification

## Architecture Summary

Apple Calendar MCP is split into clear package boundaries:

```text
MCP Client
  -> packages/mcp-server
  -> packages/calendar-service
  -> apps/macos-helper
  -> Apple Calendar / EventKit

packages/calendar-service
  -> packages/sqlite-store
  -> packages/shared
```

- `packages/mcp-server`: stdio MCP server, tool registration, semantic tool results, startup validation, stderr logging.
- `packages/calendar-service`: business rules for read, write, preview, rollback, snapshots, change feeds, diagnostics, permission modes, allowlists, duplicates, conflicts, and idempotency.
- `apps/macos-helper`: Swift EventKit bridge and native setup app.
- `packages/sqlite-store`: local SQLite migrations and persistence APIs.
- `packages/shared`: Zod schemas and shared contracts.

## MCP Contract

External tool names use the `calendar_<action>` format and avoid periods for broad client compatibility.

Implemented tool groups:

- Read and discovery: `calendar_permissions_check`, `calendar_list_calendars`, `calendar_list_events`, `calendar_search_events`, `calendar_find_free_time`, `calendar_get_event`
- Preview and write: `calendar_preview_create_event`, `calendar_preview_update_event`, `calendar_preview_delete_event`, `calendar_create_event`, `calendar_update_event`, `calendar_reschedule_event`, `calendar_delete_event`
- Snapshot and changes: `calendar_create_snapshot`, `calendar_get_snapshot`, `calendar_get_changes_since`
- Rollback and explainability: `calendar_rollback_change`, `calendar_explain_last_change`, `calendar_diagnose_issue`

Tool responses use semantic success/error envelopes and should include actionable `suggested_action` text for user-recoverable failures.

## Write Pipeline

Every write must follow this order:

1. Validate input.
2. Permission check.
3. Allowlist check.
4. Ambiguity check.
5. Duplicate/conflict check.
6. Idempotency check.
7. Rollback record.
8. EventKit write.
9. Verification.
10. Audit log.
11. Change feed update.
12. Semantic response.

This ordering is safety-critical. Tests cover the most important bypass paths.

## Local Data Model

Apple Calendar remains the source of truth. SQLite stores only local control and recovery state:

- `config`
- `calendars_cache`
- `confirmation_tokens`
- `idempotency_keys`
- `rollback_operations`
- `audit_log`
- `snapshots`
- `snapshot_events`
- `change_feed`

Snapshot records are compact and store identifiers, hashes, timestamps, recurrence metadata, and short previews only when needed. Change feeds are intended for efficient incremental agent context and must not expose blocked calendars.

## Performance Requirements

- Use pagination for list and change-feed responses.
- Keep snapshots compact and avoid storing unnecessary private event data.
- Chunk large EventKit read ranges to avoid bridge failures on long windows.
- Maintain indexes for allowlist lookup, snapshot lookup, change ordering, idempotency, rollback, and audit queries.
- Keep startup quiet and fast; stdout is reserved for MCP protocol traffic.

## Release Packaging

Release artifacts are built with:

```sh
npm run release:package
```

The script builds TypeScript, runs tests, bundles the helper app, validates client configs, creates workspace tarballs, and writes SHA-256 checksums to `dist/release/SHA256SUMS.txt`.

## Cross-References

- Product intent: [Product Specification](Product%20Specification.md)
- Security requirements: [Security Specification](Security%20Specification.md)
- Development workflow: [Development Guide](Development%20Guide.md)
- Installation: [Installation Guide](Installation%20Guide.md)
