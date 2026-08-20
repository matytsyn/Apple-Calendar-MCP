#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.join(repoRoot, "docs", "client-configs");
const templateDir = path.join(docsDir, "templates");
const localOutputDir = path.resolve(
  process.env.APPLE_CALENDAR_MCP_CLIENT_CONFIG_DIR ?? path.join(repoRoot, ".generated", "client-configs")
);
const serverName = "apple-calendar";
const handshakeTimeoutMs = Number(process.env.APPLE_CALENDAR_MCP_HANDSHAKE_TIMEOUT_MS ?? 5000);
const requiredEnvKeys = [
  "APPLE_CALENDAR_MCP_HELPER",
  "APPLE_CALENDAR_MCP_HELPER_LAUNCH_MODE",
  "APPLE_CALENDAR_MCP_DATABASE_PATH",
  "APPLE_CALENDAR_MCP_CONFIG_PATH"
];

const runtime = resolveRuntime();
const generatedFiles = clientFiles(stdioServer(runtime));
const templateFiles = clientFiles(stdioServer({
  command: "<NODE_EXECUTABLE>",
  args: ["<REPO_ROOT>/packages/mcp-server/dist/index.js"],
  env: {
    APPLE_CALENDAR_MCP_HELPER: "<REPO_ROOT>/apps/macos-helper/.build/debug/AppleCalendarMCPHelper.app/Contents/MacOS/apple-calendar-mcp-helper",
    APPLE_CALENDAR_MCP_HELPER_LAUNCH_MODE: "app",
    APPLE_CALENDAR_MCP_DATABASE_PATH: "<HOME>/Library/Application Support/AppleCalendarMCP/state.sqlite",
    APPLE_CALENDAR_MCP_CONFIG_PATH: "<HOME>/Library/Application Support/AppleCalendarMCP/config.json"
  }
}));

const readme = `# Apple Calendar MCP Client Configs

Generate machine-specific config files with:

\`\`\`sh
npm run client-configs:generate
\`\`\`

The copyable generated files are written to:

\`\`\`text
.generated/client-configs
\`\`\`

Those files contain absolute paths for this Mac, this checkout, and this Node
runtime. They are intentionally user-specific, are ignored by git, and should be
regenerated after moving the repository, changing Node versions, or rebuilding
the helper app.

Reusable placeholder templates live in \`templates/\`. Do not copy templates
directly without replacing every \`<...>\` placeholder.

Before generating, run:

\`\`\`sh
npm install
npm run build
npm run helper:bundle
npm run helper:setup
\`\`\`

## Validate And Diagnose

\`\`\`sh
npm run client-configs:validate
node scripts/generate-client-configs.mjs diagnose
\`\`\`

Validation parses every generated JSON/TOML file, checks the exact command,
args, and env values that clients will copy, confirms local paths exist, starts
the MCP server, confirms stdout stays protocol-clean, performs an MCP handshake,
and verifies that calendar tools are discoverable.

## Claude Desktop

Copy \`.generated/client-configs/claude_desktop_config.json\` into:

\`\`\`text
~/Library/Application Support/Claude/claude_desktop_config.json
\`\`\`

If the file already has other servers, merge the \`${serverName}\` entry under
the existing \`mcpServers\` object. Restart Claude Desktop after editing.

## Codex

Append \`.generated/client-configs/codex.config.toml\` to:

\`\`\`text
~/.codex/config.toml
\`\`\`

Verify with:

\`\`\`sh
codex mcp list
\`\`\`

## Cursor

Copy \`.generated/client-configs/cursor.mcp.json\` into either:

\`\`\`text
~/.cursor/mcp.json
<project>/.cursor/mcp.json
\`\`\`

Cursor Settings > Tools & MCP may open this JSON file directly. Restart or
refresh MCP in Cursor after editing.

## OpenClaw

Merge \`.generated/client-configs/openclaw.openclaw.json\` into:

\`\`\`text
~/.openclaw/openclaw.json
\`\`\`

Then verify:

\`\`\`sh
openclaw mcp status --verbose
openclaw mcp doctor ${serverName} --probe
\`\`\`

## Generic MCP Clients

Use \`.generated/client-configs/generic-mcp-client.json\` for clients that
support the common \`mcpServers\` object with local stdio servers.

Generated configs never combine command and arguments into a shell string. The
command is an absolute Node executable path and args is an array.
`;

const command = process.argv[2] ?? "generate";

if (command === "generate") {
  await generate();
  await validateOrExit();
} else if (command === "validate") {
  await validateOrExit();
} else if (command === "diagnose") {
  const diagnostics = await runDiagnostics();
  process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
  process.exitCode = diagnostics.ok ? 0 : 1;
} else {
  console.error("Usage: node scripts/generate-client-configs.mjs [generate|validate|diagnose]");
  process.exit(2);
}

