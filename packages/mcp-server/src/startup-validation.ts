import { accessSync, constants } from "node:fs";
import type { Logger } from "./logger.js";
import { createSemanticFailure } from "./semantic-error.js";

export type StartupValidationResult =
  | { success: true }
  | ReturnType<typeof createSemanticFailure>;

export function validateStartup(logger: Logger): StartupValidationResult {
  if (process.stdout.isTTY) {
    logger.warn("Starting MCP server with stdout attached to a TTY");
  }

  try {
    accessSync(process.cwd(), constants.R_OK);
  } catch {
    return createSemanticFailure(
      "STARTUP_VALIDATION_FAILED",
      "The MCP server could not read its working directory.",
      "Start the server from a readable project or installation directory."
    );
  }

  return { success: true };
}
