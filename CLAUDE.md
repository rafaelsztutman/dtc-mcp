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
    execute_code.ts     # MCP tool: runs user code in the sandbox (stateful per MCP conn)
    search_docs.ts      # MCP tool: searches the docs index (BM25)
    read_doc.ts         # MCP tool: direct fetch by chunk ID, or list all paths
  sandbox/
    runner.ts           # public entry — routes between sidecar and vm
    vm-runner.ts        # node:vm in-process fallback
    sidecar-runner.ts   # manages the sidecar child process lifecycle
    sidecar/index.ts    # sidecar entrypoint — spawned in system Node, loads isolated-vm
    protocol.ts         # NDJSON message shapes shared between main and sidecar
    node-discovery.ts   # finds system Node ≥ 20 across PATH/Homebrew/nvm/volta/fnm/asdf
    bridge.ts           # host-side method registry — every SDK path lives here
    proxy-template.ts   # in-isolate JS for node:vm (sidecar has its own embedded version)
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

1. **Sandbox has no escape hatches.** No `fetch`, `process`, `require`, `import`, `setTimeout`. Only `klaviyo`, `shopify`, `console`, `pick`, `topN`, `summarize`, plus standard JS globals (`Date`, `JSON`, `Math`, `Promise`, etc.).
1a. **Sandbox is stateful per MCP connection.** Both runners keep one context alive across `execute_code` calls until the connection closes (or 30 min idle TTL fires or 256 MB heap cap blows). LLM code shares data across calls via `globalThis.*`. When a reset happens, the next result includes `sessionReset: true`.
1b. **Response payload cap.** The runner caps `execute_code` return values at `DTC_MCP_MAX_RESPONSE_KB` (default 100). Oversized returns are replaced with `{truncated: true, preview, instructions: ...}`. LLM should use `pick`/`topN`/`summarize` to stay under the cap.
2. **All API access goes through the host bridge** (`src/sandbox/bridge.ts`). To add a new SDK method, register it in the `handlers` map there. Both runners mirror the registry as a namespace tree.
3. **Rate limiting and caching live on the host side** — never in the sandbox. Fresh isolate per invocation (sidecar) means no cross-call state. The main MCP server carries it.
4. **isolated-vm cannot load directly in Claude Desktop** because of macOS Library Validation. It MUST be loaded by a spawned system Node process — the sidecar. Don't move the `isolated-vm` import into the main process.
5. **The main MCP server (Electron Node) does NOT import isolated-vm.** Only `src/sandbox/sidecar/index.ts` does, and it's loaded only when system Node spawns it. Keep this isolation — if isolated-vm appears in `dist/server.js` or `dist/index.js`'s closure graph, Electron will fail to load the bundle.
6. **Lazy per-field env validation** (`config.ts`). Never throw at module load — return empty strings + warn. Tools surface actionable errors when actually invoked. Critical for Claude Desktop where missing env vars shouldn't crash the server.
7. **TS support via sucrase**, not regex stripping. Sucrase is the smallest viable transpiler; do not roll our own.

## Why the sidecar exists

Claude Desktop is built on Electron with macOS hardened runtime + Library Validation. The host process can only load native modules signed with Anthropic's Team ID. We can't sign with their cert, and ad-hoc signatures have no Team ID. Workaround: spawn a separate Node process from the user's system `node` binary. The child process has its own (unrestricted) hardened-runtime status, so isolated-vm loads freely there. Main MCP server and sidecar talk via newline-delimited JSON-RPC over stdio, with bidirectional message correlation so the in-isolate proxy can round-trip host bridge calls back to the main process where the rate-limited Klaviyo/Shopify clients live.

If a user doesn't have Node ≥ 20 installed, discovery fails and the runner falls back to in-process `node:vm` (weaker isolation, but works for everyone). The active mode is in every tool result as `sandbox: "sidecar" | "vm"`.

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
