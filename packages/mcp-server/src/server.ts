import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createDefaultCalendarReadService,
  createDefaultCalendarRollbackService,
  createDefaultCalendarSnapshotService,
  createDefaultCalendarWriteService,
  type CalendarReadService
} from "@apple-calendar-mcp/calendar-service";
import type { Logger } from "./logger.js";
import {
  registerCalendarTools,
  type CalendarRollbackToolService,
  type CalendarSnapshotToolService,
  type CalendarWriteToolService
} from "./tools.js";

export const SERVER_NAME = "apple-calendar-mcp";
export const SERVER_VERSION = "0.1.0";

export type ServerOptions = {
  readService?: CalendarReadService;
  writeService?: CalendarWriteToolService;
  snapshotService?: CalendarSnapshotToolService;
  rollbackService?: CalendarRollbackToolService;
};

export function createAppleCalendarMcpServer(
  logger: Logger,
  options: ServerOptions = {}
): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });

  registerCalendarTools(
    server,
    logger,
    options.readService ?? createDefaultCalendarReadService(),
    options.writeService ?? (options.readService ? createUnavailableWriteService() : createDefaultCalendarWriteService()),
    options.snapshotService ?? (options.readService ? createUnavailableSnapshotService() : createDefaultCalendarSnapshotService()),
    options.rollbackService ?? (options.readService ? createUnavailableRollbackService() : createDefaultCalendarRollbackService())
  );

  return server;
}

function createUnavailableRollbackService(): CalendarRollbackToolService {
  const notImplemented = async () => ({
    success: false as const,
    error: {
      code: "NOT_IMPLEMENTED" as const,
      message: "Calendar rollback service is not configured.",
      suggested_action: "Provide a rollbackService when constructing the test server.",
      retryable: false
    }
  });

  return {
    rollbackChange: notImplemented,
    explainLastChange: notImplemented,
    diagnoseIssue: notImplemented
  };
}

function createUnavailableSnapshotService(): CalendarSnapshotToolService {
  const notImplemented = async () => ({
    success: false as const,
    error: {
      code: "NOT_IMPLEMENTED" as const,
      message: "Calendar snapshot service is not configured.",
      suggested_action: "Provide a snapshotService when constructing the test server.",
      retryable: false
    }
  });

  return {
    createSnapshot: notImplemented,
    getSnapshot: notImplemented,
    getChangesSince: notImplemented
  };
}

function createUnavailableWriteService(): CalendarWriteToolService {
  const notImplemented = async () => ({
    success: false as const,
    error: {
      code: "NOT_IMPLEMENTED" as const,
      message: "Calendar write service is not configured.",
      suggested_action: "Provide a writeService when constructing the test server.",
      retryable: false
    }
  });

  return {
    createEvent: notImplemented,
    updateEvent: notImplemented,
    rescheduleEvent: notImplemented,
    deleteEvent: notImplemented
  };
}
