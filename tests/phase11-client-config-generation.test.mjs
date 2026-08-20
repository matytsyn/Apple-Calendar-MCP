import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, test } from "node:test";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const scriptPath = "scripts/generate-client-configs.mjs";
const templateDir = "docs/client-configs/templates";
let localConfigDir;
let generatorEnv;
const requiredEnvKeys = [
  "APPLE_CALENDAR_MCP_HELPER",
  "APPLE_CALENDAR_MCP_HELPER_LAUNCH_MODE",
  "APPLE_CALENDAR_MCP_DATABASE_PATH",
  "APPLE_CALENDAR_MCP_CONFIG_PATH"
];
const configFileNames = [
  "claude_desktop_config.json",
  "codex.config.toml",
  "cursor.mcp.json",
  "openclaw.openclaw.json",
  "generic-mcp-client.json"
];

before(async () => {
  localConfigDir = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-phase11-generated-"));
  generatorEnv = await createGeneratorEnv({
    APPLE_CALENDAR_MCP_CLIENT_CONFIG_DIR: localConfigDir
  });
  await execFileAsync(process.execPath, [scriptPath, "generate"], { env: generatorEnv });
});

async function createGeneratorEnv(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-phase11-env-"));
  const configPath = join(directory, "config.json");
  const databasePath = join(directory, "state.sqlite");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    permission_mode: "ask_before_write",
    allowed_native_calendar_ids: []
  }));

  return {
    ...process.env,
    APPLE_CALENDAR_MCP_NODE_PATH: process.execPath,
    APPLE_CALENDAR_MCP_DATABASE_PATH: databasePath,
    APPLE_CALENDAR_MCP_CONFIG_PATH: configPath,
    APPLE_CALENDAR_MCP_HANDSHAKE_TIMEOUT_MS: "800",
    ...overrides
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertStdioServer(server, { template = false } = {}) {
  assert.equal(server.type, "stdio");
  assert.equal(typeof server.command, "string");
  assert.ok(server.command.length > 0);
  assert.equal(Array.isArray(server.args), true);
  assert.match(server.args[0], /packages\/mcp-server\/dist\/index\.js$/);
  for (const key of requiredEnvKeys) {
    assert.equal(typeof server.env[key], "string");
    assert.ok(server.env[key].length > 0);
  }

  if (template) {
    assert.equal(server.command, "<NODE_EXECUTABLE>");
    assert.match(server.args[0], /^<REPO_ROOT>/);
    assert.match(server.env.APPLE_CALENDAR_MCP_HELPER, /^<REPO_ROOT>/);
    assert.match(server.env.APPLE_CALENDAR_MCP_CONFIG_PATH, /^<HOME>/);
  } else {
    assert.equal(server.command, process.execPath);
    assert.equal(resolve(server.command), server.command);
    assert.equal(resolve(server.args[0]), server.args[0]);
    assert.equal(existsSync(server.command), true);
    assert.equal(existsSync(server.args[0]), true);
    assert.equal(existsSync(server.env.APPLE_CALENDAR_MCP_HELPER), true);
    assert.equal(existsSync(server.env.APPLE_CALENDAR_MCP_CONFIG_PATH), true);
  }
}

test("Phase 11 placeholder templates and local generated configs exist", () => {
  assert.equal(existsSync("docs/client-configs/README.md"), true);

  for (const fileName of configFileNames) {
    assert.equal(existsSync(`${templateDir}/${fileName}`), true, `${fileName} template exists`);
    assert.equal(existsSync(`${localConfigDir}/${fileName}`), true, `${fileName} local config exists`);
  }
});

test("placeholder docs do not contain hardcoded local paths", async () => {
  for (const filePath of [
    "docs/client-configs/README.md",
    ...configFileNames.map((fileName) => `${templateDir}/${fileName}`)
  ]) {
    const contents = await readFile(filePath, "utf8");

    assert.equal(contents.includes(homedir()), false, `${filePath} does not contain home path`);
    assert.equal(contents.includes(resolve(".")), false, `${filePath} does not contain repo path`);
    assert.equal(contents.includes(process.execPath), false, `${filePath} does not contain Node path`);
  }
});

test("Claude, Cursor, and generic templates use common mcpServers stdio shape", async () => {
  for (const fileName of [
    "claude_desktop_config.json",
    "cursor.mcp.json",
    "generic-mcp-client.json"
  ]) {
    const config = await readJson(`${templateDir}/${fileName}`);
    assertStdioServer(config.mcpServers["apple-calendar"], { template: true });
  }
});

test("OpenClaw template uses mcp.servers stdio shape", async () => {
  const config = await readJson(`${templateDir}/openclaw.openclaw.json`);
  assertStdioServer(config.mcp.servers["apple-calendar"], { template: true });
});

test("Codex template uses config.toml mcp_servers table with placeholders", async () => {
  const config = await readFile(`${templateDir}/codex.config.toml`, "utf8");

  assert.match(config, /\[mcp_servers\.apple-calendar\]/);
  assert.match(config, /command = "<NODE_EXECUTABLE>"/);
  assert.match(config, /args = \["<REPO_ROOT>\/packages\/mcp-server\/dist\/index\.js"\]/);
  assert.match(config, /\[mcp_servers\.apple-calendar\.env\]/);
  for (const key of requiredEnvKeys) {
    assert.match(config, new RegExp(`${key} = "`));
  }
});

test("local generated configs resolve to existing copyable stdio entries", async () => {
  for (const fileName of [
    "claude_desktop_config.json",
    "cursor.mcp.json",
    "generic-mcp-client.json"
  ]) {
    const config = await readJson(`${localConfigDir}/${fileName}`);
    assertStdioServer(config.mcpServers["apple-calendar"]);
  }

  const openClaw = await readJson(`${localConfigDir}/openclaw.openclaw.json`);
  assertStdioServer(openClaw.mcp.servers["apple-calendar"]);

  const codex = await readFile(`${localConfigDir}/codex.config.toml`, "utf8");
  assert.match(codex, new RegExp(`command = "${escapeRegExp(process.execPath)}"`));
  assert.match(codex, new RegExp(`args = \\["${escapeRegExp(resolve("packages/mcp-server/dist/index.js"))}"\\]`));
});

test("client config generation prefers setup config helper and database paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-setup-config-paths-"));
  const outputDirectory = join(directory, "generated configs");
  const configPath = join(directory, "config.json");
  const databasePath = join(directory, "configured state.sqlite");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    permission_mode: "ask_before_write",
    allowed_native_calendar_ids: [],
    helper_executable: process.execPath,
    helper_launch_mode: "app",
    database_path: databasePath
  }));

  const env = {
    ...process.env,
    APPLE_CALENDAR_MCP_NODE_PATH: process.execPath,
    APPLE_CALENDAR_MCP_CONFIG_PATH: configPath,
    APPLE_CALENDAR_MCP_CLIENT_CONFIG_DIR: outputDirectory,
    APPLE_CALENDAR_MCP_HANDSHAKE_TIMEOUT_MS: "800"
  };
  await execFileAsync(process.execPath, [scriptPath, "generate"], { env });

  const cursorConfig = await readJson(join(outputDirectory, "cursor.mcp.json"));
  const server = cursorConfig.mcpServers["apple-calendar"];
  assert.equal(server.env.APPLE_CALENDAR_MCP_HELPER, process.execPath);
  assert.equal(server.env.APPLE_CALENDAR_MCP_DATABASE_PATH, databasePath);
  assert.equal(server.env.APPLE_CALENDAR_MCP_CONFIG_PATH, configPath);
});

