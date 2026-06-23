/**
 * POST /api/mcp — stateless MCP server (JSON-RPC 2.0 over Streamable HTTP, JSON
 * response mode; no SSE, no sessions). Public; tools/call is rate-limited per IP.
 * GET → 405 (no SSE channel).
 */
import type { APIRoute } from "astro";
import { getRateLimiter } from "@/lib/db/binding";
import { dispatchRpc } from "@/lib/mcp/rpc";
import { RPC } from "@/lib/mcp/types";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: RPC.PARSE_ERROR, message: "Parse error" } });
  }

  const clientKey = request.headers.get("cf-connecting-ip") ?? "anonymous";
  const limiter = getRateLimiter();
  const res = await dispatchRpc(body, { limiter, clientKey });
  // Notifications produce no response → 202 Accepted, empty body.
  return res ? json(res) : new Response(null, { status: 202 });
};

export const GET: APIRoute = () =>
  new Response("Method Not Allowed. POST a JSON-RPC 2.0 message to this endpoint.", {
    status: 405,
    headers: { Allow: "POST" },
  });
