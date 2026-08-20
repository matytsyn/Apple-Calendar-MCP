import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CalendarReadService,
  calendarIdFromNative,
  eventIdFromNative
} from "../packages/calendar-service/dist/index.js";
import { AppleCalendarSqliteStore } from "../packages/sqlite-store/dist/index.js";

const nativeCalendarId = "native-work-calendar";
const calendarId = calendarIdFromNative(nativeCalendarId);

const events = [
  {
    native_event_id: "native-standup",
    native_calendar_id: nativeCalendarId,
    title: "Daily Standup",
    start: "2026-06-06T09:00:00+08:00",
    end: "2026-06-06T09:30:00+08:00",
    timezone: "Asia/Makassar",
    is_all_day: false,
    location: "Conference Room",
    notes: null,
    url: null,
    has_recurrence_rules: true,
    last_modified_at: null
  },
  {
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
    last_modified_at: null
  },
  {
    native_event_id: "native-offsite",
    native_calendar_id: nativeCalendarId,
    title: "Company Offsite",
    start: "2026-06-07T00:00:00+08:00",
    end: "2026-06-08T00:00:00+08:00",
    timezone: "Asia/Makassar",
    is_all_day: true,
    location: "Bali",
    notes: null,
    url: null,
    has_recurrence_rules: false,
    last_modified_at: null
  }
];

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-phase6-"));
  const store = new AppleCalendarSqliteStore({
    path: join(directory, "state.sqlite")
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

  return store;
}

function createBridge() {
  const calls = [];
  return {
    calls,
    async permissionStatus() {
      calls.push({ method: "permissionStatus" });
      return { calendar_permission: "authorized" };
    },
    async requestPermission() {
      calls.push({ method: "requestPermission" });
      return { granted: true, calendar_permission: "authorized" };
    },
    async listCalendars() {
      calls.push({ method: "listCalendars" });
      return [];
    },
    async listEvents(params) {
      calls.push({ method: "listEvents", params });
      return events;
    },
    async getEvent(params) {
      calls.push({ method: "getEvent", params });
      return events.find((event) => event.native_event_id === params.native_event_id) ?? null;
    },
    async createEvent() {
      calls.push({ method: "createEvent" });
      throw new Error("Preview tools must not write.");
    },
    async updateEvent() {
      calls.push({ method: "updateEvent" });
      throw new Error("Preview tools must not write.");
    }
  };
}

function assertSuccess(response) {
  assert.equal(response.success, true);
  return response;
}

test("calendar_check_conflicts detects overlapping events without writing", async () => {
  const store = await createStore();
  const bridge = createBridge();
  const service = new CalendarReadService(bridge, store);

  try {
    const response = assertSuccess(
      await service.checkConflicts({
        calendar_id: calendarId,
        start: "2026-06-06T10:30:00+08:00",
        end: "2026-06-06T11:30:00+08:00"
      })
    );

    assert.equal(response.data.has_conflicts, true);
    assert.deepEqual(
      response.data.conflicts.map((conflict) => conflict.title),
      ["Design Review"]
    );
    assert.deepEqual(
      bridge.calls.map((call) => call.method),
      ["listEvents"]
    );
  } finally {
    store.close();
  }
});

test("calendar_preview_create_event reports conflicts and possible duplicates without writing", async () => {
  const store = await createStore();
  const bridge = createBridge();
  const service = new CalendarReadService(bridge, store);

  try {
    const response = assertSuccess(
      await service.previewCreateEvent({
        calendar_id: calendarId,
        title: "Design Review",
        start: "2026-06-06T10:15:00+08:00",
        end: "2026-06-06T10:45:00+08:00",
        location: "Studio"
      })
    );

    assert.equal(response.data.would_create, true);
    assert.equal(response.data.safety.conflicts.length, 1);
    assert.equal(response.data.safety.duplicates.length, 1);
    assert.equal(response.data.safety.ambiguities.length, 0);
    assert.deepEqual(
      bridge.calls.map((call) => call.method),
      ["listEvents"]
    );
  } finally {
    store.close();
  }
});

test("calendar_preview_create_event rejects ambiguous timestamp inputs", async () => {
  const store = await createStore();
  const service = new CalendarReadService(createBridge(), store);

  try {
    const response = await service.previewCreateEvent({
      calendar_id: calendarId,
      title: "No Timezone",
      start: "2026-06-06T10:15:00",
      end: "2026-06-06T10:45:00"
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "AMBIGUOUS_DATE");
  } finally {
    store.close();
  }
});

test("calendar_check_conflicts includes all-day conflicts around the requested range", async () => {
  const store = await createStore();
  const bridge = createBridge();
  const service = new CalendarReadService(bridge, store);

  try {
    const response = assertSuccess(
      await service.checkConflicts({
        calendar_id: calendarId,
        start: "2026-06-07T12:00:00+08:00",
        end: "2026-06-07T13:00:00+08:00"
      })
    );

    assert.equal(response.data.has_conflicts, true);
    assert.equal(response.data.conflicts[0].title, "Company Offsite");
    assert.equal(response.data.conflicts[0].is_all_day, true);
    assert.equal(bridge.calls[0].params.start, "2026-06-06T04:00:00.000Z");
    assert.equal(bridge.calls[0].params.end, "2026-06-08T05:00:00.000Z");
  } finally {
    store.close();
  }
});

test("calendar_preview_update_event requires start and end together", async () => {
  const store = await createStore();
  const service = new CalendarReadService(createBridge(), store);

  try {
    const response = await service.previewUpdateEvent({
      event_id: eventIdFromNative("native-design-review"),
      changes: {
        start: "2026-06-06T10:15:00+08:00"
      }
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "INVALID_INPUT");
  } finally {
    store.close();
  }
});

test("calendar_preview_update_event requires recurring scope for recurring events", async () => {
  const store = await createStore();
  const bridge = createBridge();
  const service = new CalendarReadService(bridge, store);

  try {
    const response = await service.previewUpdateEvent({
      event_id: eventIdFromNative("native-standup"),
      changes: {
        title: "Daily Standup Moved"
      }
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "RECURRING_SCOPE_REQUIRED");
    assert.deepEqual(
      bridge.calls.map((call) => call.method),
      ["getEvent"]
    );
  } finally {
    store.close();
  }
});

test("calendar_preview_update_event previews scoped recurring updates and safety warnings", async () => {
  const store = await createStore();
  const bridge = createBridge();
  const service = new CalendarReadService(bridge, store);

  try {
    const response = assertSuccess(
      await service.previewUpdateEvent({
        event_id: eventIdFromNative("native-standup"),
        recurrence_scope: "single_instance",
        changes: {
          title: "Design Review",
          start: "2026-06-06T10:15:00+08:00",
          end: "2026-06-06T10:45:00+08:00",
          location: "Studio"
        }
      })
    );

    assert.equal(response.data.would_update, true);
    assert.equal(response.data.recurrence_scope, "single_instance");
    assert.equal(response.data.safety.conflicts.length, 1);
    assert.equal(response.data.safety.duplicates.length, 1);
    assert.equal(response.data.safety.recurring_scope, "single_instance");
    assert.deepEqual(response.data.safety.warnings, ["possible_duplicate"]);
    assert.deepEqual(
      bridge.calls.map((call) => call.method),
      ["getEvent", "listEvents"]
    );
  } finally {
    store.close();
  }
});
