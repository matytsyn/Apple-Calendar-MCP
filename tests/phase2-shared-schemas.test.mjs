import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuditLogRecordSchema,
  CalendarSchema,
  ChangeFeedRecordSchema,
  ConfigRecordSchema,
  ConfirmationRequestSchema,
  ConfirmationTokenSchema,
  DateRangeInputSchema,
  DetailLevelSchema,
  EventSchema,
  IdempotencyRecordSchema,
  PaginationInputSchema,
  PermissionModeSchema,
  RollbackOperationSchema,
  SchemaMigrationRecordSchema,
  SemanticErrorCodeSchema,
  SemanticErrorSchema,
  SnapshotEventSchema,
  SnapshotSchema,
  ToolNameSchema,
  TimezoneSchema
} from "../packages/shared/dist/index.js";

const hash = `sha256:${"a".repeat(64)}`;
const fingerprint = `sha256:${"b".repeat(64)}`;

test("semantic error schema enforces required strict shape", () => {
  assert.equal(
    SemanticErrorSchema.parse({
      code: "INVALID_INPUT",
      message: "Invalid input.",
      suggested_action: "Fix the input and retry.",
      retryable: false
    }).code,
    "INVALID_INPUT"
  );

  assert.equal(
    SemanticErrorSchema.safeParse({
      code: "INVALID_INPUT",
      message: "Invalid input.",
      suggested_action: "Fix the input and retry.",
      retryable: false,
      stack: "hidden"
    }).success,
    false
  );

  assert.equal(SemanticErrorCodeSchema.safeParse("IDEMPOTENCY_KEY_CONFLICT").success, true);
  assert.equal(SemanticErrorCodeSchema.safeParse("DATABASE_MIGRATION_FAILED").success, true);
  assert.equal(SemanticErrorCodeSchema.safeParse("EVENTKIT_OPERATION_FAILED").success, true);
});

test("pagination, detail level, and permission mode schemas are bounded", () => {
  assert.equal(PaginationInputSchema.parse({}).limit, 50);
  assert.equal(PaginationInputSchema.safeParse({ limit: 101 }).success, false);
  assert.equal(DetailLevelSchema.safeParse("standard").success, true);
  assert.equal(DetailLevelSchema.safeParse("verbose").success, false);
  assert.equal(PermissionModeSchema.safeParse("ask_before_write").success, true);
  assert.equal(PermissionModeSchema.safeParse("unsafe_write").success, false);
});

test("tool name schema preserves calendar namespace without periods", () => {
  assert.equal(ToolNameSchema.safeParse("calendar_list_events").success, true);
  assert.equal(ToolNameSchema.safeParse("calendar_get_event").success, true);
  assert.equal(ToolNameSchema.safeParse("calendar.list_events").success, false);
  assert.equal(ToolNameSchema.safeParse("calendar-list-events").success, false);
  assert.equal(ToolNameSchema.safeParse("list_events").success, false);
});

test("date range schema requires ISO timestamps with timezone and ordered bounds", () => {
  assert.equal(
    DateRangeInputSchema.safeParse({
      start: "2026-06-05T09:00:00+08:00",
      end: "2026-06-05T10:00:00+08:00",
      timezone: "Asia/Makassar"
    }).success,
    true
  );

  assert.equal(
    DateRangeInputSchema.safeParse({
      start: "2026-06-05T09:00:00",
      end: "2026-06-05T10:00:00",
      timezone: "Asia/Makassar"
    }).success,
    false
  );

  assert.equal(
    DateRangeInputSchema.safeParse({
      start: "2026-06-05T10:00:00+08:00",
      end: "2026-06-05T09:00:00+08:00"
    }).success,
    false
  );

  assert.equal(
    DateRangeInputSchema.safeParse({
      start: "2026-99-99T10:00:00+08:00",
      end: "2026-06-05T11:00:00+08:00"
    }).success,
    false
  );

  assert.equal(TimezoneSchema.safeParse("Asia/Makassar").success, true);
  assert.equal(TimezoneSchema.safeParse("Not/AZone").success, false);
});

