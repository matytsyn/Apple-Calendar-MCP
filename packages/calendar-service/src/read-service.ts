import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CalendarSchema,
  CheckConflictsInputSchema,
  GetCalendarInputSchema,
  GetEventInputSchema,
  PermissionsCheckInputSchema,
  ListCalendarsInputSchema,
  ListEventsInputSchema,
  PreviewCreateEventInputSchema,
  PreviewUpdateEventInputSchema,
  SearchEventsInputSchema,
  TimezoneSchema,
  type Calendar,
  type CalendarPermissionStatus,
  type DetailLevel,
  type HealthCheckData,
  type PermissionsCheckData,
  type SemanticErrorCode,
  type SemanticFailure,
  type SemanticResponse,
  type SemanticSuccess
} from "@apple-calendar-mcp/shared";
import type { z } from "zod";
import { APP_SUPPORT_DIR, AppleCalendarSqliteStore } from "@apple-calendar-mcp/sqlite-store";
import { EventKitBridgeCallError, EventKitBridgeClient } from "./eventkit-bridge-client.js";

export type EventKitReadBridge = {
  permissionStatus(): Promise<unknown>;
  requestPermission(): Promise<unknown>;
  listCalendars(): Promise<unknown>;
  listEvents(params: Record<string, unknown>): Promise<unknown>;
  getEvent(params: Record<string, unknown>): Promise<unknown>;
};

export type CalendarReadStore = {
  upsertCalendar(record: Calendar): void;
  getCalendar(calendarId: string): Calendar | null;
  listAllowedCalendars(): Calendar[];
};

export type CalendarListItem = {
  calendar_id: string;
  name: string;
  allows_content_modifications: boolean;
  is_subscribed: boolean;
  color: string | null;
};

export type CalendarDetail = CalendarListItem & {
  source_title: string | null;
  last_seen_at: string;
};

export type EventMinimal = {
  event_id: string;
  title: string;
  start: string;
  end: string;
  calendar_id: string;
};

export type EventStandard = EventMinimal & {
  location_summary: string | null;
  recurrence: {
    is_recurring: boolean;
  };
  conflict: false;
};

export type EventFull = EventStandard & {
  notes: string | null;
  url: string | null;
  timezone: string;
  is_all_day: boolean;
  last_modified_at: string | null;
};

export type ConflictWarning = {
  event_id: string;
  title: string;
  start: string;
  end: string;
  calendar_id: string;
  is_all_day: boolean;
};

export type DuplicateWarning = ConflictWarning & {
  reason: string;
};

export type SafetyAnalysis = {
  conflicts: ConflictWarning[];
  duplicates: DuplicateWarning[];
  ambiguities: string[];
  recurring_scope_required: boolean;
  recurring_scope: string | null;
  warnings: string[];
};

type BridgeCalendar = {
  native_calendar_id: string;
  title: string;
  source_title?: string | null;
  allows_content_modifications?: boolean;
  is_subscribed?: boolean;
  color?: string | null;
};

type BridgeEvent = {
  native_event_id: string;
  native_calendar_id: string;
  title: string;
  start: string;
  end: string;
  timezone?: string | null;
  is_all_day?: boolean;
  location?: string | null;
  notes?: string | null;
  url?: string | null;
  has_recurrence_rules?: boolean;
  last_modified_at?: string | null;
};

type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

const MAX_TITLE_LENGTH = 120;
const MAX_LOCATION_LENGTH = 120;
const MAX_NOTES_LENGTH = 2000;
const MAX_URL_LENGTH = 500;
const EVENTKIT_QUERY_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MIN_RETRY_QUERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SETUP_CONFIG_PATH = join(APP_SUPPORT_DIR, "config.json");

export class CalendarReadService {
  constructor(
    private readonly bridge: EventKitReadBridge,
    private readonly store: CalendarReadStore
  ) {}

  async healthCheck(): Promise<SemanticResponse<HealthCheckData>> {
    try {
      const permissionStatus = parsePermissionStatus(await this.bridge.permissionStatus());
      const eventkitAvailable = isReadablePermission(permissionStatus.calendar_permission);

      return success({
        status: eventkitAvailable ? "ok" : "degraded",
        server: "started",
        swift_bridge_status: "real",
        eventkit_status: eventkitAvailable ? "real" : "unavailable",
        permission_status: permissionStatus.calendar_permission,
        permission_request_available: permissionStatus.calendar_permission === "not_determined",
        helper_bundle_identifier: permissionStatus.helper_bundle_identifier,
        info_plist_detected: permissionStatus.info_plist_detected,
        bridge_process_mode: permissionStatus.bridge_process_mode,
        database_status: "real",
        configuration_status: "loaded",
        calendar_operations: eventkitAvailable ? "real_eventkit_bridge" : "unavailable"
      });
    } catch {
      return success({
        status: "failing",
        server: "started",
        swift_bridge_status: "failing",
        eventkit_status: "failing",
        permission_status: "unknown",
        permission_request_available: false,
        helper_bundle_identifier: null,
        info_plist_detected: false,
        bridge_process_mode: "unknown",
        database_status: "real",
        configuration_status: "loaded",
        calendar_operations: "failing"
      });
    }
  }

