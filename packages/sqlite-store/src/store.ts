import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AuditLogRecordSchema,
  CalendarSchema,
  ChangeFeedRecordSchema,
  ConfigKeySchema,
  ConfigRecordSchema,
  ConfirmationTokenSchema,
  IdempotencyRecordSchema,
  RollbackOperationSchema,
  SchemaMigrationRecordSchema,
  SnapshotEventSchema,
  SnapshotSchema,
  type AuditLogRecord,
  type Calendar,
  type ChangeFeedRecord,
  type ConfigKey,
  type ConfigRecord,
  type ConfirmationToken,
  type IdempotencyRecord,
  type RollbackOperation,
  type SchemaMigrationRecord,
  type Snapshot,
  type SnapshotEvent
} from "@apple-calendar-mcp/shared";
import { MIGRATIONS } from "./migrations.js";
import { databaseMigrationFailed, SqliteStoreError } from "./errors.js";
import { DEFAULT_DATABASE_PATH } from "./paths.js";
import { validateMigrations } from "./migrations.js";

type DatabaseRow = Record<string, unknown>;

export const RETENTION_DAYS = {
  audit_log: 90,
  rollback_operations: 30,
  idempotency_keys: 7,
  snapshots: 30,
  change_feed: 30
} as const;

export type StoreOptions = {
  path?: string;
};

export class AppleCalendarSqliteStore {
  private readonly database: DatabaseSync;

  constructor(options: StoreOptions = {}) {
    const path = options.path ?? DEFAULT_DATABASE_PATH;
    prepareDatabasePath(path);
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.applyMigrations();
    secureDatabaseFile(path);
  }

  close(): void {
    this.database.close();
  }

