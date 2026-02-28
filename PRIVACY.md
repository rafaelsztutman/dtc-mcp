# Privacy Policy

**Last updated:** February 28, 2026

## Overview

dtc-mcp is an open-source MCP server that runs locally on your machine. It connects Claude (or any MCP client) to your Klaviyo and Shopify accounts using API credentials you provide.

## Data Collection

dtc-mcp does **not** collect, store, transmit, or share any user data. Specifically:

- **No analytics or telemetry.** dtc-mcp does not phone home, track usage, or send data to any third party.
- **No data storage beyond caching.** API responses are cached in-memory for performance (up to 10 minutes for Klaviyo reporting data). Caches are cleared when the process exits. Nothing is written to disk.
- **No remote servers.** dtc-mcp runs entirely on your local machine as a stdio-based MCP server.

## API Credentials

- Your Klaviyo API key, Shopify access token, and other credentials are stored locally in your MCP client configuration (e.g., Claude Desktop's `claude_desktop_config.json`).
- Credentials are only used to authenticate requests directly to the Klaviyo and Shopify APIs.
- Credentials are never transmitted to any server other than Klaviyo (`a.klaviyo.com`) and Shopify (`*.myshopify.com`).

## Data Flow

All data flows directly between your machine and the respective APIs:

```
Your Machine (dtc-mcp) <---> Klaviyo API (a.klaviyo.com)
Your Machine (dtc-mcp) <---> Shopify API (*.myshopify.com)
```

No intermediate servers, proxies, or third-party services are involved.

## Third-Party APIs

dtc-mcp interacts with:

- **Klaviyo API** — governed by [Klaviyo's Privacy Policy](https://www.klaviyo.com/legal/privacy)
- **Shopify API** — governed by [Shopify's Privacy Policy](https://www.shopify.com/legal/privacy)

Your use of these APIs is subject to your existing agreements with Klaviyo and Shopify.

## Open Source

dtc-mcp is fully open source under the MIT license. You can audit the complete source code at [github.com/rafaelsztutman/dtc-mcp](https://github.com/rafaelsztutman/dtc-mcp).

## Contact

For privacy questions or concerns, open an issue on [GitHub](https://github.com/rafaelsztutman/dtc-mcp/issues).
