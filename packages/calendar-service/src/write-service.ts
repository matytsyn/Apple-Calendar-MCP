import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuditLogRecordSchema,
  ChangeFeedRecordSchema,
  CreateEventInputSchema,
  DeleteEventInputSchema,
  IdempotencyRecordSchema,
  RescheduleEventInputSchema,
  RollbackOperationSchema,
  UpdateEventInputSchema,
  PermissionModeSchema,
  type AuditLogRecord,
  type Calendar,
  type CalendarPermissionStatus,
  type ChangeFeedRecord,
  type ConfirmationToken,
  type IdempotencyRecord,
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

type EventKitWriteBridge = {
  permissionStatus(): Promise<unknown>;
  listEvents(params: Record<string, unknown>): Promise<unknown>;
  getEvent(params: Record<string, unknown>): Promise<unknown>;
  createEvent(params: Record<string, unknown>): Promise<unknown>;
  updateEvent(params: Record<string, unknown>): Promise<unknown>;
  deleteEvent(params: Record<string, unknown>): Promise<unknown>;
};

export type CalendarWriteStore = {
  getCalendar(calendarId: string): Calendar | null;
  listAllowedCalendars(): Calendar[];
  getIdempotencyKey(idempotencyKey: string): IdempotencyRecord | null;
  putIdempotencyKey(record: IdempotencyRecord): void;
  putConfirmationToken(record: ConfirmationToken): void;
  getConfirmationTokenByHash(tokenHash: string): ConfirmationToken | null;
  addRollbackOperation(record: RollbackOperation): void;
  addAuditLog(record: AuditLogRecord): void;
  addChange(record: ChangeFeedRecord): void;
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

type NormalizedEvent = {
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

type WritePlan = {
  toolName:
    | "calendar_create_event"
    | "calendar_update_event"
    | "calendar_reschedule_event"
    | "calendar_delete_event";
  action: "create_event" | "update_event" | "reschedule_event" | "delete_event";
  operationType: "create" | "update" | "reschedule" | "delete";
  riskLevel: "medium" | "high";
  calendarId: string;
  nativeCalendarId: string | null;
  eventId: string | null;
  nativeEventId: string | null;
  before: NormalizedEvent | null;
  proposed: Record<string, unknown>;
  bridgeParams: Record<string, unknown>;
  changedFields: string[];
  rollbackStrategy:
    | "delete_created_event"
    | "restore_previous_state"
    | "recreate_deleted_event";
  idempotencyKey: string;
  requestHash: string;
  operationHash: string;
  recurrenceScope: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SETUP_CONFIG_PATH = join(APP_SUPPORT_DIR, "config.json");

export class CalendarWriteService {
  constructor(
    private readonly bridge: EventKitWriteBridge,
    private readonly store: CalendarWriteStore
  ) {}

  async createEvent(input: unknown): Promise<SemanticResponse<unknown>> {
    const parsed = CreateEventInputSchema.safeParse(input);
    if (!parsed.success) {
      const response = inputFailure(input);
      this.auditInputFailure("calendar_create_event", "create_event", "medium", input, response);
      return response;
    }

    const planned = await this.planCreate(parsed.data);
    if ("success" in planned) {
      this.auditInputFailure("calendar_create_event", "create_event", "medium", parsed.data, planned);
      return planned;
    }

    return this.runWrite(planned, parsed.data.confirmation);
  }

  async updateEvent(input: unknown): Promise<SemanticResponse<unknown>> {
    const parsed = UpdateEventInputSchema.safeParse(input);
    if (!parsed.success) {
      const response = inputFailure(input);
      this.auditInputFailure("calendar_update_event", "update_event", "medium", input, response);
      return response;
    }

    const planned = await this.planUpdate(parsed.data.event_id, parsed.data.changes, parsed.data.recurrence_scope ?? null, parsed.data);
    if ("success" in planned) {
      this.auditInputFailure("calendar_update_event", "update_event", "medium", parsed.data, planned);
      return planned;
    }

    return this.runWrite(planned, parsed.data.confirmation);
  }

  async rescheduleEvent(input: unknown): Promise<SemanticResponse<unknown>> {
    const parsed = RescheduleEventInputSchema.safeParse(input);
    if (!parsed.success) {
      const response = inputFailure(input);
      this.auditInputFailure("calendar_reschedule_event", "reschedule_event", "medium", input, response);
      return response;
    }

    const changes = {
      start: parsed.data.start,
      end: parsed.data.end,
      ...(parsed.data.timezone ? { timezone: parsed.data.timezone } : {})
    };

    const planned = await this.planUpdate(parsed.data.event_id, changes, parsed.data.recurrence_scope ?? null, {
        ...parsed.data,
        changes
      }, "calendar_reschedule_event");
    if ("success" in planned) {
      this.auditInputFailure("calendar_reschedule_event", "reschedule_event", "medium", parsed.data, planned);
      return planned;
    }

    return this.runWrite(planned, parsed.data.confirmation);
  }

  async deleteEvent(input: unknown): Promise<SemanticResponse<unknown>> {
    const parsed = DeleteEventInputSchema.safeParse(input);
    if (!parsed.success) {
      const response = invalidInput();
      this.auditInputFailure("calendar_delete_event", "delete_event", "high", input, response);
      return response;
    }

    const planned = await this.planDelete(parsed.data);
    if ("success" in planned) {
      this.auditInputFailure("calendar_delete_event", "delete_event", "high", parsed.data, planned);
      return planned;
    }

    return this.runWrite(planned, parsed.data.confirmation);
  }

  private async runWrite(
    planned: WritePlan,
    confirmation:
      | {
          confirmation_id: string;
          operation_id: string;
          confirmation_token: string;
          confirmed: true;
        }
      | undefined
  ): Promise<SemanticResponse<unknown>> {
    const idempotent = this.checkIdempotency(planned);
    if (idempotent) {
      if (!idempotent.success) {
        this.audit(planned, null, "blocked", idempotent.error.message, idempotent.error.code, {
          idempotency_key: planned.idempotencyKey
        });
      }
      return idempotent;
    }

    if (!confirmation) {
      const mode = loadConfiguredPermissionMode();
      const modeFailure = permissionModeFailure(planned, mode);
      if (modeFailure) {
        this.audit(planned, null, "blocked", modeFailure.error.message, modeFailure.error.code, {
          permission_mode: mode
        });
        return modeFailure;
      }

      if (!writeRequiresConfirmation(planned, mode)) {
        return this.executeWriteWithoutConfirmation(planned, mode);
      }

      const response = this.confirmationRequired(planned);
      this.audit(planned, response.data.operation_id, "requires_confirmation", response.data.summary, null, {
        confirmation_id: response.data.confirmation.confirmation_id,
        permission_mode: mode
      });
      return response;
    }

    const mode = loadConfiguredPermissionMode();
    const modeFailure = permissionModeFailure(planned, mode);
    if (modeFailure) {
      this.audit(planned, confirmation.operation_id, "blocked", modeFailure.error.message, modeFailure.error.code, {
        permission_mode: mode
      });
      return modeFailure;
    }

    const confirmationFailure = this.verifyConfirmation(planned, confirmation);
    if (confirmationFailure) {
      this.audit(planned, confirmation.operation_id, "failure", "Confirmation did not match the pending write.", confirmationFailure.error.code, null);
      return confirmationFailure;
    }

    const operationId = confirmation.operation_id;
    this.markConfirmationUsed(confirmation);
    this.store.putIdempotencyKey(this.idempotencyRecord(planned, operationId, null, "pending"));
    this.store.addRollbackOperation(this.rollbackRecord(planned, operationId, null));

    try {
      const written = await this.performEventKitWrite(planned);
      const verified = await this.verifyWrite(planned, written);
      if ("success" in verified) {
        this.audit(planned, operationId, "failure", "Calendar write could not be verified.", verified.error.code, null);
        this.store.putIdempotencyKey(this.idempotencyRecord(planned, operationId, verified, "failed"));
        return verified;
      }

      const response = this.semanticWriteSuccess(planned, operationId, verified);
      this.store.addRollbackOperation(this.rollbackRecord(planned, operationId, verified));
      this.store.addChange(this.changeRecord(planned, operationId, verified));
      this.audit(planned, operationId, "success", response.data.summary, null, {
        rollback_id: response.data.rollback_id
      });
      this.store.putIdempotencyKey(this.idempotencyRecord(planned, operationId, response, "completed", verified.event_id));
      return response;
    } catch (error) {
      const response = bridgeFailure(error);
      this.audit(planned, operationId, "failure", "Calendar write failed.", response.error.code, null);
      this.store.putIdempotencyKey(this.idempotencyRecord(planned, operationId, response, "failed"));
      return response;
    }
  }

  private async executeWriteWithoutConfirmation(
    planned: WritePlan,
    permissionMode: PermissionMode
  ): Promise<SemanticResponse<unknown>> {
    const operationId = id("op");
    this.store.putIdempotencyKey(this.idempotencyRecord(planned, operationId, null, "pending"));
    this.store.addRollbackOperation(this.rollbackRecord(planned, operationId, null));

    try {
      const written = await this.performEventKitWrite(planned);
      const verified = await this.verifyWrite(planned, written);
      if ("success" in verified) {
        this.audit(planned, operationId, "failure", "Calendar write could not be verified.", verified.error.code, {
          permission_mode: permissionMode
        });
        this.store.putIdempotencyKey(this.idempotencyRecord(planned, operationId, verified, "failed"));
        return verified;
      }

      const response = this.semanticWriteSuccess(planned, operationId, verified);
      this.store.addRollbackOperation(this.rollbackRecord(planned, operationId, verified));
      this.store.addChange(this.changeRecord(planned, operationId, verified));
      this.audit(planned, operationId, "success", response.data.summary, null, {
        rollback_id: response.data.rollback_id,
        permission_mode: permissionMode
      });
      this.store.putIdempotencyKey(this.idempotencyRecord(planned, operationId, response, "completed", verified.event_id));
      return response;
    } catch (error) {
      const response = bridgeFailure(error);
      this.audit(planned, operationId, "failure", "Calendar write failed.", response.error.code, {
        permission_mode: permissionMode
      });
      this.store.putIdempotencyKey(this.idempotencyRecord(planned, operationId, response, "failed"));
      return response;
    }
  }

  private async planCreate(input: {
    calendar_id: string;
    title: string;
    start: string;
    end: string;
    timezone?: string | undefined;
    is_all_day: boolean;
    location?: string | null | undefined;
    notes?: string | null | undefined;
    url?: string | null | undefined;
    idempotency_key?: string | undefined;
  }): Promise<WritePlan | SemanticResponse<unknown>> {
    const permissionFailure = await this.ensureWritePermission();
    if (permissionFailure) {
      return permissionFailure;
    }

    const calendar = this.allowedWritableCalendar(input.calendar_id);
    if ("success" in calendar) {
      return calendar;
    }

    const baseAction = {
      calendar_id: input.calendar_id,
      title: input.title.trim(),
      start: input.start,
      end: input.end,
      timezone: input.timezone ?? null,
      is_all_day: input.is_all_day,
      location: trimNullable(input.location ?? null, 300),
      notes: trimNullable(input.notes ?? null, 2000),
      url: trimNullable(input.url ?? null, 500)
    };

    const requestHash = hashObject(baseAction);
    const idempotencyKey = input.idempotency_key ?? `auto:${requestHash}`;
    const replay = this.completedIdempotentReplay("calendar_create_event", idempotencyKey, requestHash);
    if (replay) {
      return replay;
    }

    const safetyFailure = await this.ensureSafeWindow(
      calendar,
      input.start,
      input.end,
      input.title,
      input.location ?? null,
      null,
      true
    );
    if (safetyFailure) {
      return safetyFailure;
    }

    return {
      toolName: "calendar_create_event",
      action: "create_event",
      operationType: "create",
      riskLevel: "medium",
      calendarId: input.calendar_id,
      nativeCalendarId: calendar.native_calendar_id,
      eventId: null,
      nativeEventId: null,
      before: null,
      proposed: baseAction,
      bridgeParams: {
        native_calendar_id: calendar.native_calendar_id,
        title: baseAction.title,
        start: input.start,
        end: input.end,
        timezone: input.timezone,
        is_all_day: input.is_all_day,
        location: baseAction.location,
        notes: baseAction.notes,
        url: baseAction.url
      },
      changedFields: ["title", "start", "end", "calendar_id"],
      rollbackStrategy: "delete_created_event",
      idempotencyKey,
      requestHash,
      operationHash: requestHash,
      recurrenceScope: null
    };
  }

  private async planUpdate(
    eventId: string,
    changes: Record<string, unknown>,
    recurrenceScope: string | null,
    inputForHash: Record<string, unknown>,
    toolName: "calendar_update_event" | "calendar_reschedule_event" = "calendar_update_event"
  ): Promise<WritePlan | SemanticResponse<unknown>> {
    const permissionFailure = await this.ensureWritePermission();
    if (permissionFailure) {
      return permissionFailure;
    }

    const current = await this.getAllowedEvent(eventId);
    if ("success" in current) {
      return current;
    }

    if (current.is_recurring && !recurrenceScope) {
      return failure(
        "RECURRING_SCOPE_REQUIRED",
        "This event is recurring and write scope is required.",
        "Specify single_instance, this_and_future, or entire_series.",
        false
      );
    }

    const calendar = this.allowedWritableCalendar(current.calendar_id);
    if ("success" in calendar) {
      return calendar;
    }

    const proposed = {
      ...current,
      title: typeof changes.title === "string" ? changes.title.trim() : current.title,
      start: typeof changes.start === "string" ? changes.start : current.start,
      end: typeof changes.end === "string" ? changes.end : current.end,
      location: "location" in changes ? trimNullable(changes.location as string | null | undefined, 300) : current.location,
      notes: "notes" in changes ? trimNullable(changes.notes as string | null | undefined, 2000) : current.notes,
      url: "url" in changes ? trimNullable(changes.url as string | null | undefined, 500) : current.url
    };

    const action = omitConfirmation(inputForHash);
    const requestHash = hashObject(action);
    const idempotencyKey =
      typeof inputForHash.idempotency_key === "string"
        ? inputForHash.idempotency_key
        : `auto:${requestHash}`;
    const replay = this.completedIdempotentReplay(toolName, idempotencyKey, requestHash);
    if (replay) {
      return replay;
    }

    const safetyFailure = await this.ensureSafeWindow(
      calendar,
      proposed.start,
      proposed.end,
      proposed.title,
      proposed.location,
      current.event_id
    );
    if (safetyFailure) {
      return safetyFailure;
    }

    return {
      toolName,
      action: toolName === "calendar_reschedule_event" ? "reschedule_event" : "update_event",
      operationType: toolName === "calendar_reschedule_event" ? "reschedule" : "update",
      riskLevel: "medium",
      calendarId: current.calendar_id,
      nativeCalendarId: current.native_calendar_id,
      eventId: current.event_id,
      nativeEventId: current.native_event_id,
      before: current,
      proposed,
      bridgeParams: {
        native_event_id: current.native_event_id,
        changes,
        span: spanForScope(recurrenceScope)
      },
      changedFields: Object.keys(changes).filter((key) => key !== "confirmation" && key !== "idempotency_key"),
      rollbackStrategy: "restore_previous_state",
      idempotencyKey,
      requestHash,
      operationHash: requestHash,
      recurrenceScope
    };
  }

  private async planDelete(input: {
    event_id: string;
    recurrence_scope?: string | undefined;
    idempotency_key?: string | undefined;
  }): Promise<WritePlan | SemanticResponse<unknown>> {
    const permissionFailure = await this.ensureWritePermission();
    if (permissionFailure) {
      return permissionFailure;
    }

    const action = omitConfirmation(input);
    const requestHash = hashObject(action);
    const idempotencyKey = input.idempotency_key ?? `auto:${requestHash}`;
    const replay = this.completedIdempotentReplay("calendar_delete_event", idempotencyKey, requestHash);
    if (replay) {
      return replay;
    }

    const current = await this.getAllowedEvent(input.event_id);
    if ("success" in current) {
      return current;
    }

    if (current.is_recurring && !input.recurrence_scope) {
      return failure(
        "RECURRING_SCOPE_REQUIRED",
        "This event is recurring and delete scope is required.",
        "Specify single_instance, this_and_future, or entire_series.",
        false
      );
    }

    const calendar = this.allowedWritableCalendar(current.calendar_id);
    if ("success" in calendar) {
      return calendar;
    }

    return {
      toolName: "calendar_delete_event",
      action: "delete_event",
      operationType: "delete",
      riskLevel: "high",
      calendarId: current.calendar_id,
      nativeCalendarId: current.native_calendar_id,
      eventId: current.event_id,
      nativeEventId: current.native_event_id,
      before: current,
      proposed: { deleted: true, event_id: current.event_id, title: current.title },
      bridgeParams: {
        native_event_id: current.native_event_id,
        span: spanForScope(input.recurrence_scope ?? null)
      },
      changedFields: ["deleted"],
      rollbackStrategy: "recreate_deleted_event",
      idempotencyKey,
      requestHash,
      operationHash: requestHash,
      recurrenceScope: input.recurrence_scope ?? null
    };
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

  private allowedWritableCalendar(calendarId: string): Calendar | SemanticFailure {
    const calendar = this.store.getCalendar(calendarId);
    if (!calendar?.is_allowed) {
      return failure(
        "CALENDAR_NOT_FOUND",
        "The requested calendar is not available.",
        "Call calendar_list_calendars and choose an allowed calendar.",
        false
      );
    }

    if (!calendar.allows_content_modifications || calendar.is_subscribed) {
      return failure(
        "PERMISSION_DENIED",
        "The requested calendar cannot be modified.",
        "Choose an allowed calendar that supports content modifications.",
        false
      );
    }

    return calendar;
  }

  private async getAllowedEvent(eventId: string): Promise<NormalizedEvent | SemanticFailure> {
    const nativeEventId = nativeEventIdFromEventId(eventId);
    if (!nativeEventId) {
      return eventNotFound();
    }

    try {
      const event = normalizeEvent(parseBridgeEvent(await this.bridge.getEvent({ native_event_id: nativeEventId })));
      const calendar = this.store.getCalendar(event.calendar_id);
      if (!calendar?.is_allowed) {
        return eventNotFound();
      }

      return event;
    } catch (error) {
      return bridgeFailure(error);
    }
  }

  private async ensureSafeWindow(
    calendar: Calendar,
    start: string,
    end: string,
    title: string,
    location: string | null,
    excludeEventId: string | null,
    allowOverlaps = false
  ): Promise<SemanticFailure | null> {
    try {
      const events = parseBridgeEventList(
        await this.bridge.listEvents({
          native_calendar_ids: [calendar.native_calendar_id],
          start: new Date(Date.parse(start) - DAY_MS).toISOString(),
          end: new Date(Date.parse(end) + DAY_MS).toISOString()
        })
      )
        .map(normalizeEvent)
        .filter((event) => event.event_id !== excludeEventId);

      const conflicts = events.filter((event) => overlaps(start, end, event.start, event.end));
      if (!allowOverlaps && conflicts.length > 0) {
        return failure(
          "CONFLICT_DETECTED",
          "The requested write conflicts with existing events.",
          "Call calendar_check_conflicts or a preview tool, then choose a free time.",
          false
        );
      }

      const duplicate = events.find((event) =>
        isPossibleDuplicate({ title, start, end, location }, event)
      );
      if (duplicate) {
        return failure(
          "POSSIBLE_DUPLICATE_EVENT",
          "The requested write looks like a duplicate event.",
          "Review existing events or change the title/time before confirming.",
          false
        );
      }

      return null;
    } catch (error) {
      return bridgeFailure(error);
    }
  }

  private checkIdempotency(planned: WritePlan): SemanticResponse<unknown> | null {
    const existing = this.store.getIdempotencyKey(planned.idempotencyKey);
    if (!existing) {
      return null;
    }

    if (existing.operation_hash !== planned.operationHash || existing.tool_name !== planned.toolName) {
      return failure(
        "IDEMPOTENCY_KEY_CONFLICT",
        "The idempotency key was already used for a different write.",
        "Retry with the original request or provide a new idempotency_key.",
        false
      );
    }

    if (existing.status === "completed" && existing.response) {
      return existing.response;
    }

    return null;
  }

  private completedIdempotentReplay(
    toolName: WritePlan["toolName"],
    idempotencyKey: string,
    operationHash: string
  ): SemanticResponse<unknown> | null {
    const existing = this.store.getIdempotencyKey(idempotencyKey);
    if (!existing) {
      return null;
    }

    if (existing.operation_hash !== operationHash || existing.tool_name !== toolName) {
      return failure(
        "IDEMPOTENCY_KEY_CONFLICT",
        "The idempotency key was already used for a different write.",
        "Retry with the original request or provide a new idempotency_key.",
        false
      );
    }

    return existing.status === "completed" && existing.response ? existing.response : null;
  }

  private confirmationRequired(planned: WritePlan): SemanticSuccess<{
    requires_confirmation: true;
    operation_id: string;
    summary: string;
    preview: Record<string, unknown>;
    confirmation: {
      confirmation_id: string;
      confirmation_token: string;
      expires_at: string;
    };
  }> {
    const operationId = id("op");
    const confirmationId = id("confirm");
    const token = randomBytes(24).toString("base64url");
    const now = nowIso();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const pendingAction = {
      request_hash: planned.requestHash,
      operation_hash: planned.operationHash,
      idempotency_key: planned.idempotencyKey,
      preview: planned.proposed
    };

    this.store.putConfirmationToken({
      confirmation_id: confirmationId,
      token_hash: sha256(token),
      operation_id: operationId,
      tool_name: planned.toolName,
      pending_action: pendingAction,
      risk_level: planned.riskLevel,
      created_at: now,
      expires_at: expiresAt,
      used_at: null,
      status: "pending"
    });

    return success({
      requires_confirmation: true,
      operation_id: operationId,
      summary: summaryFor(planned),
      preview: planned.proposed,
      confirmation: {
        confirmation_id: confirmationId,
        confirmation_token: token,
        expires_at: expiresAt
      }
    });
  }

  private verifyConfirmation(
    planned: WritePlan,
    confirmation: {
      confirmation_id: string;
      operation_id: string;
      confirmation_token: string;
      confirmed: true;
    }
  ): SemanticFailure | null {
    const tokenHash = sha256(confirmation.confirmation_token);
    const record = this.store.getConfirmationTokenByHash(tokenHash);
    if (
      !record ||
      record.confirmation_id !== confirmation.confirmation_id ||
      record.operation_id !== confirmation.operation_id ||
      record.tool_name !== planned.toolName ||
      record.status !== "pending" ||
      Date.parse(record.expires_at) <= Date.now()
    ) {
      return failure(
        "CONFIRMATION_REQUIRED",
        "A valid confirmation is required before writing to Calendar.",
        "Call the write tool once to get a fresh confirmation, then retry with that confirmation.",
        false
      );
    }

    if (
      record.pending_action.operation_hash !== planned.operationHash ||
      record.pending_action.idempotency_key !== planned.idempotencyKey
    ) {
      return failure(
        "CONFIRMATION_REQUIRED",
        "The confirmation does not match this write request.",
        "Retry using the original write input and its matching confirmation token.",
        false
      );
    }

    return null;
  }

  private async performEventKitWrite(planned: WritePlan): Promise<unknown> {
    switch (planned.toolName) {
      case "calendar_create_event":
        return this.bridge.createEvent(planned.bridgeParams);
      case "calendar_delete_event":
        return this.bridge.deleteEvent(planned.bridgeParams);
      case "calendar_update_event":
      case "calendar_reschedule_event":
        return this.bridge.updateEvent(planned.bridgeParams);
    }
  }

  private async verifyWrite(
    planned: WritePlan,
    written: unknown
  ): Promise<NormalizedEvent | SemanticFailure> {
    if (planned.toolName === "calendar_delete_event") {
      try {
        await this.bridge.getEvent({ native_event_id: planned.nativeEventId });
        return failure(
          "EVENTKIT_OPERATION_FAILED",
          "Calendar deletion could not be verified.",
          "Refresh the event and retry if it still exists.",
          true
        );
      } catch (error) {
        if (error instanceof EventKitBridgeCallError && error.code === "EVENT_NOT_FOUND") {
          return {
            ...planned.before!,
            title: planned.before!.title,
            event_id: planned.eventId!,
            native_event_id: planned.nativeEventId!
          };
        }

        return bridgeFailure(error);
      }
    }

    const event = normalizeEvent(parseBridgeEvent(written));
    const verifiedRaw = await this.bridge.getEvent({ native_event_id: event.native_event_id });
    const verified = normalizeEvent(parseBridgeEvent(verifiedRaw));
    const verificationFailure = verifyPlannedState(planned, verified);
    return verificationFailure ?? verified;
  }

  private semanticWriteSuccess(
    planned: WritePlan,
    operationId: string,
    verified: NormalizedEvent
  ): SemanticSuccess<{
    operation_id: string;
    rollback_id: string;
    event_id: string | null;
    calendar_id: string | null;
    summary: string;
    event: Record<string, unknown> | null;
  }> {
    return success({
      operation_id: operationId,
      rollback_id: rollbackIdFor(operationId),
      event_id: planned.toolName === "calendar_delete_event" ? planned.eventId : verified.event_id,
      calendar_id: planned.calendarId,
      summary: summaryFor(planned),
      event:
        planned.toolName === "calendar_delete_event"
          ? null
          : {
              event_id: verified.event_id,
              title: verified.title,
              start: verified.start,
              end: verified.end,
              calendar_id: verified.calendar_id
            }
    });
  }

  private idempotencyRecord(
    planned: WritePlan,
    operationId: string,
    response: SemanticResponse<unknown> | null,
    status: "pending" | "completed" | "failed",
    eventId: string | null = planned.eventId
  ): IdempotencyRecord {
    return IdempotencyRecordSchema.parse({
      idempotency_id: id("idem"),
      idempotency_key: planned.idempotencyKey,
      operation_hash: planned.operationHash,
      tool_name: planned.toolName,
      request_hash: planned.requestHash,
      response,
      event_id: eventId,
      operation_id: operationId,
      status,
      created_at: nowIso(),
      expires_at: new Date(Date.now() + 7 * DAY_MS).toISOString()
    });
  }

  private rollbackRecord(
    planned: WritePlan,
    operationId: string,
    after: NormalizedEvent | null
  ): RollbackOperation {
    const eventId = planned.toolName === "calendar_create_event" && after ? after.event_id : planned.eventId;
    const nativeEventId =
      planned.toolName === "calendar_create_event" && after
        ? after.native_event_id
        : planned.nativeEventId;

    return RollbackOperationSchema.parse({
      rollback_id: rollbackIdFor(operationId),
      operation_id: operationId,
      tool_name: planned.toolName,
      operation_type: planned.operationType,
      event_id: eventId,
      native_event_id: nativeEventId,
      calendar_id: planned.calendarId,
      before_state: planned.before,
      after_state: after,
      rollback_strategy: planned.rollbackStrategy,
      rollback_status: "available",
      created_at: nowIso(),
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString()
    });
  }

  private changeRecord(
    planned: WritePlan,
    operationId: string,
    verified: NormalizedEvent
  ): ChangeFeedRecord {
    const beforeFingerprint = planned.before ? hashObject(planned.before) : null;
    const afterFingerprint = planned.toolName === "calendar_delete_event" ? null : hashObject(verified);

    return ChangeFeedRecordSchema.parse({
      change_id: id("chg"),
      snapshot_id: null,
      operation_id: operationId,
      change_type: planned.operationType === "reschedule" ? "moved" : `${planned.operationType}d`,
      event_id: planned.toolName === "calendar_create_event" ? verified.event_id : planned.eventId,
      native_event_id: planned.toolName === "calendar_create_event" ? verified.native_event_id : planned.nativeEventId,
      calendar_id: planned.calendarId,
      changed_fields: planned.changedFields,
      before_fingerprint: beforeFingerprint,
      after_fingerprint: afterFingerprint,
      summary: summaryFor(planned),
      created_at: nowIso()
    });
  }

  private audit(
    planned: WritePlan,
    operationId: string | null,
    result: "success" | "failure" | "blocked" | "requires_confirmation",
    summary: string,
    errorCode: SemanticErrorCode | null,
    metadata: Record<string, unknown> | null
  ): void {
    this.store.addAuditLog(
      AuditLogRecordSchema.parse({
        audit_id: id("audit"),
        operation_id: operationId,
        timestamp: nowIso(),
        client_name: "unknown_mcp_client",
        tool_name: planned.toolName,
        action: planned.action,
        result,
        calendar_id: planned.calendarId,
        event_id: planned.eventId,
        risk_level: planned.riskLevel,
        summary,
        error_code: errorCode,
        metadata
      })
    );
  }

  private auditInputFailure(
    toolName: WritePlan["toolName"],
    action: WritePlan["action"],
    riskLevel: WritePlan["riskLevel"],
    input: unknown,
    response: SemanticResponse<unknown>
  ): void {
    if (response.success) {
      return;
    }

    this.store.addAuditLog(
      AuditLogRecordSchema.parse({
        audit_id: id("audit"),
        operation_id: null,
        timestamp: nowIso(),
        client_name: "unknown_mcp_client",
        tool_name: toolName,
        action,
        result: "blocked",
        calendar_id: calendarIdFromInput(input),
        event_id: eventIdFromInput(input),
        risk_level: riskLevel,
        summary: response.error.message,
        error_code: response.error.code,
        metadata: null
      })
    );
  }

  private markConfirmationUsed(confirmation: {
    confirmation_token: string;
  }): void {
    const record = this.store.getConfirmationTokenByHash(sha256(confirmation.confirmation_token));
    if (!record) {
      return;
    }

    this.store.putConfirmationToken({
      ...record,
      used_at: nowIso(),
      status: "used"
    });
  }
}

export function createDefaultCalendarWriteService(): CalendarWriteService {
  const command = process.env.APPLE_CALENDAR_MCP_HELPER ?? "apple-calendar-mcp-helper";
  const databasePath = process.env.APPLE_CALENDAR_MCP_DATABASE_PATH;
  return new CalendarWriteService(
    new EventKitBridgeClient({ command }),
    new AppleCalendarSqliteStore(databasePath ? { path: databasePath } : {})
  );
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

function normalizeEvent(event: BridgeEvent): NormalizedEvent {
  return {
    event_id: eventIdFromNative(event.native_event_id),
    native_event_id: event.native_event_id,
    calendar_id: calendarIdFromNative(event.native_calendar_id),
    native_calendar_id: event.native_calendar_id,
    title: event.title.trim().slice(0, 120),
    start: event.start,
    end: event.end,
    timezone: event.timezone ?? "UTC",
    is_all_day: event.is_all_day ?? false,
    location: trimNullable(event.location, 300),
    notes: trimNullable(event.notes, 2000),
    url: trimNullable(event.url, 500),
    is_recurring: event.has_recurrence_rules ?? false,
    last_modified_at: event.last_modified_at ?? null
  };
}

function parsePermissionStatus(value: unknown): CalendarPermissionStatus {
  if (!value || typeof value !== "object") {
    return "unknown";
  }

  const record = value as Record<string, unknown>;
  const permission = record.authorization_status ?? record.calendar_permission;
  return permission === "authorized" ||
    permission === "write_only" ||
    permission === "denied" ||
    permission === "restricted" ||
    permission === "not_determined" ||
    permission === "not_checked" ||
    permission === "unknown"
    ? permission
    : "unknown";
}

function overlaps(start: string, end: string, otherStart: string, otherEnd: string): boolean {
  return Date.parse(start) < Date.parse(otherEnd) && Date.parse(otherStart) < Date.parse(end);
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

function verifyPlannedState(planned: WritePlan, verified: NormalizedEvent): SemanticFailure | null {
  if (verified.calendar_id !== planned.calendarId) {
    return verificationFailure();
  }

  if (planned.toolName === "calendar_create_event") {
    return matchesExpectedCreate(planned.proposed, verified) ? null : verificationFailure();
  }

  if (planned.toolName === "calendar_update_event" || planned.toolName === "calendar_reschedule_event") {
    return matchesExpectedChanges(planned.bridgeParams.changes, verified) ? null : verificationFailure();
  }

  return null;
}

function matchesExpectedCreate(expected: Record<string, unknown>, verified: NormalizedEvent): boolean {
  return (
    stringMatches(expected.title, verified.title) &&
    instantMatches(expected.start, verified.start) &&
    instantMatches(expected.end, verified.end) &&
    nullableStringMatches(expected.location, verified.location) &&
    nullableStringMatches(expected.notes, verified.notes) &&
    nullableStringMatches(expected.url, verified.url) &&
    (typeof expected.is_all_day !== "boolean" || expected.is_all_day === verified.is_all_day)
  );
}

function matchesExpectedChanges(changes: unknown, verified: NormalizedEvent): boolean {
  if (!changes || typeof changes !== "object") {
    return false;
  }

  const record = changes as Record<string, unknown>;
  return Object.entries(record).every(([field, value]) => {
    switch (field) {
      case "title":
        return stringMatches(value, verified.title);
      case "start":
        return instantMatches(value, verified.start);
      case "end":
        return instantMatches(value, verified.end);
      case "location":
        return nullableStringMatches(value, verified.location);
      case "notes":
        return nullableStringMatches(value, verified.notes);
      case "url":
        return nullableStringMatches(value, verified.url);
      case "timezone":
        return typeof value !== "string" || value === verified.timezone;
      default:
        return true;
    }
  });
}

function verificationFailure(): SemanticFailure {
  return failure(
    "EVENTKIT_OPERATION_FAILED",
    "Calendar write verification did not match the requested change.",
    "Refresh the event and retry only after confirming the actual Calendar state.",
    true
  );
}

function stringMatches(expected: unknown, actual: string): boolean {
  return typeof expected !== "string" || expected.trim() === actual;
}

function nullableStringMatches(expected: unknown, actual: string | null): boolean {
  if (expected === undefined) {
    return true;
  }

  const normalized = typeof expected === "string" ? trimNullable(expected, 2000) : null;
  return normalized === actual;
}

function instantMatches(expected: unknown, actual: string): boolean {
  return typeof expected !== "string" || Date.parse(expected) === Date.parse(actual);
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

function calendarIdFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const value = (input as Record<string, unknown>).calendar_id;
  return typeof value === "string" && /^cal_[A-Za-z0-9_-]{8,512}$/.test(value) ? value : null;
}

function eventIdFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const value = (input as Record<string, unknown>).event_id;
  return typeof value === "string" && /^evt_[A-Za-z0-9_-]{8,512}$/.test(value) ? value : null;
}

function spanForScope(scope: string | null): string {
  return scope === "this_and_future" || scope === "entire_series" ? "future_events" : "this_event";
}

function omitConfirmation(input: Record<string, unknown>): Record<string, unknown> {
  const { confirmation, ...rest } = input;
  void confirmation;
  return rest;
}

function summaryFor(planned: WritePlan): string {
  switch (planned.toolName) {
    case "calendar_create_event":
      return "Created event.";
    case "calendar_update_event":
      return "Updated event.";
    case "calendar_reschedule_event":
      return "Rescheduled event.";
    case "calendar_delete_event":
      return "Deleted event.";
  }
}

function rollbackIdFor(operationId: string): string {
  return `rb_${operationId.slice("op_".length)}`;
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

function id(prefix: "op" | "confirm" | "idem" | "chg" | "audit"): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

function trimNullable(value: string | null | undefined, maxLength: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function inputFailure(input: unknown): SemanticFailure {
  return hasAmbiguousDate(input) ? ambiguousDate() : invalidInput();
}

function hasAmbiguousDate(input: unknown): boolean {
  if (!input || typeof input !== "object") {
    return false;
  }

  const record = input as Record<string, unknown>;
  const candidates = [record.start, record.end];
  const changes = record.changes;
  if (changes && typeof changes === "object") {
    candidates.push((changes as Record<string, unknown>).start, (changes as Record<string, unknown>).end);
  }

  return candidates.some((value) => typeof value === "string" && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value));
}

function ambiguousDate(): SemanticFailure {
  return failure(
    "AMBIGUOUS_DATE",
    "The requested date could not be safely resolved.",
    "Provide fully specified ISO timestamps with timezone offsets.",
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

function eventNotFound(): SemanticFailure {
  return failure(
    "EVENT_NOT_FOUND",
    "The requested event is not available.",
    "Call calendar_list_events or calendar_search_events and use a returned event_id.",
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

function permissionModeFailure(
  planned: WritePlan,
  permissionMode: PermissionMode
): SemanticFailure | null {
  if (permissionMode === "read_only") {
    return failure(
      "PERMISSION_DENIED",
      "Calendar writes are disabled by the selected permission mode.",
      "Open Apple Calendar MCP Settings and choose Ask Before Write, Trusted Write, or Full Write before retrying.",
      false
    );
  }

  if (permissionMode === "trusted_write" && planned.operationType === "delete") {
    return failure(
      "PERMISSION_DENIED",
      "Delete is disabled by Trusted Write mode.",
      "Open Apple Calendar MCP Settings and choose Full Write if you want agents to request event deletion.",
      false
    );
  }

  return null;
}

function writeRequiresConfirmation(
  planned: WritePlan,
  permissionMode: PermissionMode
): boolean {
  if (permissionMode === "ask_before_write") {
    return true;
  }

  if (planned.operationType === "delete") {
    return true;
  }

  if (planned.recurrenceScope === "entire_series") {
    return true;
  }

  return false;
}

function bridgeFailure(error: unknown): SemanticFailure {
  if (error instanceof EventKitBridgeCallError) {
    return failure(normalizeBridgeErrorCode(error.code), error.message, error.suggestedAction, error.retryable);
  }

  return failure(
    "EVENTKIT_OPERATION_FAILED",
    "Calendar data could not be written.",
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
