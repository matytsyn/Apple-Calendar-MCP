import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppleCalendarMcpServer } from "../packages/mcp-server/dist/server.js";
import { createSemanticError } from "../packages/mcp-server/dist/semantic-error.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {}
};

const inertReadService = {
  async healthCheck() {
    return {
      success: true,
      data: {
        status: "ok",
        server: "started",
        swift_bridge_status: "real",
        eventkit_status: "real",
        permission_status: "authorized",
        permission_request_available: false,
        helper_bundle_identifier: "com.owensuyko.apple-calendar-mcp.helper",
        info_plist_detected: true,
        bridge_process_mode: "app_socket",
        database_status: "real",
        configuration_status: "loaded",
        calendar_operations: "real_eventkit_bridge"
      },
      meta: {}
    };
  },
  async permissionsCheck() {
    return {
      success: true,
      data: {
        calendar_permission: "authorized",
        authorization_status: "authorized",
        permission_mode: "not_loaded",
        calendar_allowlist: "loaded",
        swift_bridge_status: "real",
        eventkit_status: "real",
        request_attempted: false,
        request_api_used: null,
        helper_bundle_identifier: "com.owensuyko.apple-calendar-mcp.helper",
        info_plist_detected: true,
        bridge_process_mode: "app_socket",
        permission_request: {
          available: false,
          attempted: false,
          granted: null
        }
      },
      meta: {}
    };
  },
  async listCalendars() {
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
    return {
      success: false,
      error: {
        code: "EVENT_NOT_FOUND",
        message: "The requested event is not available.",
        suggested_action: "Call calendar_list_events or calendar_search_events and use a returned event_id.",
        retryable: false
      }
    };
  },
  async checkConflicts() {
    return { success: true, data: { has_conflicts: false, conflicts: [] }, meta: {} };
  },
  async previewCreateEvent() {
    return {
      success: true,
      data: {
        would_create: true,
        proposed_event: {},
        safety: {
          conflicts: [],
          duplicates: [],
          ambiguities: [],
          recurring_scope_required: false
        }
      },
      meta: {}
    };
  },
  async previewUpdateEvent() {
    return {
      success: true,
      data: {
        would_update: true,
        safety: {
          conflicts: [],
          duplicates: [],
          ambiguities: [],
          recurring_scope_required: false
        }
      },
      meta: {}
    };
  }
};

async function createConnectedClient() {
  const server = createAppleCalendarMcpServer(silentLogger, {
    readService: inertReadService
  });
  const client = new Client(
    {
      name: "phase1-test-client",
      version: "0.0.0"
    },
    {
      capabilities: {}
    }
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);

  return {
    client,
    server,
    async close() {
      await client.close();
      await server.close();
    }
  };
}

function parseToolJson(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  const response = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, response);
  return response;
}

test("calendar tools are registered with compatible names", async () => {
  const connection = await createConnectedClient();

  try {
    const result = await connection.client.listTools();
    const toolNames = result.tools.map((tool) => tool.name).sort();

    assert.deepEqual(toolNames, [
      "calendar_check_conflicts",
      "calendar_create_event",
      "calendar_create_snapshot",
      "calendar_delete_event",
      "calendar_diagnose_issue",
      "calendar_explain_last_change",
      "calendar_get_calendar",
      "calendar_get_changes_since",
      "calendar_get_event",
      "calendar_get_snapshot",
      "calendar_health_check",
      "calendar_list_calendars",
      "calendar_list_events",
      "calendar_permissions_check",
      "calendar_preview_create_event",
      "calendar_preview_update_event",
      "calendar_reschedule_event",
      "calendar_rollback_change",
      "calendar_search_events",
      "calendar_update_event"
    ]);
    for (const toolName of toolNames) {
      assert.match(toolName, /^[A-Za-z0-9_]+$/);
      assert.doesNotMatch(toolName, /\./);
      assert.doesNotMatch(toolName, /__/);
      assert.match(toolName, /^calendar_/);
      assert.ok(toolName.length <= 64);
    }
  } finally {
    await connection.close();
  }
});

