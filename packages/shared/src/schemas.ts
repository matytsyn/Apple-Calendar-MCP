import { z } from "zod";

const ISO_DATE_TIME_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const IANA_TIMEZONE = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_\-+]+)+)$/;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const SHA256_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const MAX_METADATA_JSON_BYTES = 10 * 1024;
const MAX_RESPONSE_JSON_BYTES = 50 * 1024;
const MAX_ROLLBACK_STATE_JSON_BYTES = 100 * 1024;

function isValidDateTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isSupportedTimezone(value: string): boolean {
  if (value === "UTC") {
    return true;
  }

  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isJsonSizeAtMost(maxBytes: number) {
  return (value: unknown): boolean => Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes;
}

export const NonEmptyBoundedStringSchema = z.string().trim().min(1).max(500);
export const ShortStringSchema = z.string().trim().min(1).max(120);
export const SummaryStringSchema = z.string().trim().min(1).max(300);

export const SemanticErrorCodeSchema = z.enum([
  "CALENDAR_NOT_FOUND",
  "EVENT_NOT_FOUND",
  "PERMISSION_DENIED",
  "CALENDAR_PERMISSION_DENIED",
  "AMBIGUOUS_DATE",
  "CONFLICT_DETECTED",
  "POSSIBLE_DUPLICATE_EVENT",
  "RECURRING_SCOPE_REQUIRED",
  "CONFIRMATION_REQUIRED",
  "INVALID_INPUT",
  "ROLLBACK_NOT_AVAILABLE",
  "SNAPSHOT_NOT_FOUND",
  "IDEMPOTENCY_KEY_CONFLICT",
  "DATABASE_MIGRATION_FAILED",
  "EVENTKIT_OPERATION_FAILED",
  "STARTUP_VALIDATION_FAILED",
  "NOT_IMPLEMENTED"
]);

export const SemanticErrorSchema = z
  .object({
    code: SemanticErrorCodeSchema,
    message: z.string().trim().min(1).max(500),
    suggested_action: z.string().trim().min(1).max(500),
    retryable: z.boolean()
  })
  .strict();

export const SemanticFailureSchema = z
  .object({
    success: z.literal(false),
    error: SemanticErrorSchema
  })
  .strict();

export const SemanticSuccessSchema = z
  .object({
    success: z.literal(true),
    data: z.unknown(),
    meta: z.record(z.string(), z.unknown())
  })
  .strict();

export const SemanticResponseSchema = z.union([
  SemanticSuccessSchema,
  SemanticFailureSchema
]);

export const PaginationInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).max(500).nullable().optional()
  })
  .strict();

export const PaginationMetaSchema = z
  .object({
    next_cursor: z.string().trim().min(1).max(500).nullable()
  })
  .strict();

export const DetailLevelSchema = z.enum(["minimal", "standard", "full"]);

export const PermissionModeSchema = z.enum([
  "read_only",
  "ask_before_write",
  "trusted_write",
  "full_write"
]);

export const NoInputSchema = z.object({}).strict();

export const CalendarPermissionStatusSchema = z.enum([
  "authorized",
  "write_only",
  "denied",
  "restricted",
  "not_determined",
  "not_checked",
  "unknown"
]);

export const BridgeProcessModeSchema = z.enum([
  "direct_stdio",
  "app_permission_prompt",
  "app_socket",
  "unknown"
]);

export const CalendarIdSchema = z.string().regex(/^cal_[A-Za-z0-9_-]{8,512}$/);
export const EventIdSchema = z.string().regex(/^evt_[A-Za-z0-9_-]{8,512}$/);
export const SnapshotIdSchema = z.string().regex(/^snap_[A-Za-z0-9_-]{8,128}$/);
export const ChangeIdSchema = z.string().regex(/^chg_[A-Za-z0-9_-]{8,128}$/);
export const OperationIdSchema = z.string().regex(/^op_[A-Za-z0-9_-]{8,128}$/);
export const RollbackIdSchema = z.string().regex(/^rb_[A-Za-z0-9_-]{8,128}$/);
export const ConfirmationIdSchema = z
  .string()
  .regex(/^confirm_[A-Za-z0-9_-]{8,128}$/);