  async permissionsCheck(input: unknown): Promise<SemanticResponse<PermissionsCheckData>> {
    const parsed = PermissionsCheckInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidInput();
    }

    try {
      const initialStatus = parsePermissionStatus(await this.bridge.permissionStatus());
      let finalStatus = initialStatus.calendar_permission;
      let granted: boolean | null = null;
      let diagnostics = initialStatus;

      if (finalStatus === "not_determined" && parsed.data.request_permission) {
        const requested = parsePermissionRequest(await this.bridge.requestPermission());
        finalStatus = requested.calendar_permission;
        granted = requested.granted;
        diagnostics = requested;

        if (!isReadablePermission(finalStatus)) {
          return failure(
            "CALENDAR_PERMISSION_DENIED",
            "Calendar permission was requested but is not authorized.",
            "Grant Calendar access in macOS Settings or run the local helper permission recovery command, then retry.",
            finalStatus === "not_determined"
          );
        }
      }

      return success({
        calendar_permission: finalStatus,
        authorization_status: finalStatus,
        permission_mode: "not_loaded",
        calendar_allowlist: "loaded",
        swift_bridge_status: "real",
        eventkit_status: isReadablePermission(finalStatus) ? "real" : "unavailable",
        request_attempted: diagnostics.request_attempted,
        request_api_used: diagnostics.request_api_used,
        helper_bundle_identifier: diagnostics.helper_bundle_identifier,
        info_plist_detected: diagnostics.info_plist_detected,
        bridge_process_mode: diagnostics.bridge_process_mode,
        permission_request: {
          available: finalStatus === "not_determined",
          attempted: diagnostics.request_attempted,
          granted
        }
      });
    } catch (error) {
      return bridgeFailure(error);
    }
  }

  async listCalendars(input: unknown): Promise<SemanticResponse<CalendarListItem[]>> {
    const parsed = ListCalendarsInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidInput();
    }

    const syncFailure = await this.syncCalendarCache();
    if (syncFailure) {
      return syncFailure;
    }

    const page = paginate(
      this.store.listAllowedCalendars().map(toCalendarListItem),
      parsed.data.limit,
      parsed.data.cursor
    );
    if ("success" in page) {
      return page;
    }

    return success(page.items, { next_cursor: page.nextCursor });
  }

  async getCalendar(input: unknown): Promise<SemanticResponse<CalendarDetail>> {
    const parsed = GetCalendarInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidInput();
    }

    const calendar = this.store.getCalendar(parsed.data.calendar_id);
    if (!calendar?.is_allowed) {
      return failure(
        "CALENDAR_NOT_FOUND",
        "The requested calendar is not available.",
        "Call calendar_list_calendars and choose an allowed calendar.",
        false
      );
    }

    return success({
      ...toCalendarListItem(calendar),
      source_title: calendar.source_title,
      last_seen_at: calendar.last_seen_at
    });
  }

  async listEvents(input: unknown): Promise<SemanticResponse<Array<EventMinimal | EventStandard | EventFull>>> {
    const parsed = ListEventsInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidInput();
    }

    const calendars = this.allowedCalendarsForFilter(parsed.data.calendar_id);
    if ("success" in calendars) {
      return calendars;
    }

    const events = await this.fetchAllowedEvents(calendars, parsed.data.start, parsed.data.end);
    if ("success" in events) {
      return events;
    }

    const page = paginate(
      sortEvents(events).map((event) => eventForDetailLevel(event, parsed.data.detail_level)),
      parsed.data.limit,
      parsed.data.cursor
    );
    if ("success" in page) {
      return page;
    }

    return success(page.items, { next_cursor: page.nextCursor });
  }

  async searchEvents(input: unknown): Promise<SemanticResponse<Array<EventMinimal | EventStandard | EventFull>>> {
    const parsed = SearchEventsInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidInput();
    }

    const calendars = this.allowedCalendarsForFilter(parsed.data.calendar_id);
    if ("success" in calendars) {
      return calendars;
    }

    const events = await this.fetchAllowedEvents(calendars, parsed.data.start, parsed.data.end);
    if ("success" in events) {
      return events;
    }

    const query = parsed.data.query.toLocaleLowerCase();
    const matchedEvents = sortEvents(events).filter((event) =>
      [event.title, event.location ?? ""].some((value) =>
        value.toLocaleLowerCase().includes(query)
      )
    );

    const page = paginate(
      matchedEvents.map((event) => eventForDetailLevel(event, parsed.data.detail_level)),
      parsed.data.limit,
      parsed.data.cursor
    );
    if ("success" in page) {
      return page;
    }

    return success(page.items, { next_cursor: page.nextCursor });
  }

  async getEvent(input: unknown): Promise<SemanticResponse<EventMinimal | EventStandard | EventFull>> {
    const parsed = GetEventInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidInput();
    }

    const nativeEventId = nativeEventIdFromEventId(parsed.data.event_id);
    if (!nativeEventId) {
      return failure(
        "EVENT_NOT_FOUND",
        "The requested event is not available.",
        "Call calendar_list_events or calendar_search_events and use a returned event_id.",
        false
      );
    }

    try {
      const rawEvent = await this.bridge.getEvent({ native_event_id: nativeEventId });
      const event = parseBridgeEvent(rawEvent);
      const calendarId = calendarIdFromNative(event.native_calendar_id);
      const calendar = this.store.getCalendar(calendarId);

      if (!calendar?.is_allowed) {
        return failure(
          "EVENT_NOT_FOUND",
          "The requested event is not available.",
          "Call calendar_list_events or calendar_search_events and use a returned event_id.",
          false
        );
      }

      return success(eventForDetailLevel(toNormalizedEvent(event), parsed.data.detail_level));
    } catch (error) {
      return bridgeFailure(error);
    }
  }

  async checkConflicts(input: unknown): Promise<SemanticResponse<{
    has_conflicts: boolean;
    conflicts: ConflictWarning[];
  }>> {
    const parsed = CheckConflictsInputSchema.safeParse(input);
    if (!parsed.success) {
      return inputFailure(input, parsed.error);
    }

    const calendars = this.allowedCalendarsForFilter(parsed.data.calendar_id);
    if ("success" in calendars) {
      return calendars;
    }

    const queryRange = expandedSafetyRange(parsed.data.start, parsed.data.end);
    const events = await this.fetchAllowedEvents(calendars, queryRange.start, queryRange.end);
    if ("success" in events) {
      return events;
    }

    const excludedNativeEventId = parsed.data.exclude_event_id
      ? nativeEventIdFromEventId(parsed.data.exclude_event_id)
      : null;
    const conflicts = events
      .filter((event) => event.event_id !== parsed.data.exclude_event_id)
      .filter((event) => excludedNativeEventId === null || event.event_id !== eventIdFromNative(excludedNativeEventId))
      .filter((event) => overlaps(parsed.data.start, parsed.data.end, event.start, event.end))
      .map(toConflictWarning);

    return success({
      has_conflicts: conflicts.length > 0,
      conflicts
    });
  }

  async previewCreateEvent(input: unknown): Promise<SemanticResponse<{
    would_create: true;
    proposed_event: {
      calendar_id: string;
      title: string;
      start: string;
      end: string;
      timezone: string | null;
      is_all_day: boolean;
      location: string | null;
      notes_present: boolean;
      url_present: boolean;
    };
    safety: SafetyAnalysis;
  }>> {
    const parsed = PreviewCreateEventInputSchema.safeParse(input);
    if (!parsed.success) {
      return inputFailure(input, parsed.error);
    }

    const calendars = this.allowedCalendarsForFilter(parsed.data.calendar_id);
    if ("success" in calendars) {
      return calendars;
    }

    const queryRange = expandedSafetyRange(parsed.data.start, parsed.data.end);
    const events = await this.fetchAllowedEvents(calendars, queryRange.start, queryRange.end);
    if ("success" in events) {
      return events;
    }

    const proposed = {
      calendar_id: parsed.data.calendar_id,
      title: boundedString(parsed.data.title, MAX_TITLE_LENGTH),
      start: parsed.data.start,
      end: parsed.data.end,
      timezone: parsed.data.timezone ?? null,
      is_all_day: parsed.data.is_all_day,
      location: trimNullable(parsed.data.location ?? null, MAX_LOCATION_LENGTH),
      notes_present: Boolean(trimNullable(parsed.data.notes ?? null, MAX_NOTES_LENGTH)),
      url_present: Boolean(trimNullable(parsed.data.url ?? null, MAX_URL_LENGTH))
    };

    return success({
      would_create: true,
      proposed_event: proposed,
      safety: analyzeCreateSafety({
        title: proposed.title,
        start: proposed.start,
        end: proposed.end,
        location: proposed.location,
        existingEvents: events
      })
    });
  }

  async previewUpdateEvent(input: unknown): Promise<SemanticResponse<{
    would_update: true;
    event_id: string;
    recurrence_scope: string | null;
    current_event: EventStandard;
    proposed_event: EventStandard;
    changes: Record<string, unknown>;
    safety: SafetyAnalysis;
  }>> {
    const parsed = PreviewUpdateEventInputSchema.safeParse(input);
    if (!parsed.success) {
      return inputFailure(input, parsed.error);
    }

    const nativeEventId = nativeEventIdFromEventId(parsed.data.event_id);
    if (!nativeEventId) {
      return failure(
        "EVENT_NOT_FOUND",
        "The requested event is not available.",
        "Call calendar_list_events or calendar_search_events and use a returned event_id.",
        false
      );
    }

    try {
      const rawEvent = await this.bridge.getEvent({ native_event_id: nativeEventId });
      const currentBridgeEvent = parseBridgeEvent(rawEvent);
      const current = toNormalizedEvent(currentBridgeEvent);
      const calendar = this.store.getCalendar(current.calendar_id);

      if (!calendar?.is_allowed) {
        return failure(
          "EVENT_NOT_FOUND",
          "The requested event is not available.",
          "Call calendar_list_events or calendar_search_events and use a returned event_id.",
          false
        );
      }

      if (current.is_recurring && !parsed.data.recurrence_scope) {
        return failure(
          "RECURRING_SCOPE_REQUIRED",
          "This event is recurring and update scope is required.",
          "Specify single_instance, this_and_future, or entire_series.",
          false
        );
      }

      const proposed = applyPreviewChanges(current, parsed.data.changes);
      if (Date.parse(proposed.start) >= Date.parse(proposed.end)) {
        return invalidInput();
      }
      const calendars = this.allowedCalendarsForFilter(current.calendar_id);
      if ("success" in calendars) {
        return calendars;
      }

      const queryRange = expandedSafetyRange(proposed.start, proposed.end);
      const events = await this.fetchAllowedEvents(calendars, queryRange.start, queryRange.end);
      if ("success" in events) {
        return events;
      }

      const otherEvents = events.filter((event) => event.event_id !== current.event_id);
      const safety = analyzeCreateSafety({
        title: proposed.title,
        start: proposed.start,
        end: proposed.end,
        location: proposed.location,
        existingEvents: otherEvents,
        recurringScope: parsed.data.recurrence_scope ?? null
      });

      return success({
        would_update: true,
        event_id: current.event_id,
        recurrence_scope: parsed.data.recurrence_scope ?? null,
        current_event: eventForDetailLevel(current, "standard") as EventStandard,
        proposed_event: eventForDetailLevel(proposed, "standard") as EventStandard,
        changes: parsed.data.changes,
        safety: {
          ...safety,
          recurring_scope_required: false
        }
      });
    } catch (error) {
      return bridgeFailure(error);
    }
  }

  private async syncCalendarCache(): Promise<SemanticFailure | null> {
    try {
      const calendars = parseBridgeCalendarList(await this.bridge.listCalendars());
      const seenAt = nowIso();
      const configuredAllowlist = loadConfiguredAllowlist();

      for (const calendar of calendars) {
        const calendarId = calendarIdFromNative(calendar.native_calendar_id);
        const existing = this.store.getCalendar(calendarId);
        const isAllowed = configuredAllowlist
          ? configuredAllowlist.has(calendar.native_calendar_id)
          : existing?.is_allowed ?? false;

        this.store.upsertCalendar(
          CalendarSchema.parse({
            calendar_id: calendarId,
            native_calendar_id: calendar.native_calendar_id,
            title: calendar.title,
            source_title: calendar.source_title ?? null,
            allows_content_modifications: calendar.allows_content_modifications ?? false,
            is_subscribed: calendar.is_subscribed ?? false,
            is_allowed: isAllowed,
            color: calendar.color ?? null,
            last_seen_at: seenAt
          })
        );
      }

      return null;
    } catch (error) {
      return bridgeFailure(error);
    }
  }

  private allowedCalendarsForFilter(calendarId: string | undefined): Calendar[] | SemanticFailure {
    if (calendarId) {
      const calendar = this.store.getCalendar(calendarId);
      if (!calendar?.is_allowed) {
        return failure(
          "CALENDAR_NOT_FOUND",
          "The requested calendar is not available.",
          "Call calendar_list_calendars and choose an allowed calendar.",
          false
        );
      }

      return [calendar];
    }

    return this.store.listAllowedCalendars();
  }

  private async fetchAllowedEvents(
    calendars: Calendar[],
    start: string,
    end: string
  ): Promise<NormalizedEvent[] | SemanticFailure> {
    if (calendars.length === 0) {
      return [];
    }

    const allowedNativeCalendarIds = new Set(
      calendars.map((calendar) => calendar.native_calendar_id)
    );

    try {
      const events = await this.fetchEventKitEventsInChunks(
        [...allowedNativeCalendarIds],
        start,
        end
      );

      return events
        .filter((event) => allowedNativeCalendarIds.has(event.native_calendar_id))
        .filter(dedupeBridgeEvents())
        .map(toNormalizedEvent);
    } catch (error) {
      return bridgeFailure(error);
    }
  }

  private async fetchEventKitEventsInChunks(
    nativeCalendarIds: string[],
    start: string,
    end: string
  ): Promise<BridgeEvent[]> {
    const chunks = eventKitQueryChunks(start, end, EVENTKIT_QUERY_WINDOW_MS);
    const results: BridgeEvent[] = [];

    for (const chunk of chunks) {
      results.push(...await this.fetchEventKitChunkWithRetrySplit(nativeCalendarIds, chunk.start, chunk.end));
    }

    return results;
  }

  private async fetchEventKitChunkWithRetrySplit(
    nativeCalendarIds: string[],
    start: string,
    end: string
  ): Promise<BridgeEvent[]> {
    try {
      return parseBridgeEventList(await this.bridge.listEvents({
        native_calendar_ids: nativeCalendarIds,
        start,
        end
      }));
    } catch (error) {
      const duration = Date.parse(end) - Date.parse(start);
      if (isRetryableBridgeError(error) && duration > MIN_RETRY_QUERY_WINDOW_MS) {
        const midpoint = new Date(Date.parse(start) + Math.ceil(duration / 2)).toISOString();
        return [
          ...await this.fetchEventKitChunkWithRetrySplit(nativeCalendarIds, start, midpoint),
          ...await this.fetchEventKitChunkWithRetrySplit(nativeCalendarIds, midpoint, end)
        ];
      }

      throw error;
    }
  }
}