test("client config README includes validation and copy/install instructions", async () => {
  const readme = await readFile("docs/client-configs/README.md", "utf8");

  for (const phrase of [
    "npm run client-configs:generate",
    "npm run client-configs:validate",
    "node scripts/generate-client-configs.mjs diagnose",
    "performs an MCP handshake",
    ".generated/client-configs",
    "intentionally user-specific",
    "ignored by git",
    "templates/",
    "Claude Desktop",
    "Codex",
    "Cursor",
    "OpenClaw",
    "Generic MCP Clients",
    "~/.codex/config.toml",
    "~/.cursor/mcp.json",
    "~/.openclaw/openclaw.json",
    "codex mcp list",
    "openclaw mcp doctor apple-calendar --probe"
  ]) {
    assert.match(readme, new RegExp(escapeRegExp(phrase)));
  }
});

test("client config validation rejects stale paths inside generated files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-client-configs-"));
  const env = await createGeneratorEnv({ APPLE_CALENDAR_MCP_CLIENT_CONFIG_DIR: directory });
  await execFileAsync(process.execPath, [scriptPath, "generate"], { env });

  const claudeConfigPath = join(directory, "claude_desktop_config.json");
  const claudeConfig = await readJson(claudeConfigPath);
  claudeConfig.mcpServers["apple-calendar"].command = "/definitely/not/a/real/node";
  await writeFile(claudeConfigPath, JSON.stringify(claudeConfig, null, 2) + "\n");

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "validate"], { env }),
    (error) => {
      assert.match(error.stderr, /claude_desktop_config\.json:command/);
      assert.match(error.stderr, /Expected .* got \/definitely\/not\/a\/real\/node/);
      return true;
    }
  );
});