export const IdempotencyIdSchema = z.string().regex(/^idem_[A-Za-z0-9_-]{8,128}$/);
export const AuditIdSchema = z.string().regex(/^audit_[A-Za-z0-9_-]{8,128}$/);
export const ToolNameSchema = z.string().regex(/^calendar_[A-Za-z0-9_]+$/);

export const NativeIdSchema = z.string().trim().min(1).max(500);
export const IsoDateTimeWithZoneSchema = z
  .string()
  .regex(ISO_DATE_TIME_WITH_ZONE, "Expected ISO 8601 timestamp with timezone")
  .refine(isValidDateTime, "Expected valid ISO 8601 timestamp");
export const TimezoneSchema = z
  .string()
  .regex(IANA_TIMEZONE, "Expected IANA timezone name")
  .refine(isSupportedTimezone, "Expected supported IANA timezone name");
export const UtcDateTimeSchema = IsoDateTimeWithZoneSchema.refine(
  (value) => value.endsWith("Z"),
  "Expected UTC timestamp ending in Z"
);

export const DateTimeInputSchema = z
  .object({
    value: IsoDateTimeWithZoneSchema,
    timezone: TimezoneSchema
  })
  .strict();

export const DateRangeInputSchema = z
  .object({
    start: IsoDateTimeWithZoneSchema,
    end: IsoDateTimeWithZoneSchema,
    timezone: TimezoneSchema.optional()
  })
  .strict()
  .refine((value) => Date.parse(value.start) < Date.parse(value.end), {
    message: "start must be before end",
    path: ["end"]
  });

const readDateRangeShape = {
  start: IsoDateTimeWithZoneSchema,
  end: IsoDateTimeWithZoneSchema,
  timezone: TimezoneSchema.optional()
};

function readDateRangeSchema<TShape extends z.ZodRawShape>(shape: TShape) {
  return z
    .object({
      ...readDateRangeShape,
      ...shape
    })
    .strict()
    .refine((value) => {
      const range = value as { start: string; end: string };
      return Date.parse(range.start) < Date.parse(range.end);
    }, {
      message: "start must be before end",
      path: ["end"]
    });
}

const ReadDateRangeSchema = z
  .object(readDateRangeShape)
  .strict()
  .refine((value) => Date.parse(value.start) < Date.parse(value.end), {
    message: "start must be before end",
    path: ["end"]
  });

export const CalendarSchema = z
  .object({
    calendar_id: CalendarIdSchema,
    native_calendar_id: NativeIdSchema,
    title: ShortStringSchema,
    source_title: ShortStringSchema.nullable(),
    allows_content_modifications: z.boolean(),
    is_subscribed: z.boolean(),
    is_allowed: z.boolean(),
    color: z.string().regex(HEX_COLOR).nullable(),
    last_seen_at: UtcDateTimeSchema
  })
  .strict();

export const EventRecurrenceScopeSchema = z.enum([
  "single_instance",
  "this_and_future",
  "entire_series"
]);

export const EventRecurrenceSchema = z
  .object({
    is_recurring: z.boolean(),
    series_id: z.string().trim().min(1).max(300).nullable(),
    instance_id: z.string().trim().min(1).max(300).nullable()
  })
  .strict();

export const EventSchema = z
  .object({
    event_id: EventIdSchema,
    native_event_id: NativeIdSchema,
    calendar_id: CalendarIdSchema,
    native_calendar_id: NativeIdSchema,
    title: ShortStringSchema,
    start_local: IsoDateTimeWithZoneSchema,
    end_local: IsoDateTimeWithZoneSchema,
    start_utc: UtcDateTimeSchema,
    end_utc: UtcDateTimeSchema,
    timezone: TimezoneSchema,
    is_all_day: z.boolean(),
    location_summary: z.string().trim().max(120).nullable(),
    notes_present: z.boolean(),
    attendees_present: z.boolean(),
    url_present: z.boolean(),
    recurrence: EventRecurrenceSchema,
    last_modified_at: UtcDateTimeSchema.nullable(),
    fingerprint: z.string().regex(SHA256_FINGERPRINT)
  })
  .strict()
  .refine((value) => Date.parse(value.start_local) < Date.parse(value.end_local), {
    message: "start_local must be before end_local",
    path: ["end_local"]
  })
  .refine((value) => Date.parse(value.start_utc) < Date.parse(value.end_utc), {
    message: "start_utc must be before end_utc",
    path: ["end_utc"]
  });