export function createDefaultCalendarReadService(): CalendarReadService {
  const command = process.env.APPLE_CALENDAR_MCP_HELPER ?? "apple-calendar-mcp-helper";
  const launchMode = process.env.APPLE_CALENDAR_MCP_HELPER_LAUNCH_MODE as
    | "auto"
    | "direct"
    | "app"
    | undefined;
  const databasePath = process.env.APPLE_CALENDAR_MCP_DATABASE_PATH;
  return new CalendarReadService(
    new EventKitBridgeClient(launchMode ? { command, launchMode } : { command }),
    new AppleCalendarSqliteStore(databasePath ? { path: databasePath } : {})
  );
}

function eventKitQueryChunks(
  start: string,
  end: string,
  maxDurationMs: number
): Array<{ start: string; end: string }> {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (endMs - startMs <= maxDurationMs) {
    return [{ start, end }];
  }

  const chunks: Array<{ start: string; end: string }> = [];
  let chunkStartMs = startMs;
  let chunkStart = start;

  while (chunkStartMs < endMs) {
    const chunkEndMs = Math.min(chunkStartMs + maxDurationMs, endMs);
    const chunkEnd = chunkEndMs === endMs ? end : new Date(chunkEndMs).toISOString();
    chunks.push({ start: chunkStart, end: chunkEnd });
    chunkStartMs = chunkEndMs;
    chunkStart = chunkEnd;
  }

  return chunks;
}

