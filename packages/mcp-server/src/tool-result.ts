import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SemanticResponse } from "@apple-calendar-mcp/shared";

export function toToolResult(response: SemanticResponse<unknown, unknown>): CallToolResult {
  return {
    isError: response.success === false,
    structuredContent: response as unknown as Record<string, unknown>,
    content: [
      {
        type: "text",
        text: JSON.stringify(response)
      }
    ]
  };
}
