import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuditLogRecordSchema,
  ChangeFeedRecordSchema,
  DiagnoseIssueInputSchema,
  ExplainLastChangeInputSchema,
  PermissionModeSchema,
  RollbackChangeInputSchema,
  RollbackOperationSchema,
  type AuditLogRecord,
  type Calendar,
  type CalendarPermissionStatus,
  type ChangeFeedRecord,
  type PermissionMode,
  type RollbackOperation,
  type SemanticErrorCode,
  type SemanticFailure,
  type SemanticResponse,
  type SemanticSuccess
} from "@apple-calendar-mcp/shared";
import { APP_SUPPORT_DIR, AppleCalendarSqliteStore } from "@apple-calendar-mcp/sqlite-store";
import { EventKitBridgeCallError, EventKitBridgeClient } from "./eventkit-bridge-client.js";
import { calendarIdFromNative, eventIdFromNative } from "./read-service.js";

type EventKitRollbackBridge = {
  permissionStatus(): Promise<unknown>;
  listEvents(params: Record<string, unknown>): Promise<unknown>;
  getEvent(params: Record<string, unknown>): Promise<unknown>;
  createEvent(params: Record<string, unknown>): Promise<unknown>;
  updateEvent(params: Record<string, unknown>): Promise<unknown>;
  deleteEvent(params: Record<string, unknown>): Promise<unknown>;
};

