// e2e harness: runs the production SQL gateway over the throwaway e2e D1 files
// so the whole Playwright suite exercises Worker → gateway → SQLite, the path
// production uses. Playwright starts webServers BEFORE globalSetup seeds the
// files, so they are resolved lazily on the first query (a failed resolution is
// retried on the next query).
//
// Also serves a test-only request counter on GATEWAY_COUNTER_PORT (kept out of
// the production server): GET /count → { count }, DELETE /count → reset. Specs
// use it to bound gateway round-trips per app request (each one is a Worker
// subrequest on the Free plan).
import { createServer } from "node:http";
import { createGatewayServer } from "../gateway/server";
import { findLocalD1File } from "./d1-helpers";

const port = Number(process.env.GATEWAY_PORT ?? 8788);
const counterPort = Number(process.env.GATEWAY_COUNTER_PORT ?? 8789);
const secret = process.env.GATEWAY_SECRET ?? "e2e-gateway-secret";

const gateway = createGatewayServer({
  secret,
  files: {
    search: () => findLocalD1File("course_section"),
    analytics: () => findLocalD1File("course_term_stats"),
  },
});

let count = 0;
gateway.on("request", (req) => {
  if (req.method === "POST" && req.url === "/v1/query") count++;
});
gateway.listen(port, "127.0.0.1");

createServer((req, res) => {
  if (req.url === "/count" && req.method === "DELETE") count = 0;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ count }));
}).listen(counterPort, "127.0.0.1");
