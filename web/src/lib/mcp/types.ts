/** JSON-RPC 2.0 + MCP wire types. Pure — no Worker imports. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown> | undefined;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<McpToolResult>;
}

/** JSON-RPC standard error codes. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;
