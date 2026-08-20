import type { SemanticFailure } from "@apple-calendar-mcp/shared";

export class SqliteStoreError extends Error {
  readonly semantic: SemanticFailure;

  constructor(semantic: SemanticFailure) {
    super(semantic.error.message);
    this.name = "SqliteStoreError";
    this.semantic = semantic;
  }
}

export function databaseMigrationFailed(message: string): SqliteStoreError {
  return new SqliteStoreError({
    success: false,
    error: {
      code: "DATABASE_MIGRATION_FAILED",
      message,
      suggested_action: "Back up local MCP state, then retry migration or reset local MCP state.",
      retryable: false
    }
  });
}