export type CalendarRollbackStore = {
  getCalendar(calendarId: string): Calendar | null;
  listAllowedCalendars(): Calendar[];
  getRollbackOperation(rollbackId: string): RollbackOperation | null;
  getLatestRollbackOperation(): RollbackOperation | null;
  getLatestRollbackOperationForOperation(operationId: string): RollbackOperation | null;
  addRollbackOperation(record: RollbackOperation): void;
  addAuditLog(record: AuditLogRecord): void;
  addChange(record: ChangeFeedRecord): void;
  getChange(changeId: string): ChangeFeedRecord | null;
  getLatestChange(): ChangeFeedRecord | null;
  getLatestChangeForOperation(operationId: string): ChangeFeedRecord | null;
  getLatestChangeForAllowedCalendars(allowedCalendarIds: string[]): ChangeFeedRecord | null;
  getLatestAuditLog(): AuditLogRecord | null;
  getLatestAuditLogForOperation(operationId: string): AuditLogRecord | null;
  listRecentAuditLogs(limit: number): AuditLogRecord[];
  listRecentAuditLogsForAllowedCalendars(allowedCalendarIds: string[], limit: number): AuditLogRecord[];
  countRollbackOperationsByStatus(status: RollbackOperation["rollback_status"]): number;
  getLatestRollbackOperationForAllowedCalendars(allowedCalendarIds: string[]): RollbackOperation | null;
  countRollbackOperationsByStatusForAllowedCalendars(status: RollbackOperation["rollback_status"], allowedCalendarIds: string[]): number;
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

type RollbackState = {
  event_id: string;
  native_event_id: string;
  calendar_id: string;
  native_calendar_id: string;
  title: string;
  start: string;
  end: string;
  timezone: string;
  is_all_day: boolean;
  location: string | null;
  notes: string | null;
  url: string | null;
  is_recurring: boolean;
  last_modified_at: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SETUP_CONFIG_PATH = join(APP_SUPPORT_DIR, "config.json");

export class CalendarRollbackService {
  constructor(
    private readonly bridge: EventKitRollbackBridge,
    private readonly store: CalendarRollbackStore
  ) {}

  async rollbackChange(input: unknown): Promise<SemanticResponse<unknown>> {
    const parsed = RollbackChangeInputSchema.safeParse(input);
    if (!parsed.success) {
      const response = invalidInput();
      this.audit(null, "rollback_change", "rollback_failure", response.error.message, response.error.code, null);
      return response;
    }

    const permissionFailure = await this.ensureWritePermission();
    if (permissionFailure) {
      this.audit(null, "rollback_change", "rollback_failure", permissionFailure.error.message, permissionFailure.error.code, null);
      return permissionFailure;
    }

    const rollback = parsed.data.rollback_id
      ? this.store.getRollbackOperation(parsed.data.rollback_id)
      : this.store.getLatestRollbackOperationForOperation(parsed.data.operation_id!);
    if (!rollback) {
      const response = rollbackUnavailable("No rollback record was found for the requested change.");
      this.audit(null, "rollback_change", "rollback_failure", response.error.message, response.error.code, {
        rollback_id: parsed.data.rollback_id ?? null,
        operation_id: parsed.data.operation_id ?? null
      });
      return response;
    }

    const modeFailure = rollbackPermissionModeFailure(rollback, loadConfiguredPermissionMode());
    if (modeFailure) {
      this.audit(rollback, "rollback_change", "rollback_failure", modeFailure.error.message, modeFailure.error.code, null);
      return modeFailure;
    }

    const preflight = await this.preflightRollback(rollback);
    if (preflight) {
      this.audit(rollback, "rollback_change", "rollback_failure", preflight.error.message, preflight.error.code, null);
      return preflight;
    }

    try {
      const result = await this.performRollback(rollback);
      if ("success" in result) {
        this.audit(rollback, "rollback_change", "rollback_failure", result.error.message, result.error.code, null);
        this.store.addRollbackOperation({ ...rollback, rollback_status: "failed" });
        return result;
      }

      const used = RollbackOperationSchema.parse({
        ...rollback,
        rollback_status: "used"
      });
      this.store.addRollbackOperation(used);
      this.store.addChange(this.rollbackChangeRecord(used, result));
      this.audit(used, "rollback_change", "rollback_success", result.summary, null, {
        reason: parsed.data.reason ?? null,
        result_event_id: result.event_id
      });

      return success({
        rollback_id: rollback.rollback_id,
        operation_id: rollback.operation_id,
        rollback_status: "used",
        strategy: rollback.rollback_strategy,
        event_id: result.event_id,
        calendar_id: rollback.calendar_id,
        audit_logged: true,
        change_feed_updated: true,
        summary: result.summary
      });
    } catch (error) {
      const response = bridgeFailure(error);
      this.audit(rollback, "rollback_change", "rollback_failure", response.error.message, response.error.code, null);
      this.store.addRollbackOperation({ ...rollback, rollback_status: "failed" });
      return response;
    }
  }

  async explainLastChange(input: unknown): Promise<SemanticResponse<unknown>> {
    const parsed = ExplainLastChangeInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidInput();
    }

    const allowedCalendarIds = this.store.listAllowedCalendars().map((calendar) => calendar.calendar_id);
    const change = parsed.data.change_id
      ? this.store.getChange(parsed.data.change_id)
      : parsed.data.operation_id
        ? this.store.getLatestChangeForOperation(parsed.data.operation_id)
        : this.store.getLatestChangeForAllowedCalendars(allowedCalendarIds);
    if (!change) {
      return failure(
        "EVENT_NOT_FOUND",
        "No change-feed record is available for that request.",
        "Create a snapshot or perform a calendar write, then retry.",
        false
      );
    }
    if (!this.canExposeCalendar(change.calendar_id)) {
      return failure(
        "EVENT_NOT_FOUND",
        "No change-feed record is available for that request.",
        "Choose a change from an allowed calendar.",
        false
      );
    }

    const rollback = change.operation_id
      ? this.store.getLatestRollbackOperationForOperation(change.operation_id)
      : null;
    const audit = change.operation_id
      ? this.store.getLatestAuditLogForOperation(change.operation_id)
      : this.store.getLatestAuditLog();
    const visibleRollback = rollback && this.canExposeCalendar(rollback.calendar_id) ? rollback : null;
    const visibleAudit = audit && this.canExposeCalendar(audit.calendar_id) ? audit : null;

    return success({
      change: compactChange(change),
      rollback: visibleRollback ? compactRollback(visibleRollback) : null,
      audit: visibleAudit ? compactAudit(visibleAudit) : null,
      explanation: explanationFor(change, visibleRollback)
    });
  }

  async diagnoseIssue(input: unknown): Promise<SemanticResponse<unknown>> {
    const parsed = DiagnoseIssueInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidInput();
    }

    const allowedCalendarIds = this.store.listAllowedCalendars().map((calendar) => calendar.calendar_id);
    const recentAudits = this.store.listRecentAuditLogsForAllowedCalendars(allowedCalendarIds, parsed.data.limit);
    const latestChange = this.store.getLatestChangeForAllowedCalendars(allowedCalendarIds);
    const latestRollback = this.store.getLatestRollbackOperationForAllowedCalendars(allowedCalendarIds);
    const failures = recentAudits.filter((audit) => audit.result === "failure" || audit.result === "rollback_failure");

    return success({
      issue: parsed.data.issue ?? null,
      database_status: "available",
      allowed_calendar_count: allowedCalendarIds.length,
      rollback_counts: {
        available: this.store.countRollbackOperationsByStatusForAllowedCalendars("available", allowedCalendarIds),
        used: this.store.countRollbackOperationsByStatusForAllowedCalendars("used", allowedCalendarIds),
        failed: this.store.countRollbackOperationsByStatusForAllowedCalendars("failed", allowedCalendarIds),
        expired: this.store.countRollbackOperationsByStatusForAllowedCalendars("expired", allowedCalendarIds),
        not_available: this.store.countRollbackOperationsByStatusForAllowedCalendars("not_available", allowedCalendarIds)
      },
      latest_change: latestChange ? compactChange(latestChange) : null,
      latest_rollback: latestRollback ? compactRollback(latestRollback) : null,
      recent_failures: failures.map(compactAudit),
      suggested_actions: suggestedActions(failures, latestRollback)
    });
  }

  private async preflightRollback(rollback: RollbackOperation): Promise<SemanticFailure | null> {
    if (rollback.rollback_status !== "available" || rollback.rollback_strategy === "not_available") {
      return rollbackUnavailable("This rollback is not available.");
    }

    if (rollback.expires_at && Date.parse(rollback.expires_at) <= Date.now()) {
      this.store.addRollbackOperation({ ...rollback, rollback_status: "expired" });
      return rollbackUnavailable("This rollback record has expired.");
    }

    if (!rollback.calendar_id) {
      return rollbackUnavailable("This rollback does not include an allowed calendar target.");
    }

    const calendar = this.store.getCalendar(rollback.calendar_id);
    if (!calendar?.is_allowed) {
      return failure(
        "CALENDAR_NOT_FOUND",
        "The rollback target calendar is not available.",
        "Call calendar_list_calendars and choose an allowed calendar.",
        false
      );
    }

    if (!calendar.allows_content_modifications || calendar.is_subscribed) {
      return failure(
        "PERMISSION_DENIED",
        "The rollback target calendar cannot be modified.",
        "Choose an allowed calendar that supports content modifications.",
        false
      );
    }

    const target = rollback.rollback_strategy === "delete_created_event"
      ? parseRollbackState(rollback.after_state)
      : parseRollbackState(rollback.before_state);
    if (!target) {
      return rollbackUnavailable("This rollback record does not contain enough verified state.");
    }

    if (target.calendar_id !== calendar.calendar_id || target.native_calendar_id !== calendar.native_calendar_id) {
      return rollbackUnavailable("This rollback state does not match the allowed calendar record.");
    }
    if (!rollbackIdentityMatchesState(rollback, target)) {
      return rollbackUnavailable("This rollback record has inconsistent event identity.");
    }

    if (rollback.rollback_strategy !== "delete_created_event") {
      const conflictFailure = await this.ensureSafeWindow(calendar, target, rollback.native_event_id);
      if (conflictFailure) {
        return conflictFailure;
      }
    }

    return null;
  }

  private async performRollback(
    rollback: RollbackOperation
  ): Promise<{ event_id: string | null; native_event_id: string | null; summary: string } | SemanticFailure> {
    switch (rollback.rollback_strategy) {
      case "delete_created_event": {
        const state = parseRollbackState(rollback.after_state);
        const nativeEventId = rollback.native_event_id ?? state?.native_event_id;
        if (!nativeEventId || !state) {
          return rollbackUnavailable("The created event cannot be identified for rollback.");
        }

        const live = await this.getLiveRollbackTarget(nativeEventId, state);
        if ("success" in live) {
          if (live.error.code === "EVENT_NOT_FOUND") {
            return {
              event_id: state.event_id,
              native_event_id: nativeEventId,
              summary: "Rolled back create; the created event was already absent."
            };
          }

          return live;
        }

        await this.bridge.deleteEvent({ native_event_id: nativeEventId });
        const verified = await this.verifyDeleted(nativeEventId);
        if (verified) {
          return verified;
        }

        return {
          event_id: state.event_id,
          native_event_id: nativeEventId,
          summary: `Rolled back ${rollback.operation_type} by deleting the created event.`
        };
      }
      case "restore_previous_state": {
        const state = parseRollbackState(rollback.before_state);
        const nativeEventId = rollback.native_event_id ?? state?.native_event_id;
        if (!nativeEventId || !state) {
          return rollbackUnavailable("The previous event state cannot be identified for rollback.");
        }

        const live = await this.getLiveRollbackTarget(nativeEventId, state);
        if ("success" in live) {
          return live;
        }

        await this.bridge.updateEvent({
          native_event_id: nativeEventId,
          changes: eventChangesFor(state)
        });
        const verified = await this.verifyRestored(nativeEventId, state);
        if (verified) {
          return verified;
        }

        return {
          event_id: state.event_id,
          native_event_id: nativeEventId,
          summary: `Rolled back ${rollback.operation_type} by restoring the previous event state.`
        };
      }
      case "recreate_deleted_event": {
        const state = parseRollbackState(rollback.before_state);
        if (!state) {
          return rollbackUnavailable("The deleted event state cannot be identified for rollback.");
        }

        const written = normalizeEvent(parseBridgeEvent(await this.bridge.createEvent({
          native_calendar_id: state.native_calendar_id,
          title: state.title,
          start: state.start,
          end: state.end,
          timezone: state.timezone,
          is_all_day: state.is_all_day,
          location: state.location,
          notes: state.notes,
          url: state.url
        })));
        await this.bridge.getEvent({ native_event_id: written.native_event_id });

        return {
          event_id: written.event_id,
          native_event_id: written.native_event_id,
          summary: `Rolled back delete by recreating the deleted event.`
        };
      }
      default:
        return rollbackUnavailable("This rollback strategy is not supported by the MVP.");
    }
  }

  private async ensureWritePermission(): Promise<SemanticFailure | null> {
    try {
      const permission = parsePermissionStatus(await this.bridge.permissionStatus());
      if (permission !== "authorized") {
        return failure(
          "CALENDAR_PERMISSION_DENIED",
          "Calendar write permission is not available.",
          "Grant full Calendar access in macOS Settings and retry.",
          false
        );
      }

      return null;
    } catch (error) {
      return bridgeFailure(error);
    }
  }

  private async ensureSafeWindow(
    calendar: Calendar,
    target: RollbackState,
    excludeNativeEventId: string | null
  ): Promise<SemanticFailure | null> {
    try {
      const events = parseBridgeEventList(await this.bridge.listEvents({
        native_calendar_ids: [calendar.native_calendar_id],
        start: new Date(Date.parse(target.start) - DAY_MS).toISOString(),
        end: new Date(Date.parse(target.end) + DAY_MS).toISOString()
      }))
        .map(normalizeEvent)
        .filter((event) => event.native_event_id !== excludeNativeEventId);

      if (events.some((event) => overlaps(target.start, target.end, event.start, event.end))) {
        return failure(
          "CONFLICT_DETECTED",
          "Rollback would conflict with an existing event.",
          "Review the target calendar before retrying rollback.",
          false
        );
      }

      if (events.some((event) => isPossibleDuplicate(target, event))) {
        return failure(
          "POSSIBLE_DUPLICATE_EVENT",
          "Rollback would create or restore a likely duplicate event.",
          "Review the target calendar before retrying rollback.",
          false
        );
      }

      return null;
    } catch (error) {
      return bridgeFailure(error);
    }
  }

  private async verifyDeleted(nativeEventId: string): Promise<SemanticFailure | null> {
    try {
      await this.bridge.getEvent({ native_event_id: nativeEventId });
      return failure(
        "EVENTKIT_OPERATION_FAILED",
        "Rollback deletion could not be verified.",
        "Refresh Calendar and retry rollback if the event still exists.",
        true
      );
    } catch (error) {
      if (error instanceof EventKitBridgeCallError && error.code === "EVENT_NOT_FOUND") {
        return null;
      }

      return bridgeFailure(error);
    }
  }

  private async verifyRestored(nativeEventId: string, expected: RollbackState): Promise<SemanticFailure | null> {
    try {
      const verified = normalizeEvent(parseBridgeEvent(await this.bridge.getEvent({ native_event_id: nativeEventId })));
      const keys: Array<keyof RollbackState> = ["title", "start", "end", "timezone", "is_all_day", "location", "notes", "url"];
      if (keys.some((key) => verified[key] !== expected[key])) {
        return failure(
          "EVENTKIT_OPERATION_FAILED",
          "Rollback restoration could not be verified.",
          "Refresh the event and retry if it was not restored.",
          true
        );
      }

      return null;
    } catch (error) {
      return bridgeFailure(error);
    }
  }

  private async getLiveRollbackTarget(
    nativeEventId: string,
    expected: RollbackState
  ): Promise<RollbackState | SemanticFailure> {
    try {
      const live = normalizeEvent(parseBridgeEvent(await this.bridge.getEvent({ native_event_id: nativeEventId })));
      if (
        live.native_event_id !== expected.native_event_id ||
        live.event_id !== expected.event_id ||
        live.calendar_id !== expected.calendar_id ||
        live.native_calendar_id !== expected.native_calendar_id ||
        !this.canExposeCalendar(live.calendar_id)
      ) {
        return rollbackUnavailable("The live EventKit event no longer matches the rollback target.");
      }

      return live;
    } catch (error) {
      return bridgeFailure(error);
    }
  }

  private rollbackChangeRecord(
    rollback: RollbackOperation,
    result: { event_id: string | null; native_event_id: string | null; summary: string }
  ): ChangeFeedRecord {
    const beforeFingerprint = rollback.after_state ? hashObject(rollback.after_state) : null;
    const afterFingerprint = rollback.rollback_strategy === "delete_created_event"
      ? null
      : rollback.before_state
        ? hashObject(rollback.before_state)
        : null;

    return ChangeFeedRecordSchema.parse({
      change_id: id("chg"),
      snapshot_id: null,
      operation_id: rollback.operation_id,
      change_type: rollback.rollback_strategy === "delete_created_event"
        ? "deleted"
        : rollback.rollback_strategy === "recreate_deleted_event"
          ? "created"
          : rollback.operation_type === "reschedule"
            ? "moved"
            : "updated",
      event_id: result.event_id ?? rollback.event_id,
      native_event_id: result.native_event_id ?? rollback.native_event_id,
      calendar_id: rollback.calendar_id,
      changed_fields: ["rollback"],
      before_fingerprint: beforeFingerprint,
      after_fingerprint: afterFingerprint,
      summary: result.summary,
      created_at: nowIso()
    });
  }

  private audit(
    rollback: RollbackOperation | null,
    action: string,
    result: AuditLogRecord["result"],
    summary: string | null,
    errorCode: SemanticErrorCode | null,
    metadata: Record<string, unknown> | null
  ): void {
    this.store.addAuditLog(AuditLogRecordSchema.parse({
      audit_id: id("audit"),
      operation_id: rollback?.operation_id ?? null,
      timestamp: nowIso(),
      client_name: "apple-calendar-mcp",
      tool_name: "calendar_rollback_change",
      action,
      result,
      calendar_id: rollback?.calendar_id ?? null,
      event_id: rollback?.event_id ?? null,
      risk_level: "high",
      summary,
      error_code: errorCode,
      metadata: {
        rollback_id: rollback?.rollback_id ?? null,
        rollback_strategy: rollback?.rollback_strategy ?? null,
        ...(metadata ?? {})
      }
    }));
  }

  private canExposeCalendar(calendarId: string | null): boolean {
    if (calendarId === null) {
      return true;
    }

    return this.store.getCalendar(calendarId)?.is_allowed === true;
  }
}

