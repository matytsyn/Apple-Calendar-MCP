import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  EventKitBridgeCallError,
  CalendarReadService,
  calendarIdFromNative,
  eventIdFromNative
} from "../packages/calendar-service/dist/index.js";
import { AppleCalendarSqliteStore } from "../packages/sqlite-store/dist/index.js";
import { createAppleCalendarMcpServer } from "../packages/mcp-server/dist/server.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {}
};

const workNativeCalendarId = "native-work-calendar";
const personalNativeCalendarId = "native-personal-calendar";
const workCalendarId = calendarIdFromNative(workNativeCalendarId);
const personalCalendarId = calendarIdFromNative(personalNativeCalendarId);
const originalConfigPath = process.env.APPLE_CALENDAR_MCP_CONFIG_PATH;
const isolatedMissingConfigPath = join(tmpdir(), "apple-calendar-mcp-missing-test-config.json");

process.env.APPLE_CALENDAR_MCP_CONFIG_PATH = isolatedMissingConfigPath;

after(() => {
  if (originalConfigPath === undefined) {
    delete process.env.APPLE_CALENDAR_MCP_CONFIG_PATH;
  } else {
    process.env.APPLE_CALENDAR_MCP_CONFIG_PATH = originalConfigPath;
  }
});

const bridgeCalendars = [
  {
    native_calendar_id: workNativeCalendarId,
    title: "Work",
    source_title: "iCloud",
    allows_content_modifications: true,
    is_subscribed: false,
    color: "#3366FF"
  },
  {
    native_calendar_id: personalNativeCalendarId,
    title: "Personal",
    source_title: "iCloud",
    allows_content_modifications: true,
    is_subscribed: false,
    color: "#00AA66"
  }
];

const bridgeEvents = [
  {
    native_event_id: "native-event-standup",
    native_calendar_id: workNativeCalendarId,
    title: "Daily Standup",
    start: "2026-06-06T09:00:00+08:00",
    end: "2026-06-06T09:30:00+08:00",
    timezone: "Asia/Makassar",
    is_all_day: false,
    location: "Conference Room",
    notes: "Sprint notes stay hidden unless full detail is requested.",
    url: "https://example.invalid/standup",
    has_recurrence_rules: true,
    last_modified_at: "2026-06-06T00:00:00Z"
  },
  {
    native_event_id: "native-event-review",
    native_calendar_id: workNativeCalendarId,
    title: "Design Review",
    start: "2026-06-06T10:00:00+08:00",
    end: "2026-06-06T11:00:00+08:00",
    timezone: "Asia/Makassar",
    is_all_day: false,
    location: "Studio",
    notes: "Full details only.",
    url: null,
    has_recurrence_rules: false,
    last_modified_at: null
  },
  {
    native_event_id: "native-event-private",
    native_calendar_id: personalNativeCalendarId,
    title: "Blocked Calendar Event",
    start: "2026-06-06T12:00:00+08:00",
    end: "2026-06-06T13:00:00+08:00",
    timezone: "Asia/Makassar",
    is_all_day: false,
    location: "Home",
    notes: "This must never be exposed.",
    url: null,
    has_recurrence_rules: false,
    last_modified_at: null
  }
];

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-phase5-"));
  const store = new AppleCalendarSqliteStore({
    path: join(directory, "state.sqlite")
  });

  const now = "2026-06-06T00:00:00Z";
  store.upsertCalendar({
    calendar_id: workCalendarId,
    native_calendar_id: workNativeCalendarId,
    title: "Work",
    source_title: "iCloud",
    allows_content_modifications: true,
    is_subscribed: false,
    is_allowed: true,
    color: "#3366FF",
    last_seen_at: now
  });
  store.upsertCalendar({
    calendar_id: personalCalendarId,
    native_calendar_id: personalNativeCalendarId,
    title: "Personal",
    source_title: "iCloud",
    allows_content_modifications: true,
    is_subscribed: false,
    is_allowed: false,
    color: "#00AA66",
    last_seen_at: now
  });

  return store;
}

function createBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    async listCalendars() {
      calls.push({ method: "listCalendars" });
      return bridgeCalendars;
    },
    async listEvents(params) {
      calls.push({ method: "listEvents", params });
      return bridgeEvents;
    },
    async getEvent(params) {
      calls.push({ method: "getEvent", params });
      return bridgeEvents.find((event) => event.native_event_id === params.native_event_id) ?? null;
    },
    ...overrides
  };
}