function isRetryableBridgeError(error: unknown): boolean {
  return error instanceof EventKitBridgeCallError && error.retryable;
}

function dedupeBridgeEvents(): (event: BridgeEvent) => boolean {
  const seen = new Set<string>();
  return (event) => {
    if (seen.has(event.native_event_id)) {
      return false;
    }
    seen.add(event.native_event_id);
    return true;
  };
}

export function calendarIdFromNative(nativeCalendarId: string): string {
  return `cal_b64_${Buffer.from(nativeCalendarId, "utf8").toString("base64url")}`;
}

export function eventIdFromNative(nativeEventId: string): string {
  return `evt_b64_${Buffer.from(nativeEventId, "utf8").toString("base64url")}`;
}

function nativeEventIdFromEventId(eventId: string): string | null {
  if (!eventId.startsWith("evt_b64_")) {
    return null;
  }

  try {
    return Buffer.from(eventId.slice("evt_b64_".length), "base64url").toString("utf8");
  } catch {
    return null;
  }
}

type NormalizedEvent = {
  event_id: string;
  title: string;
  start: string;
  end: string;
  calendar_id: string;
  location: string | null;
  notes: string | null;
  url: string | null;
  timezone: string;
  is_all_day: boolean;
  is_recurring: boolean;
  last_modified_at: string | null;
};