test("calendar_health_check returns real runtime state fields", async () => {
  const connection = await createConnectedClient();

  try {
    const result = await connection.client.callTool({
      name: "calendar_health_check",
      arguments: {}
    });
    const response = parseToolJson(result);

    assert.equal(response.success, true);
    assert.equal(response.data.status, "ok");
    assert.equal(response.data.swift_bridge_status, "real");
    assert.equal(response.data.eventkit_status, "real");
    assert.equal(response.data.permission_status, "authorized");
    assert.equal(response.data.bridge_process_mode, "app_socket");
    assert.equal(response.data.database_status, "real");
    assert.equal(response.data.configuration_status, "loaded");
    assert.equal(response.data.calendar_operations, "real_eventkit_bridge");
    assert.equal("phase" in response.data, false);
    assert.equal("bridge_status" in response.data, false);
  } finally {
    await connection.close();
  }
});

test("calendar_permissions_check returns bridge-backed permission fields", async () => {
  const connection = await createConnectedClient();

  try {
    const result = await connection.client.callTool({
      name: "calendar_permissions_check",
      arguments: {}
    });
    const response = parseToolJson(result);

    assert.equal(response.success, true);
    assert.equal(response.data.calendar_permission, "authorized");
    assert.equal(response.data.authorization_status, "authorized");
    assert.equal(response.data.permission_mode, "not_loaded");
    assert.equal(response.data.calendar_allowlist, "loaded");
    assert.equal(response.data.swift_bridge_status, "real");
    assert.equal(response.data.eventkit_status, "real");
    assert.equal(response.data.request_attempted, false);
    assert.equal(response.data.request_api_used, null);
    assert.equal(response.data.helper_bundle_identifier, "com.owensuyko.apple-calendar-mcp.helper");
    assert.equal(response.data.info_plist_detected, true);
    assert.equal(response.data.bridge_process_mode, "app_socket");
    assert.equal(response.data.permission_request.attempted, false);
    assert.equal("phase" in response.data, false);
  } finally {
    await connection.close();
  }
});

test("semantic error helper uses required error shape", () => {
  assert.deepEqual(
    createSemanticError(
      "INVALID_INPUT",
      "The request was invalid.",
      "Check the tool schema and retry."
    ),
    {
      code: "INVALID_INPUT",
      message: "The request was invalid.",
      suggested_action: "Check the tool schema and retry.",
      retryable: false
    }
  );
});