export const ListCalendarsInputSchema = PaginationInputSchema;

export const GetCalendarInputSchema = z
  .object({
    calendar_id: CalendarIdSchema
  })
  .strict();

export const ListEventsInputSchema = readDateRangeSchema({
  calendar_id: CalendarIdSchema.optional(),
  detail_level: DetailLevelSchema.default("standard"),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(500).nullable().optional()
});

export const SearchEventsInputSchema = readDateRangeSchema({
  query: z.string().trim().min(1).max(200),
  calendar_id: CalendarIdSchema.optional(),
  detail_level: DetailLevelSchema.default("standard"),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(500).nullable().optional()
});

export const GetEventInputSchema = z
  .object({
    event_id: EventIdSchema,
    detail_level: DetailLevelSchema.default("standard")
  })
  .strict();

export const PermissionsCheckInputSchema = z
  .object({
    request_permission: z.boolean().default(false)
  })
  .strict();

export const PreviewCreateEventInputSchema = readDateRangeSchema({
  calendar_id: CalendarIdSchema,
  title: ShortStringSchema,
  location: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  url: z.string().url().max(500).nullable().optional(),
  is_all_day: z.boolean().default(false)
});

export const EventUpdateChangesSchema = z
  .object({
    title: ShortStringSchema.optional(),
    start: IsoDateTimeWithZoneSchema.optional(),
    end: IsoDateTimeWithZoneSchema.optional(),
    location: z.string().trim().max(300).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    url: z.string().url().max(500).nullable().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one change is required"
  })
  .refine(
    (value) =>
      value.start === undefined ||
      value.end === undefined ||
      Date.parse(value.start) < Date.parse(value.end),
    {
      message: "start must be before end",
      path: ["end"]
    }
  )
  .refine((value) => (value.start === undefined) === (value.end === undefined), {
    message: "start and end must be provided together",
    path: ["end"]
  });

export const PreviewUpdateEventInputSchema = z
  .object({
    event_id: EventIdSchema,
    changes: EventUpdateChangesSchema,
    recurrence_scope: EventRecurrenceScopeSchema.optional()
  })
  .strict();

export const CheckConflictsInputSchema = readDateRangeSchema({
  calendar_id: CalendarIdSchema,
  exclude_event_id: EventIdSchema.optional()
});

export const WriteConfirmationRiskLevelSchema = z.enum([
  "low",
  "medium",
  "high",
  "critical"
]);

export const ConfirmationTokenSchema = z
  .object({
    confirmation_id: ConfirmationIdSchema,
    token_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    operation_id: OperationIdSchema,
    tool_name: ToolNameSchema,
    pending_action: z
      .record(z.string(), z.unknown())
      .refine(isJsonSizeAtMost(MAX_METADATA_JSON_BYTES), "pending_action exceeds 10 KB"),
    risk_level: WriteConfirmationRiskLevelSchema,
    created_at: UtcDateTimeSchema,
    expires_at: UtcDateTimeSchema,
    used_at: UtcDateTimeSchema.nullable(),
    status: z.enum(["pending", "used", "expired", "cancelled"])
  })
  .strict()
  .refine((value) => Date.parse(value.created_at) < Date.parse(value.expires_at), {
    message: "created_at must be before expires_at",
    path: ["expires_at"]
  });

export const ConfirmationRequestSchema = z
  .object({
    confirmation_id: ConfirmationIdSchema,
    operation_id: OperationIdSchema,
    confirmation_token: z.string().trim().min(16).max(256),
    confirmed: z.literal(true)
  })
  .strict();

export const CreateEventInputSchema = PreviewCreateEventInputSchema.safeExtend({
  idempotency_key: z.string().trim().min(8).max(256).optional(),
  confirmation: ConfirmationRequestSchema.optional()
});

export const UpdateEventInputSchema = PreviewUpdateEventInputSchema.safeExtend({
  idempotency_key: z.string().trim().min(8).max(256).optional(),
  confirmation: ConfirmationRequestSchema.optional()
});