export function createDefaultCalendarRollbackService(): CalendarRollbackService {
  const command = process.env.APPLE_CALENDAR_MCP_HELPER ?? "apple-calendar-mcp-helper";
  const databasePath = process.env.APPLE_CALENDAR_MCP_DATABASE_PATH;
  return new CalendarRollbackService(
    new EventKitBridgeClient({ command }),
    new AppleCalendarSqliteStore(databasePath ? { path: databasePath } : {})
  );
}

function parseRollbackState(value: Record<string, unknown> | null): RollbackState | null {
  if (!value) {
    return null;
  }

  const state = value as Record<string, unknown>;
  if (
    typeof state.event_id !== "string" ||
    typeof state.native_event_id !== "string" ||
    typeof state.calendar_id !== "string" ||
    typeof state.native_calendar_id !== "string" ||
    typeof state.title !== "string" ||
    typeof state.start !== "string" ||
    typeof state.end !== "string" ||
    Date.parse(state.start) >= Date.parse(state.end)
  ) {
    return null;
  }

  return {
    event_id: state.event_id,
    native_event_id: state.native_event_id,
    calendar_id: state.calendar_id,
    native_calendar_id: state.native_calendar_id,
    title: state.title,
    start: state.start,
    end: state.end,
    timezone: typeof state.timezone === "string" ? state.timezone : "UTC",
    is_all_day: Boolean(state.is_all_day),
    location: typeof state.location === "string" ? state.location : null,
    notes: typeof state.notes === "string" ? state.notes : null,
    url: typeof state.url === "string" ? state.url : null,
    is_recurring: Boolean(state.is_recurring),
    last_modified_at: typeof state.last_modified_at === "string" ? state.last_modified_at : null
  };
}

