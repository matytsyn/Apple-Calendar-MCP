import { createHash, randomBytes } from "node:crypto";
import {
  ChangeFeedRecordSchema,
  CreateSnapshotInputSchema,
  GetChangesSinceInputSchema,
  GetSnapshotInputSchema,
  SnapshotEventSchema,
  SnapshotSchema,
  TimezoneSchema,
  type Calendar,
  type ChangeFeedRecord,
  type SemanticErrorCode,
  type SemanticFailure,
  type SemanticResponse,
  type SemanticSuccess,
  type Snapshot,
  type SnapshotEvent
} from "@apple-calendar-mcp/shared";
import { AppleCalendarSqliteStore } from "@apple-calendar-mcp/sqlite-store";
import { EventKitBridgeCallError, EventKitBridgeClient } from "./eventkit-bridge-client.js";
import { calendarIdFromNative, eventIdFromNative } from "./read-service.js";

type EventKitSnapshotBridge = {
  listEvents(params: Record<string, unknown>): Promise<unknown>;
};

export type CalendarSnapshotStore = {
  getCalendar(calendarId: string): Calendar | null;
  listAllowedCalendars(): Calendar[];
  createSnapshot(record: Snapshot): void;
  createSnapshotBundle(record: Snapshot, events: SnapshotEvent[], changes: ChangeFeedRecord[]): void;
  getSnapshot(snapshotId: string): Snapshot | null;
  getLatestSnapshotForScope(scope: Snapshot["scope"], beforeCreatedAt: string): Snapshot | null;
  addSnapshotEvent(record: SnapshotEvent): void;
  listSnapshotEvents(snapshotId: string): SnapshotEvent[];
  listSnapshotEventsPage(snapshotId: string, limit: number, offset: number): SnapshotEvent[];
  addChange(record: ChangeFeedRecord): void;
  listChangesSince(createdAt: string, filters?: { calendarId?: string; snapshotId?: string }): ChangeFeedRecord[];
  listChangesSincePage(
    createdAt: string,
    filters: { calendarId?: string; snapshotId?: string; allowedCalendarIds?: string[] },
    limit: number,
    offset: number
  ): ChangeFeedRecord[];
};

type BridgeEvent = {
  native_event_id: string;
  native_calendar_id: string;
  title: string;
  start: string;
  end: string;
  timezone: string | null;
  is_all_day: boolean;
  location: string | null;
  notes: string | null;
  url: string | null;
  has_recurrence_rules: boolean;
  last_modified_at: string | null;
};

type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

const DEFAULT_MAX_SNAPSHOT_RANGE_DAYS = 370;
const LARGE_MAX_SNAPSHOT_RANGE_DAYS = 1827;
const MAX_SNAPSHOT_EVENTS = 5000;

export type SnapshotCompactEvent = {
  event_id: string;
  calendar_id: string;
  title_preview: string | null;
  start_utc: string;
  end_utc: string;
  timezone: string | null;
  is_all_day: boolean;
  is_recurring: boolean;
  fingerprint: string;
  last_modified_at: string | null;
};

export class CalendarSnapshotService {
  constructor(
    private readonly bridge: EventKitSnapshotBridge,
    private readonly store: CalendarSnapshotStore
  ) {}