export const RescheduleEventInputSchema = z
  .object({
    event_id: EventIdSchema,
    start: IsoDateTimeWithZoneSchema,
    end: IsoDateTimeWithZoneSchema,
    timezone: TimezoneSchema.optional(),
    recurrence_scope: EventRecurrenceScopeSchema.optional(),
    idempotency_key: z.string().trim().min(8).max(256).optional(),
    confirmation: ConfirmationRequestSchema.optional()
  })
  .strict()
  .refine((value) => Date.parse(value.start) < Date.parse(value.end), {
    message: "start must be before end",
    path: ["end"]
  });

export const DeleteEventInputSchema = z
  .object({
    event_id: EventIdSchema,
    recurrence_scope: EventRecurrenceScopeSchema.optional(),
    idempotency_key: z.string().trim().min(8).max(256).optional(),
    confirmation: ConfirmationRequestSchema.optional()
  })
  .strict();

export const CreateSnapshotInputSchema = readDateRangeSchema({
  calendar_id: CalendarIdSchema.optional(),
  notes: z.string().trim().max(300).nullable().optional(),
  allow_large_range: z.boolean().default(false)
});

export const GetSnapshotInputSchema = z
  .object({
    snapshot_id: SnapshotIdSchema,
    include_events: z.boolean().default(true),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).max(500).nullable().optional()
  })
  .strict();

export const GetChangesSinceInputSchema = z
  .object({
    snapshot_id: SnapshotIdSchema,
    calendar_id: CalendarIdSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).max(500).nullable().optional()
  })
  .strict();

export const RollbackChangeInputSchema = z
  .object({
    rollback_id: RollbackIdSchema.optional(),
    operation_id: OperationIdSchema.optional(),
    confirmed: z.literal(true),
    reason: z.string().trim().max(300).nullable().optional()
  })
  .strict()
  .refine((value) => (value.rollback_id === undefined) !== (value.operation_id === undefined), {
    message: "exactly one of rollback_id or operation_id is required",
    path: ["rollback_id"]
  });

export const ExplainLastChangeInputSchema = z
  .object({
    change_id: ChangeIdSchema.optional(),
    operation_id: OperationIdSchema.optional()
  })
  .strict();

export const DiagnoseIssueInputSchema = z
  .object({
    issue: z.string().trim().max(300).nullable().optional(),
    limit: z.number().int().min(1).max(20).default(10)
  })
  .strict();

export const IdempotencyRecordSchema = z
  .object({
    idempotency_id: IdempotencyIdSchema,
    idempotency_key: z.string().trim().min(8).max(256),
    operation_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    tool_name: ToolNameSchema,
    request_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    response: SemanticResponseSchema.nullable().refine(
      isJsonSizeAtMost(MAX_RESPONSE_JSON_BYTES),
      "response exceeds 50 KB"
    ),
    event_id: EventIdSchema.nullable(),
    operation_id: OperationIdSchema.nullable(),
    status: z.enum(["pending", "completed", "failed", "expired"]),
    created_at: UtcDateTimeSchema,
    expires_at: UtcDateTimeSchema
  })
  .strict()
  .refine((value) => Date.parse(value.created_at) < Date.parse(value.expires_at), {
    message: "created_at must be before expires_at",
    path: ["expires_at"]
  });

export const SnapshotScopeSchema = z
  .object({
    calendar_ids: z.array(CalendarIdSchema).min(1).max(50),
    start_utc: UtcDateTimeSchema,
    end_utc: UtcDateTimeSchema
  })
  .strict()
  .refine((value) => Date.parse(value.start_utc) < Date.parse(value.end_utc), {
    message: "start_utc must be before end_utc",
    path: ["end_utc"]
  });

export const SnapshotSchema = z
  .object({
    snapshot_id: SnapshotIdSchema,
    scope: SnapshotScopeSchema,
    created_at: UtcDateTimeSchema,
    created_by: z.string().trim().min(1).max(120).nullable(),
    event_count: z.number().int().min(0).max(100000),
    hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    notes: z.string().trim().max(300).nullable()
  })
  .strict();

