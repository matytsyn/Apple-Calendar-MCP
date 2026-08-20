# Installation Guide

## Source Install

```sh
git clone <repo-url>
cd apple-calendar-mcp
npm install
npm run build
npm run helper:bundle
npm run helper:setup
```

## Native Setup App Flow

The setup app is the recommended installation path.

1. Open the app with `npm run helper:setup`.
2. Read the local-first permission explanation.
3. Click Request Calendar Access and approve the macOS prompt.
4. Select the calendars agents may access. Allow All is available but not selected by default.
5. Choose a permission mode. Ask Before Write is the recommended default.
6. Select an MCP client and generate configuration.
7. Copy or preview-install the generated config.
8. Run verification and test connection.
9. Finish setup or open settings.

Settings can later update calendar access, permission mode, connected client config, diagnostics, and advanced reset options. Reset must not delete Apple Calendar data.

## Generated Files

Local setup state is stored in:

```text
~/Library/Application Support/AppleCalendarMCP/config.json
~/Library/Application Support/AppleCalendarMCP/mcp.env
~/Library/Application Support/AppleCalendarMCP/state.sqlite
```

Generated client configs are written to:

```text
.generated/client-configs/
```

These files are user-specific and ignored by git.

## Client Configuration

Run:

```sh
npm run client-configs:generate
```

Then copy or merge the generated config:

- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Codex: `~/.codex/config.toml`
- Cursor: `~/.cursor/mcp.json` or `<project>/.cursor/mcp.json`
- OpenClaw: `~/.openclaw/openclaw.json`
- Generic clients: use the common `mcpServers` object from `generic-mcp-client.json`

Generated configs use:

- absolute Node executable path
- absolute MCP server entrypoint
- args array, not a shell string
- explicit environment variables for helper, database, and config paths

## Validation

```sh
npm run client-configs:validate
npm run client-configs:diagnose
```

Validation checks Node, the MCP entrypoint, helper path, setup config, SQLite directory, stdout/stderr separation, MCP handshake, and tool discovery.

## Troubleshooting

- Permission prompt never appears: run `tccutil reset Calendar`, reopen the setup app, and request access again.
- Permission denied: enable Calendar access in System Settings > Privacy & Security > Calendars.
- MCP startup fails: run `npm run build` and confirm `packages/mcp-server/dist/index.js` exists.
- Client cannot see tools: regenerate config, copy it to the right client file, then restart the client.
- Paths with spaces fail: do not hand-edit command strings; regenerate configs and keep command/args separate.
- Cursor shows connected false: check the Cursor MCP log, then run `npm run client-configs:diagnose` for the exact failing check.

## Public Package Path

The MCP server package exposes:

```sh
npx apple-calendar-mcp
```

For the release candidate, use source install until the npm package namespace and internal workspace package publication order are confirmed.
