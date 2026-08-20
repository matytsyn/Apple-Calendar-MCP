#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger } from "./logger.js";
import { createAppleCalendarMcpServer } from "./server.js";
import { validateStartup } from "./startup-validation.js";

export { createLogger } from "./logger.js";
export { createSemanticError, createSemanticFailure } from "./semantic-error.js";
export { createAppleCalendarMcpServer } from "./server.js";
export { registerCalendarTools } from "./tools.js";
export { validateStartup } from "./startup-validation.js";

function createConfiguredLogger() {
  const filePath = process.env.APPLE_CALENDAR_MCP_LOG_FILE;

  return createLogger(filePath ? { filePath } : {});
}

async function main(): Promise<void> {
  const logger = createConfiguredLogger();

  const validation = validateStartup(logger);

  if (!validation.success) {
    logger.error("Startup validation failed", { error: validation.error });
    process.exitCode = 1;
    return;
  }

  const server = createAppleCalendarMcpServer(logger);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  logger.info("Apple Calendar MCP server started");
}

const isEntrypoint = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isEntrypoint) {
  main().catch((error: unknown) => {
    const logger = createConfiguredLogger();

    logger.error("Unhandled MCP server startup error", {
      message: error instanceof Error ? error.message : "Unknown error"
    });
    process.exitCode = 1;
  });
}
