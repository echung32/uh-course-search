/**
 * MCP-specific result caps — tighter than the web UI's MAX_PAGE_SIZE (250 in
 * lib/pageSize.ts) to keep agent payloads small and block term-exfiltration via
 * deep pagination. Pure module.
 */
export const MCP_DEFAULT_PAGE_SIZE = 20;
export const MCP_MAX_PAGE_SIZE = 50;
export const MCP_MAX_PAGE_OFFSET = 200;

/** Thrown for invalid tool arguments; the dispatcher maps it to JSON-RPC -32602. */
export class McpInvalidInput extends Error {}

export interface McpPageInput {
  pageOffset: number;
  pageMaxSize: number;
}

/**
 * Clamp a search tool's pagination to MCP limits. `pageMaxSize` is clamped to
 * [1, MCP_MAX_PAGE_SIZE] (defaulting when absent/invalid). `pageOffset` beyond
 * MCP_MAX_PAGE_OFFSET throws McpInvalidInput (narrow with filters instead).
 */
export function clampMcpPage(rawOffset: unknown, rawSize: unknown): McpPageInput {
  const offset =
    typeof rawOffset === "number" && Number.isInteger(rawOffset) ? rawOffset : 0;
  if (offset < 0) {
    throw new McpInvalidInput("pageOffset must be >= 0");
  }
  if (offset > MCP_MAX_PAGE_OFFSET) {
    throw new McpInvalidInput(
      `pageOffset exceeds the maximum of ${MCP_MAX_PAGE_OFFSET}. ` +
        `Narrow your search with filters (subject, courseNumber, campus) ` +
        `instead of paging deeper.`
    );
  }
  let size =
    typeof rawSize === "number" && Number.isInteger(rawSize)
      ? rawSize
      : MCP_DEFAULT_PAGE_SIZE;
  if (size < 1) size = MCP_DEFAULT_PAGE_SIZE;
  if (size > MCP_MAX_PAGE_SIZE) size = MCP_MAX_PAGE_SIZE;
  return { pageOffset: offset, pageMaxSize: size };
}
