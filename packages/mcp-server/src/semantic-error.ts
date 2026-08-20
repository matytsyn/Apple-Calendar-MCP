import type {
  SemanticError,
  SemanticErrorCode,
  SemanticFailure
} from "@apple-calendar-mcp/shared";

export function createSemanticError(
  code: SemanticErrorCode,
  message: string,
  suggestedAction: string,
  retryable = false
): SemanticError {
  return {
    code,
    message,
    suggested_action: suggestedAction,
    retryable
  };
}

export function createSemanticFailure(
  code: SemanticErrorCode,
  message: string,
  suggestedAction: string,
  retryable = false
): SemanticFailure {
  return {
    success: false,
    error: createSemanticError(code, message, suggestedAction, retryable)
  };
}