function parseBridgeEvent(value: unknown): BridgeEvent {
  if (!value || typeof value !== "object") {
    throw new Error("EventKit bridge returned invalid event data.");
  }

  const event = value as Record<string, unknown>;
  if (
    typeof event.native_event_id !== "string" ||
    typeof event.native_calendar_id !== "string" ||
    typeof event.title !== "string" ||
    typeof event.start !== "string" ||
    typeof event.end !== "string"
  ) {
    throw new Error("EventKit bridge returned invalid event data.");
  }

  return event as BridgeEvent;
}

function parseBridgeEventList(value: unknown): BridgeEvent[] {
  if (!Array.isArray(value)) {
    throw new Error("EventKit bridge returned invalid event data.");
  }

  return value.map(parseBridgeEvent);
}

function normalizeEvent(event: BridgeEvent): RollbackState {
  return {
    event_id: eventIdFromNative(event.native_event_id),
    native_event_id: event.native_event_id,
    calendar_id: calendarIdFromNative(event.native_calendar_id),
    native_calendar_id: event.native_calendar_id,
    title: event.title,
    start: event.start,
    end: event.end,
    timezone: event.timezone ?? "UTC",
    is_all_day: event.is_all_day ?? false,
    location: event.location ?? null,
    notes: event.notes ?? null,
    url: event.url ?? null,
    is_recurring: event.has_recurrence_rules ?? false,
    last_modified_at: event.last_modified_at ?? null
  };
}