async function generate() {
  mkdirSync(localOutputDir, { recursive: true });
  mkdirSync(templateDir, { recursive: true });
  for (const [fileName, content] of Object.entries(generatedFiles)) {
    writeFileSync(path.join(localOutputDir, fileName), content);
  }
  for (const [fileName, content] of Object.entries(templateFiles)) {
    writeFileSync(path.join(templateDir, fileName), content);
  }
  writeFileSync(path.join(docsDir, "README.md"), readme);
  console.log(`Generated user-specific client configs in ${localOutputDir}`);
  console.log(`Updated reusable templates in ${templateDir}`);
}

function resolveRuntime() {
  const serverPath = path.resolve(
    process.env.APPLE_CALENDAR_MCP_SERVER_PATH ?? path.join(repoRoot, "packages", "mcp-server", "dist", "index.js")
  );
  const appSupportDir = path.join(homedir(), "Library", "Application Support", "AppleCalendarMCP");
  const setupConfigPath = path.resolve(process.env.APPLE_CALENDAR_MCP_CONFIG_PATH ?? path.join(appSupportDir, "config.json"));
  const setupConfig = readSetupConfig(setupConfigPath);
  const helperPath = path.resolve(
    process.env.APPLE_CALENDAR_MCP_HELPER ??
      setupConfig.helper_executable ??
      path.join(
        repoRoot,
        "apps",
        "macos-helper",
        ".build",
        "debug",
        "AppleCalendarMCPHelper.app",
        "Contents",
        "MacOS",
        "apple-calendar-mcp-helper"
      )
  );
  const databasePath = path.resolve(
    process.env.APPLE_CALENDAR_MCP_DATABASE_PATH ??
      setupConfig.database_path ??
      path.join(appSupportDir, "state.sqlite")
  );
  const command = detectNodeExecutable();

  return {
    command,
    args: [serverPath],
    env: {
      APPLE_CALENDAR_MCP_HELPER: helperPath,
      APPLE_CALENDAR_MCP_HELPER_LAUNCH_MODE: process.env.APPLE_CALENDAR_MCP_HELPER_LAUNCH_MODE ?? setupConfig.helper_launch_mode ?? "app",
      APPLE_CALENDAR_MCP_DATABASE_PATH: databasePath,
      APPLE_CALENDAR_MCP_CONFIG_PATH: setupConfigPath
    }
  };
}

function readSetupConfig(setupConfigPath) {
  try {
    return JSON.parse(readFileSync(setupConfigPath, "utf8"));
  } catch {
    return {};
  }
}

function detectNodeExecutable() {
  const override = process.env.APPLE_CALENDAR_MCP_NODE_PATH;
  if (override) {
    return path.resolve(override);
  }

  return path.resolve(process.execPath);
}

function clientFiles(server) {
  return {
    "claude_desktop_config.json": json({ mcpServers: { [serverName]: server } }),
    "cursor.mcp.json": json({ mcpServers: { [serverName]: server } }),
    "generic-mcp-client.json": json({ mcpServers: { [serverName]: server } }),
    "openclaw.openclaw.json": json({ mcp: { servers: { [serverName]: server } } }),
    "codex.config.toml": codexToml(server)
  };
}

function stdioServer({ command, args, env }) {
  return { type: "stdio", command, args, env };
}

function codexToml(server) {
  return `[mcp_servers.${serverName}]
command = ${tomlString(server.command)}
args = [${server.args.map(tomlString).join(", ")}]

[mcp_servers.${serverName}.env]
${Object.entries(server.env).map(([key, value]) => `${key} = ${tomlString(value)}`).join("\n")}
`;
}

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function tomlString(value) {
  return JSON.stringify(value);
}

async function validateOrExit() {
  const diagnostics = await runDiagnostics();
  if (!diagnostics.ok) {
    console.error("Client config validation failed:");
    for (const check of diagnostics.checks.filter((entry) => !entry.ok && entry.required !== false)) {
      console.error(`- ${check.name}: ${check.message}`);
      if (check.fix) {
        console.error(`  Fix: ${check.fix}`);
      }
    }
    console.error("Run: npm run build && npm run helper:bundle && npm run helper:setup && npm run client-configs:generate");
    process.exit(1);
  }

  const warnings = diagnostics.checks.filter((entry) => !entry.ok && entry.required === false);
  for (const warning of warnings) {
    console.error(`Client config validation warning: ${warning.name}: ${warning.message}`);
    if (warning.fix) {
      console.error(`  Fix: ${warning.fix}`);
    }
  }
  console.log("Client config validation passed.");
}

