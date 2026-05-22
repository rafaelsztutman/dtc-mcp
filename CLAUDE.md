# dtc-mcp v1.0 — Project conventions

## Build & test

```bash
npm install      # builds isolated-vm via node-gyp (needs C++ toolchain + Python)
npm run build    # tsc → dist/
npm test         # vitest
npm run dev      # tsc --watch
npm run inspect  # MCP Inspector
```

## Architecture (post-v1 rewrite)

dtc-mcp now exposes **exactly 2 MCP tools**: `execute_code` and `search_docs`. The 22 hand-built tools and per-tool transforms from v0.2 are gone.

```
src/
  index.ts              # bin entrypoint (stdio transport)
  server.ts             # creates the McpServer + registers the 2 tools
  config.ts             # lazy per-field env validation (KEEP this pattern)
  tools/
    execute_code.ts     # MCP tool: runs user code in the sandbox
    search_docs.ts      # MCP tool: searches the docs index
  sandbox/
    runner.ts           # isolated-vm bootstrap + sucrase TS strip
    bridge.ts           # host-side method registry — every SDK path lives here
    proxy-template.ts   # in-isolate JS that mirrors bridge as `klaviyo`/`shopify` globals
    timeout.ts          # `// @timeout` annotation parser
  sdk/
    klaviyo/host.ts     # host-side Klaviyo client: rate limiter + caches + metric ID discovery
    shopify/host.ts     # host-side Shopify client: token mgr + cost tracker + ql cache
  docs/
    loader.ts           # cache (~/.cache/dtc-mcp/docs.json) + ETag refresh from CDN
    search.ts           # MiniSearch index
  shared/
    cache.ts            # TTLCache + buildCacheKey
    errors.ts           # KlaviyoApiError, ShopifyApiError, ConfigError
data/
  docs.json             # bundled fallback docs index
tools/codegen/          # build-time spec → SDK types + docs.json
```

## Key invariants

1. **Sandbox has no escape hatches.** No `fetch`, `process`, `require`, `import`, `setTimeout`. Only `klaviyo`, `shopify`, `console`, plus standard JS globals (`Date`, `JSON`, `Math`, `Promise`, etc.).
2. **All API access goes through the host bridge** (`src/sandbox/bridge.ts`). To add a new SDK method, register it in the `handlers` map there. The proxy template auto-mirrors the registry as a namespace tree inside the isolate.
3. **Rate limiting and caching live on the host side** — never in the sandbox. The sandbox can't cache across calls (fresh isolate each invocation), so the host carries that state.
4. **Lazy per-field env validation** (`config.ts`). Never throw at module load — return empty strings + warn. Tools surface actionable errors when actually invoked. Critical for Claude Desktop where missing env vars shouldn't crash the server.
5. **TS support via sucrase**, not regex stripping. Sucrase is the smallest viable transpiler; do not roll our own.

## Klaviyo rate limits (critical)

- Standard endpoints (campaigns, flows, profiles, etc.): 10/s burst, 150/min steady
- **Reporting endpoints (campaign-values-reports, flow-values-reports): 1/s burst, 2/min steady, 225/day**
- Reporting cache TTL: 10 minutes (skip the API entirely for repeat queries)
- Conversion metric ID: cached for server lifetime via `getConversionMetricId()`

## Shopify

- Dual auth: Client Credentials Grant (Dev Dashboard apps, recommended) or static `shpat_` token (legacy). Auto-detected in `config.ts`.
- GraphQL cost budget (1000 capacity, restores 50/s): `CostTracker` in `src/sdk/shopify/host.ts` mirrors Shopify's bucket and pre-waits when low.
- ShopifyQL responses cached 5 minutes.

## Adding a new SDK method

1. Implement the host-side function in `src/sdk/<platform>/host.ts` (rate-limited, cached if appropriate).
2. Register it in `src/sandbox/bridge.ts` with a dotted path (e.g. `klaviyo.subscribers.find`).
3. Add a doc chunk in `data/docs.json` (or regenerate via `npm run codegen:docs` when that script lands).
4. Add a sandbox test if behavior is non-obvious.

## Testing

- Unit tests for the timeout parser, bridge registry, docs search index.
- Integration tests for the sandbox runner that compile and execute small scripts end-to-end (validating proxies, console capture, timeout enforcement, TS stripping).
- `process.env.DTC_MCP_DOCS_REFRESH = "0"` in tests to disable the background CDN fetch.
- No tests hit live Klaviyo/Shopify — the host SDK is mocked at the boundary.

## Logging

All logging to stderr (`console.error`) — stdout is the MCP transport. Use `log(level, message, data?)` from `config.ts`.