  async createSnapshot(input: unknown): Promise<SemanticResponse<{
    snapshot_id: string;
    created_at: string;
    event_count: number;
    hash: string;
    scope: Snapshot["scope"];
    changes_detected: number;
  }>> {
    const parsed = CreateSnapshotInputSchema.safeParse(input);
    if (!parsed.success) {
      return inputFailure(input);
    }

    const calendars = this.allowedCalendars(parsed.data.calendar_id);
    if ("success" in calendars) {
      return calendars;
    }

    const rangeFailure = validateSnapshotRange(parsed.data.start, parsed.data.end, parsed.data.allow_large_range);
    if (rangeFailure) {
      return rangeFailure;
    }

    const scope = {
      calendar_ids: calendars.map((calendar) => calendar.calendar_id).sort(),
      start_utc: new Date(Date.parse(parsed.data.start)).toISOString(),
      end_utc: new Date(Date.parse(parsed.data.end)).toISOString()
    };
    let createdAt = nowIso();
    const previousSnapshot = this.store.getLatestSnapshotForScope(scope, createdAt);
    if (previousSnapshot && Date.parse(createdAt) <= Date.parse(previousSnapshot.created_at)) {
      createdAt = new Date(Date.parse(previousSnapshot.created_at) + 1).toISOString();
    }

    try {
      const events = parseBridgeEventList(
        await this.bridge.listEvents({
          native_calendar_ids: calendars.map((calendar) => calendar.native_calendar_id),
          start: parsed.data.start,
          end: parsed.data.end
        })
      )
        .filter((event) => calendars.some((calendar) => calendar.native_calendar_id === event.native_calendar_id))
        .map(toSnapshotEvent);

      if (events.length > MAX_SNAPSHOT_EVENTS) {
        return failure(
          "INVALID_INPUT",
          `Snapshot would include ${events.length} events, exceeding the ${MAX_SNAPSHOT_EVENTS} event limit.`,
          "Create a narrower snapshot range or filter to one calendar.",
          false
        );
      }

      const snapshotId = id("snap");
      const snapshotHash = hashObject(events.map((event) => event.fingerprint).sort());
      const snapshot = SnapshotSchema.parse({
        snapshot_id: snapshotId,
        scope,
        created_at: createdAt,
        created_by: "unknown_mcp_client",
        event_count: events.length,
        hash: snapshotHash,
        notes: parsed.data.notes ?? null
      });

      const snapshotEvents = events.map((event) => ({
          ...event,
          snapshot_event_id: id("snap_evt"),
          snapshot_id: snapshotId
      }));

      const changes = previousSnapshot
        ? diffSnapshotEvents(
            previousSnapshot,
            this.store.listSnapshotEvents(previousSnapshot.snapshot_id),
            snapshot,
            snapshotEvents
          )
        : [];

      this.store.createSnapshotBundle(snapshot, snapshotEvents, changes);

      return success({
        snapshot_id: snapshotId,
        created_at: createdAt,
        event_count: events.length,
        hash: snapshotHash,
        scope,
        changes_detected: changes.length
      });
    } catch (error) {
      return bridgeFailure(error);
    }
  }

  async getSnapshot(input: unknown): Promise<SemanticResponse<{
    snapshot: Snapshot;
    events: SnapshotCompactEvent[];
  }>> {
    const parsed = GetSnapshotInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidInput();
    }

    const snapshot = this.allowedSnapshot(parsed.data.snapshot_id);
    if ("success" in snapshot) {
      return snapshot;
    }

    const offset = decodeCursor(parsed.data.cursor);
    if (offset === null) {
      return invalidInput();
    }

    const eventRows = parsed.data.include_events
      ? this.store.listSnapshotEventsPage(snapshot.snapshot_id, parsed.data.limit + 1, offset)
      : [];
    const page = pageFromRows(eventRows.map(toPublicSnapshotEvent), parsed.data.limit, offset);

    return success(
      {
        snapshot,
        events: page.items
      },
      { next_cursor: page.nextCursor }
    );
  }

  async getChangesSince(input: unknown): Promise<SemanticResponse<{
    since_snapshot_id: string;
    changes: Array<{
      change_id: string;
      change_type: string;
      event_id: string | null;
      calendar_id: string | null;
      changed_fields: string[];
      summary: string | null;
      created_at: string;
    }>;
  }>> {
    const parsed = GetChangesSinceInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidInput();
    }

    const snapshot = this.allowedSnapshot(parsed.data.snapshot_id);
    if ("success" in snapshot) {
      return snapshot;
    }

    if (parsed.data.calendar_id) {
      const calendar = this.store.getCalendar(parsed.data.calendar_id);
      if (!calendar?.is_allowed) {
        return calendarNotFound();
      }
    }

    const offset = decodeCursor(parsed.data.cursor);
    if (offset === null) {
      return invalidInput();
    }

    const allowedCalendarIds = this.store.listAllowedCalendars().map((calendar) => calendar.calendar_id);
    const changeRows = this.store
      .listChangesSincePage(
        snapshot.created_at,
        {
          snapshotId: snapshot.snapshot_id,
          allowedCalendarIds,
          ...(parsed.data.calendar_id ? { calendarId: parsed.data.calendar_id } : {})
        },
        parsed.data.limit + 1,
        offset
      )
      .map(toPublicChange);
    const page = pageFromRows(changeRows, parsed.data.limit, offset);

    return success(
      {
        since_snapshot_id: snapshot.snapshot_id,
        changes: page.items
      },
      { next_cursor: page.nextCursor }
    );
  }

  private allowedCalendars(calendarId: string | undefined): Calendar[] | SemanticFailure {
    if (calendarId) {
      const calendar = this.store.getCalendar(calendarId);
      if (!calendar?.is_allowed) {
        return calendarNotFound();
      }

      return [calendar];
    }

    const calendars = this.store.listAllowedCalendars();
    return calendars.length > 0 ? calendars : calendarNotFound();
  }

  private allowedSnapshot(snapshotId: string): Snapshot | SemanticFailure {
    const snapshot = this.store.getSnapshot(snapshotId);
    if (!snapshot) {
      return snapshotNotFound();
    }

    const allowedCalendarIds = new Set(
      this.store.listAllowedCalendars().map((calendar) => calendar.calendar_id)
    );
    if (!snapshot.scope.calendar_ids.every((calendarId) => allowedCalendarIds.has(calendarId))) {
      return snapshotNotFound();
    }

    return snapshot;
  }
}