async function runDiagnostics() {
  const checks = [];
  const servers = readGeneratedServers(checks);
  validateGeneratedServers(servers, checks);
  validateTemplates(checks);
  await validateLocalRuntime(checks);
  await validateStdoutSeparation(checks);
  await validateMcpHandshake(checks);

  return {
    ok: checks.every((check) => check.ok || check.required === false),
    generated_at: new Date().toISOString(),
    output_dir: localOutputDir,
    server_name: serverName,
    runtime,
    checks
  };
}

function readGeneratedServers(checks) {
  const servers = new Map();
  for (const fileName of Object.keys(generatedFiles)) {
    const filePath = path.join(localOutputDir, fileName);
    if (!existsSync(filePath)) {
      checks.push(fail(`generated:${fileName}`, `Missing generated file: ${filePath}`, "Run npm run client-configs:generate."));
      continue;
    }

    try {
      if (fileName.endsWith(".json")) {
        servers.set(fileName, serverFromJson(fileName, JSON.parse(readFileSync(filePath, "utf8"))));
      } else {
        servers.set(fileName, serverFromCodexToml(readFileSync(filePath, "utf8")));
      }
      checks.push(pass(`generated:${fileName}`, "Generated config parsed."));
    } catch (error) {
      checks.push(fail(`generated:${fileName}`, error.message, "Regenerate the client configs."));
    }
  }
  return servers;
}

function validateGeneratedServers(servers, checks) {
  for (const [fileName, server] of servers) {
    if (!server || typeof server !== "object") {
      checks.push(fail(`${fileName}:server`, `Missing ${serverName} server entry.`, "Regenerate or merge the apple-calendar entry."));
      continue;
    }
    if (server.type !== "stdio") {
      checks.push(fail(`${fileName}:type`, "Server type must be stdio.", "Use the generated config without editing type."));
    }
    if (server.command !== runtime.command) {
      checks.push(fail(`${fileName}:command`, `Expected ${runtime.command}, got ${server.command}.`, "Regenerate configs after changing Node."));
    }
    if (!Array.isArray(server.args) || server.args.length !== 1 || server.args[0] !== runtime.args[0]) {
      checks.push(fail(`${fileName}:args`, `Expected args [${runtime.args[0]}].`, "Do not combine command and args into one shell string."));
    }
    if (!server.env || typeof server.env !== "object") {
      checks.push(fail(`${fileName}:env`, "Missing env object.", "Use the generated env block."));
      continue;
    }
    for (const key of requiredEnvKeys) {
      if (server.env[key] !== runtime.env[key]) {
        checks.push(fail(`${fileName}:env:${key}`, `Expected ${runtime.env[key]}, got ${server.env[key]}.`, "Regenerate configs after setup changes."));
      }
    }
  }
}

async function validateLocalRuntime(checks) {
  await checkFile("node executable", runtime.command, checks, "Set APPLE_CALENDAR_MCP_NODE_PATH to the absolute Node executable.");
  await checkFile("MCP server entrypoint", runtime.args[0], checks, "Run npm run build.");
  await checkFile("Swift helper", runtime.env.APPLE_CALENDAR_MCP_HELPER, checks, "Run npm run helper:bundle.");
  await checkFile("setup config", runtime.env.APPLE_CALENDAR_MCP_CONFIG_PATH, checks, "Run npm run helper:setup and click Generate Config.");
  await mkdir(path.dirname(runtime.env.APPLE_CALENDAR_MCP_DATABASE_PATH), { recursive: true });
  checks.push(pass("SQLite directory", `Writable directory: ${path.dirname(runtime.env.APPLE_CALENDAR_MCP_DATABASE_PATH)}`));
  await validateEventKit(checks);
}

async function checkFile(name, filePath, checks, fix) {
  try {
    await access(filePath, constants.F_OK | constants.R_OK);
    checks.push(pass(name, filePath));
  } catch {
    checks.push(fail(name, `Missing or unreadable path: ${filePath}`, fix));
  }
}

async function validateEventKit(checks) {
  try {
    const { EventKitBridgeClient } = await import("../packages/calendar-service/dist/index.js");
    const client = new EventKitBridgeClient({
      command: runtime.env.APPLE_CALENDAR_MCP_HELPER,
      launchMode: "app"
    });
    try {
      const status = await client.call("permission_status");
      checks.push(pass("EventKit permission", JSON.stringify(status)));
    } finally {
      client.close();
    }
  } catch (error) {
    checks.push(warn("EventKit permission", error.message, "Open the setup app and grant Calendar access before using calendar data tools."));
  }
}

