import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CalendarReadService,
  CalendarRollbackService,
  CalendarSnapshotService,
  CalendarWriteService
} from "@apple-calendar-mcp/calendar-service";
import {
  CreateEventInputSchema,
  CreateSnapshotInputSchema,
  DiagnoseIssueInputSchema,
  DeleteEventInputSchema,
  ExplainLastChangeInputSchema,
  GetChangesSinceInputSchema,
  GetCalendarInputSchema,
  GetEventInputSchema,
  GetSnapshotInputSchema,
  ListCalendarsInputSchema,
  ListEventsInputSchema,
  NoInputSchema,
  PermissionsCheckInputSchema,
  PreviewCreateEventInputSchema,
  PreviewUpdateEventInputSchema,
  CheckConflictsInputSchema,
  RescheduleEventInputSchema,
  RollbackChangeInputSchema,
  UpdateEventInputSchema,
  SearchEventsInputSchema
} from "@apple-calendar-mcp/shared";
import type { Logger } from "./logger.js";
import { toToolResult } from "./tool-result.js";

export type CalendarWriteToolService = Pick<
  CalendarWriteService,
  "createEvent" | "updateEvent" | "rescheduleEvent" | "deleteEvent"
>;

export type CalendarSnapshotToolService = Pick<
  CalendarSnapshotService,
  "createSnapshot" | "getSnapshot" | "getChangesSince"
>;

export type CalendarRollbackToolService = Pick<
  CalendarRollbackService,
  "rollbackChange" | "explainLastChange" | "diagnoseIssue"
>;

