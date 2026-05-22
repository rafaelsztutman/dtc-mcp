# dtc-mcp-docs (template for the docs side-repo)

This folder is a **template** for the separate `rafaelsztutman/dtc-mcp-docs` GitHub repository that serves the docs index for [dtc-mcp](https://github.com/rafaelsztutman/dtc-mcp) v1.0+ over jsDelivr.

## Why a separate repo?

The dtc-mcp MCP server doesn't need a new npm release every time Klaviyo or Shopify ships an API change. Instead, the docs are regenerated daily by a GitHub Action and served from a CDN. The MCP fetches them in the background on boot and writes them to `~/.cache/dtc-mcp/docs.json`.

## Setup (one-time)

1. Create `rafaelsztutman/dtc-mcp-docs` on GitHub.
2. Copy this folder's contents into the new repo's root.
3. Add the following **repository secrets** (Settings → Secrets and variables → Actions):
   - `SHOPIFY_STORE` — a dev store you control (e.g. `dtc-mcp-dev.myshopify.com`)
   - `SHOPIFY_ACCESS_TOKEN` — admin API token for that store (Shopify schema introspection requires auth)
4. Push to `main`. The Action runs immediately and again every day at 06:00 UTC.

## Served URL

After the first successful run, the docs are available at:

```
https://cdn.jsdelivr.net/gh/rafaelsztutman/dtc-mcp-docs@latest/docs.json
```

The MCP fetches this by default. Override via `DTC_MCP_DOCS_URL`.

## Files

- `.github/workflows/refresh.yml` — daily cron that runs the codegen and commits `docs.json` when it changes
- `docs.json` — committed artifact (overwritten by the workflow)
- `README.md` — this file (for visitors)
