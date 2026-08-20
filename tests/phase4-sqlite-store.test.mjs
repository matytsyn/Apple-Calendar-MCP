import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AppleCalendarSqliteStore,
  validateMigrations
} from "../packages/sqlite-store/dist/index.js";

const hash = `sha256:${"a".repeat(64)}`;
const fingerprint = `sha256:${"b".repeat(64)}`;

async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-store-"));
  const path = join(dir, "state.sqlite");
  return {
    path,
    store: new AppleCalendarSqliteStore({ path })
  };
}

test("SQLite migrations create DATA_MODEL tables and indexes", async () => {
  const { path, store } = await createStore();

  try {
    assert.deepEqual(store.listMigrations(), [
      {
        version: 1,
        applied_at: store.listMigrations()[0].applied_at
      }
    ]);

    assert.deepEqual(store.tableNames(), [
      "audit_log",
      "calendars_cache",
      "change_feed",
      "config",
      "confirmation_tokens",
      "idempotency_keys",
      "rollback_operations",
      "schema_migrations",
      "snapshot_events",
      "snapshots"
    ]);
  } finally {
    store.close();
  }

  const database = new DatabaseSync(path);
  try {
    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all()
      .map((row) => row.name);

    assert.ok(indexes.includes("idx_calendars_allowed"));
    assert.ok(indexes.includes("idx_snapshot_events_snapshot"));
    assert.ok(indexes.includes("idx_snapshot_events_event"));
    assert.ok(indexes.includes("idx_snapshot_events_calendar_time"));
    assert.ok(indexes.includes("idx_snapshot_events_fingerprint"));
    assert.ok(indexes.includes("idx_change_feed_snapshot"));
    assert.ok(indexes.includes("idx_change_feed_operation"));
    assert.ok(indexes.includes("idx_change_feed_created"));
    assert.ok(indexes.includes("idx_rollback_operation"));
    assert.ok(indexes.includes("idx_rollback_event"));
    assert.ok(indexes.includes("idx_rollback_status"));
    assert.ok(indexes.includes("idx_audit_timestamp"));
    assert.ok(indexes.includes("idx_audit_operation"));
    assert.ok(indexes.includes("idx_audit_tool"));
    assert.ok(indexes.includes("idx_audit_result"));
    assert.ok(indexes.includes("idx_idempotency_key"));
    assert.ok(indexes.includes("idx_idempotency_expires"));
  } finally {
    database.close();
  }
});