export const SnapshotEventSchema = z
  .object({
    snapshot_event_id: z.string().regex(/^snap_evt_[A-Za-z0-9_-]{8,128}$/),
    snapshot_id: SnapshotIdSchema,
    event_id: EventIdSchema,
    native_event_id: NativeIdSchema.nullable(),
    calendar_id: CalendarIdSchema,
    title_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    title_preview: z.string().trim().max(120).nullable(),
    start_utc: UtcDateTimeSchema,
    end_utc: UtcDateTimeSchema,
    timezone: TimezoneSchema.nullable(),
    is_all_day: z.boolean(),
    is_recurring: z.boolean(),
    recurrence_key: z.string().trim().min(1).max(300).nullable(),
    fingerprint: z.string().regex(SHA256_FINGERPRINT),
    last_modified_at: UtcDateTimeSchema.nullable(),
    compact: z
      .record(z.string(), z.unknown())
      .refine(isJsonSizeAtMost(MAX_METADATA_JSON_BYTES), "compact exceeds 10 KB")
      .nullable()
  })
  .strict()
  .refine((value) => Date.parse(value.start_utc) < Date.parse(value.end_utc), {
    message: "start_utc must be before end_utc",
    path: ["end_utc"]
  });

export const ChangeFeedTypeSchema = z.enum([
  "created",
  "updated",
  "deleted",
  "moved",
  "recurrence_changed",
  "calendar_changed",
  "unknown"
]);

export const ChangeFeedRecordSchema = z
  .object({
    change_id: ChangeIdSchema,
    snapshot_id: SnapshotIdSchema.nullable(),
    operation_id: OperationIdSchema.nullable(),
    change_type: ChangeFeedTypeSchema,
    event_id: EventIdSchema.nullable(),
    native_event_id: NativeIdSchema.nullable(),
    calendar_id: CalendarIdSchema.nullable(),
    changed_fields: z.array(z.string().regex(/^[a-z_]+$/)).max(50),
    before_fingerprint: z.string().regex(SHA256_FINGERPRINT).nullable(),
    after_fingerprint: z.string().regex(SHA256_FINGERPRINT).nullable(),
    summary: z.string().trim().max(300).nullable(),
    created_at: UtcDateTimeSchema
  })
  .strict();

export const AuditResultSchema = z.enum([
  "success",
  "failure",
  "blocked",
  "requires_confirmation",
  "rollback_success",
  "rollback_failure"
]);

export const AuditLogRecordSchema = z
  .object({
    audit_id: AuditIdSchema,
    operation_id: OperationIdSchema.nullable(),
    timestamp: UtcDateTimeSchema,
    client_name: z.string().trim().min(1).max(120).nullable(),
    tool_name: ToolNameSchema,
    action: z.string().trim().min(1).max(120),
    result: AuditResultSchema,
    calendar_id: CalendarIdSchema.nullable(),
    event_id: EventIdSchema.nullable(),
    risk_level: WriteConfirmationRiskLevelSchema,
    summary: z.string().trim().max(300).nullable(),
    error_code: SemanticErrorCodeSchema.nullable(),
    metadata: z
      .record(z.string(), z.unknown())
      .refine(isJsonSizeAtMost(MAX_METADATA_JSON_BYTES), "metadata exceeds 10 KB")
      .nullable()
  })
  .strict();

export const RollbackOperationTypeSchema = z.enum([
  "create",
  "update",
  "delete",
  "reschedule",
  "bulk_create",
  "bulk_update",
  "bulk_delete",
  "recurring_update"
]);

export const RollbackStrategySchema = z.enum([
  "delete_created_event",
  "restore_previous_state",
  "recreate_deleted_event",
  "multi_step",
  "not_available"
]);

export const RollbackStatusSchema = z.enum([
  "available",
  "used",
  "expired",
  "failed",
  "not_available"
]);

