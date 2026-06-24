#!/usr/bin/env bash
# Wrapper for `yarn test` that prepends the cloudflare:workers shim to
# NODE_OPTIONS BEFORE Playwright starts. The shim must come first so it
# intercepts the `cloudflare:` protocol before Yarn's PnP loader rejects it.
SHIM="$(dirname "$0")/../e2e/cloudflare-workers-register.mjs"
SHIM_ABS="$(cd "$(dirname "$SHIM")" && pwd)/$(basename "$SHIM")"
export NODE_OPTIONS="--import $SHIM_ABS $NODE_OPTIONS"
exec playwright test "$@"