test("calendar schema validates normalized calendar records", () => {
  const calendar = CalendarSchema.parse({
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

  assert.equal(calendar.calendar_id, "cal_12345678");
  assert.equal(
    CalendarSchema.safeParse({
      ...calendar,
      native_event_id: "not allowed"
    }).success,
    false
  );
});

test("event schema validates normalized event records and recurrence fields", () => {
  const event = EventSchema.parse({
    event_id: "evt_12345678",
    native_event_id: "eventkit-event-id",
    calendar_id: "cal_12345678",
    native_calendar_id: "eventkit-calendar-id",
    title: "Study Session",
    start_local: "2026-06-05T14:00:00+08:00",
    end_local: "2026-06-05T15:00:00+08:00",
    start_utc: "2026-06-05T06:00:00.000Z",
    end_utc: "2026-06-05T07:00:00.000Z",
    timezone: "Asia/Makassar",
    is_all_day: false,
    location_summary: "Library",
    notes_present: true,
    attendees_present: false,
    url_present: false,
    recurrence: {
      is_recurring: false,
      series_id: null,
      instance_id: null
    },
    last_modified_at: "2026-06-05T04:30:00.000Z",
    fingerprint
  });

  assert.equal(event.event_id, "evt_12345678");
  assert.equal(EventSchema.safeParse({ ...event, start_utc: event.end_utc }).success, false);
});

test("confirmation and idempotency schemas enforce hashes and expiry order", () => {
  assert.equal(
    ConfirmationTokenSchema.safeParse({
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
    }).success,
    true
  );

  assert.equal(
    ConfirmationRequestSchema.safeParse({
      confirmation_id: "confirm_12345678",
      operation_id: "op_12345678",
      confirmation_token: "single-use-token-123",
      confirmed: true
    }).success,
    true
  );

  assert.equal(
    ConfirmationRequestSchema.safeParse({
      confirmation_id: "confirm_12345678",
      operation_id: "op_12345678",
      confirmation_token: "single-use-token-123",
      confirmed: false
    }).success,
    false
  );

  assert.equal(
    IdempotencyRecordSchema.safeParse({
      idempotency_id: "idem_12345678",
      idempotency_key: "client-key-123",
      operation_hash: hash,
      tool_name: "calendar_create_event",
      request_hash: hash,
      response: null,
      event_id: null,
      operation_id: null,
      status: "pending",
      created_at: "2026-06-05T04:30:00.000Z",
      expires_at: "2026-06-05T04:00:00.000Z"
    }).success,
    false
  );
});

test("snapshot, change feed, and rollback schemas validate state records", () => {
  assert.equal(
    SnapshotSchema.safeParse({
      snapshot_id: "snap_12345678",
      scope: {
        calendar_ids: ["cal_12345678"],
        start_utc: "2026-06-01T00:00:00.000Z",
        end_utc: "2026-06-30T00:00:00.000Z"
      },
      created_at: "2026-06-05T04:30:00.000Z",
      created_by: "unknown_mcp_client",
      event_count: 10,
      hash,
      notes: null
    }).success,
    true
  );

  assert.equal(
    SnapshotEventSchema.safeParse({
      snapshot_event_id: "snap_evt_12345678",
      snapshot_id: "snap_12345678",
      event_id: "evt_12345678",
      native_event_id: "eventkit-event-id",
      calendar_id: "cal_12345678",
      title_hash: hash,
      title_preview: "Study Session",
      start_utc: "2026-06-05T07:00:00.000Z",
      end_utc: "2026-06-05T06:00:00.000Z",
      timezone: "Asia/Makassar",
      is_all_day: false,
      is_recurring: false,
      recurrence_key: null,
      fingerprint,
      last_modified_at: null,
      compact: null
    }).success,
    false
  );

  assert.equal(
    ChangeFeedRecordSchema.safeParse({
      change_id: "chg_12345678",
      snapshot_id: "snap_12345678",
      operation_id: "op_12345678",
      change_type: "updated",
      event_id: "evt_12345678",
      native_event_id: "eventkit-event-id",
      calendar_id: "cal_12345678",
      changed_fields: ["start", "end"],
      before_fingerprint: fingerprint,
      after_fingerprint: fingerprint,
      summary: "Time changed.",
      created_at: "2026-06-05T04:30:00.000Z"
    }).success,
    true
  );

  assert.equal(
    RollbackOperationSchema.safeParse({
      rollback_id: "rb_12345678",
      operation_id: "op_12345678",
      tool_name: "calendar_update_event",
      operation_type: "update",
      event_id: "evt_12345678",
      native_event_id: "eventkit-event-id",
      calendar_id: "cal_12345678",
      before_state: { title: "Old" },
      after_state: { title: "New" },
      rollback_strategy: "restore_previous_state",
      rollback_status: "available",
      created_at: "2026-06-05T04:30:00.000Z",
      expires_at: "2026-07-05T04:30:00.000Z"
    }).success,
    true
  );

  assert.equal(
    RollbackOperationSchema.safeParse({
      rollback_id: "rb_12345678",
      operation_id: "op_12345678",
      tool_name: "calendar_update_event",
      operation_type: "update",
      event_id: "evt_12345678",
      native_event_id: "eventkit-event-id",
      calendar_id: "cal_12345678",
      before_state: { oversized: "x".repeat(101 * 1024) },
      after_state: null,
      rollback_strategy: "restore_previous_state",
      rollback_status: "available",
      created_at: "2026-06-05T04:30:00.000Z",
      expires_at: null
    }).success,
    false
  );
});

test("audit, config, and migration schemas match DATA_MODEL records", () => {
  assert.equal(
    AuditLogRecordSchema.safeParse({
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
    }).success,
    true
  );

  assert.equal(
    AuditLogRecordSchema.safeParse({
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
      summary: "x".repeat(301),
      error_code: null,
      metadata: null
    }).success,
    false
  );

  assert.equal(
    ConfigRecordSchema.safeParse({
      key: "permission_mode",
      value: "ask_before_write",
      updated_at: "2026-06-05T04:30:00.000Z"
    }).success,
    true
  );

  assert.equal(
    ConfigRecordSchema.safeParse({
      key: "permission_mode",
      value: "standard",
      updated_at: "2026-06-05T04:30:00.000Z"
    }).success,
    false
  );

  assert.equal(
    SchemaMigrationRecordSchema.safeParse({
      version: 1,
      applied_at: "2026-06-05T04:30:00.000Z"
    }).success,
    true
  );
});