test("tools reject unexpected input arguments", async () => {
  const connection = await createConnectedClient();

  try {
    const result = await connection.client.callTool({
      name: "calendar_health_check",
      arguments: {
        unexpected: true
      }
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Input validation error/);
    assert.match(result.content[0].text, /unexpected/);
  } finally {
    await connection.close();
  }
});

test("normal runtime uses the bridge subprocess for health, permissions, permission request, and list calendars", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-runtime-bridge-"));
  const helperPath = join(directory, "fake-eventkit-bridge.mjs");
  const callsPath = join(directory, "calls.jsonl");
  const databasePath = join(directory, "state.sqlite");
  const previousHelper = process.env.APPLE_CALENDAR_MCP_HELPER;
  const previousCalls = process.env.BRIDGE_CALLS_FILE;
  const previousDatabase = process.env.APPLE_CALENDAR_MCP_DATABASE_PATH;

  await writeFile(
    helperPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const callsPath = process.env.BRIDGE_CALLS_FILE;
let count = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(callsPath, JSON.stringify({ method: request.method }) + "\\n");
  let data;
  if (request.method === "permission_status") {
    data = {
      calendar_permission: "not_determined",
      authorization_status: "not_determined",
      request_attempted: false,
      request_api_used: null,
      helper_bundle_identifier: "com.owensuyko.apple-calendar-mcp.helper",
      info_plist_detected: true,
      bridge_process_mode: "direct_stdio"
    };
  } else if (request.method === "request_permission") {
    data = {
      granted: true,
      calendar_permission: "authorized",
      authorization_status: "authorized",
      request_attempted: true,
      request_api_used: "requestFullAccessToEvents",
      helper_bundle_identifier: "com.owensuyko.apple-calendar-mcp.helper",
      info_plist_detected: true,
      bridge_process_mode: "direct_stdio"
    };
  } else if (request.method === "list_calendars") {
    data = [];
  } else {
    data = null;
  }
  process.stdout.write(JSON.stringify({ id: request.id, success: true, data }) + "\\n");
  count += 1;
  if (count >= 5) {
    process.exit(0);
  }
});
`,
    "utf8"
  );
  await chmod(helperPath, 0o700);

  process.env.APPLE_CALENDAR_MCP_HELPER = helperPath;
  process.env.BRIDGE_CALLS_FILE = callsPath;
  process.env.APPLE_CALENDAR_MCP_DATABASE_PATH = databasePath;

  const server = createAppleCalendarMcpServer(silentLogger);
  const client = new Client(
    {
      name: "normal-runtime-test-client",
      version: "0.0.0"
    },
    {
      capabilities: {}
    }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    const health = parseToolJson(
      await client.callTool({ name: "calendar_health_check", arguments: {} })
    );
    const permissions = parseToolJson(
      await client.callTool({ name: "calendar_permissions_check", arguments: {} })
    );
    const requestedPermissions = parseToolJson(
      await client.callTool({
        name: "calendar_permissions_check",
        arguments: { request_permission: true }
      })
    );
    const calendars = parseToolJson(
      await client.callTool({ name: "calendar_list_calendars", arguments: {} })
    );

    assert.equal(health.data.permission_status, "not_determined");
    assert.equal(health.data.swift_bridge_status, "real");
    assert.equal(health.data.permission_request_available, true);
    assert.equal(health.data.bridge_process_mode, "direct_stdio");
    assert.equal(permissions.data.calendar_permission, "not_determined");
    assert.equal(permissions.data.authorization_status, "not_determined");
    assert.equal(permissions.data.helper_bundle_identifier, "com.owensuyko.apple-calendar-mcp.helper");
    assert.equal(permissions.data.info_plist_detected, true);
    assert.equal(permissions.data.bridge_process_mode, "direct_stdio");
    assert.equal(permissions.data.request_attempted, false);
    assert.equal(permissions.data.permission_request.available, true);
    assert.equal(permissions.data.permission_request.attempted, false);
    assert.equal(requestedPermissions.data.calendar_permission, "authorized");
    assert.equal(requestedPermissions.data.authorization_status, "authorized");
    assert.equal(requestedPermissions.data.request_attempted, true);
    assert.equal(requestedPermissions.data.request_api_used, "requestFullAccessToEvents");
    assert.equal(requestedPermissions.data.permission_request.attempted, true);
    assert.equal(requestedPermissions.data.permission_request.granted, true);
    assert.deepEqual(calendars.data, []);

    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).method);
    assert.deepEqual(calls, [
      "permission_status",
      "permission_status",
      "permission_status",
      "request_permission",
      "list_calendars"
    ]);
  } finally {
    await client.close();
    await server.close();
    if (previousHelper === undefined) {
      delete process.env.APPLE_CALENDAR_MCP_HELPER;
    } else {
      process.env.APPLE_CALENDAR_MCP_HELPER = previousHelper;
    }
    if (previousCalls === undefined) {
      delete process.env.BRIDGE_CALLS_FILE;
    } else {
      process.env.BRIDGE_CALLS_FILE = previousCalls;
    }
    if (previousDatabase === undefined) {
      delete process.env.APPLE_CALENDAR_MCP_DATABASE_PATH;
    } else {
      process.env.APPLE_CALENDAR_MCP_DATABASE_PATH = previousDatabase;
    }
  }
});

test("stdio entrypoint does not write startup logs to stdout", async () => {
  const child = spawn(process.execPath, ["packages/mcp-server/dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APPLE_CALENDAR_MCP_DATABASE_PATH: ":memory:"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1000);
    child.stderr.on("data", () => {
      if (stderr.includes("Apple Calendar MCP server started")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  child.stdin.end();
  child.kill("SIGTERM");
  await once(child, "close");

  assert.equal(stdout, "");
  assert.match(stderr, /Apple Calendar MCP server started/);
});

test("root start scripts launch the built MCP stdio server", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(
    packageJson.scripts.start,
    "npm run build && node packages/mcp-server/dist/index.js"
  );
  assert.equal(
    packageJson.scripts.dev,
    "npm run build && node --enable-source-maps packages/mcp-server/dist/index.js"
  );
});