  applyMigrations(): void {
    this.database.exec("BEGIN IMMEDIATE");

    try {
      this.database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`);
      validateMigrations(MIGRATIONS);

      const applied = new Set(
        this.database
          .prepare("SELECT version FROM schema_migrations")
          .all()
          .map((row) => Number((row as DatabaseRow).version))
      );

      for (const migration of MIGRATIONS) {
        if (applied.has(migration.version)) {
          continue;
        }

        for (const statement of migration.statements) {
          this.database.exec(statement);
        }

        const record = SchemaMigrationRecordSchema.parse({
          version: migration.version,
          applied_at: nowIso()
        });

        this.database
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(record.version, record.applied_at);
      }

      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (error instanceof SqliteStoreError) {
        throw error;
      }

      throw databaseMigrationFailed("SQLite migration failed.");
    }
  }

  listMigrations(): SchemaMigrationRecord[] {
    return this.database
      .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => SchemaMigrationRecordSchema.parse(row));
  }

  setConfig(record: ConfigRecord): void {
    const parsed = ConfigRecordSchema.parse(record);

    this.database
      .prepare(
        `INSERT INTO config (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(parsed.key, JSON.stringify(parsed.value), parsed.updated_at);
  }

  getConfig(key: ConfigKey): ConfigRecord | null {
    const parsedKey = ConfigKeySchema.parse(key);
    const row = this.database
      .prepare("SELECT key, value_json, updated_at FROM config WHERE key = ?")
      .get(parsedKey) as DatabaseRow | undefined;

    if (!row) {
      return null;
    }

    return ConfigRecordSchema.parse({
      key: row.key,
      value: parseJson(String(row.value_json)),
      updated_at: row.updated_at
    });
  }

  upsertCalendar(record: Calendar, timestamps: { created_at?: string; updated_at?: string } = {}): void {
    const parsed = CalendarSchema.parse(record);
    const createdAt = timestamps.created_at ?? nowIso();
    const updatedAt = timestamps.updated_at ?? nowIso();

    this.database
      .prepare(
        `INSERT INTO calendars_cache (
          calendar_id,
          native_calendar_id,
          title,
          source_title,
          allows_content_modifications,
          is_subscribed,
          is_allowed,
          color,
          last_seen_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(calendar_id) DO UPDATE SET
          native_calendar_id = excluded.native_calendar_id,
          title = excluded.title,
          source_title = excluded.source_title,
          allows_content_modifications = excluded.allows_content_modifications,
          is_subscribed = excluded.is_subscribed,
          is_allowed = excluded.is_allowed,
          color = excluded.color,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at`
      )
      .run(
        parsed.calendar_id,
        parsed.native_calendar_id,
        parsed.title,
        parsed.source_title,
        boolToInt(parsed.allows_content_modifications),
        boolToInt(parsed.is_subscribed),
        boolToInt(parsed.is_allowed),
        parsed.color,
        parsed.last_seen_at,
        createdAt,
        updatedAt
      );
  }

  getCalendar(calendarId: string): Calendar | null {
    const row = this.database
      .prepare("SELECT * FROM calendars_cache WHERE calendar_id = ?")
      .get(calendarId) as DatabaseRow | undefined;

    return row ? calendarFromRow(row) : null;
  }

  listAllowedCalendars(): Calendar[] {
    return this.database
      .prepare("SELECT * FROM calendars_cache WHERE is_allowed = 1 ORDER BY title")
      .all()
      .map((row) => calendarFromRow(row as DatabaseRow));
  }

  createSnapshot(record: Snapshot): void {
    const parsed = SnapshotSchema.parse(record);

    this.database
      .prepare(
        `INSERT INTO snapshots (
          snapshot_id,
          scope_json,
          created_at,
          created_by,
          event_count,
          hash,
          notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        parsed.snapshot_id,
        snapshotScopeJson(parsed.scope),
        parsed.created_at,
        parsed.created_by,
        parsed.event_count,
        parsed.hash,
        parsed.notes
      );
  }

  createSnapshotBundle(record: Snapshot, events: SnapshotEvent[], changes: ChangeFeedRecord[]): void {
    this.database.exec("BEGIN IMMEDIATE");

    try {
      this.createSnapshot(record);
      for (const event of events) {
        this.addSnapshotEvent(event);
      }
      for (const change of changes) {
        this.addChange(change);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getSnapshot(snapshotId: string): Snapshot | null {
    const row = this.database
      .prepare("SELECT * FROM snapshots WHERE snapshot_id = ?")
      .get(snapshotId) as DatabaseRow | undefined;

    return row ? snapshotFromRow(row) : null;
  }

  getLatestSnapshotForScope(scope: Snapshot["scope"], beforeCreatedAt: string): Snapshot | null {
    const row = this.database
      .prepare(
        `SELECT * FROM snapshots
         WHERE scope_json = ? AND created_at <= ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(snapshotScopeJson(scope), beforeCreatedAt) as DatabaseRow | undefined;

    return row ? snapshotFromRow(row) : null;
  }

  listSnapshotEvents(snapshotId: string): SnapshotEvent[] {
    return this.database
      .prepare("SELECT * FROM snapshot_events WHERE snapshot_id = ? ORDER BY start_utc, event_id")
      .all(snapshotId)
      .map((row) => snapshotEventFromRow(row as DatabaseRow));
  }

  listSnapshotEventsPage(snapshotId: string, limit: number, offset: number): SnapshotEvent[] {
    return this.database
      .prepare(
        `SELECT * FROM snapshot_events
         WHERE snapshot_id = ?
         ORDER BY start_utc, event_id
         LIMIT ? OFFSET ?`
      )
      .all(snapshotId, limit, offset)
      .map((row) => snapshotEventFromRow(row as DatabaseRow));
  }

  addSnapshotEvent(record: SnapshotEvent): void {
    const parsed = SnapshotEventSchema.parse(record);

    this.database
      .prepare(
        `INSERT INTO snapshot_events (
          snapshot_event_id,
          snapshot_id,
          event_id,
          native_event_id,
          calendar_id,
          title_hash,
          title_preview,
          start_utc,
          end_utc,
          timezone,
          is_all_day,
          is_recurring,
          recurrence_key,
          fingerprint,
          last_modified_at,
          compact_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        parsed.snapshot_event_id,
        parsed.snapshot_id,
        parsed.event_id,
        parsed.native_event_id,
        parsed.calendar_id,
        parsed.title_hash,
        parsed.title_preview,
        parsed.start_utc,
        parsed.end_utc,
        parsed.timezone,
        boolToInt(parsed.is_all_day),
        boolToInt(parsed.is_recurring),
        parsed.recurrence_key,
        parsed.fingerprint,
        parsed.last_modified_at,
        parsed.compact === null ? null : JSON.stringify(parsed.compact)
      );
  }

  addChange(record: ChangeFeedRecord): void {
    const parsed = ChangeFeedRecordSchema.parse(record);

    this.database
      .prepare(
        `INSERT INTO change_feed (
          change_id,
          snapshot_id,
          operation_id,
          change_type,
          event_id,
          native_event_id,
          calendar_id,
          changed_fields_json,
          before_fingerprint,
          after_fingerprint,
          summary,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        parsed.change_id,
        parsed.snapshot_id,
        parsed.operation_id,
        parsed.change_type,
        parsed.event_id,
        parsed.native_event_id,
        parsed.calendar_id,
        JSON.stringify(parsed.changed_fields),
        parsed.before_fingerprint,
        parsed.after_fingerprint,
        parsed.summary,
        parsed.created_at
      );
  }

  getChange(changeId: string): ChangeFeedRecord | null {
    const row = this.database
      .prepare("SELECT * FROM change_feed WHERE change_id = ?")
      .get(changeId) as DatabaseRow | undefined;

    return row ? changeFromRow(row) : null;
  }

  getLatestChange(): ChangeFeedRecord | null {
    const row = this.database
      .prepare("SELECT * FROM change_feed ORDER BY created_at DESC, change_id DESC LIMIT 1")
      .get() as DatabaseRow | undefined;

    return row ? changeFromRow(row) : null;
  }

  getLatestChangeForOperation(operationId: string): ChangeFeedRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM change_feed
         WHERE operation_id = ?
         ORDER BY created_at DESC, change_id DESC
         LIMIT 1`
      )
      .get(operationId) as DatabaseRow | undefined;

    return row ? changeFromRow(row) : null;
  }

  getLatestChangeForAllowedCalendars(allowedCalendarIds: string[]): ChangeFeedRecord | null {
    if (allowedCalendarIds.length === 0) {
      const row = this.database
        .prepare(
          `SELECT * FROM change_feed
           WHERE calendar_id IS NULL
           ORDER BY created_at DESC, change_id DESC
           LIMIT 1`
        )
        .get() as DatabaseRow | undefined;

      return row ? changeFromRow(row) : null;
    }

    const row = this.database
      .prepare(
        `SELECT * FROM change_feed
         WHERE calendar_id IS NULL OR calendar_id IN (${allowedCalendarIds.map(() => "?").join(", ")})
         ORDER BY created_at DESC, change_id DESC
         LIMIT 1`
      )
      .get(...allowedCalendarIds) as DatabaseRow | undefined;

    return row ? changeFromRow(row) : null;
  }

  listChangesSince(
    createdAt: string,
    filters: {
      calendarId?: string;
      snapshotId?: string;
    } = {}
  ): ChangeFeedRecord[] {
    const conditions = ["created_at > ?"];
    const params: unknown[] = [createdAt];

    if (filters.calendarId) {
      conditions.push("calendar_id = ?");
      params.push(filters.calendarId);
    }

    if (filters.snapshotId) {
      conditions.push("(snapshot_id IS NULL OR snapshot_id != ?)");
      params.push(filters.snapshotId);
    }

    return this.database
      .prepare(
        `SELECT * FROM change_feed
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at, change_id`
      )
      .all(...params)
      .map((row) => changeFromRow(row as DatabaseRow));
  }

  listChangesSincePage(
    createdAt: string,
    filters: {
      calendarId?: string;
      snapshotId?: string;
      allowedCalendarIds?: string[];
    },
    limit: number,
    offset: number
  ): ChangeFeedRecord[] {
    const conditions = ["created_at > ?"];
    const params: unknown[] = [createdAt];

    if (filters.calendarId) {
      conditions.push("calendar_id = ?");
      params.push(filters.calendarId);
    } else if (filters.allowedCalendarIds && filters.allowedCalendarIds.length > 0) {
      conditions.push(`(calendar_id IS NULL OR calendar_id IN (${filters.allowedCalendarIds.map(() => "?").join(", ")}))`);
      params.push(...filters.allowedCalendarIds);
    } else {
      conditions.push("calendar_id IS NULL");
    }

    if (filters.snapshotId) {
      conditions.push("(snapshot_id IS NULL OR snapshot_id != ?)");
      params.push(filters.snapshotId);
    }

    params.push(limit, offset);

    return this.database
      .prepare(
        `SELECT * FROM change_feed
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at, change_id
         LIMIT ? OFFSET ?`
      )
      .all(...params)
      .map((row) => changeFromRow(row as DatabaseRow));
  }

  addRollbackOperation(record: RollbackOperation): void {
    const parsed = RollbackOperationSchema.parse(record);

    this.database
      .prepare(
        `INSERT INTO rollback_operations (
          rollback_id,
          operation_id,
          tool_name,
          operation_type,
          event_id,
          native_event_id,
          calendar_id,
          before_state_json,
          after_state_json,
          rollback_strategy,
          rollback_status,
          created_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        + ` ON CONFLICT(rollback_id) DO UPDATE SET
          event_id = excluded.event_id,
          native_event_id = excluded.native_event_id,
          calendar_id = excluded.calendar_id,
          before_state_json = excluded.before_state_json,
          after_state_json = excluded.after_state_json,
          rollback_strategy = excluded.rollback_strategy,
          rollback_status = excluded.rollback_status,
          expires_at = excluded.expires_at`
      )
      .run(
        parsed.rollback_id,
        parsed.operation_id,
        parsed.tool_name,
        parsed.operation_type,
        parsed.event_id,
        parsed.native_event_id,
        parsed.calendar_id,
        parsed.before_state === null ? null : JSON.stringify(parsed.before_state),
        parsed.after_state === null ? null : JSON.stringify(parsed.after_state),
        parsed.rollback_strategy,
        parsed.rollback_status,
        parsed.created_at,
        parsed.expires_at
      );
  }

  getRollbackOperation(rollbackId: string): RollbackOperation | null {
    const row = this.database
      .prepare("SELECT * FROM rollback_operations WHERE rollback_id = ?")
      .get(rollbackId) as DatabaseRow | undefined;

    return row ? rollbackFromRow(row) : null;
  }

  getLatestRollbackOperation(): RollbackOperation | null {
    const row = this.database
      .prepare("SELECT * FROM rollback_operations ORDER BY created_at DESC, rollback_id DESC LIMIT 1")
      .get() as DatabaseRow | undefined;

    return row ? rollbackFromRow(row) : null;
  }

  getLatestRollbackOperationForOperation(operationId: string): RollbackOperation | null {
    const row = this.database
      .prepare(
        `SELECT * FROM rollback_operations
         WHERE operation_id = ?
         ORDER BY created_at DESC, rollback_id DESC
         LIMIT 1`
      )
      .get(operationId) as DatabaseRow | undefined;

    return row ? rollbackFromRow(row) : null;
  }

  getLatestRollbackOperationForAllowedCalendars(allowedCalendarIds: string[]): RollbackOperation | null {
    if (allowedCalendarIds.length === 0) {
      return null;
    }

    const row = this.database
      .prepare(
        `SELECT * FROM rollback_operations
         WHERE calendar_id IN (${allowedCalendarIds.map(() => "?").join(", ")})
         ORDER BY created_at DESC, rollback_id DESC
         LIMIT 1`
      )
      .get(...allowedCalendarIds) as DatabaseRow | undefined;

    return row ? rollbackFromRow(row) : null;
  }

  countRollbackOperationsByStatus(status: RollbackOperation["rollback_status"]): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM rollback_operations WHERE rollback_status = ?")
      .get(status) as DatabaseRow | undefined;

    return Number(row?.count ?? 0);
  }

  countRollbackOperationsByStatusForAllowedCalendars(
    status: RollbackOperation["rollback_status"],
    allowedCalendarIds: string[]
  ): number {
    if (allowedCalendarIds.length === 0) {
      return 0;
    }

    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM rollback_operations
         WHERE rollback_status = ? AND calendar_id IN (${allowedCalendarIds.map(() => "?").join(", ")})`
      )
      .get(status, ...allowedCalendarIds) as DatabaseRow | undefined;

    return Number(row?.count ?? 0);
  }

  addAuditLog(record: AuditLogRecord): void {
    const parsed = AuditLogRecordSchema.parse(record);

    this.database
      .prepare(
        `INSERT INTO audit_log (
          audit_id,
          operation_id,
          timestamp,
          client_name,
          tool_name,
          action,
          result,
          calendar_id,
          event_id,
          risk_level,
          summary,
          error_code,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        parsed.audit_id,
        parsed.operation_id,
        parsed.timestamp,
        parsed.client_name,
        parsed.tool_name,
        parsed.action,
        parsed.result,
        parsed.calendar_id,
        parsed.event_id,
        parsed.risk_level,
        parsed.summary,
        parsed.error_code,
        parsed.metadata === null ? null : JSON.stringify(parsed.metadata)
      );
  }

  getLatestAuditLog(): AuditLogRecord | null {
    const row = this.database
      .prepare("SELECT * FROM audit_log ORDER BY timestamp DESC, audit_id DESC LIMIT 1")
      .get() as DatabaseRow | undefined;

    return row ? auditFromRow(row) : null;
  }

  getLatestAuditLogForOperation(operationId: string): AuditLogRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM audit_log
         WHERE operation_id = ?
         ORDER BY timestamp DESC, audit_id DESC
         LIMIT 1`
      )
      .get(operationId) as DatabaseRow | undefined;

    return row ? auditFromRow(row) : null;
  }

  listRecentAuditLogs(limit: number): AuditLogRecord[] {
    return this.database
      .prepare("SELECT * FROM audit_log ORDER BY timestamp DESC, audit_id DESC LIMIT ?")
      .all(limit)
      .map((row) => auditFromRow(row as DatabaseRow));
  }

  listRecentAuditLogsForAllowedCalendars(allowedCalendarIds: string[], limit: number): AuditLogRecord[] {
    if (allowedCalendarIds.length === 0) {
      return this.database
        .prepare(
          `SELECT * FROM audit_log
           WHERE calendar_id IS NULL
           ORDER BY timestamp DESC, audit_id DESC
           LIMIT ?`
        )
        .all(limit)
        .map((row) => auditFromRow(row as DatabaseRow));
    }

    return this.database
      .prepare(
        `SELECT * FROM audit_log
         WHERE calendar_id IS NULL OR calendar_id IN (${allowedCalendarIds.map(() => "?").join(", ")})
         ORDER BY timestamp DESC, audit_id DESC
         LIMIT ?`
      )
      .all(...allowedCalendarIds, limit)
      .map((row) => auditFromRow(row as DatabaseRow));
  }

  putIdempotencyKey(record: IdempotencyRecord): void {
    const parsed = IdempotencyRecordSchema.parse(record);

    this.database
      .prepare(
        `INSERT INTO idempotency_keys (
          idempotency_id,
          idempotency_key,
          operation_hash,
          tool_name,
          request_hash,
          response_json,
          event_id,
          operation_id,
          status,
          created_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          operation_hash = excluded.operation_hash,
          tool_name = excluded.tool_name,
          request_hash = excluded.request_hash,
          response_json = excluded.response_json,
          event_id = excluded.event_id,
          operation_id = excluded.operation_id,
          status = excluded.status,
          expires_at = excluded.expires_at`
      )
      .run(
        parsed.idempotency_id,
        parsed.idempotency_key,
        parsed.operation_hash,
        parsed.tool_name,
        parsed.request_hash,
        parsed.response === null ? null : JSON.stringify(parsed.response),
        parsed.event_id,
        parsed.operation_id,
        parsed.status,
        parsed.created_at,
        parsed.expires_at
      );
  }

  getIdempotencyKey(idempotencyKey: string): IdempotencyRecord | null {
    const row = this.database
      .prepare("SELECT * FROM idempotency_keys WHERE idempotency_key = ?")
      .get(idempotencyKey) as DatabaseRow | undefined;

    return row ? idempotencyFromRow(row) : null;
  }

  putConfirmationToken(record: ConfirmationToken): void {
    const parsed = ConfirmationTokenSchema.parse(record);

    this.database
      .prepare(
        `INSERT INTO confirmation_tokens (
          confirmation_id,
          token_hash,
          operation_id,
          tool_name,
          pending_action_json,
          risk_level,
          created_at,
          expires_at,
          used_at,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_hash) DO UPDATE SET
          used_at = excluded.used_at,
          status = excluded.status`
      )
      .run(
        parsed.confirmation_id,
        parsed.token_hash,
        parsed.operation_id,
        parsed.tool_name,
        JSON.stringify(parsed.pending_action),
        parsed.risk_level,
        parsed.created_at,
        parsed.expires_at,
        parsed.used_at,
        parsed.status
      );
  }

  getConfirmationTokenByHash(tokenHash: string): ConfirmationToken | null {
    const row = this.database
      .prepare("SELECT * FROM confirmation_tokens WHERE token_hash = ?")
      .get(tokenHash) as DatabaseRow | undefined;

    return row ? confirmationFromRow(row) : null;
  }

  tableNames(): string[] {
    return this.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String((row as DatabaseRow).name));
  }

  cleanupExpired(referenceDate = new Date()): void {
    const referenceIso = referenceDate.toISOString();
    const auditBefore = daysBefore(referenceDate, RETENTION_DAYS.audit_log);
    const rollbackBefore = daysBefore(referenceDate, RETENTION_DAYS.rollback_operations);
    const idempotencyBefore = daysBefore(referenceDate, RETENTION_DAYS.idempotency_keys);
    const snapshotBefore = daysBefore(referenceDate, RETENTION_DAYS.snapshots);
    const changeBefore = daysBefore(referenceDate, RETENTION_DAYS.change_feed);

    this.database.exec("BEGIN IMMEDIATE");

    try {
      this.database.prepare("DELETE FROM confirmation_tokens WHERE expires_at <= ?").run(referenceIso);
      this.database.prepare("DELETE FROM idempotency_keys WHERE expires_at <= ? OR created_at <= ?").run(referenceIso, idempotencyBefore);
      this.database.prepare("DELETE FROM rollback_operations WHERE expires_at <= ? OR created_at <= ?").run(referenceIso, rollbackBefore);
      this.database.prepare("DELETE FROM audit_log WHERE timestamp <= ?").run(auditBefore);
      this.database.prepare("DELETE FROM change_feed WHERE created_at <= ?").run(changeBefore);
      this.database
        .prepare(
          `DELETE FROM snapshot_events
           WHERE snapshot_id IN (
             SELECT snapshot_id FROM snapshots WHERE created_at <= ?
           )`
        )
        .run(snapshotBefore);
      this.database.prepare("DELETE FROM snapshots WHERE created_at <= ?").run(snapshotBefore);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  clearAuditLogs(): void {
    this.database.prepare("DELETE FROM audit_log").run();
  }

  clearRollbackRecords(): void {
    this.database.prepare("DELETE FROM rollback_operations").run();
  }

  clearSnapshots(): void {
    this.database.exec("BEGIN IMMEDIATE");

    try {
      this.database.prepare("DELETE FROM snapshot_events").run();
      this.database.prepare("DELETE FROM snapshots").run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  resetLocalState(): void {
    this.database.exec("BEGIN IMMEDIATE");

    try {
      this.database.prepare("DELETE FROM confirmation_tokens").run();
      this.database.prepare("DELETE FROM idempotency_keys").run();
      this.database.prepare("DELETE FROM audit_log").run();
      this.database.prepare("DELETE FROM rollback_operations").run();
      this.database.prepare("DELETE FROM change_feed").run();
      this.database.prepare("DELETE FROM snapshot_events").run();
      this.database.prepare("DELETE FROM snapshots").run();
      this.database.prepare("DELETE FROM calendars_cache").run();
      this.database.prepare("DELETE FROM config").run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function prepareDatabasePath(path: string): void {
  if (path === ":memory:") {
    return;
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function secureDatabaseFile(path: string): void {
  if (path === ":memory:") {
    return;
  }

  chmodSync(path, 0o600);
}

function nowIso(): string {
  return new Date().toISOString();
}

function daysBefore(referenceDate: Date, days: number): string {
  return new Date(referenceDate.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

function intToBool(value: unknown): boolean {
  return Number(value) === 1;
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function snapshotScopeJson(scope: Snapshot["scope"]): string {
  return JSON.stringify({
    calendar_ids: [...scope.calendar_ids].sort(),
    start_utc: scope.start_utc,
    end_utc: scope.end_utc
  });
}

function calendarFromRow(row: DatabaseRow): Calendar {
  return CalendarSchema.parse({
    calendar_id: row.calendar_id,
    native_calendar_id: row.native_calendar_id,
    title: row.title,
    source_title: row.source_title ?? null,
    allows_content_modifications: intToBool(row.allows_content_modifications),
    is_subscribed: intToBool(row.is_subscribed),
    is_allowed: intToBool(row.is_allowed),
    color: row.color ?? null,
    last_seen_at: row.last_seen_at
  });
}

function snapshotFromRow(row: DatabaseRow): Snapshot {
  return SnapshotSchema.parse({
    snapshot_id: row.snapshot_id,
    scope: parseJson(String(row.scope_json)),
    created_at: row.created_at,
    created_by: row.created_by ?? null,
    event_count: row.event_count,
    hash: row.hash,
    notes: row.notes ?? null
  });
}

function snapshotEventFromRow(row: DatabaseRow): SnapshotEvent {
  return SnapshotEventSchema.parse({
    snapshot_event_id: row.snapshot_event_id,
    snapshot_id: row.snapshot_id,
    event_id: row.event_id,
    native_event_id: row.native_event_id ?? null,
    calendar_id: row.calendar_id,
    title_hash: row.title_hash,
    title_preview: row.title_preview ?? null,
    start_utc: row.start_utc,
    end_utc: row.end_utc,
    timezone: row.timezone ?? null,
    is_all_day: intToBool(row.is_all_day),
    is_recurring: intToBool(row.is_recurring),
    recurrence_key: row.recurrence_key ?? null,
    fingerprint: row.fingerprint,
    last_modified_at: row.last_modified_at ?? null,
    compact: row.compact_json === null ? null : parseJson(String(row.compact_json))
  });
}

function changeFromRow(row: DatabaseRow): ChangeFeedRecord {
  return ChangeFeedRecordSchema.parse({
    change_id: row.change_id,
    snapshot_id: row.snapshot_id ?? null,
    operation_id: row.operation_id ?? null,
    change_type: row.change_type,
    event_id: row.event_id ?? null,
    native_event_id: row.native_event_id ?? null,
    calendar_id: row.calendar_id ?? null,
    changed_fields: parseJson(String(row.changed_fields_json)),
    before_fingerprint: row.before_fingerprint ?? null,
    after_fingerprint: row.after_fingerprint ?? null,
    summary: row.summary ?? null,
    created_at: row.created_at
  });
}

function rollbackFromRow(row: DatabaseRow): RollbackOperation {
  return RollbackOperationSchema.parse({
    rollback_id: row.rollback_id,
    operation_id: row.operation_id,
    tool_name: row.tool_name,
    operation_type: row.operation_type,
    event_id: row.event_id ?? null,
    native_event_id: row.native_event_id ?? null,
    calendar_id: row.calendar_id ?? null,
    before_state: row.before_state_json === null ? null : parseJson(String(row.before_state_json)),
    after_state: row.after_state_json === null ? null : parseJson(String(row.after_state_json)),
    rollback_strategy: row.rollback_strategy,
    rollback_status: row.rollback_status,
    created_at: row.created_at,
    expires_at: row.expires_at ?? null
  });
}

function auditFromRow(row: DatabaseRow): AuditLogRecord {
  return AuditLogRecordSchema.parse({
    audit_id: row.audit_id,
    operation_id: row.operation_id ?? null,
    timestamp: row.timestamp,
    client_name: row.client_name ?? null,
    tool_name: row.tool_name,
    action: row.action,
    result: row.result,
    calendar_id: row.calendar_id ?? null,
    event_id: row.event_id ?? null,
    risk_level: row.risk_level,
    summary: row.summary ?? null,
    error_code: row.error_code ?? null,
    metadata: row.metadata_json === null ? null : parseJson(String(row.metadata_json))
  });
}

function idempotencyFromRow(row: DatabaseRow): IdempotencyRecord {
  return IdempotencyRecordSchema.parse({
    idempotency_id: row.idempotency_id,
    idempotency_key: row.idempotency_key,
    operation_hash: row.operation_hash,
    tool_name: row.tool_name,
    request_hash: row.request_hash,
    response: row.response_json === null ? null : parseJson(String(row.response_json)),
    event_id: row.event_id ?? null,
    operation_id: row.operation_id ?? null,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at
  });
}

function confirmationFromRow(row: DatabaseRow): ConfirmationToken {
  return ConfirmationTokenSchema.parse({
    confirmation_id: row.confirmation_id,
    token_hash: row.token_hash,
    operation_id: row.operation_id,
    tool_name: row.tool_name,
    pending_action: parseJson(String(row.pending_action_json)),
    risk_level: row.risk_level,
    created_at: row.created_at,
    expires_at: row.expires_at,
    used_at: row.used_at ?? null,
    status: row.status
  });
}
