# dtc-mcp v1.0

**Stainless-style two-tool MCP for DTC e-commerce.** The LLM writes TypeScript against typed Klaviyo + Shopify SDKs in an isolated V8 sandbox — instead of picking from a long menu of pre-built tools.

> v1.0 is a complete rewrite of [v0.2](https://github.com/rafaelsztutman/dtc-mcp/tree/v0.2). The 22 hand-built analytics tools are gone; in their place are two tools that compose to anything those 22 could do — and arbitrary new analyses besides. See **Migration from v0.2** below.

Inspired by [Stainless's code-execution MCP architecture](https://www.stainless.com/docs/mcp/) and [Cloudflare's Code Mode](https://blog.cloudflare.com/code-mode-mcp/), which both report ~99% input-token reduction vs traditional one-tool-per-endpoint MCPs.

## The two tools

### `execute_code`
Runs JavaScript (TypeScript syntax supported, stripped via [sucrase](https://github.com/alangpierce/sucrase)) inside a fresh [isolated-vm](https://github.com/laverdet/isolated-vm) V8 isolate. Globals exposed:

- `klaviyo` — typed client wrapping the Klaviyo REST API (`get`, `post`, `paginate`, plus `campaigns`, `flows`, `lists`, `segments`, `profiles`, `events`, `metrics`, `reporting.{campaignValues,flowValues}`)
- `shopify` — typed client for Shopify Admin GraphQL + ShopifyQL (`gql`, `ql`, `timezone`)
- `console.{log,error,warn,info}` — captured and returned to the caller as `stdout`

The host applies rate limiting, auth, and caching transparently — Klaviyo's dual-tier limiter (1/s reporting, 10/s standard), Shopify's GraphQL cost budget, and a 10-min reporting POST cache all carry over from v0.2's battle-tested implementations.

Defaults: 30s wall-clock, 128MB heap. Opt-in `// @timeout 2m` (max 5m).

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

## Architecture

```
┌─ dtc-mcp v1.0 (stdio MCP server) ──────────────────────┐
│                                                         │
│  execute_code ──→ isolated-vm V8 isolate                │
│                   ├ klaviyo proxy ──┐                   │
│                   ├ shopify proxy ──┼→ host bridge      │
│                   └ console capture │                   │
│                                     ▼                   │
│                              ┌─ host SDK ─────────┐     │
│                              │ - Klaviyo rate     │     │
│                              │   limiter + cache  │     │
│                              │ - Shopify token    │     │
│                              │   mgr + cost track │     │
│                              └────────────────────┘     │
│                                     │                   │
│  search_docs ──→ MiniSearch ◄───────┘  HTTP             │
│                  in-memory          (Klaviyo, Shopify)  │
│                  index of docs.json                     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

The sandbox has **no `fetch`, no `process`, no filesystem, no env**. The only way out is the host bridge, which validates every call against a method registry — unknown paths are rejected.

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