export function createDefaultCalendarSnapshotService(): CalendarSnapshotService {
  const command = process.env.APPLE_CALENDAR_MCP_HELPER ?? "apple-calendar-mcp-helper";
  const databasePath = process.env.APPLE_CALENDAR_MCP_DATABASE_PATH;
  return new CalendarSnapshotService(
    new EventKitBridgeClient({ command }),
    new AppleCalendarSqliteStore(databasePath ? { path: databasePath } : {})
  );
}

function toSnapshotEvent(event: BridgeEvent): Omit<SnapshotEvent, "snapshot_event_id" | "snapshot_id"> {
  const calendarId = calendarIdFromNative(event.native_calendar_id);
  const eventId = eventIdFromNative(event.native_event_id);
  const startUtc = new Date(Date.parse(event.start)).toISOString();
  const endUtc = new Date(Date.parse(event.end)).toISOString();
  const titleHash = sha256(normalizeComparable(event.title));
  const timezone = TimezoneSchema.safeParse(event.timezone).success ? event.timezone : null;
  const compact = {
    title_hash: titleHash,
    location_hash: event.location ? sha256(normalizeComparable(event.location)) : null,
    notes_present: Boolean(event.notes?.trim()),
    url_present: Boolean(event.url?.trim())
  };

  const fingerprint = hashObject({
    calendar_id: calendarId,
    title_hash: titleHash,
    start_utc: startUtc,
    end_utc: endUtc,
    timezone,
    is_all_day: event.is_all_day,
    is_recurring: event.has_recurrence_rules,
    location_hash: compact.location_hash,
    notes_present: compact.notes_present,
    url_present: compact.url_present
  });

  const parsed = SnapshotEventSchema.parse({
    snapshot_event_id: "snap_evt_validate",
    snapshot_id: "snap_validate",
    event_id: eventId,
    native_event_id: event.native_event_id,
    calendar_id: calendarId,
    title_hash: titleHash,
    title_preview: null,
    start_utc: startUtc,
    end_utc: endUtc,
    timezone,
    is_all_day: event.is_all_day,
    is_recurring: event.has_recurrence_rules,
    recurrence_key: event.has_recurrence_rules ? sha256(`${eventId}:recurring`) : null,
    fingerprint,
    last_modified_at: validUtcOrNull(event.last_modified_at),
    compact
  });
  const { snapshot_event_id, snapshot_id, ...snapshotEvent } = parsed;
  void snapshot_event_id;
  void snapshot_id;
  return snapshotEvent;
}

function diffSnapshotEvents(
  previousSnapshot: Snapshot,
  previousEvents: SnapshotEvent[],
  currentSnapshot: Snapshot,
  currentEvents: SnapshotEvent[]
): ChangeFeedRecord[] {
  const previousByEventId = new Map(previousEvents.map((event) => [event.event_id, event]));
  const currentByEventId = new Map(currentEvents.map((event) => [event.event_id, event]));
  const changes: ChangeFeedRecord[] = [];

  for (const current of currentEvents) {
    const previous = previousByEventId.get(current.event_id);
    if (!previous) {
      changes.push(changeRecord("created", currentSnapshot, null, current, ["event"]));
      continue;
    }

    if (previous.fingerprint !== current.fingerprint) {
      changes.push(changeRecord(changeType(previous, current), currentSnapshot, previous, current, changedFields(previous, current)));
    }
  }

  for (const previous of previousEvents) {
    if (!currentByEventId.has(previous.event_id)) {
      changes.push(changeRecord("deleted", currentSnapshot, previous, null, ["event"]));
    }
  }

  return changes;
}

