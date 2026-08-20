import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

const setupSourcePath = "apps/macos-helper/Sources/SetupApp.swift";
const mainSourcePath = "apps/macos-helper/Sources/main.swift";

test("native setup app exposes required Phase 10 setup surfaces", async () => {
  const source = await readFile(setupSourcePath, "utf8");

  assert.match(source, /SetupAppDelegate/);
  assert.match(source, /Apple Calendar MCP/);
  assert.match(source, /Safely connect AI assistants to your Apple Calendar/);
  assert.match(source, /Works locally on your Mac/);
  assert.match(source, /Your calendar data stays on your device/);
  assert.match(source, /Request Calendar Access/);
  assert.match(source, /Calendar Access Selection/);
  assert.match(source, /Only selected calendars will be visible to AI assistants/);
  assert.match(source, /Blocked calendars remain hidden/);
  assert.match(source, /Allow All Calendars/);
  assert.match(source, /Recommended/);
  assert.match(source, /Permission Mode/);
  assert.match(source, /Ask Before Write/);
  assert.match(source, /Trusted Write/);
  assert.match(source, /Full Write/);
  assert.match(source, /MCP Client Setup/);
  assert.match(source, /Claude/);
  assert.match(source, /Codex/);
  assert.match(source, /Cursor/);
  assert.match(source, /OpenClaw/);
  assert.match(source, /Generic MCP/);
  assert.match(source, /Copy Configuration/);
  assert.match(source, /Preview Install into/);
  assert.match(source, /Run Test Connection/);
  assert.match(source, /Apple Calendar MCP is ready/);
  assert.match(source, /Manage Settings/);
  assert.match(source, /Permission Recovery/);
  assert.match(source, /Diagnostics/);
  assert.match(source, /Advanced/);
  assert.match(source, /Generate Config/);
  assert.match(source, /Reset/);
  assert.match(source, /System Settings > Privacy & Security > Calendars/);
  assert.match(source, /tccutil reset Calendar/);
});

test("native setup app generates compact local config and env entry points", async () => {
  const source = await readFile(setupSourcePath, "utf8");

  assert.match(source, /SetupConfigWriter/);
  assert.match(source, /config\.json/);
  assert.match(source, /mcp\.env/);
  assert.match(source, /allowed_native_calendar_ids/);
  assert.match(source, /calendar_allowlist/);
  assert.match(source, /permission_mode/);
  assert.match(source, /ask_before_write/);
  assert.match(source, /APPLE_CALENDAR_MCP_CONFIG_PATH/);
  assert.match(source, /APPLE_CALENDAR_MCP_HELPER_LAUNCH_MODE=app/);
  assert.match(source, /APPLE_CALENDAR_MCP_DATABASE_PATH/);
  assert.match(source, /Select at least one calendar/);
  assert.match(source, /static func reset/);
  assert.doesNotMatch(source, /notes/);
  assert.doesNotMatch(source, /attendees/);
  assert.doesNotMatch(source, /"source_title": sourceTitle/);
  assert.doesNotMatch(source, /"title": title/);
});

test("redesigned setup app guards client installation with preview and explicit confirmation", async () => {
  const source = await readFile(setupSourcePath, "utf8");

  assert.match(source, /ClientInstallPreview/);
  assert.match(source, /previewInstallSelectedClient/);
  assert.match(source, /installSelectedClientAfterPreview/);
  assert.match(source, /NSAlert/);
  assert.match(source, /This will modify/);
  assert.match(source, /Automatic installation is not available/);
  assert.match(source, /installCursor/);
  assert.match(source, /installCodex/);
  assert.match(source, /Merge the apple-calendar entry/);
  assert.match(source, /Never silently modify|Review the preview before continuing|Preview the installation before applying changes/);
});

test("redesigned setup app verifies permission, EventKit, SQLite, MCP config, and allowlist", async () => {
  const source = await readFile(setupSourcePath, "utf8");

  assert.match(source, /Calendar access working/);
  assert.match(source, /EventKit check/);
  assert.match(source, /SQLite check/);
  assert.match(source, /MCP server startup/);
  assert.match(source, /MCP configuration generated/);
  assert.match(source, /stdout\/stderr separation/);
  assert.match(source, /mcpServerPreflight/);
  assert.match(source, /mcpServerEnvironment/);
  assert.match(source, /nodeExecutable/);
  assert.match(source, /NODE_EXECUTABLE_NOT_FOUND/);
  assert.match(source, /for _ in 0\.\.<12/);
  assert.match(source, /fileExists\(atPath: serverPath\.path\)/);
  assert.match(source, /\.local\/node\/bin/);
  assert.match(source, /APPLE_CALENDAR_MCP_HELPER/);
  assert.doesNotMatch(source, /args": \["node", serverEntrypoint\.path\]/);
  assert.match(source, /Allowlist validation/);
  assert.match(source, /Permission mode configured/);
  assert.match(source, /Required verification passed/);
  assert.match(source, /isRequired: false/);
});

test("run test connection cannot freeze the setup app UI", async () => {
  const source = await readFile(setupSourcePath, "utf8");

  assert.match(source, /@Published var isTestingConnection = false/);
  assert.match(source, /DispatchQueue\.global\(qos: \.userInitiated\)\.async/);
  assert.match(source, /statusMessage = "Running test connection\.\.\."/);
  assert.match(source, /\.disabled\(model\.isTestingConnection\)/);
  assert.match(source, /waitForProcessExit\(process, timeout: 0\.75\)/);
  assert.match(source, /Darwin\.kill\(process\.processIdentifier, SIGKILL\)/);
  assert.doesNotMatch(source, /process\.waitUntilExit\(\)/);
});

test("helper app launch keeps bridge modes and adds explicit setup mode", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /--request-permission-and-exit/);
  assert.match(source, /--bridge-socket/);
  assert.match(source, /--setup/);
  assert.match(source, /runningInsideAppBundle/);
  assert.match(source, /direct_stdio/);
  assert.match(source, /SetupAppDelegate/);
});

test("setup app has npm and script entry points", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const script = await readFile("scripts/open-setup-app.sh", "utf8");
  const scriptStat = await stat("scripts/open-setup-app.sh");

  assert.equal(packageJson.scripts["helper:setup"], "bash scripts/open-setup-app.sh");
  assert.match(script, /build-helper-app\.sh/);
  assert.match(script, /--setup/);
  assert.ok((scriptStat.mode & 0o111) !== 0);
});
