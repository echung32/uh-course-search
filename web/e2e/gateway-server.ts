// e2e harness: runs the production SQL gateway over the throwaway e2e D1 files
// so the whole Playwright suite exercises Worker → gateway → SQLite, the path
// production uses. Playwright starts webServers BEFORE globalSetup seeds the
// files, so they are resolved lazily on the first query (a failed resolution is
// retried on the next query).
//
// The Worker talks to a thin front proxy on GATEWAY_PORT that forwards to the
// real gateway (on GATEWAY_PORT + 100) — standing in for Cloudflare Tunnel.
// Test-only controls on GATEWAY_COUNTER_PORT (kept out of the production server):
//   GET /count → { count }, DELETE /count → reset   (gateway round-trips; each one
//                                                    is a Worker subrequest on Free)
//   POST /down → front proxy answers 502 HTML like a tunnel whose origin is gone;
//   DELETE /down → back up.
import { createServer } from "node:http";
import { createGatewayServer } from "../gateway/server";
import { findLocalD1File } from "./d1-helpers";

const port = Number(process.env.GATEWAY_PORT ?? 8788);
const innerPort = port + 100;
const counterPort = Number(process.env.GATEWAY_COUNTER_PORT ?? 8789);
const secret = process.env.GATEWAY_SECRET ?? "e2e-gateway-secret";

createGatewayServer({
  secret,
  files: {
    search: () => findLocalD1File("course_section"),
    analytics: () => findLocalD1File("course_term_stats"),
  },
}).listen(innerPort, "127.0.0.1");

let count = 0;
let down = false;

createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/query") count++;
  if (down && req.url !== "/healthz") {
    res.writeHead(502, { "Content-Type": "text/html" });
    res.end("<html><body>Bad gateway: origin unreachable</body></html>");
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const upstream = await fetch(`http://127.0.0.1:${innerPort}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.method === "GET" ? undefined : Buffer.concat(chunks),
  });
  res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "text/plain" });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}).listen(port, "127.0.0.1");

createServer((req, res) => {
  if (req.url === "/count" && req.method === "DELETE") count = 0;
  if (req.url === "/down") down = req.method === "POST";
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ count, down }));
}).listen(counterPort, "127.0.0.1");