export const RollbackOperationSchema = z
  .object({
    rollback_id: RollbackIdSchema,
    operation_id: OperationIdSchema,
    tool_name: ToolNameSchema,
    operation_type: RollbackOperationTypeSchema,
    event_id: EventIdSchema.nullable(),
    native_event_id: NativeIdSchema.nullable(),
    calendar_id: CalendarIdSchema.nullable(),
    before_state: z
      .record(z.string(), z.unknown())
      .refine(isJsonSizeAtMost(MAX_ROLLBACK_STATE_JSON_BYTES), "before_state exceeds 100 KB")
      .nullable(),
    after_state: z
      .record(z.string(), z.unknown())
      .refine(isJsonSizeAtMost(MAX_ROLLBACK_STATE_JSON_BYTES), "after_state exceeds 100 KB")
      .nullable(),
    rollback_strategy: RollbackStrategySchema,
    rollback_status: RollbackStatusSchema,
    created_at: UtcDateTimeSchema,
    expires_at: UtcDateTimeSchema.nullable()
  })
  .strict()
  .refine(
    (value) =>
      value.expires_at === null ||
      Date.parse(value.created_at) < Date.parse(value.expires_at),
    {
      message: "created_at must be before expires_at",
      path: ["expires_at"]
    }
  );

export const ConfigKeySchema = z.enum([
  "permission_mode",
  "default_timezone",
  "max_events_per_response",
  "default_detail_level",
  "audit_logging_enabled",
  "rollback_enabled"
]);

export const ConfigValueSchema = z.union([
  PermissionModeSchema,
  TimezoneSchema,
  z.number().int().min(1).max(100),
  DetailLevelSchema,
  z.boolean()
]);

export const ConfigRecordSchema = z
  .object({
    key: ConfigKeySchema,
    value: ConfigValueSchema,
    updated_at: UtcDateTimeSchema
  })
  .strict()
  .superRefine((value, context) => {
    const validByKey: Record<z.infer<typeof ConfigKeySchema>, boolean> = {
      permission_mode: PermissionModeSchema.safeParse(value.value).success,
      default_timezone: TimezoneSchema.safeParse(value.value).success,
      max_events_per_response:
        typeof value.value === "number" && Number.isInteger(value.value) && value.value >= 1 && value.value <= 100,
      default_detail_level: DetailLevelSchema.safeParse(value.value).success,
      audit_logging_enabled: typeof value.value === "boolean",
      rollback_enabled: typeof value.value === "boolean"
    };

    if (!validByKey[value.key]) {
      context.addIssue({
        code: "custom",
        message: "config value does not match config key",
        path: ["value"]
      });
    }
  });

export const SchemaMigrationRecordSchema = z
  .object({
    version: z.number().int().positive(),
    applied_at: UtcDateTimeSchema
  })
  .strict();

export const HealthCheckDataSchema = z
  .object({
    status: z.enum(["ok", "degraded", "failing"]),
    server: z.literal("started"),
    swift_bridge_status: z.enum(["real", "mocked", "unavailable", "failing"]),
    eventkit_status: z.enum(["real", "mocked", "unavailable", "failing"]),
    permission_status: CalendarPermissionStatusSchema,
    permission_request_available: z.boolean(),
    helper_bundle_identifier: z.string().trim().min(1).max(300).nullable(),
    info_plist_detected: z.boolean(),
    bridge_process_mode: BridgeProcessModeSchema,
    database_status: z.enum(["real", "mocked", "unavailable", "failing"]),
    configuration_status: z.enum(["loaded", "not_loaded"]),
    calendar_operations: z.enum(["real_eventkit_bridge", "unavailable", "failing"])
  })
  .strict();

export const PermissionsCheckDataSchema = z
  .object({
    calendar_permission: CalendarPermissionStatusSchema,
    authorization_status: CalendarPermissionStatusSchema,
    permission_mode: z.literal("not_loaded"),
    calendar_allowlist: z.enum(["loaded", "not_loaded"]),
    swift_bridge_status: z.enum(["real", "mocked", "unavailable", "failing"]),
    eventkit_status: z.enum(["real", "mocked", "unavailable", "failing"]),
    request_attempted: z.boolean(),
    request_api_used: z
      .enum(["requestFullAccessToEvents", "requestAccess(to:.event)"])
      .nullable(),
    helper_bundle_identifier: z.string().trim().min(1).max(300).nullable(),
    info_plist_detected: z.boolean(),
    bridge_process_mode: BridgeProcessModeSchema,
    permission_request: z
      .object({
        available: z.boolean(),
        attempted: z.boolean(),
        granted: z.boolean().nullable()
      })
      .strict()
  })
  .strict();

