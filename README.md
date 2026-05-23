# dtc-mcp v1.5

**Code-execution MCP for DTC e-commerce. Three architectural moves beyond Stainless.**

The LLM writes TypeScript against typed Klaviyo + Shopify SDKs in a sandbox — instead of picking from a long menu of pre-built tools. v1.5 takes the Stainless / Cloudflare / Anthropic "code execution + docs search" pattern and adds three things none of them ship:

1. **Stateful sandbox sessions.** Variables on `globalThis` persist across `execute_code` calls within the same MCP connection. Stainless's Cloudflare-Workers sandbox is stateless per call; ours isn't. Iterative DTC analyses don't re-fetch.
2. **Code-as-docs via `read_doc`.** Adopts Anthropic's [filesystem-as-API pattern](https://www.anthropic.com/engineering/code-execution-with-mcp) — direct chunk fetch by exact path, cheaper than re-searching when the LLM already knows what it wants.
3. **Output projection contracts.** In-sandbox `pick` / `topN` / `summarize` helpers + a host-side 100 KB response cap. Directly attacks the published 53% factuality ceiling of code-mode MCP (models over-return; we give them the vocabulary to be disciplined AND enforce a ceiling).

Plus everything v1.0 already had: hybrid sidecar runner that works inside Claude Desktop's Electron hardened-runtime, `node:vm` fallback when no system Node is available, self-hosted auto-updating docs via jsDelivr CDN.