function assertSemanticSuccess(response) {
  assert.equal(response.success, true);
  return response;
}

test("calendar_list_calendars returns only allowlisted calendars with pagination", async () => {
  const store = await createStore();
  const bridge = createBridge();
  const service = new CalendarReadService(bridge, store);

  try {
    const response = assertSemanticSuccess(await service.listCalendars({ limit: 100 }));

    assert.deepEqual(
      response.data.map((calendar) => calendar.calendar_id),
      [workCalendarId]
    );
    assert.equal(response.data[0].name, "Work");
    assert.equal(response.meta.next_cursor, null);
    assert.equal(response.data.some((calendar) => calendar.name === "Personal"), false);
  } finally {
    store.close();
  }
});

test("calendar_list_calendars applies setup config allowlist by native calendar id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-config-"));
  const configPath = join(directory, "config.json");
  const previousConfigPath = process.env.APPLE_CALENDAR_MCP_CONFIG_PATH;
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      allowed_native_calendar_ids: [personalNativeCalendarId]
    })
  );
  process.env.APPLE_CALENDAR_MCP_CONFIG_PATH = configPath;

  const store = await createStore();
  const service = new CalendarReadService(createBridge(), store);

  try {
    const response = assertSemanticSuccess(await service.listCalendars({ limit: 100 }));

    assert.deepEqual(
      response.data.map((calendar) => calendar.calendar_id),
      [personalCalendarId]
    );
    assert.equal(store.getCalendar(workCalendarId).is_allowed, false);
    assert.equal(store.getCalendar(personalCalendarId).is_allowed, true);
  } finally {
    store.close();
    if (previousConfigPath === undefined) {
      delete process.env.APPLE_CALENDAR_MCP_CONFIG_PATH;
    } else {
      process.env.APPLE_CALENDAR_MCP_CONFIG_PATH = previousConfigPath;
    }
  }
});

test("calendar_get_calendar hides blocked calendars behind CALENDAR_NOT_FOUND", async () => {
  const store = await createStore();
  const service = new CalendarReadService(createBridge(), store);

  try {
    const response = await service.getCalendar({ calendar_id: personalCalendarId });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "CALENDAR_NOT_FOUND");
    assert.match(response.error.message, /not available/);
    assert.doesNotMatch(JSON.stringify(response), /Personal/);
  } finally {
    store.close();
  }
});

test("calendar_list_events passes only allowed native calendars and supports detail levels", async () => {
  const store = await createStore();
  const bridge = createBridge();
  const service = new CalendarReadService(bridge, store);

  try {
    const response = assertSemanticSuccess(
      await service.listEvents({
        start: "2026-06-06T00:00:00+08:00",
        end: "2026-06-07T00:00:00+08:00",
        detail_level: "minimal",
        limit: 10
      })
    );

    assert.deepEqual(bridge.calls.at(-1).params.native_calendar_ids, [workNativeCalendarId]);
    assert.equal(bridge.calls.at(-1).params.start, "2026-06-06T00:00:00+08:00");
    assert.equal(bridge.calls.at(-1).params.end, "2026-06-07T00:00:00+08:00");
    assert.deepEqual(
      response.data.map((event) => event.title),
      ["Daily Standup", "Design Review"]
    );
    assert.equal("notes" in response.data[0], false);
    assert.equal("location_summary" in response.data[0], false);
    assert.equal(
      response.data.some((event) => event.title === "Blocked Calendar Event"),
      false
    );
  } finally {
    store.close();
  }
});

test("calendar_list_events paginates standard event results", async () => {
  const store = await createStore();
  const service = new CalendarReadService(createBridge(), store);

  try {
    const firstPage = assertSemanticSuccess(
      await service.listEvents({
        calendar_id: workCalendarId,
        start: "2026-06-06T00:00:00+08:00",
        end: "2026-06-07T00:00:00+08:00",
        limit: 1
      })
    );
    const secondPage = assertSemanticSuccess(
      await service.listEvents({
        calendar_id: workCalendarId,
        start: "2026-06-06T00:00:00+08:00",
        end: "2026-06-07T00:00:00+08:00",
        limit: 1,
        cursor: firstPage.meta.next_cursor
      })
    );

    assert.equal(firstPage.data.length, 1);
    assert.equal(firstPage.data[0].title, "Daily Standup");
    assert.equal(firstPage.data[0].location_summary, "Conference Room");
    assert.equal(firstPage.data[0].recurrence.is_recurring, true);
    assert.equal(firstPage.data[0].conflict, false);
    assert.equal("notes" in firstPage.data[0], false);
    assert.equal(secondPage.data[0].title, "Design Review");
    assert.equal(secondPage.meta.next_cursor, null);
  } finally {
    store.close();
  }
});