export function parseWithSchema<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown
): z.infer<TSchema> {
  return schema.parse(value);
}

export type SemanticErrorCode = z.infer<typeof SemanticErrorCodeSchema>;
export type SemanticError = z.infer<typeof SemanticErrorSchema>;
export type SemanticSuccess<TData, TMeta = Record<string, unknown>> = {
  success: true;
  data: TData;
  meta: TMeta;
};
export type SemanticFailure = z.infer<typeof SemanticFailureSchema>;
export type SemanticResponse<TData, TMeta = Record<string, unknown>> =
  | SemanticSuccess<TData, TMeta>
  | SemanticFailure;
export type PaginationInput = z.infer<typeof PaginationInputSchema>;
export type DetailLevel = z.infer<typeof DetailLevelSchema>;
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export type NoInput = z.infer<typeof NoInputSchema>;
export type Calendar = z.infer<typeof CalendarSchema>;
export type CalendarPermissionStatus = z.infer<
  typeof CalendarPermissionStatusSchema
>;
export type ToolName = z.infer<typeof ToolNameSchema>;
export type Event = z.infer<typeof EventSchema>;
export type ListCalendarsInput = z.infer<typeof ListCalendarsInputSchema>;
export type GetCalendarInput = z.infer<typeof GetCalendarInputSchema>;
export type ListEventsInput = z.infer<typeof ListEventsInputSchema>;
export type SearchEventsInput = z.infer<typeof SearchEventsInputSchema>;
export type GetEventInput = z.infer<typeof GetEventInputSchema>;
export type PermissionsCheckInput = z.infer<typeof PermissionsCheckInputSchema>;
export type PreviewCreateEventInput = z.infer<typeof PreviewCreateEventInputSchema>;
export type PreviewUpdateEventInput = z.infer<typeof PreviewUpdateEventInputSchema>;
export type CreateEventInput = z.infer<typeof CreateEventInputSchema>;
export type UpdateEventInput = z.infer<typeof UpdateEventInputSchema>;
export type RescheduleEventInput = z.infer<typeof RescheduleEventInputSchema>;
export type DeleteEventInput = z.infer<typeof DeleteEventInputSchema>;
export type CreateSnapshotInput = z.infer<typeof CreateSnapshotInputSchema>;
export type GetSnapshotInput = z.infer<typeof GetSnapshotInputSchema>;
export type GetChangesSinceInput = z.infer<typeof GetChangesSinceInputSchema>;
export type RollbackChangeInput = z.infer<typeof RollbackChangeInputSchema>;
export type ExplainLastChangeInput = z.infer<typeof ExplainLastChangeInputSchema>;
export type DiagnoseIssueInput = z.infer<typeof DiagnoseIssueInputSchema>;
export type CheckConflictsInput = z.infer<typeof CheckConflictsInputSchema>;
export type DateTimeInput = z.infer<typeof DateTimeInputSchema>;
export type DateRangeInput = z.infer<typeof DateRangeInputSchema>;
export type EventRecurrenceScope = z.infer<typeof EventRecurrenceScopeSchema>;
export type ConfirmationToken = z.infer<typeof ConfirmationTokenSchema>;
export type ConfirmationRequest = z.infer<typeof ConfirmationRequestSchema>;
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type SnapshotEvent = z.infer<typeof SnapshotEventSchema>;
export type ChangeFeedRecord = z.infer<typeof ChangeFeedRecordSchema>;
export type AuditLogRecord = z.infer<typeof AuditLogRecordSchema>;
export type RollbackOperation = z.infer<typeof RollbackOperationSchema>;
export type ConfigKey = z.infer<typeof ConfigKeySchema>;
export type ConfigRecord = z.infer<typeof ConfigRecordSchema>;
export type SchemaMigrationRecord = z.infer<typeof SchemaMigrationRecordSchema>;
export type HealthCheckData = z.infer<typeof HealthCheckDataSchema>;
export type PermissionsCheckData = z.infer<typeof PermissionsCheckDataSchema>;
