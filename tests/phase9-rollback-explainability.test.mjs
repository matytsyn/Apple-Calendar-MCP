import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  CalendarRollbackService,
  EventKitBridgeCallError,
  calendarIdFromNative,
  eventIdFromNative
} from "../packages/calendar-service/dist/index.js";
import { AppleCalendarSqliteStore } from "../packages/sqlite-store/dist/index.js";

const nativeCalendarId = "native-work-calendar";
const calendarId = calendarIdFromNative(nativeCalendarId);
const now = "2027-06-06T00:00:00Z";
const later = "2027-07-06T00:00:00Z";
const fingerprint = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const originalConfigPath = process.env.APPLE_CALENDAR_MCP_CONFIG_PATH;
const isolatedMissingConfigPath = join(tmpdir(), "apple-calendar-mcp-missing-phase9-config.json");

process.env.APPLE_CALENDAR_MCP_CONFIG_PATH = isolatedMissingConfigPath;

after(() => {
  if (originalConfigPath === undefined) {
    delete process.env.APPLE_CALENDAR_MCP_CONFIG_PATH;
  } else {
    process.env.APPLE_CALENDAR_MCP_CONFIG_PATH = originalConfigPath;
  }
});

async function withPermissionMode(mode, run) {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-phase9-mode-"));
  const configPath = join(directory, "config.json");
  const previousConfigPath = process.env.APPLE_CALENDAR_MCP_CONFIG_PATH;
  await writeFile(configPath, JSON.stringify({ version: 1, permission_mode: mode }));
  process.env.APPLE_CALENDAR_MCP_CONFIG_PATH = configPath;

  try {
    return await run();
  } finally {
    process.env.APPLE_CALENDAR_MCP_CONFIG_PATH = previousConfigPath;
  }
}

async function createStoreWithPath() {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-phase9-"));
  const path = join(directory, "state.sqlite");
  const store = new AppleCalendarSqliteStore({ path });

  store.upsertCalendar({
    calendar_id: calendarId,
    native_calendar_id: nativeCalendarId,
    title: "Work",
    source_title: "iCloud",
    allows_content_modifications: true,
    is_subscribed: false,
    is_allowed: true,
    color: "#3366FF",
    last_seen_at: now
  });

  return { store, path };
}

function createBridge(initialEvents = []) {
  const calls = [];
  const events = initialEvents.map((event) => ({ ...event }));
  let nextId = 1;

  return {
    calls,
    events,
    async permissionStatus() {
      calls.push({ method: "permissionStatus" });
      return { calendar_permission: "authorized", authorization_status: "authorized" };
    },
    async listEvents(params) {
      calls.push({ method: "listEvents", params });
      return events.filter((event) => params.native_calendar_ids.includes(event.native_calendar_id));
    },
    async getEvent(params) {
      calls.push({ method: "getEvent", params });
      const event = events.find((candidate) => candidate.native_event_id === params.native_event_id);
      if (!event) {
        throw new EventKitBridgeCallError({
          code: "EVENT_NOT_FOUND",
          message: "Event not found.",
          suggested_action: "Refresh events and retry.",
          retryable: false
        });
      }

      return event;
    },
    async createEvent(params) {
      calls.push({ method: "createEvent", params });
      const event = {
        native_event_id: `native-recreated-${nextId++}`,
        native_calendar_id: params.native_calendar_id,
        title: params.title,
        start: params.start,
        end: params.end,
        timezone: params.timezone ?? "Asia/Makassar",
        is_all_day: params.is_all_day ?? false,
        location: params.location ?? null,
        notes: params.notes ?? null,
        url: params.url ?? null,
        has_recurrence_rules: false,
        last_modified_at: now
      };
      events.push(event);
      return event;
    },
    async updateEvent(params) {
      calls.push({ method: "updateEvent", params });
      const event = events.find((candidate) => candidate.native_event_id === params.native_event_id);
      if (!event) {
        throw new EventKitBridgeCallError({
          code: "EVENT_NOT_FOUND",
          message: "Event not found.",
          suggested_action: "Refresh events and retry.",
          retryable: false
        });
      }

      Object.assign(event, params.changes);
      return event;
    },
    async deleteEvent(params) {
      calls.push({ method: "deleteEvent", params });
      const index = events.findIndex((event) => event.native_event_id === params.native_event_id);
      if (index === -1) {
        throw new EventKitBridgeCallError({
          code: "EVENT_NOT_FOUND",
          message: "Event not found.",
          suggested_action: "Refresh events and retry.",
          retryable: false
        });
      }

      events.splice(index, 1);
      return { native_event_id: params.native_event_id, deleted: true };
    }
  };
}

