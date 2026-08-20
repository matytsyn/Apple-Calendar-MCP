import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CalendarSnapshotService,
  calendarIdFromNative
} from "../packages/calendar-service/dist/index.js";
import { AppleCalendarSqliteStore } from "../packages/sqlite-store/dist/index.js";

const workNativeCalendarId = "native-work-calendar";
const blockedNativeCalendarId = "native-blocked-calendar";
const workCalendarId = calendarIdFromNative(workNativeCalendarId);
const blockedCalendarId = calendarIdFromNative(blockedNativeCalendarId);

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-phase8-"));
  const path = join(directory, "state.sqlite");
  const store = new AppleCalendarSqliteStore({ path });

  store.upsertCalendar({
    calendar_id: workCalendarId,
    native_calendar_id: workNativeCalendarId,
    title: "Work",
    source_title: "iCloud",
    allows_content_modifications: true,
    is_subscribed: false,
    is_allowed: true,
    color: "#3366FF",
    last_seen_at: "2026-06-06T00:00:00Z"
  });
  store.upsertCalendar({
    calendar_id: blockedCalendarId,
    native_calendar_id: blockedNativeCalendarId,
    title: "Private",
    source_title: "iCloud",
    allows_content_modifications: true,
    is_subscribed: false,
    is_allowed: false,
    color: "#FF3366",
    last_seen_at: "2026-06-06T00:00:00Z"
  });

  return { store, path };
}

function createBridge(events) {
  const calls = [];
  return {
    calls,
    events,
    async listEvents(params) {
      calls.push({ method: "listEvents", params });
      return events.filter((event) => params.native_calendar_ids.includes(event.native_calendar_id));
    }
  };
}

function event(overrides = {}) {
  return {
    native_event_id: "native-design-review",
    native_calendar_id: workNativeCalendarId,
    title: "Sensitive Project Review",
    start: "2026-06-06T10:00:00+08:00",
    end: "2026-06-06T11:00:00+08:00",
    timezone: "Asia/Makassar",
    is_all_day: false,
    location: "Secret Room",
    notes: "Do not store this private note.",
    url: "https://private.example.invalid/secret",
    has_recurrence_rules: false,
    last_modified_at: "2026-06-06T00:00:00Z",
    ...overrides
  };
}

function allRows(path, sql) {
  const database = new DatabaseSync(path);
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

function assertSuccess(response) {
  assert.equal(response.success, true);
  return response;
}

test("calendar_create_snapshot stores compact allowed-calendar records only", async () => {
  const { store, path } = await createStore();
  const bridge = createBridge([
    event(),
    event({
      native_event_id: "native-blocked-event",
      native_calendar_id: blockedNativeCalendarId,
      title: "Blocked Event",
      notes: "Must not be stored."
    })
  ]);
  const service = new CalendarSnapshotService(bridge, store);

  try {
    const response = assertSuccess(
      await service.createSnapshot({
        start: "2026-06-06T00:00:00+08:00",
        end: "2026-06-07T00:00:00+08:00"
      })
    );

    assert.equal(response.data.event_count, 1);
    assert.deepEqual(bridge.calls[0].params.native_calendar_ids, [workNativeCalendarId]);

    const rows = allRows(path, "SELECT * FROM snapshot_events");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].calendar_id, workCalendarId);
    assert.equal(rows[0].title_preview, null);
    assert.doesNotMatch(JSON.stringify(rows[0]), /Do not store this private note/);
    assert.doesNotMatch(JSON.stringify(rows[0]), /private\.example/);
    assert.equal(JSON.parse(rows[0].compact_json).notes_present, true);
    assert.equal(JSON.parse(rows[0].compact_json).url_present, true);
  } finally {
    store.close();
  }
});

test("calendar_get_snapshot returns paginated compact events without private fields", async () => {
  const { store } = await createStore();
  const bridge = createBridge([
    event({ native_event_id: "native-a", title: "Alpha" }),
    event({ native_event_id: "native-b", title: "Beta", start: "2026-06-06T12:00:00+08:00", end: "2026-06-06T13:00:00+08:00" })
  ]);
  const service = new CalendarSnapshotService(bridge, store);

  try {
    const created = assertSuccess(
      await service.createSnapshot({
        calendar_id: workCalendarId,
        start: "2026-06-06T00:00:00+08:00",
        end: "2026-06-07T00:00:00+08:00"
      })
    );
    const firstPage = assertSuccess(
      await service.getSnapshot({
        snapshot_id: created.data.snapshot_id,
        limit: 1
      })
    );
    const secondPage = assertSuccess(
      await service.getSnapshot({
        snapshot_id: created.data.snapshot_id,
        limit: 1,
        cursor: firstPage.meta.next_cursor
      })
    );

    assert.equal(firstPage.data.events.length, 1);
    assert.equal(firstPage.data.events[0].title_preview, null);
    assert.equal("notes" in firstPage.data.events[0], false);
    assert.equal("url" in firstPage.data.events[0], false);
    assert.equal(secondPage.data.events.length, 1);
    assert.equal(secondPage.meta.next_cursor, null);
  } finally {
    store.close();
  }
});