test("client config validation rejects missing node executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-missing-node-"));
  const env = await createGeneratorEnv({
    APPLE_CALENDAR_MCP_CLIENT_CONFIG_DIR: directory,
    APPLE_CALENDAR_MCP_NODE_PATH: join(directory, "missing-node")
  });

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "generate"], { env }),
    (error) => {
      assert.match(error.stderr, /node executable/);
      assert.match(error.stderr, /Missing or unreadable path/);
      return true;
    }
  );
});

test("client config validation rejects missing server entrypoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-missing-server-"));
  const env = await createGeneratorEnv({
    APPLE_CALENDAR_MCP_CLIENT_CONFIG_DIR: directory,
    APPLE_CALENDAR_MCP_SERVER_PATH: join(directory, "missing-server.js")
  });

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "generate"], { env }),
    (error) => {
      assert.match(error.stderr, /MCP server entrypoint/);
      assert.match(error.stderr, /Missing or unreadable path/);
      return true;
    }
  );
});

test("client config validation rejects malformed generated config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-malformed-config-"));
  const env = await createGeneratorEnv({ APPLE_CALENDAR_MCP_CLIENT_CONFIG_DIR: directory });
  await execFileAsync(process.execPath, [scriptPath, "generate"], { env });
  await writeFile(join(directory, "cursor.mcp.json"), "{bad json\n");

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "validate"], { env }),
    (error) => {
      assert.match(error.stderr, /generated:cursor\.mcp\.json/);
      return true;
    }
  );
});

test("client config validation reports failed MCP startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-startup-fail-"));
  const failingServer = join(directory, "server exits immediately.js");
  await writeFile(failingServer, "process.stderr.write('boom startup\\n'); process.exit(42);");
  const env = await createGeneratorEnv({
    APPLE_CALENDAR_MCP_CLIENT_CONFIG_DIR: directory,
    APPLE_CALENDAR_MCP_SERVER_PATH: failingServer
  });

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "generate"], { env }),
    (error) => {
      assert.match(error.stderr, /MCP startup|MCP handshake/);
      assert.match(error.stderr, /boom startup|exited/);
      return true;
    }
  );
});

test("client config validation reports failed MCP handshake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-calendar-mcp-handshake-fail-"));
  const hangingServer = join(directory, "server hangs without protocol.js");
  await writeFile(hangingServer, "setInterval(() => {}, 1000);");
  const env = await createGeneratorEnv({
    APPLE_CALENDAR_MCP_CLIENT_CONFIG_DIR: directory,
    APPLE_CALENDAR_MCP_SERVER_PATH: hangingServer,
    APPLE_CALENDAR_MCP_HANDSHAKE_TIMEOUT_MS: "150"
  });

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "generate"], { env }),
    (error) => {
      assert.match(error.stderr, /MCP handshake/);
      assert.match(error.stderr, /timed out/);
      return true;
    }
  );
});

test("client config generation handles spaces in output and server paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple calendar mcp spaced output "));
  const spacedServer = join(directory, "server with spaces.js");
  await writeFile(
    spacedServer,
    "import process from 'node:process'; await import(process.argv[2]);\n"
  );
  const env = await createGeneratorEnv({
    APPLE_CALENDAR_MCP_CLIENT_CONFIG_DIR: directory,
    APPLE_CALENDAR_MCP_SERVER_PATH: resolve("packages/mcp-server/dist/index.js")
  });
  await execFileAsync(process.execPath, [scriptPath, "generate"], { env });

  const cursorConfig = await readJson(join(directory, "cursor.mcp.json"));
  assert.equal(cursorConfig.mcpServers["apple-calendar"].args.length, 1);
  assert.match(cursorConfig.mcpServers["apple-calendar"].args[0], /Apple Calendar MCP|packages\/mcp-server/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