function eventState(overrides = {}) {
  const nativeEventId = overrides.native_event_id ?? "native-design-review";
  return {
    event_id: eventIdFromNative(nativeEventId),
    native_event_id: nativeEventId,
    calendar_id: calendarId,
    native_calendar_id: nativeCalendarId,
    title: "Design Review",
    start: "2027-06-06T10:00:00+08:00",
    end: "2027-06-06T11:00:00+08:00",
    timezone: "Asia/Makassar",
    is_all_day: false,
    location: "Studio",
    notes: null,
    url: null,
    is_recurring: false,
    last_modified_at: null,
    ...overrides
  };
}

function bridgeEvent(state) {
  return {
    native_event_id: state.native_event_id,
    native_calendar_id: state.native_calendar_id,
    title: state.title,
    start: state.start,
    end: state.end,
    timezone: state.timezone,
    is_all_day: state.is_all_day,
    location: state.location,
    notes: state.notes,
    url: state.url,
    has_recurrence_rules: state.is_recurring,
    last_modified_at: state.last_modified_at
  };
}

function seedRollback(store, overrides = {}) {
  const rollback = {
    rollback_id: "rb_phase9rollback1",
    operation_id: "op_phase9operation1",
    tool_name: "calendar_update_event",
    operation_type: "update",
    event_id: eventIdFromNative("native-design-review"),
    native_event_id: "native-design-review",
    calendar_id: calendarId,
    before_state: eventState(),
    after_state: eventState({ title: "Design Critique" }),
    rollback_strategy: "restore_previous_state",
    rollback_status: "available",
    created_at: now,
    expires_at: later,
    ...overrides
  };
  store.addRollbackOperation(rollback);
  return rollback;
}

function firstRow(path, sql) {
  const database = new DatabaseSync(path);
  try {
    return database.prepare(sql).get();
  } finally {
    database.close();
  }
}

function assertSuccess(response) {
  assert.equal(response.success, true);
  return response;
}

test("calendar_rollback_change requires explicit confirmation before EventKit writes", async () => {
  const { store, path } = await createStoreWithPath();
  const rollback = seedRollback(store);
  const bridge = createBridge([bridgeEvent(rollback.after_state)]);
  const service = new CalendarRollbackService(bridge, store);

  try {
    const response = await service.rollbackChange({ rollback_id: rollback.rollback_id });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "INVALID_INPUT");
    assert.equal(bridge.calls.length, 0);
    assert.equal(firstRow(path, "SELECT result FROM audit_log").result, "rollback_failure");
  } finally {
    store.close();
  }
});