test("calendar_list_events chunks full-year ranges before querying EventKit", async () => {
  const store = await createStore();
  const bridge = createBridge({
    async listEvents(params) {
      this.calls.push({ method: "listEvents", params });
      return [bridgeEvents[0], bridgeEvents[0]];
    }
  });
  const service = new CalendarReadService(bridge, store);

  try {
    const response = assertSemanticSuccess(
      await service.listEvents({
        calendar_id: workCalendarId,
        start: "2026-01-01T00:00:00+08:00",
        end: "2027-01-01T00:00:00+08:00",
        detail_level: "minimal",
        limit: 50
      })
    );

    const eventCalls = bridge.calls.filter((call) => call.method === "listEvents");
    assert.ok(eventCalls.length >= 12, "year range is split into bounded windows");
    for (const call of eventCalls) {
      assert.ok(
        Date.parse(call.params.end) - Date.parse(call.params.start) <= 31 * 24 * 60 * 60 * 1000,
        `chunk too large: ${call.params.start} to ${call.params.end}`
      );
    }
    assert.deepEqual(response.data.map((event) => event.event_id), [eventIdFromNative("native-event-standup")]);
  } finally {
    store.close();
  }
});

test("calendar_list_events splits retryable EventKit chunk failures instead of failing the whole range", async () => {
  const store = await createStore();
  let failedOnce = false;
  const bridge = createBridge({
    async listEvents(params) {
      this.calls.push({ method: "listEvents", params });
      const duration = Date.parse(params.end) - Date.parse(params.start);
      if (!failedOnce && duration > 7 * 24 * 60 * 60 * 1000) {
        failedOnce = true;
        throw new EventKitBridgeCallError({
          code: "EVENTKIT_OPERATION_FAILED",
          message: "Large EventKit query failed.",
          suggested_action: "Retry with a smaller range.",
          retryable: true
        });
      }
      return [bridgeEvents[1]];
    }
  });
  const service = new CalendarReadService(bridge, store);

  try {
    const response = assertSemanticSuccess(
      await service.listEvents({
        calendar_id: workCalendarId,
        start: "2026-01-01T00:00:00+08:00",
        end: "2026-02-15T00:00:00+08:00",
        detail_level: "minimal",
        limit: 50
      })
    );

    const eventCalls = bridge.calls.filter((call) => call.method === "listEvents");
    assert.ok(eventCalls.length > 2);
    assert.deepEqual(response.data.map((event) => event.title), ["Design Review"]);
  } finally {
    store.close();
  }
});

test("calendar_search_events filters allowed events by query and date range", async () => {
  const store = await createStore();
  const service = new CalendarReadService(createBridge(), store);

  try {
    const response = assertSemanticSuccess(
      await service.searchEvents({
        query: "review",
        start: "2026-06-06T00:00:00+08:00",
        end: "2026-06-07T00:00:00+08:00",
        detail_level: "full",
        limit: 10
      })
    );

    assert.equal(response.data.length, 1);
    assert.equal(response.data[0].title, "Design Review");
    assert.equal(response.data[0].notes, "Full details only.");
    assert.equal(response.data[0].timezone, "Asia/Makassar");
  } finally {
    store.close();
  }
});

test("calendar_get_event returns allowed events and hides blocked event calendars", async () => {
  const store = await createStore();
  const service = new CalendarReadService(createBridge(), store);

  try {
    const allowedResponse = assertSemanticSuccess(
      await service.getEvent({
        event_id: eventIdFromNative("native-event-standup"),
        detail_level: "full"
      })
    );
    const blockedResponse = await service.getEvent({
      event_id: eventIdFromNative("native-event-private")
    });

    assert.equal(allowedResponse.data.title, "Daily Standup");
    assert.equal(allowedResponse.data.notes, "Sprint notes stay hidden unless full detail is requested.");
    assert.equal(blockedResponse.success, false);
    assert.equal(blockedResponse.error.code, "EVENT_NOT_FOUND");
    assert.doesNotMatch(JSON.stringify(blockedResponse), /Blocked Calendar Event|Personal/);
  } finally {
    store.close();
  }
});