> v1.5 is a complete rewrite of [v0.2](https://github.com/rafaelsztutman/dtc-mcp/tree/v0.2). The 22 hand-built analytics tools are gone; in their place are three composable primitives. See **Migration from v0.2** below.

Inspired by [Stainless's SDK Code Mode](https://www.stainless.com/blog/sdk-code-mode), [Cloudflare's Code Mode](https://blog.cloudflare.com/code-mode-mcp/), and Anthropic's [Code Execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) — extended where the literature shows soft spots.

## The three tools

### `execute_code`
Runs JavaScript (TypeScript syntax supported, stripped via [sucrase](https://github.com/alangpierce/sucrase)) inside a **hybrid sandbox**:

- **Preferred runner — sidecar [isolated-vm](https://github.com/laverdet/isolated-vm)**: a fresh V8 isolate per call (separate heap, 128 MB hard limit, hard timeout). The sidecar is a child Node process spawned at MCP server startup from the user's system Node binary. This indirection exists because Claude Desktop is Electron + macOS hardened runtime + Library Validation, which refuses to dlopen native modules whose code signature doesn't share Anthropic's Team ID. See **Sandbox architecture** below.
- **Fallback runner — `node:vm`**: in-process sandbox. Activates automatically when no system Node ≥ 20 is found, or when the sidecar crashes. Weaker isolation but no extra requirements. Each result includes a `sandbox` field so the LLM (and you) can see which mode ran.

Globals exposed in both modes:
- `klaviyo` — typed client wrapping the Klaviyo REST API (`get`, `post`, `paginate`, plus `campaigns`, `flows`, `lists`, `segments`, `profiles`, `events`, `metrics`, `reporting.{campaignValues,flowValues}`)
- `shopify` — typed client for Shopify Admin GraphQL + ShopifyQL (`gql`, `ql`, `timezone`)
- `console.{log,error,warn,info}` — captured and returned to the caller as `stdout`
- `pick(value, schema)` / `topN(arr, n, by)` / `summarize(arr, opts)` — output-discipline helpers. Use these to project / aggregate raw API responses before returning. See `guide.output-discipline`.
- `globalThis.*` — assignments persist across calls within the same MCP connection. See `guide.stateful-sessions`.

The host applies rate limiting, auth, and caching transparently — Klaviyo's dual-tier limiter (1/s reporting, 10/s standard), Shopify's GraphQL cost budget, and a 10-min reporting POST cache all carry over from v0.2's battle-tested implementations.

Defaults: 30s wall-clock, 128 MB heap (sidecar only). Opt-in `// @timeout 2m` (max 5m).

```js
// Top 5 email campaigns by revenue, last 30 days, with names hydrated.
const metricId = await klaviyo.getConversionMetricId();
const report = await klaviyo.reporting.campaignValues({
  data: { type: "campaign-values-report", attributes: {
    timeframe: { key: "last_30_days" },
    conversion_metric_id: metricId,
    statistics: ["recipients", "open_rate", "conversion_value"],
  }}
});
const top = report.data.attributes.results
  .sort((a, b) => b.statistics.conversion_value - a.statistics.conversion_value)
  .slice(0, 5);
for (const r of top) {
  const { data } = await klaviyo.campaigns.get(r.groupings.campaign_id, { "fields[campaign]": "name" });
  r.name = data.attributes.name;
}
return top;
```

### `search_docs`
Searches the bundled SDK reference (MiniSearch / BM25) for method signatures, parameter docs, and runnable recipes. Use this **before** writing code in `execute_code` — it tells the LLM exactly which methods are exposed and how to call them.

Docs are auto-refreshed daily from [dtc-mcp-docs](https://github.com/rafaelsztutman/dtc-mcp-docs) via jsDelivr CDN (with ETag negotiation). New Klaviyo / Shopify API revisions land without a new MCP release.

### `read_doc`
Fetches a specific docs chunk by exact path, or lists all available paths when called with no args. Use after `search_docs` to fetch one chunk's full content without paying the search round-trip — or call `read_doc({})` at session start to map out the entire SDK surface in one go.

```js
read_doc({ path: "klaviyo.reporting.campaignValues" })  // single chunk
read_doc({ platform: "shopify" })                       // list Shopify paths
read_doc({})                                            // list all 332 paths
```

## Sandbox architecture

The preferred sandbox runs `isolated-vm` in a sidecar process. Why a sidecar:

> Claude Desktop is an Electron app whose main binary is signed with hardened
> runtime + macOS Library Validation. Native modules loaded into Claude
> Desktop must share Anthropic's Team ID. We can't sign `isolated-vm` with
> Anthropic's cert, and ad-hoc signing has no Team ID — so the native module
> is refused at `dlopen`. A child process spawned from the user's system
> `node` binary has its own (unrestricted) hardened-runtime status, so
> isolated-vm loads cleanly there.

```
┌─ Claude Desktop (Electron, hardened runtime) ────────────────┐
│                                                               │
│  Main MCP server (Electron's bundled Node)                    │
│  ├ search_docs       MiniSearch BM25 over data/docs.json      │
│  ├ execute_code      proxies to ↓                             │
│  ├ host SDK          Klaviyo + Shopify clients (rate limit,   │
│  │                   auth, cache — same code as v0.2)         │
│  └ sidecar manager   spawn / lifecycle / NDJSON over stdio    │
│                                                               │
└─────────────────────────────│─────────────────────────────────┘
                              │ newline-delimited JSON-RPC
┌─ Sidecar (system /usr/local/bin/node — outside Electron) ────┐
│                                                               │
│  isolated-vm loads (no Library Validation here)               │
│                                                               │
│  Per execute request:                                         │
│  ┌─ Fresh V8 isolate ───────────────────────────────────┐    │
│  │ • 128 MB heap limit, hard wall-clock timeout         │    │
│  │ • No fetch / process / require / fs / env / globals  │    │
│  │ • klaviyo + shopify proxies → __host_invoke ────────╮│    │
│  │ • console capture → stdout                          ││    │
│  └─────────────────────────────────────────────────────╯│    │
│                                                          │    │
└──────────────────────────────────────────────────────────│────┘
                                                           │
                                          (host-call round-trip
                                           back to main MCP for
                                           the actual HTTP call,
                                           rate-limited there)
```

If discovery fails (no Node ≥ 20 on the system) or the sidecar crashes, `execute_code` automatically falls back to an in-process `node:vm` runner with documented threat-model caveats (mistake fence, not a security boundary). The tool result includes a `sandbox: "sidecar"` or `sandbox: "vm"` field so the LLM (and you) can see which mode ran.

Node discovery checks (in order): `DTC_MCP_NODE_PATH` env var → `which node` / `where node` → Homebrew (both archs) → standard system paths → nvm → Volta → fnm → asdf. Set `DTC_MCP_SANDBOX=vm` to force the in-process fallback, or `DTC_MCP_SANDBOX=sidecar` to require the sidecar.

## Quick start

```bash
npm install -g dtc-mcp
```

Or via `npx`:

```bash
npx dtc-mcp
```

### Claude Desktop (Desktop Extension)

1. Download the latest `dtc-mcp.mcpb` from [Releases](https://github.com/rafaelsztutman/dtc-mcp/releases)
2. Double-click to install — Claude Desktop opens an install dialog
3. Paste your Klaviyo key (required) and Shopify creds (optional)
4. The two tools (`execute_code`, `search_docs`) appear in the hammer menu

### Claude Desktop (manual config)

```json
{
  "mcpServers": {
    "dtc-mcp": {
      "command": "npx",
      "args": ["-y", "dtc-mcp"],
      "env": {
        "KLAVIYO_API_KEY": "pk_your_private_key_here",
        "SHOPIFY_STORE": "your-store.myshopify.com",
        "SHOPIFY_CLIENT_ID": "your_client_id",
        "SHOPIFY_CLIENT_SECRET": "shpss_your_secret"
      }
    }
  }
}
```

Klaviyo-only mode: omit the `SHOPIFY_*` variables. `shopify.*` calls in the sandbox will throw a configuration error; `klaviyo.*` calls work normally.

## Environment

| Variable | Required | Description |
|---|---|---|
| `KLAVIYO_API_KEY` | Yes | Klaviyo private API key (`pk_...`) |
| `SHOPIFY_STORE` | For Shopify | `*.myshopify.com` domain |
| `SHOPIFY_CLIENT_ID` | For Shopify (Dev Dashboard) | App Client ID |
| `SHOPIFY_CLIENT_SECRET` | For Shopify (Dev Dashboard) | App Client Secret (`shpss_...`) |
| `SHOPIFY_ACCESS_TOKEN` | For Shopify (legacy) | Admin API token (`shpat_...`) |
| `SHOPIFY_API_VERSION` | No | Default `2026-01` |
| `KLAVIYO_CONVERSION_METRIC_ID` | No | Override auto-discovered "Placed Order" metric ID |
| `DTC_MCP_DOCS_URL` | No | Override docs source (default: jsDelivr → `dtc-mcp-docs@latest`) |
| `DTC_MCP_DOCS_REFRESH` | No | Set to `0` to disable the background docs refresh (offline mode) |
| `DTC_MCP_SANDBOX` | No | `auto` (default) \| `sidecar` (require isolated-vm) \| `vm` (force `node:vm`) |
| `DTC_MCP_NODE_PATH` | No | Absolute path to the Node binary used by the sidecar. Skips discovery. |
| `DTC_MCP_MAX_RESPONSE_KB` | No | Cap on bytes of `execute_code` return values (default `100`). |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` (default `info`) |

## Migration from v0.2

Every v0.2 tool is now one `execute_code` call. The `search_docs` index ships with recipes for the most common ones:

| v0.2 tool | v1.0 recipe |
|---|---|
| `klaviyo_campaign_summary` | `guide.recipe.top-campaigns` — paginate `klaviyo.reporting.campaignValues`, sort, hydrate names |
| `klaviyo_flow_summary` | `klaviyo.reporting.flowValues` (cached) + `klaviyo.flows.get` |
| `klaviyo_subscriber_health` | `klaviyo.lists.list` + `klaviyo.segments.list` + your own engagement bucketing |
| `shopify_sales_summary` | `shopify.ql('FROM sales SHOW gross_sales, net_sales, orders SINCE -30d UNTIL today')` |
| `shopify_sales_timeseries` | Same ShopifyQL with `GROUP BY day` |
| `shopify_customer_cohorts` | `shopify.gql` for `customers` + your bucketing logic |
| `dtc_dashboard` | `guide.recipe.dashboard` — `Promise.all` of Klaviyo reporting + Shopify ShopifyQL |
| `dtc_email_revenue_attribution` | Subset of `guide.recipe.dashboard` |

Run `search_docs({ query: "<your old tool name>" })` inside Claude to find the corresponding recipe.

## Token budget

Tool-list payload (what every client loads on connect):

| | v0.2 | v1.0 |
|---|---|---|
| Tools | 22 | 2 |
| `tools/list` JSON size | ~12KB | ~1.5KB |
| Per-conversation overhead | high (every tool's schema in context) | flat (~1KB) |

v1.0 trades fixed tool-list cost for variable per-call cost (the LLM writes code that runs in the sandbox). For repeated analytics in one conversation, savings compound — the sandbox is stateful per call but the host's caches (Klaviyo reporting cache, ShopifyQL cache) persist across calls.

## Development

```bash
npm install        # also builds isolated-vm via node-gyp (needs C++ toolchain)
npm run build      # tsc → dist/
npm run dev        # tsc --watch
npm test           # vitest
npm run inspect    # MCP Inspector — visual tool tester
```

### Regenerating docs / SDK types

The Klaviyo OpenAPI spec and Shopify GraphQL schema change periodically. To regenerate the bundled `data/docs.json` and the SDK types locally:

```bash
npm run codegen:klaviyo   # download Klaviyo OpenAPI → docs chunks
npm run codegen:shopify   # introspect Shopify GraphQL → docs chunks
npm run codegen:docs      # merge into data/docs.json
```

In production this runs daily on a GitHub Action in [dtc-mcp-docs](https://github.com/rafaelsztutman/dtc-mcp-docs); the MCP fetches the freshest copy on the next boot. Releasing a new MCP version is **not** required for new API methods to appear in `search_docs`.

## License

MIT. See `LICENSE`.