async function validateStdoutSeparation(checks) {
  const result = await launchForProbe(350);
  if (!result.started) {
    checks.push(fail("MCP startup", result.message, "Check Node, server path, helper path, and SQLite permissions."));
    checks.push(pass("stdout/stderr separation", "Skipped because startup failed before protocol wait."));
    return;
  }

  checks.push(pass("MCP startup", "Process stayed alive waiting for stdio input."));
  if (result.stdout.length === 0) {
    checks.push(pass("stdout/stderr separation", "No startup bytes written to stdout."));
  } else {
    checks.push(fail("stdout/stderr separation", `Unexpected stdout: ${result.stdout.slice(0, 200)}`, "Keep logs on stderr only."));
  }
}

async function launchForProbe(delayMs) {
  return await new Promise((resolve) => {
    const child = spawn(runtime.command, runtime.args, {
      env: { ...process.env, ...runtime.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let exited = false;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      exited = true;
      resolve({ started: false, stdout, stderr, message: error.message });
    });
    child.on("exit", (code) => {
      exited = true;
      resolve({ started: false, stdout, stderr, message: `Process exited early with code ${code}. ${stderr}`.trim() });
    });
    setTimeout(() => {
      if (!exited) {
        child.kill("SIGTERM");
        resolve({ started: true, stdout, stderr, message: "started" });
      }
    }, delayMs);
  });
}

async function validateMcpHandshake(checks) {
  const transport = new StdioClientTransport({
    command: runtime.command,
    args: runtime.args,
    env: { ...process.env, ...runtime.env },
    stderr: "pipe"
  });
  const client = new Client({ name: "apple-calendar-mcp-config-validator", version: "0.1.0" }, { capabilities: {} });

  try {
    await withTimeout(client.connect(transport), handshakeTimeoutMs, "MCP handshake timed out.");
    checks.push(pass("MCP handshake", "Client initialized successfully."));
    const tools = await withTimeout(client.listTools(), handshakeTimeoutMs, "Tool discovery timed out.");
    const toolNames = tools.tools.map((tool) => tool.name);
    if (toolNames.includes("calendar_list_calendars") && toolNames.includes("calendar_permissions_check")) {
      checks.push(pass("MCP tool discovery", `${toolNames.length} tools discovered.`));
    } else {
      checks.push(fail("MCP tool discovery", `Missing expected calendar tools. Found: ${toolNames.join(", ")}`, "Rebuild the MCP server."));
    }
  } catch (error) {
    checks.push(fail("MCP handshake", error.message, "Run npm run build and npm run helper:bundle, then retry validation."));
  } finally {
    try {
      await transport.close();
    } catch {
      // Best-effort cleanup after failed startup or handshake probes.
    }
  }
}

function withTimeout(promise, ms, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), ms);
    })
  ]).finally(() => clearTimeout(timeout));
}

function serverFromJson(fileName, parsed) {
  if (fileName === "openclaw.openclaw.json") {
    return parsed?.mcp?.servers?.[serverName];
  }
  return parsed?.mcpServers?.[serverName];
}

function serverFromCodexToml(contents) {
  const command = matchTomlString(contents, /^command = ("(?:\\.|[^"])*")$/m, "command");
  const argsMatch = contents.match(/^args = \[(.*)\]$/m);
  if (!argsMatch) {
    throw new Error("missing args");
  }
  const args = JSON.parse(`[${argsMatch[1]}]`);
  const parsedEnv = {};
  for (const key of requiredEnvKeys) {
    parsedEnv[key] = matchTomlString(contents, new RegExp(`^${key} = ("(?:\\\\.|[^"])*")$`, "m"), key);
  }
  if (!contents.includes(`[mcp_servers.${serverName}]`) || !contents.includes(`[mcp_servers.${serverName}.env]`)) {
    throw new Error("missing Codex MCP server section");
  }
  return stdioServer({ command, args, env: parsedEnv });
}

function matchTomlString(contents, pattern, label) {
  const match = contents.match(pattern);
  if (!match) {
    throw new Error(`missing ${label}`);
  }
  return JSON.parse(match[1]);
}

function validateTemplates(checks) {
  const docsFiles = [
    path.join(docsDir, "README.md"),
    ...Object.keys(templateFiles).map((fileName) => path.join(templateDir, fileName))
  ];
  for (const filePath of docsFiles) {
    if (!existsSync(filePath)) {
      checks.push(fail(`template:${path.basename(filePath)}`, `Missing ${filePath}`, "Run npm run client-configs:generate."));
      continue;
    }
    const contents = readFileSync(filePath, "utf8");
    if (contents.includes(homedir()) || contents.includes(repoRoot) || contents.includes(runtime.command)) {
      checks.push(fail(`template:${path.basename(filePath)}`, "Reusable docs contain local hardcoded paths.", "Regenerate templates."));
    }
  }
}

function pass(name, message) {
  return { name, ok: true, required: true, message };
}

function fail(name, message, fix) {
  return { name, ok: false, required: true, message, fix };
}

function warn(name, message, fix) {
  return { name, ok: false, required: false, message, fix };
}