function eventChangesFor(state: RollbackState): Record<string, unknown> {
  return {
    title: state.title,
    start: state.start,
    end: state.end,
    timezone: state.timezone,
    is_all_day: state.is_all_day,
    location: state.location,
    notes: state.notes,
    url: state.url
  };
}

function rollbackIdentityMatchesState(rollback: RollbackOperation, state: RollbackState): boolean {
  return (
    (rollback.event_id === null || rollback.event_id === state.event_id) &&
    (rollback.native_event_id === null || rollback.native_event_id === state.native_event_id) &&
    (rollback.calendar_id === null || rollback.calendar_id === state.calendar_id)
  );
}

function compactChange(change: ChangeFeedRecord): Record<string, unknown> {
  return {
    change_id: change.change_id,
    operation_id: change.operation_id,
    change_type: change.change_type,
    event_id: change.event_id,
    calendar_id: change.calendar_id,
    changed_fields: change.changed_fields,
    summary: change.summary,
    created_at: change.created_at
  };
}

function compactRollback(rollback: RollbackOperation): Record<string, unknown> {
  return {
    rollback_id: rollback.rollback_id,
    operation_id: rollback.operation_id,
    tool_name: rollback.tool_name,
    operation_type: rollback.operation_type,
    event_id: rollback.event_id,
    calendar_id: rollback.calendar_id,
    strategy: rollback.rollback_strategy,
    status: rollback.rollback_status,
    expires_at: rollback.expires_at
  };
}