function toNormalizedEvent(event: BridgeEvent): NormalizedEvent {
  return {
    event_id: eventIdFromNative(event.native_event_id),
    title: boundedString(event.title, MAX_TITLE_LENGTH),
    start: event.start,
    end: event.end,
    calendar_id: calendarIdFromNative(event.native_calendar_id),
    location: trimNullable(event.location, MAX_LOCATION_LENGTH),
    notes: trimNullable(event.notes, MAX_NOTES_LENGTH),
    url: trimNullable(event.url, MAX_URL_LENGTH),
    timezone: TimezoneSchema.safeParse(event.timezone).success ? String(event.timezone) : "UTC",
    is_all_day: event.is_all_day ?? false,
    is_recurring: event.has_recurrence_rules ?? false,
    last_modified_at: event.last_modified_at ?? null
  };
}

function eventForDetailLevel(
  event: NormalizedEvent,
  detailLevel: DetailLevel
): EventMinimal | EventStandard | EventFull {
  const minimal: EventMinimal = {
    event_id: event.event_id,
    title: event.title,
    start: event.start,
    end: event.end,
    calendar_id: event.calendar_id
  };

  if (detailLevel === "minimal") {
    return minimal;
  }

  const standard: EventStandard = {
    ...minimal,
    location_summary: event.location,
    recurrence: {
      is_recurring: event.is_recurring
    },
    conflict: false
  };

  if (detailLevel === "standard") {
    return standard;
  }

  return {
    ...standard,
    notes: event.notes,
    url: event.url,
    timezone: event.timezone,
    is_all_day: event.is_all_day,
    last_modified_at: event.last_modified_at
  };
}