function changeRecord(
  changeTypeValue: ChangeFeedRecord["change_type"],
  snapshot: Snapshot,
  before: SnapshotEvent | null,
  after: SnapshotEvent | null,
  fields: string[]
): ChangeFeedRecord {
  const event = after ?? before;
  return ChangeFeedRecordSchema.parse({
    change_id: id("chg"),
    snapshot_id: snapshot.snapshot_id,
    operation_id: null,
    change_type: changeTypeValue,
    event_id: event?.event_id ?? null,
    native_event_id: event?.native_event_id ?? null,
    calendar_id: event?.calendar_id ?? null,
    changed_fields: fields,
    before_fingerprint: before?.fingerprint ?? null,
    after_fingerprint: after?.fingerprint ?? null,
    summary: compactChangeSummary(changeTypeValue, event),
    created_at: snapshot.created_at
  });
}

function changeType(previous: SnapshotEvent, current: SnapshotEvent): ChangeFeedRecord["change_type"] {
  if (previous.start_utc !== current.start_utc || previous.end_utc !== current.end_utc) {
    return "moved";
  }

  if (previous.is_recurring !== current.is_recurring || previous.recurrence_key !== current.recurrence_key) {
    return "recurrence_changed";
  }

  if (previous.calendar_id !== current.calendar_id) {
    return "calendar_changed";
  }

  return "updated";
}

function changedFields(previous: SnapshotEvent, current: SnapshotEvent): string[] {
  const fields: string[] = [];
  for (const field of ["calendar_id", "title_hash", "start_utc", "end_utc", "timezone", "is_all_day", "is_recurring", "recurrence_key"] as const) {
    if (previous[field] !== current[field]) {
      fields.push(field);
    }
  }

  if (compactField(previous, "location_hash") !== compactField(current, "location_hash")) {
    fields.push("location_hash");
  }
  if (compactField(previous, "notes_present") !== compactField(current, "notes_present")) {
    fields.push("notes_present");
  }
  if (compactField(previous, "url_present") !== compactField(current, "url_present")) {
    fields.push("url_present");
  }

  return fields.length > 0 ? fields : ["fingerprint"];
}

function compactField(event: SnapshotEvent, field: string): unknown {
  return event.compact && typeof event.compact === "object"
    ? (event.compact as Record<string, unknown>)[field]
    : null;
}

function toPublicSnapshotEvent(event: SnapshotEvent): SnapshotCompactEvent {
  return {
    event_id: event.event_id,
    calendar_id: event.calendar_id,
    title_preview: event.title_preview,
    start_utc: event.start_utc,
    end_utc: event.end_utc,
    timezone: event.timezone,
    is_all_day: event.is_all_day,
    is_recurring: event.is_recurring,
    fingerprint: event.fingerprint,
    last_modified_at: event.last_modified_at
  };
}

function toPublicChange(change: ChangeFeedRecord): {
  change_id: string;
  change_type: string;
  event_id: string | null;
  calendar_id: string | null;
  changed_fields: string[];
  summary: string | null;
  created_at: string;
} {
  return {
    change_id: change.change_id,
    change_type: change.change_type,
    event_id: change.event_id,
    calendar_id: change.calendar_id,
    changed_fields: change.changed_fields,
    summary: change.summary,
    created_at: change.created_at
  };
}

function parseBridgeEventList(value: unknown): BridgeEvent[] {
  if (!Array.isArray(value)) {
    throw new Error("EventKit bridge returned invalid event data.");
  }

  return value.map(parseBridgeEvent);
}

function parseBridgeEvent(value: unknown): BridgeEvent {
  if (!value || typeof value !== "object") {
    throw new Error("EventKit bridge returned invalid event data.");
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.native_event_id !== "string" ||
    typeof record.native_calendar_id !== "string" ||
    typeof record.title !== "string" ||
    typeof record.start !== "string" ||
    typeof record.end !== "string" ||
    Number.isNaN(Date.parse(record.start)) ||
    Number.isNaN(Date.parse(record.end)) ||
    Date.parse(record.start) >= Date.parse(record.end)
  ) {
    throw new Error("EventKit bridge returned invalid event data.");
  }

  return {
    native_event_id: record.native_event_id,
    native_calendar_id: record.native_calendar_id,
    title: record.title,
    start: record.start,
    end: record.end,
    timezone: typeof record.timezone === "string" ? record.timezone : null,
    is_all_day: typeof record.is_all_day === "boolean" ? record.is_all_day : false,
    location: typeof record.location === "string" ? record.location : null,
    notes: typeof record.notes === "string" ? record.notes : null,
    url: typeof record.url === "string" ? record.url : null,
    has_recurrence_rules:
      typeof record.has_recurrence_rules === "boolean" ? record.has_recurrence_rules : false,
    last_modified_at: typeof record.last_modified_at === "string" ? record.last_modified_at : null
  };
}

