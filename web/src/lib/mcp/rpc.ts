/**
 * Stateless MCP JSON-RPC dispatcher. Handles initialize / tools/list /
 * tools/call / ping / notifications. Rate-limits tools/call only (fail-open).
 * Returns null for notifications (the route answers 202).
 */
import { SERVER_INFO, SERVER_INSTRUCTIONS, TOOLS } from "./tools";
import { checkRateLimit, type RateLimiter } from "./gate";
import { McpInvalidInput } from "./limits";
import { RPC, type JsonRpcResponse, type McpToolResult } from "./types";

const PROTOCOL_VERSION = "2025-06-18";

export interface RpcDeps {
  limiter: RateLimiter | null;
  clientKey: string;
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function err(
  id: string | number | null,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function rateLimited(): McpToolResult {
  return {
    content: [{ type: "text", text: "Rate limit exceeded — try again in a minute." }],
    isError: true,
  };
}

export async function dispatchRpc(
  msg: unknown,
  deps: RpcDeps
): Promise<JsonRpcResponse | null> {
  const m = (msg ?? {}) as {
    jsonrpc?: unknown;
    id?: string | number | null;
    method?: unknown;
    params?: Record<string, unknown>;
  };
  const isNotification = m.id === undefined;
  const id = m.id ?? null;

  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    return isNotification ? null : err(id, RPC.INVALID_REQUEST, "Invalid Request");
  }

  switch (m.method) {
    case "initialize": {
      const requested = m.params?.protocolVersion;
      return ok(id, {
        protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case "notifications/initialized":
      return null;
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const allowed = await checkRateLimit(deps.limiter, deps.clientKey);
      if (!allowed) return ok(id, rateLimited());

      const params = m.params ?? {};
      const name = params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return ok(id, {
          content: [{ type: "text", text: `Unknown tool '${String(name)}'` }],
          isError: true,
        });
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return ok(id, await tool.handler(args));
      } catch (e) {
        if (e instanceof McpInvalidInput) {
          return err(id, RPC.INVALID_PARAMS, e.message);
        }
        console.error(`MCP tool ${String(name)} failed:`, e);
        return ok(id, {
          content: [
            { type: "text", text: "The data source is temporarily unavailable. Please try again." },
          ],
          isError: true,
        });
      }
    }
    default:
      return isNotification
        ? null
        : err(id, RPC.METHOD_NOT_FOUND, `Method not found: ${m.method}`);
  }
}