function compactAudit(audit: AuditLogRecord): Record<string, unknown> {
  return {
    audit_id: audit.audit_id,
    operation_id: audit.operation_id,
    timestamp: audit.timestamp,
    tool_name: audit.tool_name,
    action: audit.action,
    result: audit.result,
    calendar_id: audit.calendar_id,
    event_id: audit.event_id,
    error_code: audit.error_code,
    summary: audit.summary
  };
}

function explanationFor(change: ChangeFeedRecord, rollback: RollbackOperation | null): string {
  const rollbackText = rollback?.rollback_status === "available"
    ? ` Rollback is available as ${rollback.rollback_id}.`
    : rollback
      ? ` Rollback status is ${rollback.rollback_status}.`
      : " No rollback record is attached.";
  return `The last recorded calendar change was ${change.change_type} for event ${change.event_id ?? "unknown"}.${rollbackText}`;
}

function suggestedActions(
  failures: AuditLogRecord[],
  latestRollback: RollbackOperation | null
): string[] {
  const actions = new Set<string>();
  if (failures.some((audit) => audit.error_code === "CALENDAR_PERMISSION_DENIED")) {
    actions.add("Grant full Calendar access in macOS Settings, then retry.");
  }
  if (failures.some((audit) => audit.error_code === "CONFLICT_DETECTED" || audit.error_code === "POSSIBLE_DUPLICATE_EVENT")) {
    actions.add("Review the target calendar for conflicts or duplicates before retrying.");
  }
  if (latestRollback?.rollback_status === "available") {
    actions.add("Use calendar_rollback_change with confirmed: true and the rollback_id if you want to undo the latest eligible write.");
  }
  if (actions.size === 0) {
    actions.add("Inspect the latest audit entry and retry the specific calendar operation if needed.");
  }
  return [...actions];
}