function pageFromRows<T>(
  rows: T[],
  limit: number,
  offset: number
): Page<T> {
  const pageItems = rows.slice(0, limit);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    nextCursor: rows.length > limit ? encodeCursor(nextOffset) : null
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): number | null {
  if (!cursor) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    return typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0
      ? parsed.offset
      : null;
  } catch {
    return null;
  }
}

function compactChangeSummary(changeTypeValue: string, event: SnapshotEvent | null | undefined): string {
  void event;
  return `${changeTypeValue} event`;
}

function validUtcOrNull(value: string | null): string | null {
  return typeof value === "string" && value.endsWith("Z") && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function normalizeComparable(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function hashObject(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)])
    );
  }

  return value;
}

function id(prefix: "snap" | "snap_evt" | "chg"): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

function inputFailure(input: unknown): SemanticFailure {
  return hasAmbiguousDate(input) ? ambiguousDate() : invalidInput();
}

function validateSnapshotRange(start: string, end: string, allowLargeRange: boolean): SemanticFailure | null {
  const rangeDays = (Date.parse(end) - Date.parse(start)) / (24 * 60 * 60 * 1000);
  const maxDays = allowLargeRange ? LARGE_MAX_SNAPSHOT_RANGE_DAYS : DEFAULT_MAX_SNAPSHOT_RANGE_DAYS;
  if (rangeDays > maxDays) {
    return failure(
      "INVALID_INPUT",
      `Snapshot range is ${Math.ceil(rangeDays)} days, exceeding the ${maxDays} day limit.`,
      allowLargeRange
        ? "Create a narrower snapshot range."
        : "Create a narrower snapshot range or set allow_large_range: true for an explicit large snapshot.",
      false
    );
  }

  return null;
}

function hasAmbiguousDate(input: unknown): boolean {
  if (!input || typeof input !== "object") {
    return false;
  }

  const record = input as Record<string, unknown>;
  return [record.start, record.end].some((value) => typeof value === "string" && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value));
}

function ambiguousDate(): SemanticFailure {
  return failure(
    "AMBIGUOUS_DATE",
    "The requested date could not be safely resolved.",
    "Provide fully specified ISO timestamps with timezone offsets.",
    false
  );
}

function calendarNotFound(): SemanticFailure {
  return failure(
    "CALENDAR_NOT_FOUND",
    "The requested calendar is not available.",
    "Call calendar_list_calendars and choose an allowed calendar.",
    false
  );
}

function snapshotNotFound(): SemanticFailure {
  return failure(
    "SNAPSHOT_NOT_FOUND",
    "The requested snapshot is not available.",
    "Create a new snapshot or use a snapshot_id returned by calendar_create_snapshot.",
    false
  );
}

function invalidInput(): SemanticFailure {
  return failure(
    "INVALID_INPUT",
    "The request did not match the tool schema.",
    "Check the tool input fields and retry.",
    false
  );
}

function bridgeFailure(error: unknown): SemanticFailure {
  if (error instanceof EventKitBridgeCallError) {
    return failure(normalizeBridgeErrorCode(error.code), error.message, error.suggestedAction, error.retryable);
  }

  return failure(
    "EVENTKIT_OPERATION_FAILED",
    "Calendar snapshot data could not be read.",
    "Check Calendar permissions and retry.",
    true
  );
}

function normalizeBridgeErrorCode(code: string): SemanticErrorCode {
  const supportedCodes = new Set<SemanticErrorCode>([
    "CALENDAR_NOT_FOUND",
    "EVENT_NOT_FOUND",
    "PERMISSION_DENIED",
    "CALENDAR_PERMISSION_DENIED",
    "INVALID_INPUT",
    "EVENTKIT_OPERATION_FAILED"
  ]);

  return supportedCodes.has(code as SemanticErrorCode)
    ? (code as SemanticErrorCode)
    : "EVENTKIT_OPERATION_FAILED";
}

function failure(
  code: SemanticErrorCode,
  message: string,
  suggestedAction: string,
  retryable: boolean
): SemanticFailure {
  return {
    success: false,
    error: {
      code,
      message,
      suggested_action: suggestedAction,
      retryable
    }
  };
}

function success<TData>(
  data: TData,
  meta: Record<string, unknown> = {}
): SemanticSuccess<TData> {
  return {
    success: true,
    data,
    meta
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
