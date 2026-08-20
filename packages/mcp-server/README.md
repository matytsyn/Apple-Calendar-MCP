# MCP Server Package

Owns the MCP-facing TypeScript stdio server.

Responsibilities:

- create the MCP server
- register calendar tools
- validate startup assumptions
- shape semantic tool results
- keep stdout reserved for MCP protocol messages
- write runtime logs to stderr or an optional local log file

The package exposes the `apple-calendar-mcp` binary after build:

```sh
node dist/index.js
```
