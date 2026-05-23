# dtc-mcp

**A code-execution MCP server for Klaviyo + Shopify analytics.**

Three tools. Typed SDKs. A V8 sandbox that keeps state across calls so iterative analyses don't re-fetch. Works inside Claude Desktop, Cursor, or any MCP client.

```
LLM asks → execute_code → V8 sandbox ─→ host bridge ─→ Klaviyo / Shopify
                              ↑                             ↓
                         globalThis state            rate limit + cache
                         persists across calls
```

```bash
npm install -g dtc-mcp
```

Or get the one-click [Claude Desktop extension](#install).

---

## The three tools

### `execute_code(code)`

Runs JavaScript (TypeScript syntax accepted — type annotations are stripped before execution) inside a constrained V8 sandbox. The sandbox exposes typed Klaviyo and Shopify clients; the host handles auth, rate limiting, and caching invisibly.

**Globals available inside the sandbox:**

| | |
|---|---|
| `klaviyo` | `get`, `post`, `paginate`, plus typed namespaces: `campaigns`, `flows`, `lists`, `segments`, `profiles`, `events`, `metrics`, and `reporting.{campaignValues,flowValues}` |
| `shopify` | `gql`, `ql` (ShopifyQL), `timezone` |
| `console` | `log` / `error` / `warn` / `info` — captured and returned as `stdout` |
| `pick(v, schema)` | Deep projection over objects / arrays |
| `topN(arr, n, by)` | Top-N by numeric key, descending |
| `summarize(arr, opts)` | Auto-aggregate (count, total, min/max/avg, optional topN) |
| `globalThis.*` | Assignments persist across `execute_code` calls within the same MCP session |

**Not exposed:** `fetch`, `process`, `require`, `import`, `setTimeout`, the filesystem, or any env var. The only path out of the sandbox is the typed SDK methods, which route through the host's rate limiter and cache.

Defaults: 30s wall-clock per call, 128 MB heap (sidecar), 256 MB total per session. Opt-in `// @timeout 2m` at the top of the code extends the wall-clock up to 5 min.

### `search_docs(query, platform?, limit?)`

Full-text BM25 search over the bundled SDK reference. Returns ranked markdown chunks with signatures and runnable examples. Use this when you're discovering methods by intent ("how do I list flows with their actions?").

### `read_doc(path?, platform?)`

Direct fetch of a chunk by exact path, or a full listing when called with no args. Cheaper than `search_docs` once the LLM knows what it wants. Calling `read_doc({})` once at the start of a session is the recommended way to map the whole SDK surface in one shot.

```js
read_doc({})                                            // list all 332 paths
read_doc({ path: "klaviyo.reporting.campaignValues" })  // one chunk verbatim
read_doc({ platform: "shopify" })                       // Shopify only
```

---

## Architecture

The sandbox runs in one of two modes, chosen automatically at startup.

### Preferred: sidecar with isolated-vm

```
┌─ Claude Desktop (Electron, hardened runtime) ────────────────┐
│                                                               │
│  MCP server (Electron's bundled Node)                         │
│   ├ execute_code      proxies to ↓                            │
│   ├ search_docs       MiniSearch BM25 over data/docs.json     │
│   ├ read_doc          direct fetch by chunk ID                │
│   ├ host SDK          Klaviyo + Shopify (rate limit / cache)  │
│   └ sidecar manager   spawn / lifecycle / NDJSON over stdio   │
│                                                               │
└─────────────────────────────│─────────────────────────────────┘
                              │ newline-delimited JSON-RPC
┌─ Sidecar process (system Node, outside Electron) ────────────┐
│                                                               │
│  isolated-vm loads here (no Library Validation restriction)   │
│                                                               │
│  One long-lived V8 isolate per MCP connection:                │
│   • 256 MB heap, 30 min idle TTL                              │
│   • klaviyo/shopify/pick/topN/summarize injected once         │
│   • globalThis state preserved across execute_code calls      │
│   • host-bridge calls round-trip back to the main process     │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**Why a sidecar:** Claude Desktop is an Electron app with macOS hardened runtime + Library Validation. Native modules loaded into the Claude Desktop process must share Anthropic's Team ID — which we can't sign with. Spawning the user's `/usr/local/bin/node` as a child process sidesteps the restriction; the child has its own hardened-runtime status, so `isolated-vm` loads cleanly.

Node discovery walks: `DTC_MCP_NODE_PATH` env var → `which node` / `where node` → Homebrew (Intel + Apple Silicon) → standard system paths → nvm → Volta → fnm → asdf. Requires Node ≥ 20.

### Fallback: in-process `node:vm`

If no system Node ≥ 20 is found, or the sidecar fails to start, the server falls back to a `node:vm` runner in the main process. Sandbox surface is identical (same `globalThis`, same helpers, same state semantics), but isolation is weaker — `node:vm` is a mistake fence, not a security boundary, and can be escaped via prototype-chain tricks. Acceptable because the threat model is "the user's own LLM might write buggy code," not "an attacker is trying to escape."

Every `execute_code` result includes `"sandbox": "sidecar"` or `"sandbox": "vm"` so you (and the LLM) can see which mode ran.

### Stateful sessions

A single sandbox context lives for the lifetime of the MCP connection. `globalThis.x = ...` in one `execute_code` call is visible in every later call. `const`/`let` declared at the top of a script are scoped to that call only — use `globalThis` for anything you want to carry forward.

The context is recreated on: connection close, 30 min idle, isolate OOM, or first call after a long gap. When that happens the next result includes `"sessionReset": true` so the LLM knows prior state is gone.

### Output discipline

Klaviyo and Shopify endpoints return verbose JSON. The host caps any `execute_code` return value at 100 KB (configurable via `DTC_MCP_MAX_RESPONSE_KB`); oversized returns are replaced with `{ truncated: true, preview, instructions }`. The sandbox-side `pick` / `topN` / `summarize` helpers exist so the LLM can stay under the cap by design — see the `guide.output-discipline` doc chunk for examples.

### Docs delivery

`search_docs` and `read_doc` query an in-memory MiniSearch index built from `data/docs.json`. The bundled copy ships with ~330 chunks (hand-authored guides + recipes + auto-generated reference for every Klaviyo OpenAPI endpoint). A background fetch on startup pulls a fresher copy from `https://cdn.jsdelivr.net/gh/rafaelsztutman/dtc-mcp-docs@latest/docs.json` (ETag-cached at `~/.cache/dtc-mcp/docs.json`), so new API endpoints land without a new MCP release. Set `DTC_MCP_DOCS_REFRESH=0` for fully offline use.

---

## Install

### Option A — Claude Desktop one-click

1. Download `dtc-mcp.mcpb` from the latest [GitHub release](https://github.com/rafaelsztutman/dtc-mcp/releases).
2. Double-click the file. Claude Desktop opens an install dialog.
3. Paste your Klaviyo API key (required) and Shopify credentials (optional).
4. Restart Claude Desktop. Three tools appear in the hammer menu: `execute_code`, `search_docs`, `read_doc`.

### Option B — manual config (`claude_desktop_config.json`, Cursor, etc.)

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

Klaviyo-only mode: omit the `SHOPIFY_*` variables. `shopify.*` calls throw a configuration error; `klaviyo.*` calls work normally.

### Option C — npm global install

```bash
npm install -g dtc-mcp
dtc-mcp           # runs the MCP server on stdio
```

---

## Getting credentials

### Klaviyo

1. Log into Klaviyo. **Settings → Account → API Keys** (left sidebar).
2. **Create Private API Key**. Name it `dtc-mcp`.
3. Grant read-only scopes: `campaigns:read`, `flows:read`, `lists:read`, `segments:read`, `profiles:read`, `metrics:read`, `events:read`.
4. Copy the `pk_...` key.

### Shopify

Two auth modes. Use whichever matches your app type.

**Dev Dashboard app (recommended, required for apps created after Jan 2026):**

1. Open your app in the [Shopify Partners Dashboard](https://partners.shopify.com).
2. **Configuration → Client credentials.** Copy the Client ID and Client Secret.
3. Required scopes: `read_orders`, `read_products`, `read_customers`, `read_inventory`, `read_reports`.

Env vars:

```
SHOPIFY_STORE=your-store.myshopify.com
SHOPIFY_CLIENT_ID=your_client_id
SHOPIFY_CLIENT_SECRET=shpss_your_secret
```

**Legacy custom app (apps created before Jan 2026):**

1. Shopify Admin → **Settings → Apps and sales channels → Develop apps**, open your app.
2. **API credentials** → copy the Admin API access token (`shpat_...`).

Env vars:

```
SHOPIFY_STORE=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_your_token_here
```

Do not set both auth modes at once; the server logs a warning and uses Client Credentials if both are present.

---

## Environment

| Variable | Required | Description |
|---|---|---|
| `KLAVIYO_API_KEY` | Yes | Klaviyo private API key (`pk_...`) |
| `SHOPIFY_STORE` | For Shopify | `*.myshopify.com` domain |
| `SHOPIFY_CLIENT_ID` | Dev Dashboard auth | App Client ID |
| `SHOPIFY_CLIENT_SECRET` | Dev Dashboard auth | App Client Secret (`shpss_...`) |
| `SHOPIFY_ACCESS_TOKEN` | Legacy custom app | Admin API token (`shpat_...`) |
| `SHOPIFY_API_VERSION` | No | Default `2026-01` |
| `KLAVIYO_CONVERSION_METRIC_ID` | No | Override auto-discovered "Placed Order" metric ID |
| `DTC_MCP_SANDBOX` | No | `auto` (default) \| `sidecar` (require isolated-vm) \| `vm` (force `node:vm`) |
| `DTC_MCP_NODE_PATH` | No | Absolute path to the Node binary used by the sidecar. Skips discovery. |
| `DTC_MCP_MAX_RESPONSE_KB` | No | Cap on bytes of `execute_code` return values (default `100`). |
| `DTC_MCP_DOCS_URL` | No | Override docs source. Default: jsDelivr → `dtc-mcp-docs@latest`. |
| `DTC_MCP_DOCS_REFRESH` | No | Set to `0` to disable the background docs refresh (offline mode). |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` (default `info`) |

---

## Development

```bash
npm install        # installs deps, builds isolated-vm via node-gyp
npm run build      # tsc → dist/
npm run dev        # tsc --watch
npm test           # vitest (53 tests)
npm run inspect    # MCP Inspector — connect any client to dist/index.js
```

### Building the .mcpb bundle

```bash
tools/build-mcpb.sh           # → dtc-mcp-v<version>.mcpb in repo root
```

Stages prod-only dependencies, ad-hoc code-signs native `.node` binaries (macOS requirement), and zips into a `.mcpb` ready for one-click install.

### Regenerating bundled docs

```bash
npm run codegen:klaviyo   # download Klaviyo OpenAPI, emit chunk JSON
npm run codegen:shopify   # introspect Shopify GraphQL (needs SHOPIFY_* env), emit chunks
npm run codegen:docs      # merge guides + chunks into data/docs.json
```

In production this runs daily on a GitHub Action in [dtc-mcp-docs](https://github.com/rafaelsztutman/dtc-mcp-docs); the MCP fetches the freshest copy on the next boot.

---

## License

MIT. See `LICENSE`.