function toCalendarListItem(calendar: Calendar): CalendarListItem {
  return {
    calendar_id: calendar.calendar_id,
    name: calendar.title,
    allows_content_modifications: calendar.allows_content_modifications,
    is_subscribed: calendar.is_subscribed,
    color: calendar.color
  };
}

function sortEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  return [...events].sort((left, right) => {
    const byStart = Date.parse(left.start) - Date.parse(right.start);
    return byStart === 0 ? left.title.localeCompare(right.title) : byStart;
  });
}

function analyzeCreateSafety(input: {
  title: string;
  start: string;
  end: string;
  location: string | null;
  existingEvents: NormalizedEvent[];
  recurringScope?: string | null;
}): SafetyAnalysis {
  const conflicts = input.existingEvents
    .filter((event) => overlaps(input.start, input.end, event.start, event.end))
    .map(toConflictWarning);
  const duplicates = input.existingEvents
    .filter((event) => isPossibleDuplicate(input, event))
    .map((event) => ({
      ...toConflictWarning(event),
      reason: "similar title and overlapping time"
    }));
  const warnings = [
    ...conflicts.filter((event) => event.is_all_day).map(() => "all_day_conflict"),
    ...duplicates.map(() => "possible_duplicate")
  ];

  return {
    conflicts,
    duplicates,
    ambiguities: [],
    recurring_scope_required: false,
    recurring_scope: input.recurringScope ?? null,
    warnings: [...new Set(warnings)]
  };
}

function applyPreviewChanges(
  current: NormalizedEvent,
  changes: Record<string, unknown>
): NormalizedEvent {
  return {
    ...current,
    title: typeof changes.title === "string" ? boundedString(changes.title, MAX_TITLE_LENGTH) : current.title,
    start: typeof changes.start === "string" ? changes.start : current.start,
    end: typeof changes.end === "string" ? changes.end : current.end,
    location:
      "location" in changes
        ? trimNullable(changes.location as string | null | undefined, MAX_LOCATION_LENGTH)
        : current.location,
    notes:
      "notes" in changes
        ? trimNullable(changes.notes as string | null | undefined, MAX_NOTES_LENGTH)
        : current.notes,
    url:
      "url" in changes
        ? trimNullable(changes.url as string | null | undefined, MAX_URL_LENGTH)
        : current.url
  };
}

function overlaps(start: string, end: string, otherStart: string, otherEnd: string): boolean {
  return Date.parse(start) < Date.parse(otherEnd) && Date.parse(otherStart) < Date.parse(end);
}

function expandedSafetyRange(start: string, end: string): { start: string; end: string } {
  const dayMs = 24 * 60 * 60 * 1000;
  return {
    start: new Date(Date.parse(start) - dayMs).toISOString(),
    end: new Date(Date.parse(end) + dayMs).toISOString()
  };
}

function isPossibleDuplicate(
  proposed: { title: string; start: string; end: string; location: string | null },
  existing: NormalizedEvent
): boolean {
  if (!overlaps(proposed.start, proposed.end, existing.start, existing.end)) {
    return false;
  }

  const titleMatches = normalizeComparable(proposed.title) === normalizeComparable(existing.title);
  const similarTitles = titleSimilarity(proposed.title, existing.title) >= 0.82;
  const locationMatches =
    proposed.location !== null &&
    existing.location !== null &&
    normalizeComparable(proposed.location) === normalizeComparable(existing.location);

  return titleMatches || (similarTitles && (locationMatches || sameStartMinute(proposed.start, existing.start)));
}

