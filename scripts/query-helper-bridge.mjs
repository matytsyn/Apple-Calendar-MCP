import { EventKitBridgeClient } from "../packages/calendar-service/dist/index.js";

const method = process.argv[2] ?? "permission_status";
const helper =
  process.env.APPLE_CALENDAR_MCP_HELPER ??
  "apps/macos-helper/.build/debug/AppleCalendarMCPHelper.app/Contents/MacOS/apple-calendar-mcp-helper";

const allowedMethods = new Set(["permission_status", "request_permission", "list_calendars"]);

if (!allowedMethods.has(method)) {
  process.stderr.write(`Unsupported helper query method: ${method}\n`);
  process.exit(2);
}

const client = new EventKitBridgeClient({
  command: helper,
  launchMode: "app"
});

try {
  const data = await client.call(method);
  process.stdout.write(`${JSON.stringify({ success: true, data })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      success: false,
      error: {
        code: "EVENTKIT_OPERATION_FAILED",
        message: "Helper bridge query failed.",
        suggested_action: error instanceof Error ? error.message : "Check helper build and permissions.",
        retryable: true
      }
    })}\n`
  );
  process.exitCode = 1;
} finally {
  client.close();
}
