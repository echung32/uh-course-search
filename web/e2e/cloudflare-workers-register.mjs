/**
 * Preloader for Playwright test-runner workers: registers a `cloudflare:workers`
 * stub so that test files can import modules that transitively depend on
 * `cloudflare:workers` (e.g. src/lib/db/binding.ts) without crashing with
 * "Received protocol 'cloudflare:'".
 *
 * Loaded via NODE_OPTIONS="--import ./e2e/cloudflare-workers-register.mjs"
 * in playwright.config.ts. The actual hook logic lives in cloudflare-workers-shim.mjs.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

register(
  pathToFileURL(resolve(__dirname, "cloudflare-workers-shim.mjs")).href,
  pathToFileURL(__dirname + "/")
);