function overlaps(startA: string, endA: string, startB: string, endB: string): boolean {
  return Date.parse(startA) < Date.parse(endB) && Date.parse(startB) < Date.parse(endA);
}

function isPossibleDuplicate(target: RollbackState, event: RollbackState): boolean {
  return (
    normalizeComparable(target.title) === normalizeComparable(event.title) &&
    Math.abs(Date.parse(target.start) - Date.parse(event.start)) <= 5 * 60 * 1000 &&
    Math.abs(Date.parse(target.end) - Date.parse(event.end)) <= 5 * 60 * 1000 &&
    normalizeComparable(target.location ?? "") === normalizeComparable(event.location ?? "")
  );
}

function normalizeComparable(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function parsePermissionStatus(value: unknown): CalendarPermissionStatus {
  if (!value || typeof value !== "object") {
    return "unknown";
  }

  const status = (value as Record<string, unknown>).authorization_status
    ?? (value as Record<string, unknown>).calendar_permission;
  return typeof status === "string" ? (status as CalendarPermissionStatus) : "unknown";
}

function hashObject(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function id(prefix: "chg" | "audit"): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function invalidInput(): SemanticFailure {
  return failure(
    "INVALID_INPUT",
    "The request did not match the tool schema.",
    "Check the tool input fields and retry.",
    false
  );
}

function rollbackUnavailable(message: string): SemanticFailure {
  return failure(
    "ROLLBACK_NOT_AVAILABLE",
    message,
    "Use calendar_explain_last_change or calendar_diagnose_issue to inspect available rollback records.",
    false
  );
}

function loadConfiguredPermissionMode(): PermissionMode {
  const path = process.env.APPLE_CALENDAR_MCP_CONFIG_PATH ?? DEFAULT_SETUP_CONFIG_PATH;

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") {
      return "ask_before_write";
    }

    const parsed = PermissionModeSchema.safeParse((raw as Record<string, unknown>).permission_mode);
    return parsed.success ? parsed.data : "ask_before_write";
  } catch {
    return "ask_before_write";
  }
}

function rollbackPermissionModeFailure(
  rollback: RollbackOperation,
  permissionMode: PermissionMode
): SemanticFailure | null {
  if (permissionMode === "read_only") {
    return failure(
      "PERMISSION_DENIED",
      "Rollback writes are disabled by the selected permission mode.",
      "Open Apple Calendar MCP Settings and choose Ask Before Write, Trusted Write, or Full Write before retrying rollback.",
      false
    );
  }

  if (permissionMode === "trusted_write" && rollback.rollback_strategy === "delete_created_event") {
    return failure(
      "PERMISSION_DENIED",
      "This rollback would delete an event, which is disabled by Trusted Write mode.",
      "Open Apple Calendar MCP Settings and choose Full Write if you want to authorize this rollback.",
      false
    );
  }

  return null;
}

function bridgeFailure(error: unknown): SemanticFailure {
  if (error instanceof EventKitBridgeCallError) {
    return failure(normalizeBridgeErrorCode(error.code), error.message, error.suggestedAction, error.retryable);
  }

  return failure(
    "EVENTKIT_OPERATION_FAILED",
    "Calendar rollback could not be completed.",
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
    "CONFLICT_DETECTED",
    "POSSIBLE_DUPLICATE_EVENT",
    "INVALID_INPUT",
    "ROLLBACK_NOT_AVAILABLE",
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