test("SQLite store validates and writes required logical stores", async () => {
  const { path, store } = await createStore();

  try {
    store.setConfig({
      key: "permission_mode",
      value: "ask_before_write",
      updated_at: "2026-06-05T04:30:00.000Z"
    });
    assert.deepEqual(store.getConfig("permission_mode"), {
      key: "permission_mode",
      value: "ask_before_write",
      updated_at: "2026-06-05T04:30:00.000Z"
    });

    store.upsertCalendar({
      calendar_id: "cal_12345678",
      native_calendar_id: "eventkit-calendar-id",
      title: "Work",
      source_title: "iCloud",
      allows_content_modifications: true,
      is_subscribed: false,
      is_allowed: true,
      color: "#3366FF",
      last_seen_at: "2026-06-05T04:30:00.000Z"
    });
    assert.equal(store.listAllowedCalendars().length, 1);

    store.createSnapshot({
      snapshot_id: "snap_12345678",
      scope: {
        calendar_ids: ["cal_12345678"],
        start_utc: "2026-06-01T00:00:00.000Z",
        end_utc: "2026-06-30T00:00:00.000Z"
      },
      created_at: "2026-06-05T04:30:00.000Z",
      created_by: "unknown_mcp_client",
      event_count: 1,
      hash,
      notes: null
    });
    assert.equal(store.getSnapshot("snap_12345678")?.event_count, 1);

    store.addSnapshotEvent({
      snapshot_event_id: "snap_evt_12345678",
      snapshot_id: "snap_12345678",
      event_id: "evt_12345678",
      native_event_id: "eventkit-event-id",
      calendar_id: "cal_12345678",
      title_hash: hash,
      title_preview: "Study Session",
      start_utc: "2026-06-05T06:00:00.000Z",
      end_utc: "2026-06-05T07:00:00.000Z",
      timezone: "Asia/Makassar",
      is_all_day: false,
      is_recurring: false,
      recurrence_key: null,
      fingerprint,
      last_modified_at: null,
      compact: null
    });

    store.addChange({
      change_id: "chg_12345678",
      snapshot_id: "snap_12345678",
      operation_id: "op_12345678",
      change_type: "created",
      event_id: "evt_12345678",
      native_event_id: "eventkit-event-id",
      calendar_id: "cal_12345678",
      changed_fields: ["title"],
      before_fingerprint: null,
      after_fingerprint: fingerprint,
      summary: "Created event.",
      created_at: "2026-06-05T04:30:00.000Z"
    });

    store.addRollbackOperation({
      rollback_id: "rb_12345678",
      operation_id: "op_12345678",
      tool_name: "calendar_create_event",
      operation_type: "create",
      event_id: "evt_12345678",
      native_event_id: "eventkit-event-id",
      calendar_id: "cal_12345678",
      before_state: null,
      after_state: { event_id: "evt_12345678" },
      rollback_strategy: "delete_created_event",
      rollback_status: "available",
      created_at: "2026-06-05T04:30:00.000Z",
      expires_at: "2026-07-05T04:30:00.000Z"
    });

    store.addAuditLog({
      audit_id: "audit_12345678",
      operation_id: "op_12345678",
      timestamp: "2026-06-05T04:30:00.000Z",
      client_name: "unknown_mcp_client",
      tool_name: "calendar_create_event",
      action: "create_event",
      result: "success",
      calendar_id: "cal_12345678",
      event_id: "evt_12345678",
      risk_level: "medium",
      summary: "Created event.",
      error_code: null,
      metadata: { idempotent_replay: false }
    });

    store.putIdempotencyKey({
      idempotency_id: "idem_12345678",
      idempotency_key: "client-key-123",
      operation_hash: hash,
      tool_name: "calendar_create_event",
      request_hash: hash,
      response: {
        success: true,
        data: { event_id: "evt_12345678" },
        meta: {}
      },
      event_id: "evt_12345678",
      operation_id: "op_12345678",
      status: "completed",
      created_at: "2026-06-05T04:30:00.000Z",
      expires_at: "2026-06-12T04:30:00.000Z"
    });
    assert.equal(store.getIdempotencyKey("client-key-123")?.status, "completed");

    store.putConfirmationToken({
      confirmation_id: "confirm_12345678",
      token_hash: hash,
      operation_id: "op_12345678",
      tool_name: "calendar_delete_event",
      pending_action: { event_id: "evt_12345678" },
      risk_level: "high",
      created_at: "2026-06-05T04:30:00.000Z",
      expires_at: "2026-06-05T04:45:00.000Z",
      used_at: null,
      status: "pending"
    });
    assert.equal(store.getConfirmationTokenByHash(hash)?.status, "pending");
  } finally {
    store.close();
  }

  const database = new DatabaseSync(path);
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM snapshot_events").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM change_feed").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM rollback_operations").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM confirmation_tokens").get().count, 1);
  } finally {
    database.close();
  }
});

test("SQLite store rejects invalid records before writing", async () => {
  const { store } = await createStore();

  try {
    assert.throws(() =>
      store.setConfig({
        key: "permission_mode",
        value: "full",
        updated_at: "2026-06-05T04:30:00.000Z"
      })
    );
  } finally {
    store.close();
  }
});

test("SQLite migration validation rejects non-sequential versions", () => {
  assert.throws(() =>
    validateMigrations([
      {
        version: 1,
        statements: []
      },
      {
        version: 3,
        statements: []
      }
    ])
  );
});