function sameStartMinute(left: string, right: string): boolean {
  return Math.floor(Date.parse(left) / 60000) === Math.floor(Date.parse(right) / 60000);
}

function titleSimilarity(left: string, right: string): number {
  const leftWords = new Set(normalizeComparable(left).split(" ").filter(Boolean));
  const rightWords = new Set(normalizeComparable(right).split(" ").filter(Boolean));
  if (leftWords.size === 0 || rightWords.size === 0) {
    return 0;
  }

  const shared = [...leftWords].filter((word) => rightWords.has(word)).length;
  return shared / Math.max(leftWords.size, rightWords.size);
}

function normalizeComparable(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function toConflictWarning(event: NormalizedEvent): ConflictWarning {
  return {
    event_id: event.event_id,
    title: event.title,
    start: event.start,
    end: event.end,
    calendar_id: event.calendar_id,
    is_all_day: event.is_all_day
  };
}

function paginate<T>(
  items: T[],
  limit: number,
  cursor: string | null | undefined
): Page<T> | SemanticFailure {
  const offset = decodeCursor(cursor);
  if (offset === null) {
    return invalidCursor();
  }

  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null
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
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      offset?: unknown;
    };
    return typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0
      ? parsed.offset
      : null;
  } catch {
    return null;
  }
}

function parseBridgeCalendarList(value: unknown): BridgeCalendar[] {
  if (!Array.isArray(value)) {
    throw new Error("EventKit bridge returned invalid calendar data.");
  }

  return value.map(parseBridgeCalendar);
}