test("calendar_create_snapshot diffs against prior same-scope snapshot and calendar_get_changes_since returns compact changes", async () => {
  const { store } = await createStore();
  const events = [event()];
  const bridge = createBridge(events);
  const service = new CalendarSnapshotService(bridge, store);
  const input = {
    calendar_id: workCalendarId,
    start: "2026-06-06T00:00:00+08:00",
    end: "2026-06-07T00:00:00+08:00"
  };

  try {
    const first = assertSuccess(await service.createSnapshot(input));
    events[0].start = "2026-06-06T12:00:00+08:00";
    events[0].end = "2026-06-06T13:00:00+08:00";
    events[0].last_modified_at = "2026-06-06T01:00:00Z";
    const second = assertSuccess(await service.createSnapshot(input));

    assert.equal(second.data.changes_detected, 1);

    const changes = assertSuccess(
      await service.getChangesSince({
        snapshot_id: first.data.snapshot_id
      })
    );

    assert.equal(changes.data.since_snapshot_id, first.data.snapshot_id);
    assert.equal(changes.data.changes.length, 1);
    assert.equal(changes.data.changes[0].change_type, "moved");
    assert.deepEqual(changes.data.changes[0].changed_fields, ["start_utc", "end_utc"]);
    assert.equal("before_fingerprint" in changes.data.changes[0], false);
  } finally {
    store.close();
  }
});

test("calendar_create_snapshot detects compact note and URL presence changes without storing private bodies", async () => {
  const { store } = await createStore();
  const events = [event({ notes: null, url: null })];
  const bridge = createBridge(events);
  const service = new CalendarSnapshotService(bridge, store);
  const input = {
    calendar_id: workCalendarId,
    start: "2026-06-06T00:00:00+08:00",
    end: "2026-06-07T00:00:00+08:00"
  };

  try {
    const first = assertSuccess(await service.createSnapshot(input));
    events[0].notes = "New private note";
    events[0].url = "https://private.example.invalid/new";
    assertSuccess(await service.createSnapshot(input));

    const changes = assertSuccess(await service.getChangesSince({ snapshot_id: first.data.snapshot_id }));
    assert.equal(changes.data.changes.length, 1);
    assert.equal(changes.data.changes[0].change_type, "updated");
    assert.deepEqual(changes.data.changes[0].changed_fields, ["notes_present", "url_present"]);
    assert.doesNotMatch(JSON.stringify(changes), /New private note/);
    assert.doesNotMatch(JSON.stringify(changes), /private\.example/);
  } finally {
    store.close();
  }
});

test("calendar_create_snapshot requires explicit large range and enforces absolute range limit", async () => {
  const { store } = await createStore();
  const service = new CalendarSnapshotService(createBridge([]), store);

  try {
    const defaultRange = await service.createSnapshot({
      calendar_id: workCalendarId,
      start: "2026-01-01T00:00:00Z",
      end: "2027-06-01T00:00:00Z"
    });
    assert.equal(defaultRange.success, false);
    assert.equal(defaultRange.error.code, "INVALID_INPUT");

    const explicitLargeRange = assertSuccess(
      await service.createSnapshot({
        calendar_id: workCalendarId,
        start: "2026-01-01T00:00:00Z",
        end: "2027-06-01T00:00:00Z",
        allow_large_range: true
      })
    );
    assert.equal(explicitLargeRange.data.event_count, 0);

    const tooLarge = await service.createSnapshot({
      calendar_id: workCalendarId,
      start: "2026-01-01T00:00:00Z",
      end: "2032-01-01T00:00:00Z",
      allow_large_range: true
    });
    assert.equal(tooLarge.success, false);
    assert.equal(tooLarge.error.code, "INVALID_INPUT");
  } finally {
    store.close();
  }
});