export function registerCalendarTools(
  server: McpServer,
  logger: Logger,
  readService: CalendarReadService,
  writeService: CalendarWriteToolService,
  snapshotService: CalendarSnapshotToolService,
  rollbackService: CalendarRollbackToolService
): void {
  server.registerTool(
    "calendar_health_check",
    {
      title: "Calendar Health Check",
      description:
        "No-input health check. Calls the Swift EventKit bridge and reports whether the bridge, EventKit, SQLite, and calendar read operations are real, unavailable, or failing. Safe read-only diagnostic; does not expose calendar data.",
      inputSchema: NoInputSchema
    },
    async () => {
      logger.info("calendar_health_check called");
      return toToolResult(await readService.healthCheck());
    }
  );

  server.registerTool(
    "calendar_permissions_check",
    {
      title: "Calendar Permissions Check",
      description:
        "Calls the Swift EventKit bridge for current Calendar authorization. If permission is not_determined, callers may pass request_permission: true to invoke the real macOS EventKit permission request path. Does not reveal blocked calendars.",
      inputSchema: PermissionsCheckInputSchema
    },
    async (input) => {
      logger.info("calendar_permissions_check called");
      return toToolResult(await readService.permissionsCheck(input));
    }
  );

  server.registerTool(
    "calendar_list_calendars",
    {
      title: "List Allowed Calendars",
      description:
        "Return only calendars allowed by the local user allowlist. Supports limit and cursor pagination. Blocked calendars are filtered server-side and are never returned.",
      inputSchema: ListCalendarsInputSchema
    },
    async (input) => {
      logger.info("calendar_list_calendars called");
      return toToolResult(await readService.listCalendars(input));
    }
  );

  server.registerTool(
    "calendar_get_calendar",
    {
      title: "Get Allowed Calendar",
      description:
        "Return metadata for one allowed calendar. Returns CALENDAR_NOT_FOUND for missing or blocked calendars without revealing whether a blocked calendar exists.",
      inputSchema: GetCalendarInputSchema
    },
    async (input) => {
      logger.info("calendar_get_calendar called");
      return toToolResult(await readService.getCalendar(input));
    }
  );

  server.registerTool(
    "calendar_list_events",
    {
      title: "List Events",
      description:
        "List events in an explicit ISO timestamp date range from allowed calendars only. Supports calendar_id filtering, limit/cursor pagination, and minimal, standard, or full detail levels.",
      inputSchema: ListEventsInputSchema
    },
    async (input) => {
      logger.info("calendar_list_events called");
      return toToolResult(await readService.listEvents(input));
    }
  );

  server.registerTool(
    "calendar_search_events",
    {
      title: "Search Events",
      description:
        "Search event titles and locations in an explicit ISO timestamp date range from allowed calendars only. Supports calendar_id filtering, limit/cursor pagination, and minimal, standard, or full detail levels.",
      inputSchema: SearchEventsInputSchema
    },
    async (input) => {
      logger.info("calendar_search_events called");
      return toToolResult(await readService.searchEvents(input));
    }
  );

  server.registerTool(
    "calendar_check_conflicts",
    {
      title: "Check Calendar Conflicts",
      description:
        "Read-only safety tool. Checks whether an ISO timestamp date range overlaps existing events on an allowed calendar. Does not write to Apple Calendar.",
      inputSchema: CheckConflictsInputSchema
    },
    async (input) => {
      logger.info("calendar_check_conflicts called");
      return toToolResult(await readService.checkConflicts(input));
    }
  );

  server.registerTool(
    "calendar_preview_create_event",
    {
      title: "Preview Event Creation",
      description:
        "Read-only preview tool. Shows the event that would be created and reports conflicts, possible duplicates, and ambiguity warnings. Does not write to Apple Calendar.",
      inputSchema: PreviewCreateEventInputSchema
    },
    async (input) => {
      logger.info("calendar_preview_create_event called");
      return toToolResult(await readService.previewCreateEvent(input));
    }
  );

  server.registerTool(
    "calendar_preview_update_event",
    {
      title: "Preview Event Update",
      description:
        "Read-only preview tool. Shows the event changes that would be applied and reports conflicts, possible duplicates, ambiguity warnings, and recurring-scope requirements. Does not write to Apple Calendar.",
      inputSchema: PreviewUpdateEventInputSchema
    },
    async (input) => {
      logger.info("calendar_preview_update_event called");
      return toToolResult(await readService.previewUpdateEvent(input));
    }
  );

  server.registerTool(
    "calendar_get_event",
    {
      title: "Get Event",
      description:
        "Return one event by event_id only if it belongs to an allowed calendar. Supports minimal, standard, or explicit full detail. Blocked-calendar events return EVENT_NOT_FOUND.",
      inputSchema: GetEventInputSchema
    },
    async (input) => {
      logger.info("calendar_get_event called");
      return toToolResult(await readService.getEvent(input));
    }
  );

  server.registerTool(
    "calendar_create_event",
    {
      title: "Create Calendar Event",
      description:
        "Write tool. Validates input, checks permission and allowlist, checks conflicts/duplicates/idempotency, requires preview-confirm confirmation, writes through EventKit, verifies, audits, and updates the change feed.",
      inputSchema: CreateEventInputSchema
    },
    async (input) => {
      logger.info("calendar_create_event called");
      return toToolResult(await writeService.createEvent(input));
    }
  );

  server.registerTool(
    "calendar_update_event",
    {
      title: "Update Calendar Event",
      description:
        "Write tool. Requires explicit confirmation before updating an allowed writable calendar event. Recurring events require recurrence_scope.",
      inputSchema: UpdateEventInputSchema
    },
    async (input) => {
      logger.info("calendar_update_event called");
      return toToolResult(await writeService.updateEvent(input));
    }
  );

  server.registerTool(
    "calendar_reschedule_event",
    {
      title: "Reschedule Calendar Event",
      description:
        "Write tool. Requires explicit confirmation before changing an allowed writable event start/end time. Recurring events require recurrence_scope.",
      inputSchema: RescheduleEventInputSchema
    },
    async (input) => {
      logger.info("calendar_reschedule_event called");
      return toToolResult(await writeService.rescheduleEvent(input));
    }
  );

  server.registerTool(
    "calendar_delete_event",
    {
      title: "Delete Calendar Event",
      description:
        "Write tool. Requires explicit confirmation before deleting an allowed writable calendar event. Recurring events require recurrence_scope.",
      inputSchema: DeleteEventInputSchema
    },
    async (input) => {
      logger.info("calendar_delete_event called");
      return toToolResult(await writeService.deleteEvent(input));
    }
  );

  server.registerTool(
    "calendar_create_snapshot",
    {
      title: "Create Calendar Snapshot",
      description:
        "Create a compact snapshot of allowed calendar events in an explicit ISO timestamp range. Stores hashes, IDs, timestamps, and compact metadata only; does not store full notes, URLs, attendees, or descriptions.",
      inputSchema: CreateSnapshotInputSchema
    },
    async (input) => {
      logger.info("calendar_create_snapshot called");
      return toToolResult(await snapshotService.createSnapshot(input));
    }
  );

  server.registerTool(
    "calendar_get_snapshot",
    {
      title: "Get Calendar Snapshot",
      description:
        "Return snapshot metadata and paginated compact snapshot event records for an allowed snapshot.",
      inputSchema: GetSnapshotInputSchema
    },
    async (input) => {
      logger.info("calendar_get_snapshot called");
      return toToolResult(await snapshotService.getSnapshot(input));
    }
  );

  server.registerTool(
    "calendar_get_changes_since",
    {
      title: "Get Calendar Changes Since Snapshot",
      description:
        "Return compact change-feed records created after a snapshot. Filters blocked calendars and does not expose private event bodies.",
      inputSchema: GetChangesSinceInputSchema
    },
    async (input) => {
      logger.info("calendar_get_changes_since called");
      return toToolResult(await snapshotService.getChangesSince(input));
    }
  );

  server.registerTool(
    "calendar_rollback_change",
    {
      title: "Rollback Calendar Change",
      description:
        "Best-effort write tool. Requires confirmed: true and a rollback_id or operation_id, checks Calendar write permission and allowlist, verifies rollback state, writes through EventKit, audits the attempt, and updates the change feed.",
      inputSchema: RollbackChangeInputSchema
    },
    async (input) => {
      logger.info("calendar_rollback_change called");
      return toToolResult(await rollbackService.rollbackChange(input));
    }
  );

  server.registerTool(
    "calendar_explain_last_change",
    {
      title: "Explain Last Calendar Change",
      description:
        "Explain the latest compact change-feed record, or a specific change/operation, without returning private rollback before/after state.",
      inputSchema: ExplainLastChangeInputSchema
    },
    async (input) => {
      logger.info("calendar_explain_last_change called");
      return toToolResult(await rollbackService.explainLastChange(input));
    }
  );

  server.registerTool(
    "calendar_diagnose_issue",
    {
      title: "Diagnose Calendar MCP Issue",
      description:
        "Return compact local diagnostics from audit logs, rollback status counts, and the latest change feed entry without exposing private event bodies.",
      inputSchema: DiagnoseIssueInputSchema
    },
    async (input) => {
      logger.info("calendar_diagnose_issue called");
      return toToolResult(await rollbackService.diagnoseIssue(input));
    }
  );
}