test("calendar_rollback_change rejects ambiguous rollback targets before EventKit writes", async () => {
  const { store } = await createStoreWithPath();
  const rollback = seedRollback(store);
  const bridge = createBridge([bridgeEvent(rollback.after_state)]);
  const service = new CalendarRollbackService(bridge, store);

  try {
    const response = await service.rollbackChange({
      rollback_id: rollback.rollback_id,
      operation_id: rollback.operation_id,
      confirmed: true
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "INVALID_INPUT");
    assert.equal(bridge.calls.length, 0);
  } finally {
    store.close();
  }
});

test("permission mode read_only blocks rollback before EventKit writes", async () => {
  await withPermissionMode("read_only", async () => {
    const { store } = await createStoreWithPath();
    const rollback = seedRollback(store);
    const bridge = createBridge([bridgeEvent(rollback.after_state)]);
    const service = new CalendarRollbackService(bridge, store);

    try {
      const response = await service.rollbackChange({
        rollback_id: rollback.rollback_id,
        confirmed: true
      });

      assert.equal(response.success, false);
      assert.equal(response.error.code, "PERMISSION_DENIED");
      assert.deepEqual(bridge.calls.map((call) => call.method), ["permissionStatus"]);
    } finally {
      store.close();
    }
  });
});

test("calendar_rollback_change deletes an event created by the original write and audits it", async () => {
  const { store, path } = await createStoreWithPath();
  const created = eventState({ native_event_id: "native-created" });
  const rollback = seedRollback(store, {
    rollback_id: "rb_phase9created1",
    operation_id: "op_phase9created1",
    tool_name: "calendar_create_event",
    operation_type: "create",
    event_id: created.event_id,
    native_event_id: created.native_event_id,
    before_state: null,
    after_state: created,
    rollback_strategy: "delete_created_event"
  });
  const bridge = createBridge([bridgeEvent(created)]);
  const service = new CalendarRollbackService(bridge, store);

  try {
    const response = assertSuccess(await service.rollbackChange({
      rollback_id: rollback.rollback_id,
      confirmed: true
    }));

    assert.equal(response.data.rollback_status, "used");
    assert.equal(bridge.events.length, 0);
    assert.equal(firstRow(path, "SELECT rollback_status FROM rollback_operations").rollback_status, "used");
    assert.equal(firstRow(path, "SELECT result FROM audit_log ORDER BY timestamp DESC LIMIT 1").result, "rollback_success");
    assert.equal(firstRow(path, "SELECT change_type FROM change_feed ORDER BY created_at DESC LIMIT 1").change_type, "deleted");
  } finally {
    store.close();
  }
});

test("calendar_rollback_change treats an already absent created event as successful rollback", async () => {
  const { store, path } = await createStoreWithPath();
  const created = eventState({ native_event_id: "native-already-absent" });
  const rollback = seedRollback(store, {
    rollback_id: "rb_phase9absent1",
    operation_id: "op_phase9absent1",
    tool_name: "calendar_create_event",
    operation_type: "create",
    event_id: created.event_id,
    native_event_id: created.native_event_id,
    before_state: null,
    after_state: created,
    rollback_strategy: "delete_created_event"
  });
  const bridge = createBridge();
  const service = new CalendarRollbackService(bridge, store);

  try {
    const response = assertSuccess(await service.rollbackChange({
      rollback_id: rollback.rollback_id,
      confirmed: true
    }));

    assert.equal(response.data.rollback_status, "used");
    assert.equal(response.data.summary, "Rolled back create; the created event was already absent.");
    assert.deepEqual(bridge.calls.map((call) => call.method), ["permissionStatus", "getEvent"]);
    assert.equal(firstRow(path, "SELECT result FROM audit_log").result, "rollback_success");
  } finally {
    store.close();
  }
});

test("calendar_rollback_change restores previous state only after permission, allowlist, and conflict checks", async () => {
  const { store, path } = await createStoreWithPath();
  const before = eventState();
  const after = eventState({ title: "Design Critique", start: "2027-06-06T12:00:00+08:00", end: "2027-06-06T13:00:00+08:00" });
  const rollback = seedRollback(store, { before_state: before, after_state: after });
  const bridge = createBridge([bridgeEvent(after)]);
  const service = new CalendarRollbackService(bridge, store);

  try {
    const response = assertSuccess(await service.rollbackChange({
      operation_id: rollback.operation_id,
      confirmed: true
    }));

    assert.equal(response.data.strategy, "restore_previous_state");
    assert.equal(bridge.events[0].title, "Design Review");
    assert.equal(bridge.events[0].start, before.start);
    assert.deepEqual(
      bridge.calls.map((call) => call.method),
      ["permissionStatus", "listEvents", "getEvent", "updateEvent", "getEvent"]
    );
    assert.equal(firstRow(path, "SELECT change_type FROM change_feed").change_type, "updated");
  } finally {
    store.close();
  }
});

test("calendar_rollback_change rejects inconsistent rollback identity before writing", async () => {
  const { store } = await createStoreWithPath();
  const rollback = seedRollback(store, {
    native_event_id: "native-other-event"
  });
  const bridge = createBridge([bridgeEvent(rollback.before_state)]);
  const service = new CalendarRollbackService(bridge, store);

  try {
    const response = await service.rollbackChange({
      rollback_id: rollback.rollback_id,
      confirmed: true
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "ROLLBACK_NOT_AVAILABLE");
    assert.deepEqual(bridge.calls.map((call) => call.method), ["permissionStatus"]);
  } finally {
    store.close();
  }
});

test("calendar_rollback_change verifies live EventKit identity before rollback writes", async () => {
  const { store } = await createStoreWithPath();
  const created = eventState({ native_event_id: "native-created" });
  const rollback = seedRollback(store, {
    rollback_id: "rb_phase9liveidentity1",
    operation_id: "op_phase9liveidentity1",
    tool_name: "calendar_create_event",
    operation_type: "create",
    event_id: created.event_id,
    native_event_id: created.native_event_id,
    before_state: null,
    after_state: created,
    rollback_strategy: "delete_created_event"
  });
  const bridge = createBridge([
    bridgeEvent({
      ...created,
      native_calendar_id: "native-unallowed-calendar"
    })
  ]);
  const service = new CalendarRollbackService(bridge, store);

  try {
    const response = await service.rollbackChange({
      rollback_id: rollback.rollback_id,
      confirmed: true
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "ROLLBACK_NOT_AVAILABLE");
    assert.equal(bridge.events.length, 1);
    assert.deepEqual(bridge.calls.map((call) => call.method), ["permissionStatus", "getEvent"]);
  } finally {
    store.close();
  }
});

test("calendar_rollback_change recreates a deleted event without using private state in the response", async () => {
  const { store } = await createStoreWithPath();
  const deleted = eventState({ notes: "private notes should not be returned" });
  const rollback = seedRollback(store, {
    rollback_id: "rb_phase9deleted1",
    operation_id: "op_phase9deleted1",
    tool_name: "calendar_delete_event",
    operation_type: "delete",
    before_state: deleted,
    after_state: null,
    rollback_strategy: "recreate_deleted_event"
  });
  const bridge = createBridge();
  const service = new CalendarRollbackService(bridge, store);

  try {
    const response = assertSuccess(await service.rollbackChange({
      rollback_id: rollback.rollback_id,
      confirmed: true
    }));

    assert.equal(response.data.strategy, "recreate_deleted_event");
    assert.equal(bridge.events.length, 1);
    assert.equal(bridge.events[0].notes, deleted.notes);
    assert.equal(JSON.stringify(response).includes("private notes"), false);
  } finally {
    store.close();
  }
});

test("calendar_explain_last_change returns compact audit and rollback context without private rollback state", async () => {
  const { store } = await createStoreWithPath();
  const rollback = seedRollback(store, {
    before_state: eventState({ notes: "secret rollback body" })
  });
  store.addChange({
    change_id: "chg_phase9change1",
    snapshot_id: null,
    operation_id: rollback.operation_id,
    change_type: "updated",
    event_id: rollback.event_id,
    native_event_id: rollback.native_event_id,
    calendar_id: calendarId,
    changed_fields: ["title"],
    before_fingerprint: fingerprint,
    after_fingerprint: fingerprint,
    summary: "Updated Design Review.",
    created_at: now
  });
  store.addAuditLog({
    audit_id: "audit_phase9audit1",
    operation_id: rollback.operation_id,
    timestamp: now,
    client_name: "test",
    tool_name: "calendar_update_event",
    action: "update_event",
    result: "success",
    calendar_id: calendarId,
    event_id: rollback.event_id,
    risk_level: "medium",
    summary: "Updated Design Review.",
    error_code: null,
    metadata: null
  });
  const service = new CalendarRollbackService(createBridge(), store);

  try {
    const response = assertSuccess(await service.explainLastChange({}));

    assert.equal(response.data.change.change_id, "chg_phase9change1");
    assert.equal(response.data.rollback.rollback_id, rollback.rollback_id);
    assert.equal(response.data.audit.result, "success");
    assert.equal(JSON.stringify(response).includes("secret rollback body"), false);
    assert.equal("before_state" in response.data.rollback, false);
    assert.equal("after_state" in response.data.rollback, false);
  } finally {
    store.close();
  }
});

test("calendar_diagnose_issue reports compact rollback counts and recent failures", async () => {
  const { store } = await createStoreWithPath();
  seedRollback(store);
  store.addAuditLog({
    audit_id: "audit_phase9failure1",
    operation_id: "op_phase9operation1",
    timestamp: now,
    client_name: "test",
    tool_name: "calendar_rollback_change",
    action: "rollback_change",
    result: "rollback_failure",
    calendar_id: calendarId,
    event_id: eventIdFromNative("native-design-review"),
    risk_level: "high",
    summary: "Calendar write permission is not available.",
    error_code: "CALENDAR_PERMISSION_DENIED",
    metadata: { rollback_id: "rb_phase9rollback1" }
  });
  const service = new CalendarRollbackService(createBridge(), store);

  try {
    const response = assertSuccess(await service.diagnoseIssue({ issue: "rollback failed" }));

    assert.equal(response.data.rollback_counts.available, 1);
    assert.equal(response.data.recent_failures.length, 1);
    assert.equal(response.data.recent_failures[0].error_code, "CALENDAR_PERMISSION_DENIED");
    assert.ok(response.data.suggested_actions.some((action) => action.includes("Grant full Calendar access")));
    assert.equal(JSON.stringify(response).includes("before_state"), false);
  } finally {
    store.close();
  }
});

test("calendar_explain_last_change and diagnose hide blocked-calendar local rows", async () => {
  const { store } = await createStoreWithPath();
  const blockedNativeCalendarId = "native-blocked-calendar";
  const blockedCalendarId = calendarIdFromNative(blockedNativeCalendarId);
  const blockedNativeEventId = "native-blocked-event";
  const blockedEventId = eventIdFromNative(blockedNativeEventId);

  store.upsertCalendar({
    calendar_id: blockedCalendarId,
    native_calendar_id: blockedNativeCalendarId,
    title: "Blocked",
    source_title: "iCloud",
    allows_content_modifications: true,
    is_subscribed: false,
    is_allowed: false,
    color: "#AA0000",
    last_seen_at: now
  });
  store.addChange({
    change_id: "chg_phase9blocked1",
    snapshot_id: null,
    operation_id: "op_phase9blocked1",
    change_type: "updated",
    event_id: blockedEventId,
    native_event_id: blockedNativeEventId,
    calendar_id: blockedCalendarId,
    changed_fields: ["title"],
    before_fingerprint: fingerprint,
    after_fingerprint: fingerprint,
    summary: "Blocked private event.",
    created_at: "2026-06-06T00:01:00Z"
  });
  store.addAuditLog({
    audit_id: "audit_phase9blocked1",
    operation_id: "op_phase9blocked1",
    timestamp: "2026-06-06T00:01:00Z",
    client_name: "test",
    tool_name: "calendar_update_event",
    action: "update_event",
    result: "failure",
    calendar_id: blockedCalendarId,
    event_id: blockedEventId,
    risk_level: "medium",
    summary: "Blocked private event.",
    error_code: "EVENTKIT_OPERATION_FAILED",
    metadata: null
  });
  const service = new CalendarRollbackService(createBridge(), store);

  try {
    const explain = await service.explainLastChange({});
    assert.equal(explain.success, false);
    assert.equal(explain.error.code, "EVENT_NOT_FOUND");

    const diagnose = assertSuccess(await service.diagnoseIssue({}));
    assert.equal(diagnose.data.latest_change, null);
    assert.equal(diagnose.data.recent_failures.length, 0);
    assert.equal(JSON.stringify(diagnose).includes("Blocked private event"), false);
  } finally {
    store.close();
  }
});