function parseBridgeCalendar(value: unknown): BridgeCalendar {
  if (!value || typeof value !== "object") {
    throw new Error("EventKit bridge returned invalid calendar data.");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.native_calendar_id !== "string" || typeof record.title !== "string") {
    throw new Error("EventKit bridge returned invalid calendar data.");
  }

  return {
    native_calendar_id: record.native_calendar_id,
    title: boundedString(record.title, MAX_TITLE_LENGTH),
    source_title:
      typeof record.source_title === "string"
        ? trimNullable(record.source_title, MAX_TITLE_LENGTH)
        : null,
    allows_content_modifications:
      typeof record.allows_content_modifications === "boolean"
        ? record.allows_content_modifications
        : false,
    is_subscribed: typeof record.is_subscribed === "boolean" ? record.is_subscribed : false,
    color: typeof record.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(record.color) ? record.color : null
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
    title: boundedString(record.title, MAX_TITLE_LENGTH),
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

type PermissionDiagnostics = {
  calendar_permission: CalendarPermissionStatus;
  authorization_status: CalendarPermissionStatus;
  request_attempted: boolean;
  request_api_used: "requestFullAccessToEvents" | "requestAccess(to:.event)" | null;
  helper_bundle_identifier: string | null;
  info_plist_detected: boolean;
  bridge_process_mode: "direct_stdio" | "app_permission_prompt" | "app_socket" | "unknown";
};

function parsePermissionStatus(value: unknown): PermissionDiagnostics {
  if (!value || typeof value !== "object") {
    throw new Error("EventKit bridge returned invalid permission data.");
  }

  const record = value as Record<string, unknown>;
  const permission = record.authorization_status ?? record.calendar_permission;
  return {
    calendar_permission: normalizePermissionStatus(permission),
    authorization_status: normalizePermissionStatus(permission),
    request_attempted: record.request_attempted === true,
    request_api_used: normalizePermissionRequestApi(record.request_api_used),
    helper_bundle_identifier:
      typeof record.helper_bundle_identifier === "string"
        ? record.helper_bundle_identifier
        : null,
    info_plist_detected: record.info_plist_detected === true,
    bridge_process_mode: normalizeBridgeProcessMode(record.bridge_process_mode)
  };
}

function parsePermissionRequest(value: unknown): PermissionDiagnostics & {
  granted: boolean;
} {
  if (!value || typeof value !== "object") {
    throw new Error("EventKit bridge returned invalid permission request data.");
  }

  const record = value as Record<string, unknown>;
  const status = parsePermissionStatus(record);
  return {
    ...status,
    request_attempted: true,
    granted: record.granted === true
  };
}

function normalizePermissionRequestApi(
  value: unknown
): "requestFullAccessToEvents" | "requestAccess(to:.event)" | null {
  return value === "requestFullAccessToEvents" || value === "requestAccess(to:.event)"
    ? value
    : null;
}

function normalizeBridgeProcessMode(
  value: unknown
): "direct_stdio" | "app_permission_prompt" | "app_socket" | "unknown" {
  switch (value) {
    case "direct_stdio":
    case "app_permission_prompt":
    case "app_socket":
      return value;
    default:
      return "unknown";
  }
}

function normalizePermissionStatus(value: unknown): CalendarPermissionStatus {
  switch (value) {
    case "authorized":
    case "write_only":
    case "denied":
    case "restricted":
    case "not_determined":
    case "not_checked":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function isReadablePermission(status: CalendarPermissionStatus): boolean {
  return status === "authorized";
}

function bridgeFailure(error: unknown): SemanticFailure {
  if (error instanceof EventKitBridgeCallError) {
    return semanticBridgeFailure(normalizeBridgeErrorCode(error.code), error.retryable);
  }

  return failure(
    "EVENTKIT_OPERATION_FAILED",
    "Calendar data could not be read.",
    "Check Calendar permissions and retry.",
    true
  );
}

function semanticBridgeFailure(
  code: SemanticErrorCode,
  retryable: boolean
): SemanticFailure {
  switch (code) {
    case "CALENDAR_NOT_FOUND":
      return failure(
        "CALENDAR_NOT_FOUND",
        "The requested calendar is not available.",
        "Call calendar_list_calendars and choose an allowed calendar.",
        false
      );
    case "EVENT_NOT_FOUND":
      return failure(
        "EVENT_NOT_FOUND",
        "The requested event is not available.",
        "Call calendar_list_events or calendar_search_events and use a returned event_id.",
        false
      );
    case "PERMISSION_DENIED":
    case "CALENDAR_PERMISSION_DENIED":
      return failure(
        "CALENDAR_PERMISSION_DENIED",
        "Calendar permission is not available.",
        "Grant Calendar access in macOS Settings and retry.",
        false
      );
    case "INVALID_INPUT":
      return invalidInput();
    default:
      return failure(
        "EVENTKIT_OPERATION_FAILED",
        "Calendar data could not be read.",
        "Check Calendar permissions and retry.",
        retryable
      );
  }
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

function invalidInput(): SemanticFailure {
  return failure(
    "INVALID_INPUT",
    "The request did not match the tool schema.",
    "Check the tool input fields and retry.",
    false
  );
}

function inputFailure(input: unknown, error: z.ZodError): SemanticFailure {
  return hasAmbiguousDateIssue(input, error)
    ? ambiguousDate()
    : invalidInput();
}

function hasAmbiguousDateIssue(input: unknown, error: z.ZodError): boolean {
  const datePaths = new Set(["start", "end"]);
  const issueTargetsDate = error.issues.some((issue) =>
    issue.path.some((pathPart) => datePaths.has(String(pathPart)))
  );
  if (!issueTargetsDate || !input || typeof input !== "object") {
    return false;
  }

  const values = collectDateLikeValues(input as Record<string, unknown>);
  return values.some((value) => typeof value === "string" && !hasExplicitTimezone(value));
}

function collectDateLikeValues(input: Record<string, unknown>): unknown[] {
  const values: unknown[] = [];
  for (const key of ["start", "end"]) {
    values.push(input[key]);
  }

  const changes = input.changes;
  if (changes && typeof changes === "object") {
    for (const key of ["start", "end"]) {
      values.push((changes as Record<string, unknown>)[key]);
    }
  }

  return values;
}

function hasExplicitTimezone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function ambiguousDate(): SemanticFailure {
  return failure(
    "AMBIGUOUS_DATE",
    "The requested date could not be safely resolved.",
    "Provide fully specified ISO timestamps with timezone offsets.",
    false
  );
}

function invalidCursor(): SemanticFailure {
  return failure(
    "INVALID_INPUT",
    "The pagination cursor is invalid.",
    "Retry without a cursor or use the next_cursor returned by the previous response.",
    false
  );
}

function loadConfiguredAllowlist(): Set<string> | null {
  const path = process.env.APPLE_CALENDAR_MCP_CONFIG_PATH ?? DEFAULT_SETUP_CONFIG_PATH;

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const ids = (raw as Record<string, unknown>).allowed_native_calendar_ids;
    if (!Array.isArray(ids)) {
      return null;
    }

    const allowed = ids.filter((id): id is string =>
      typeof id === "string" &&
      id.trim().length > 0 &&
      id.length <= 500
    );
    return new Set(allowed);
  } catch {
    return null;
  }
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

function trimNullable(value: string | null | undefined, maxLength: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? boundedString(trimmed, maxLength) : null;
}

function boundedString(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}

function nowIso(): string {
  return new Date().toISOString();
}
