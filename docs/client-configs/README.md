# Apple Calendar MCP Client Configs

Generate machine-specific config files with:

```sh
npm run client-configs:generate
```

The copyable generated files are written to:

```text
.generated/client-configs
```

Those files contain absolute paths for this Mac, this checkout, and this Node
runtime. They are intentionally user-specific, are ignored by git, and should be
regenerated after moving the repository, changing Node versions, or rebuilding
the helper app.

Reusable placeholder templates live in `templates/`. Do not copy templates
directly without replacing every `<...>` placeholder.

Before generating, run:

```sh
npm install
npm run build
npm run helper:bundle
npm run helper:setup
```

## Validate And Diagnose

```sh
npm run client-configs:validate
node scripts/generate-client-configs.mjs diagnose
```

Validation parses every generated JSON/TOML file, checks the exact command,
args, and env values that clients will copy, confirms local paths exist, starts
the MCP server, confirms stdout stays protocol-clean, performs an MCP handshake,
and verifies that calendar tools are discoverable.

## Claude Desktop

Copy `.generated/client-configs/claude_desktop_config.json` into:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

If the file already has other servers, merge the `apple-calendar` entry under
the existing `mcpServers` object. Restart Claude Desktop after editing.

## Codex

Append `.generated/client-configs/codex.config.toml` to:

```text
~/.codex/config.toml
```

Verify with:

```sh
codex mcp list
```

## Cursor

Copy `.generated/client-configs/cursor.mcp.json` into either:

```text
~/.cursor/mcp.json
<project>/.cursor/mcp.json
```

Cursor Settings > Tools & MCP may open this JSON file directly. Restart or
refresh MCP in Cursor after editing.

## OpenClaw

Merge `.generated/client-configs/openclaw.openclaw.json` into:

```text
~/.openclaw/openclaw.json
```

Then verify:

```sh
openclaw mcp status --verbose
openclaw mcp doctor apple-calendar --probe
```

## Generic MCP Clients

Use `.generated/client-configs/generic-mcp-client.json` for clients that
support the common `mcpServers` object with local stdio servers.

Generated configs never combine command and arguments into a shell string. The
command is an absolute Node executable path and args is an array.