test("calendar_create_snapshot rejects snapshots above the event-count cap before storing rows", async () => {
  const { store, path } = await createStore();
  const manyEvents = Array.from({ length: 5001 }, (_, index) =>
    event({
      native_event_id: `native-many-${index}`,
      title: `Many ${index}`,
      start: "2026-06-06T10:00:00+08:00",
      end: "2026-06-06T11:00:00+08:00"
    })
  );
  const service = new CalendarSnapshotService(createBridge(manyEvents), store);

  try {
    const response = await service.createSnapshot({
      calendar_id: workCalendarId,
      start: "2026-06-06T00:00:00+08:00",
      end: "2026-06-07T00:00:00+08:00"
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, "INVALID_INPUT");
    assert.equal(allRows(path, "SELECT * FROM snapshots").length, 0);
    assert.equal(allRows(path, "SELECT * FROM snapshot_events").length, 0);
  } finally {
    store.close();
  }
});

test("SQLite snapshot bundle creation is atomic", async () => {
  const { store, path } = await createStore();
  const snapshot = {
    snapshot_id: "snap_atomic12",
    scope: {
      calendar_ids: [workCalendarId],
      start_utc: "2026-06-06T00:00:00.000Z",
      end_utc: "2026-06-07T00:00:00.000Z"
    },
    created_at: "2026-06-06T00:00:00.000Z",
    created_by: "unknown_mcp_client",
    event_count: 1,
    hash: `sha256:${"a".repeat(64)}`,
    notes: null
  };

  try {
    assert.throws(() =>
      store.createSnapshotBundle(
        snapshot,
        [
          {
            snapshot_event_id: "invalid",
            snapshot_id: "snap_atomic12",
            event_id: "evt_12345678",
            native_event_id: "native-event",
            calendar_id: workCalendarId,
            title_hash: `sha256:${"b".repeat(64)}`,
            title_preview: null,
            start_utc: "2026-06-06T01:00:00.000Z",
            end_utc: "2026-06-06T02:00:00.000Z",
            timezone: "UTC",
            is_all_day: false,
            is_recurring: false,
            recurrence_key: null,
            fingerprint: `sha256:${"c".repeat(64)}`,
            last_modified_at: null,
            compact: null
          }
        ],
        []
      )
    );

    assert.equal(allRows(path, "SELECT * FROM snapshots WHERE snapshot_id = 'snap_atomic12'").length, 0);
  } finally {
    store.close();
  }
});

test("calendar_get_snapshot and calendar_get_changes_since use paged store reads", async () => {
  const { store } = await createStore();
  const events = [
    event({ native_event_id: "native-a", title: "Alpha" }),
    event({ native_event_id: "native-b", title: "Beta", start: "2026-06-06T12:00:00+08:00", end: "2026-06-06T13:00:00+08:00" })
  ];
  const service = new CalendarSnapshotService(createBridge(events), store);

  let fullSnapshotReads = 0;
  let pagedSnapshotReads = 0;
  let fullChangeReads = 0;
  let pagedChangeReads = 0;
  const instrumentedStore = new Proxy(store, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== "function") {
        return value;
      }

      return (...args) => {
        if (property === "listSnapshotEvents") {
          fullSnapshotReads += 1;
        }
        if (property === "listSnapshotEventsPage") {
          pagedSnapshotReads += 1;
        }
        if (property === "listChangesSince") {
          fullChangeReads += 1;
        }
        if (property === "listChangesSincePage") {
          pagedChangeReads += 1;
        }
        return value.apply(target, args);
      };
    }
  });
  const instrumentedService = new CalendarSnapshotService(createBridge(events), instrumentedStore);

  try {
    const first = assertSuccess(
      await instrumentedService.createSnapshot({
        calendar_id: workCalendarId,
        start: "2026-06-06T00:00:00+08:00",
        end: "2026-06-07T00:00:00+08:00"
      })
    );
    events[0].start = "2026-06-06T14:00:00+08:00";
    events[0].end = "2026-06-06T15:00:00+08:00";
    assertSuccess(
      await instrumentedService.createSnapshot({
        calendar_id: workCalendarId,
        start: "2026-06-06T00:00:00+08:00",
        end: "2026-06-07T00:00:00+08:00"
      })
    );

    assertSuccess(await instrumentedService.getSnapshot({ snapshot_id: first.data.snapshot_id, limit: 1 }));
    assertSuccess(await instrumentedService.getChangesSince({ snapshot_id: first.data.snapshot_id, limit: 1 }));

    assert.equal(pagedSnapshotReads, 1);
    assert.equal(pagedChangeReads, 1);
    assert.equal(fullChangeReads, 0);
    assert.equal(fullSnapshotReads, 1);
  } finally {
    store.close();
  }
});

test("calendar_get_snapshot hides snapshots whose calendars are no longer allowed", async () => {
  const { store } = await createStore();
  const service = new CalendarSnapshotService(createBridge([event()]), store);

  try {
    const created = assertSuccess(
      await service.createSnapshot({
        calendar_id: workCalendarId,
        start: "2026-06-06T00:00:00+08:00",
        end: "2026-06-07T00:00:00+08:00"
      })
    );
    store.upsertCalendar({
      calendar_id: workCalendarId,
      native_calendar_id: workNativeCalendarId,
      title: "Work",
      source_title: "iCloud",
      allows_content_modifications: true,
      is_subscribed: false,
      is_allowed: false,
      color: "#3366FF",
      last_seen_at: "2026-06-06T00:00:00Z"
    });

    const response = await service.getSnapshot({ snapshot_id: created.data.snapshot_id });
    assert.equal(response.success, false);
    assert.equal(response.error.code, "SNAPSHOT_NOT_FOUND");
  } finally {
    store.close();
  }
});
