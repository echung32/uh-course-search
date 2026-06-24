/**
 * Node ESM hook: intercepts `cloudflare:workers` and returns a stub
 * exporting an empty `env` object. This lets Playwright's test-runner process
 * (which runs in Node, not Wrangler) import modules that transitively depend on
 * `cloudflare:workers` (e.g. src/lib/db/binding.ts) without crashing.
 *
 * Used as an ESM loader hook (not a regular --import file). Registered via
 * the `register()` call in cloudflare-workers-register.mjs, which is in turn
 * loaded via NODE_OPTIONS="--import ./e2e/cloudflare-workers-register.mjs".
 */
export function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      shortCircuit: true,
      url: "node:cloudflare-stub",
    };
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url === "node:cloudflare-stub") {
    return {
      shortCircuit: true,
      format: "module",
      source: "export const env = {};",
    };
  }
  return nextLoad(url, context);
}
