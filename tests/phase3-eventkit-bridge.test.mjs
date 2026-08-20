import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CalendarReadService,
  EventKitBridgeCallError,
  EventKitBridgeClient
} from "../packages/calendar-service/dist/index.js";

const emptyStore = {
  upsertCalendar() {},
  getCalendar() {
    return null;
  },
  listAllowedCalendars() {
    return [];
  }
};

const fakeBridgeScript = `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "permission_status") {
      process.stdout.write(JSON.stringify({
        id: request.id,
        success: true,
        data: {
          calendar_permission: "authorized",
          authorization_status: "authorized",
          request_attempted: false,
          request_api_used: null,
          helper_bundle_identifier: "com.owensuyko.apple-calendar-mcp.helper",
          info_plist_detected: true,
          bridge_process_mode: "direct_stdio"
        }
      }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({
        id: request.id,
        success: false,
        error: {
          code: "INVALID_INPUT",
          message: "Unknown method.",
          suggested_action: "Use a supported method.",
          retryable: false
        }
      }) + "\\n");
    }
  }
});
`;

test("EventKitBridgeClient calls JSON-line bridge methods", async () => {
  const client = new EventKitBridgeClient({
    command: process.execPath,
    args: ["-e", fakeBridgeScript]
  });

  try {
    assert.deepEqual(await client.permissionStatus(), {
      calendar_permission: "authorized",
      authorization_status: "authorized",
      request_attempted: false,
      request_api_used: null,
      helper_bundle_identifier: "com.owensuyko.apple-calendar-mcp.helper",
      info_plist_detected: true,
      bridge_process_mode: "direct_stdio"
    });
  } finally {
    client.close();
  }
});

test("EventKitBridgeClient maps bridge semantic errors", async () => {
  const client = new EventKitBridgeClient({
    command: process.execPath,
    args: ["-e", fakeBridgeScript]
  });

  try {
    await assert.rejects(
      client.call("list_calendars"),
      (error) =>
        error instanceof EventKitBridgeCallError &&
        error.code === "INVALID_INPUT" &&
        error.suggestedAction === "Use a supported method." &&
        error.retryable === false
    );
  } finally {
    client.close();
  }
});

test("calendar permission request returns semantic failure when denied", async () => {
  const service = new CalendarReadService(
    {
      async permissionStatus() {
        return {
          calendar_permission: "not_determined",
          authorization_status: "not_determined",
          request_attempted: false,
          request_api_used: null,
          helper_bundle_identifier: "com.owensuyko.apple-calendar-mcp.helper",
          info_plist_detected: true,
          bridge_process_mode: "app_socket"
        };
      },
      async requestPermission() {
        return {
          granted: false,
          calendar_permission: "denied",
          authorization_status: "denied",
          request_attempted: true,
          request_api_used: "requestFullAccessToEvents",
          helper_bundle_identifier: "com.owensuyko.apple-calendar-mcp.helper",
          info_plist_detected: true,
          bridge_process_mode: "app_socket"
        };
      },
      async listCalendars() {
        return [];
      },
      async listEvents() {
        return [];
      },
      async getEvent() {
        return {};
      }
    },
    emptyStore
  );

  const response = await service.permissionsCheck({ request_permission: true });

  assert.equal(response.success, false);
  assert.equal(response.error.code, "CALENDAR_PERMISSION_DENIED");
  assert.equal(response.error.retryable, false);
});

test("calendar health reports missing Info.plist diagnostics without calendar data", async () => {
  const service = new CalendarReadService(
    {
      async permissionStatus() {
        return {
          calendar_permission: "not_determined",
          authorization_status: "not_determined",
          request_attempted: false,
          request_api_used: null,
          helper_bundle_identifier: "com.owensuyko.apple-calendar-mcp.helper",
          info_plist_detected: false,
          bridge_process_mode: "app_socket"
        };
      },
      async requestPermission() {
        return {};
      },
      async listCalendars() {
        return [];
      },
      async listEvents() {
        return [];
      },
      async getEvent() {
        return {};
      }
    },
    emptyStore
  );

  const response = await service.healthCheck();

  assert.equal(response.success, true);
  assert.equal(response.data.status, "degraded");
  assert.equal(response.data.info_plist_detected, false);
  assert.equal(response.data.bridge_process_mode, "app_socket");
  assert.equal("calendars" in response.data, false);
});

test("calendar health reports bridge failures semantically", async () => {
  const service = new CalendarReadService(
    {
      async permissionStatus() {
        throw new Error("boom");
      },
      async requestPermission() {
        return {};
      },
      async listCalendars() {
        return [];
      },
      async listEvents() {
        return [];
      },
      async getEvent() {
        return {};
      }
    },
    emptyStore
  );

  const response = await service.healthCheck();

  assert.equal(response.success, true);
  assert.equal(response.data.status, "failing");
  assert.equal(response.data.swift_bridge_status, "failing");
  assert.equal(response.data.bridge_process_mode, "unknown");
});
