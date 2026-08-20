export type Migration = {
  version: number;
  statements: string[];
};

export function validateMigrations(migrations: readonly Migration[]): void {
  let previousVersion = 0;

  for (const migration of migrations) {
    if (migration.version !== previousVersion + 1) {
      throw new Error("SQLite migrations must be sequential and non-destructive by default.");
    }

    previousVersion = migration.version;
  }
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS calendars_cache (
        calendar_id TEXT PRIMARY KEY,
        native_calendar_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        source_title TEXT,
        allows_content_modifications INTEGER NOT NULL,
        is_subscribed INTEGER NOT NULL DEFAULT 0,
        is_allowed INTEGER NOT NULL DEFAULT 0,
        color TEXT,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_calendars_allowed ON calendars_cache(is_allowed)`,
      `CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id TEXT PRIMARY KEY,
        scope_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT,
        event_count INTEGER NOT NULL,
        hash TEXT NOT NULL,
        notes TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS snapshot_events (
        snapshot_event_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        native_event_id TEXT,
        calendar_id TEXT NOT NULL,
        title_hash TEXT NOT NULL,
        title_preview TEXT,
        start_utc TEXT NOT NULL,
        end_utc TEXT NOT NULL,
        timezone TEXT,
        is_all_day INTEGER NOT NULL DEFAULT 0,
        is_recurring INTEGER NOT NULL DEFAULT 0,
        recurrence_key TEXT,
        fingerprint TEXT NOT NULL,
        last_modified_at TEXT,
        compact_json TEXT,
        FOREIGN KEY(snapshot_id) REFERENCES snapshots(snapshot_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_snapshot_events_snapshot ON snapshot_events(snapshot_id)`,
      `CREATE INDEX IF NOT EXISTS idx_snapshot_events_event ON snapshot_events(event_id)`,
      `CREATE INDEX IF NOT EXISTS idx_snapshot_events_calendar_time ON snapshot_events(calendar_id, start_utc, end_utc)`,
      `CREATE INDEX IF NOT EXISTS idx_snapshot_events_fingerprint ON snapshot_events(fingerprint)`,
      `CREATE TABLE IF NOT EXISTS change_feed (
        change_id TEXT PRIMARY KEY,
        snapshot_id TEXT,
        operation_id TEXT,
        change_type TEXT NOT NULL,
        event_id TEXT,
        native_event_id TEXT,
        calendar_id TEXT,
        changed_fields_json TEXT,
        before_fingerprint TEXT,
        after_fingerprint TEXT,
        summary TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_change_feed_snapshot ON change_feed(snapshot_id)`,
      `CREATE INDEX IF NOT EXISTS idx_change_feed_operation ON change_feed(operation_id)`,
      `CREATE INDEX IF NOT EXISTS idx_change_feed_created ON change_feed(created_at)`,
      `CREATE TABLE IF NOT EXISTS rollback_operations (
        rollback_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        event_id TEXT,
        native_event_id TEXT,
        calendar_id TEXT,
        before_state_json TEXT,
        after_state_json TEXT,
        rollback_strategy TEXT NOT NULL,
        rollback_status TEXT NOT NULL DEFAULT 'available',
        created_at TEXT NOT NULL,
        expires_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rollback_operation ON rollback_operations(operation_id)`,
      `CREATE INDEX IF NOT EXISTS idx_rollback_event ON rollback_operations(event_id)`,
      `CREATE INDEX IF NOT EXISTS idx_rollback_status ON rollback_operations(rollback_status)`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        audit_id TEXT PRIMARY KEY,
        operation_id TEXT,
        timestamp TEXT NOT NULL,
        client_name TEXT,
        tool_name TEXT NOT NULL,
        action TEXT NOT NULL,
        result TEXT NOT NULL,
        calendar_id TEXT,
        event_id TEXT,
        risk_level TEXT NOT NULL,
        summary TEXT,
        error_code TEXT,
        metadata_json TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_operation ON audit_log(operation_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_log(tool_name)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_log(result)`,
      `CREATE TABLE IF NOT EXISTS idempotency_keys (
        idempotency_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        operation_hash TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT,
        event_id TEXT,
        operation_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_idempotency_key ON idempotency_keys(idempotency_key)`,
      `CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at)`,
      `CREATE TABLE IF NOT EXISTS confirmation_tokens (
        confirmation_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        operation_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        pending_action_json TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
      )`
    ]
  }
];