test("SQLite store applies DATA_MODEL retention and reset helpers", async () => {
  const { path, store } = await createStore();

  try {
    store.createSnapshot({
      snapshot_id: "snap_87654321",
      scope: {
        calendar_ids: ["cal_12345678"],
        start_utc: "2026-04-01T00:00:00.000Z",
        end_utc: "2026-04-30T00:00:00.000Z"
      },
      created_at: "2026-04-01T00:00:00.000Z",
      created_by: "unknown_mcp_client",
      event_count: 1,
      hash,
      notes: null
    });
    store.addSnapshotEvent({
      snapshot_event_id: "snap_evt_87654321",
      snapshot_id: "snap_87654321",
      event_id: "evt_87654321",
      native_event_id: "eventkit-event-id",
      calendar_id: "cal_12345678",
      title_hash: hash,
      title_preview: "Old Study Session",
      start_utc: "2026-04-05T06:00:00.000Z",
      end_utc: "2026-04-05T07:00:00.000Z",
      timezone: "Asia/Makassar",
      is_all_day: false,
      is_recurring: false,
      recurrence_key: null,
      fingerprint,
      last_modified_at: null,
      compact: null
    });
    store.addChange({
      change_id: "chg_87654321",
      snapshot_id: "snap_87654321",
      operation_id: "op_87654321",
      change_type: "updated",
      event_id: "evt_87654321",
      native_event_id: "eventkit-event-id",
      calendar_id: "cal_12345678",
      changed_fields: ["start"],
      before_fingerprint: fingerprint,
      after_fingerprint: fingerprint,
      summary: "Old change.",
      created_at: "2026-04-01T00:00:00.000Z"
    });
    store.addRollbackOperation({
      rollback_id: "rb_87654321",
      operation_id: "op_87654321",
      tool_name: "calendar_update_event",
      operation_type: "update",
      event_id: "evt_87654321",
      native_event_id: "eventkit-event-id",
      calendar_id: "cal_12345678",
      before_state: { event_id: "evt_87654321" },
      after_state: { event_id: "evt_87654321" },
      rollback_strategy: "restore_previous_state",
      rollback_status: "available",
      created_at: "2026-04-01T00:00:00.000Z",
      expires_at: "2026-04-30T00:00:00.000Z"
    });
    store.addAuditLog({
      audit_id: "audit_87654321",
      operation_id: "op_87654321",
      timestamp: "2026-01-01T00:00:00.000Z",
      client_name: "unknown_mcp_client",
      tool_name: "calendar_update_event",
      action: "update_event",
      result: "success",
      calendar_id: "cal_12345678",
      event_id: "evt_87654321",
      risk_level: "medium",
      summary: "Old audit.",
      error_code: null,
      metadata: null
    });
    store.putIdempotencyKey({
      idempotency_id: "idem_87654321",
      idempotency_key: "old-client-key-123",
      operation_hash: hash,
      tool_name: "calendar_update_event",
      request_hash: hash,
      response: null,
      event_id: "evt_87654321",
      operation_id: "op_87654321",
      status: "expired",
      created_at: "2026-04-01T00:00:00.000Z",
      expires_at: "2026-04-08T00:00:00.000Z"
    });
    store.putConfirmationToken({
      confirmation_id: "confirm_87654321",
      token_hash: `sha256:${"c".repeat(64)}`,
      operation_id: "op_87654321",
      tool_name: "calendar_delete_event",
      pending_action: { event_id: "evt_87654321" },
      risk_level: "high",
      created_at: "2026-04-01T00:00:00.000Z",
      expires_at: "2026-04-01T00:15:00.000Z",
      used_at: null,
      status: "pending"
    });

    store.cleanupExpired(new Date("2026-06-06T00:00:00.000Z"));
  } finally {
    store.close();
  }

  const database = new DatabaseSync(path);
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM snapshots").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM snapshot_events").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM change_feed").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM rollback_operations").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM confirmation_tokens").get().count, 0);
  } finally {
    database.close();
  }
});
