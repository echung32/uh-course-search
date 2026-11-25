// Entry point for the home SQL gateway (`yarn gateway`). Config from env:
//   GATEWAY_SECRET           (required) bearer secret the Worker sends
//   SEARCH_D1_LOCAL_FILE     (required) path to search.sqlite
//   ANALYTICS_D1_LOCAL_FILE  (required) path to analytics.sqlite
//   GATEWAY_PORT             (default 8787)
//   GATEWAY_HOST             (default 127.0.0.1; 0.0.0.0 inside Docker)
import { createGatewayServer } from "./server";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const secret = required("GATEWAY_SECRET");
const files = {
  search: required("SEARCH_D1_LOCAL_FILE"),
  analytics: required("ANALYTICS_D1_LOCAL_FILE"),
};
const port = Number(process.env.GATEWAY_PORT ?? 8787);
const host = process.env.GATEWAY_HOST ?? "127.0.0.1";

const server = createGatewayServer({ secret, files, log: (l) => console.log(l) });
server.listen(port, host, () => console.log(`[gateway] listening on http://${host}:${port}`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
