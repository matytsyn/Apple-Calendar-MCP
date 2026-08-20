import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  CalendarWriteService,
  EventKitBridgeCallError,
  calendarIdFromNative,
  eventIdFromNative
} from "../packages/calendar-service/dist/index.js";
import { AppleCalendarSqliteStore } from "../packages/sqlite-store/dist/index.js";

const nativeCalendarId = "native-work-calendar";
const calendarId = calendarIdFromNative(nativeCalendarId);
const originalConfigPath = process.env.APPLE_CALENDAR_MCP_CONFIG_PATH;
const isolatedMissingConfigPath = join(tmpdir(), "apple-calendar-mcp-missing-phase7-config.json");

process.env.APPLE_CALENDAR_MCP_CONFIG_PATH = isolatedMissingConfigPath;

after(() => {
  if (originalConfigPath === undefined) {
    delete process.env.APPLE_CALENDAR_MCP_CONFIG_PATH;
  } else {
    process.env.APPLE_CALENDAR_MCP_CONFIG_PATH = originalConfigPath;
  }
});

async function withPermissionMode(mode, run) {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-phase7-mode-"));
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

async function createStore() {
  const { store } = await createStoreWithPath();
  return store;
}

async function createStoreWithPath() {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-phase7-"));
  const path = join(directory, "state.sqlite");
  const store = new AppleCalendarSqliteStore({
    path
  });

  store.upsertCalendar({
    calendar_id: calendarId,
    native_calendar_id: nativeCalendarId,
    title: "Work",
    source_title: "iCloud",
    allows_content_modifications: true,
    is_subscribed: false,
    is_allowed: true,
    color: "#3366FF",
    last_seen_at: "2026-06-06T00:00:00Z"
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
        native_event_id: `native-created-${nextId++}`,
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
        last_modified_at: "2026-06-06T00:00:00Z"
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
      event.last_modified_at = "2026-06-06T00:30:00Z";
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

function sampleEvent(overrides = {}) {
  return {
    native_event_id: "native-design-review",
    native_calendar_id: nativeCalendarId,
    title: "Design Review",
    start: "2026-06-06T10:00:00+08:00",
    end: "2026-06-06T11:00:00+08:00",
    timezone: "Asia/Makassar",
    is_all_day: false,
    location: "Studio",
    notes: null,
    url: null,
    has_recurrence_rules: false,
    last_modified_at: null,
    ...overrides
  };
}

function confirmedInput(input, preview) {
  return {
    ...input,
    confirmation: {
      confirmation_id: preview.data.confirmation.confirmation_id,
      operation_id: preview.data.operation_id,
      confirmation_token: preview.data.confirmation.confirmation_token,
      confirmed: true
    }
  };
}

function assertSuccess(response) {
  assert.equal(response.success, true);
  return response;
}

function firstRow(path, sql) {
  const database = new DatabaseSync(path);
  try {
    return database.prepare(sql).get();
  } finally {
    database.close();
  }
}

test("calendar_create_event requires confirmation before writing and replays idempotently", async () => {
  const { store, path } = await createStoreWithPath();
  const bridge = createBridge();
  const service = new CalendarWriteService(bridge, store);
  const input = {
    calendar_id: calendarId,
    title: "Planning",
    start: "2026-06-06T13:00:00+08:00",
    end: "2026-06-06T14:00:00+08:00",
    timezone: "Asia/Makassar",
    is_all_day: false,
    idempotency_key: "create-planning-1"
  };

  try {
    const preview = assertSuccess(await service.createEvent(input));
    assert.equal(preview.data.requires_confirmation, true);
    assert.equal(bridge.calls.some((call) => call.method === "createEvent"), false);

    const written = assertSuccess(await service.createEvent(confirmedInput(input, preview)));
    assert.equal(written.data.event.title, "Planning");
    assert.equal(written.data.rollback_id.startsWith("rb_"), true);
    assert.equal(bridge.events.length, 1);

    const replay = assertSuccess(await service.createEvent(input));
    assert.deepEqual(replay.data, written.data);
    assert.equal(bridge.events.length, 1);

    const rollback = firstRow(path, "SELECT event_id, native_event_id, after_state_json FROM rollback_operations");
    assert.equal(rollback.event_id, written.data.event_id);
    assert.equal(rollback.native_event_id, "native-created-1");
    assert.equal(JSON.parse(rollback.after_state_json).event_id, written.data.event_id);
  } finally {
    store.close();
  }
});

test("permission mode read_only blocks write tools before EventKit writes", async () => {
  await withPermissionMode("read_only", async () => {
    const store = await createStore();
    const bridge = createBridge();
    const service = new CalendarWriteService(bridge, store);

    try {
      const response = await service.createEvent({
        calendar_id: calendarId,
        title: "Planning",
        start: "2026-06-06T13:00:00+08:00",
        end: "2026-06-06T14:00:00+08:00",
        timezone: "Asia/Makassar",
        is_all_day: false
      });

      assert.equal(response.success, false);
      assert.equal(response.error.code, "PERMISSION_DENIED");
      assert.equal(bridge.calls.some((call) => call.method === "createEvent"), false);
    } finally {
      store.close();
    }
  });
});

test("permission mode trusted_write allows create without confirmation but blocks delete", async () => {
  await withPermissionMode("trusted_write", async () => {
    const store = await createStore();
    const bridge = createBridge([sampleEvent()]);
    const service = new CalendarWriteService(bridge, store);

    try {
      const created = assertSuccess(await service.createEvent({
        calendar_id: calendarId,
        title: "Planning",
        start: "2026-06-06T13:00:00+08:00",
        end: "2026-06-06T14:00:00+08:00",
        timezone: "Asia/Makassar",
        is_all_day: false,
        idempotency_key: "trusted-create-1"
      }));

      assert.equal(created.data.event.title, "Planning");
      assert.equal(bridge.calls.some((call) => call.method === "createEvent"), true);

      const deleted = await service.deleteEvent({
        event_id: eventIdFromNative("native-design-review"),
        idempotency_key: "trusted-delete-1"
      });
      assert.equal(deleted.success, false);
      assert.equal(deleted.error.code, "PERMISSION_DENIED");
      assert.equal(bridge.calls.some((call) => call.method === "deleteEvent"), false);
    } finally {
      store.close();
    }
  });
});

test("permission mode full_write still requires confirmation for delete", async () => {
  await withPermissionMode("full_write", async () => {
    const store = await createStore();
    const bridge = createBridge([sampleEvent()]);
    const service = new CalendarWriteService(bridge, store);

    try {
      const preview = assertSuccess(await service.deleteEvent({
        event_id: eventIdFromNative("native-design-review"),
        idempotency_key: "full-delete-1"
      }));

      assert.equal(preview.data.requires_confirmation, true);
      assert.equal(bridge.calls.some((call) => call.method === "deleteEvent"), false);
    } finally {
      store.close();
    }
  });
});

test("calendar_update_event requires recurring scope and updates after confirmation", async () => {
  const store = await createStore();
  const bridge = createBridge([
    sampleEvent({ has_recurrence_rules: true })
  ]);
  const service = new CalendarWriteService(bridge, store);
  const input = {
    event_id: eventIdFromNative("native-design-review"),
    changes: {
      title: "Design Critique"
    },
    idempotency_key: "update-design-1"
  };

  try {
    const missingScope = await service.updateEvent(input);
    assert.equal(missingScope.success, false);
    assert.equal(missingScope.error.code, "RECURRING_SCOPE_REQUIRED");

    const scoped = { ...input, recurrence_scope: "single_instance" };
    const preview = assertSuccess(await service.updateEvent(scoped));
    const written = assertSuccess(await service.updateEvent(confirmedInput(scoped, preview)));

    assert.equal(written.data.event.title, "Design Critique");
    assert.equal(bridge.events[0].title, "Design Critique");
  } finally {
    store.close();
  }
});

test("calendar_reschedule_event blocks conflicts before confirmation", async () => {
  const store = await createStore();
  const bridge = createBridge([
    sampleEvent(),
    sampleEvent({
      native_event_id: "native-lunch",
      title: "Lunch",
      start: "2026-06-06T12:00:00+08:00",
      end: "2026-06-06T13:00:00+08:00"
    })
  ]);
  const service = new CalendarWriteService(bridge, store);

  try {
    const response = await service.rescheduleEvent({
      event_id: eventIdFromNative("native-design-review"),
      start: "2026-06-06T12:30:00+08:00",
      end: "2026-06-06T13:30:00+08:00",
      idempotency_key: "reschedule-design-1"
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "CONFLICT_DETECTED");
    assert.equal(bridge.calls.some((call) => call.method === "updateEvent"), false);
  } finally {
    store.close();
  }
});

test("calendar_delete_event deletes only after confirmation and verifies removal", async () => {
  const store = await createStore();
  const bridge = createBridge([sampleEvent()]);
  const service = new CalendarWriteService(bridge, store);
  const input = {
    event_id: eventIdFromNative("native-design-review"),
    idempotency_key: "delete-design-1"
  };

  try {
    const preview = assertSuccess(await service.deleteEvent(input));
    assert.equal(preview.data.requires_confirmation, true);
    assert.equal(bridge.events.length, 1);

    const written = assertSuccess(await service.deleteEvent(confirmedInput(input, preview)));
    assert.equal(written.data.event, null);
    assert.equal(written.data.event_id, eventIdFromNative("native-design-review"));
    assert.equal(bridge.events.length, 0);

    const replay = assertSuccess(await service.deleteEvent(input));
    assert.deepEqual(replay.data, written.data);
  } finally {
    store.close();
  }
});

test("calendar_delete_event does not verify deletion on non-not-found bridge errors", async () => {
  const store = await createStore();
  const bridge = createBridge([sampleEvent()]);
  const service = new CalendarWriteService(bridge, store);
  const input = {
    event_id: eventIdFromNative("native-design-review"),
    idempotency_key: "delete-design-verify-fails"
  };

  try {
    const preview = assertSuccess(await service.deleteEvent(input));
    bridge.getEvent = async (params) => {
      bridge.calls.push({ method: "getEvent", params });
      throw new EventKitBridgeCallError({
        code: "EVENTKIT_OPERATION_FAILED",
        message: "Bridge unavailable.",
        suggested_action: "Retry later.",
        retryable: true
      });
    };

    const response = await service.deleteEvent(confirmedInput(input, preview));
    assert.equal(response.success, false);
    assert.equal(response.error.code, "EVENTKIT_OPERATION_FAILED");
  } finally {
    store.close();
  }
});

test("calendar_update_event fails verification when EventKit state does not match request", async () => {
  const store = await createStore();
  const bridge = createBridge([sampleEvent()]);
  const service = new CalendarWriteService(bridge, store);
  const input = {
    event_id: eventIdFromNative("native-design-review"),
    changes: {
      title: "Design Critique"
    },
    idempotency_key: "update-design-mismatch"
  };

  try {
    const preview = assertSuccess(await service.updateEvent(input));
    bridge.updateEvent = async (params) => {
      bridge.calls.push({ method: "updateEvent", params });
      return sampleEvent({ title: "Wrong Title" });
    };
    bridge.getEvent = async (params) => {
      bridge.calls.push({ method: "getEvent", params });
      return sampleEvent({ title: "Wrong Title" });
    };

    const response = await service.updateEvent(confirmedInput(input, preview));
    assert.equal(response.success, false);
    assert.equal(response.error.code, "EVENTKIT_OPERATION_FAILED");
  } finally {
    store.close();
  }
});

test("calendar_create_event audits blocked duplicate writes before confirmation", async () => {
  const { store, path } = await createStoreWithPath();
  const bridge = createBridge([
    sampleEvent({
      title: "Design Review Sync",
      start: "2026-06-06T10:00:00+08:00",
      end: "2026-06-06T11:00:00+08:00",
      location: "Studio"
    })
  ]);
  const service = new CalendarWriteService(bridge, store);

  try {
    const response = await service.createEvent({
      calendar_id: calendarId,
      title: "Design Review",
      start: "2026-06-06T10:00:00+08:00",
      end: "2026-06-06T10:30:00+08:00",
      location: "Studio",
      is_all_day: false,
      idempotency_key: "duplicate-design-review"
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "CONFLICT_DETECTED");
    assert.equal(bridge.calls.some((call) => call.method === "createEvent"), false);

    const audit = firstRow(path, "SELECT result, error_code FROM audit_log ORDER BY timestamp DESC LIMIT 1");
    assert.equal(audit.result, "blocked");
    assert.equal(audit.error_code, "CONFLICT_DETECTED");
  } finally {
    store.close();
  }
});