test("read tools return semantic INVALID_INPUT for missing required date range", async () => {
  const store = await createStore();
  const service = new CalendarReadService(createBridge(), store);

  try {
    const response = await service.listEvents({
      calendar_id: workCalendarId,
      detail_level: "standard"
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "INVALID_INPUT");
  } finally {
    store.close();
  }
});

test("read tools reject invalid cursors instead of replaying the first page", async () => {
  const store = await createStore();
  const service = new CalendarReadService(createBridge(), store);

  try {
    const response = await service.listEvents({
      calendar_id: workCalendarId,
      start: "2026-06-06T00:00:00+08:00",
      end: "2026-06-07T00:00:00+08:00",
      cursor: "not-a-valid-cursor"
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "INVALID_INPUT");
    assert.match(response.error.message, /cursor/);
  } finally {
    store.close();
  }
});

test("full detail output is bounded", async () => {
  const store = await createStore();
  const bridge = createBridge({
    async listEvents(params) {
      this.calls.push({ method: "listEvents", params });
      return [
        {
          native_event_id: "native-event-long",
          native_calendar_id: workNativeCalendarId,
          title: "T".repeat(500),
          start: "2026-06-06T14:00:00+08:00",
          end: "2026-06-06T15:00:00+08:00",
          timezone: "Asia/Makassar",
          is_all_day: false,
          location: "L".repeat(500),
          notes: "N".repeat(5000),
          url: `https://example.invalid/${"u".repeat(1000)}`,
          has_recurrence_rules: false,
          last_modified_at: null
        }
      ];
    }
  });
  const service = new CalendarReadService(bridge, store);

  try {
    const response = assertSemanticSuccess(
      await service.listEvents({
        calendar_id: workCalendarId,
        start: "2026-06-06T00:00:00+08:00",
        end: "2026-06-07T00:00:00+08:00",
        detail_level: "full"
      })
    );

    assert.equal(response.data[0].title.length, 120);
    assert.equal(response.data[0].location_summary.length, 120);
    assert.equal(response.data[0].notes.length, 2000);
    assert.equal(response.data[0].url.length, 500);
  } finally {
    store.close();
  }
});

test("native bridge semantic errors are sanitized before returning to MCP clients", async () => {
  const store = await createStore();
  const service = new CalendarReadService(
    createBridge({
      async getEvent() {
        throw new EventKitBridgeCallError({
          code: "EVENT_NOT_FOUND",
          message: "Native event Secret Blocked Calendar Event was not found.",
          suggested_action: "Inspect native id native-event-private.",
          retryable: false
        });
      }
    }),
    store
  );

  try {
    const response = await service.getEvent({
      event_id: eventIdFromNative("native-event-private")
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "EVENT_NOT_FOUND");
    assert.doesNotMatch(JSON.stringify(response), /Secret|native-event-private|Blocked Calendar Event/);
  } finally {
    store.close();
  }
});

test("MCP read tools expose semantic errors in structuredContent and isError", async () => {
  const service = {
    async listCalendars(input) {
      assert.deepEqual(input, { limit: 50 });
      return { success: true, data: [], meta: { next_cursor: null } };
    },
    async getCalendar() {
      return {
        success: false,
        error: {
          code: "CALENDAR_NOT_FOUND",
          message: "The requested calendar is not available.",
          suggested_action: "Call calendar_list_calendars and choose an allowed calendar.",
          retryable: false
        }
      };
    },
    async listEvents() {
      return { success: true, data: [], meta: { next_cursor: null } };
    },
    async searchEvents() {
      return { success: true, data: [], meta: { next_cursor: null } };
    },
    async getEvent() {
      return { success: true, data: null, meta: {} };
    }
  };
  const server = createAppleCalendarMcpServer(silentLogger, { readService: service });
  const client = new Client(
    { name: "phase5-test-client", version: "0.0.0" },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listResponse = await client.callTool({
      name: "calendar_list_calendars",
      arguments: {}
    });
    const errorResponse = await client.callTool({
      name: "calendar_get_calendar",
      arguments: { calendar_id: workCalendarId }
    });

    assert.equal(JSON.parse(listResponse.content[0].text).success, true);
    assert.equal(errorResponse.isError, true);
    assert.equal(errorResponse.structuredContent.error.code, "CALENDAR_NOT_FOUND");
  } finally {
    await client.close();
    await server.close();
  }
});
