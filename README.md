# dtc-mcp

Context-optimized MCP server for DTC e-commerce brands. Connect Claude (or any MCP client) to your Klaviyo and Shopify data with 16 pre-built analytics tools.

Unlike raw API wrappers, dtc-mcp pre-aggregates data server-side and returns only actionable fields — using ~80% less context than dumping raw API responses into your conversation.

## Features

- **8 Klaviyo tools** — campaign performance, flow breakdowns, subscriber health, profile search, event activity
- **7 Shopify tools** — sales summaries, daily/weekly/monthly trends, product performance, inventory alerts, customer cohorts, order search
- **2 cross-platform tools** — email revenue attribution, full DTC health dashboard
- **Dual revenue metrics** — both gross and net revenue on every sales query
- **Smart fallbacks** — ShopifyQL when available, GraphQL pagination when not
- **Aggressive caching** — respects Klaviyo's strict rate limits (1 req/s on reporting)

## Quick Start

```bash
npm install -g dtc-mcp
```

Or run directly:

```bash
npx dtc-mcp
```

## Setup with Claude Desktop

1. Open Claude Desktop
2. Go to **Settings** (gear icon) > **Developer** > **Edit Config**
3. Add the following to your `claude_desktop_config.json`:

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

4. Restart Claude Desktop
5. Look for the hammer icon in the chat input — that confirms the MCP tools are loaded

### Klaviyo-only mode

If you only use Klaviyo (no Shopify), just omit the Shopify variables. The 8 Klaviyo tools and subscriber analytics will work standalone. Shopify tools will return a helpful "not configured" message.

## Setup with ChatGPT

ChatGPT supports MCP servers via remote connections. Since dtc-mcp uses stdio transport (runs locally), you would need an MCP-to-HTTP bridge to expose it as a remote server. See [OpenAI's MCP documentation](https://platform.openai.com/docs/guides/tools-remote-mcp) for details on connecting remote MCP servers.

## Getting Your API Credentials

### Klaviyo API Key

1. Log into [Klaviyo](https://www.klaviyo.com/login)
2. Go to **Settings** (bottom-left) > **Account** > **Settings**
3. Click **API Keys** in the left sidebar
4. Click **Create Private API Key**
5. Give it a name (e.g., "dtc-mcp")
6. Select **Read-only** access for these scopes:
   - `campaigns:read`
   - `flows:read`
   - `lists:read`
   - `segments:read`
   - `profiles:read`
   - `metrics:read`
   - `events:read`
7. Copy the key (starts with `pk_`)

### Shopify Credentials

There are two authentication methods. Use whichever matches your app type.

#### Option A: Dev Dashboard App (Recommended)

For apps created in the [Shopify Partners Dashboard](https://partners.shopify.com/) or Shopify CLI (required for new apps since January 2026):

1. Go to your app in the Partners Dashboard
2. Navigate to **Configuration** > **Client credentials**
3. Copy the **Client ID** and **Client Secret**
4. Your store URL is your `*.myshopify.com` domain

Set these environment variables:
```
SHOPIFY_STORE=your-store.myshopify.com
SHOPIFY_CLIENT_ID=your_client_id
SHOPIFY_CLIENT_SECRET=shpss_your_secret
```

**Required scopes:** `read_orders`, `read_products`, `read_customers`, `read_inventory`

#### Option B: Legacy Custom App

For custom apps created directly in Shopify Admin (apps created before January 2026):

1. Go to **Shopify Admin** > **Settings** > **Apps and sales channels**
2. Click **Develop apps** > select your app
3. Go to **API credentials** and copy the **Admin API access token**

Set these environment variables:
```
SHOPIFY_STORE=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_your_token_here
```

> Do not set both `SHOPIFY_ACCESS_TOKEN` and `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET` at the same time. The server will error if both are present.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KLAVIYO_API_KEY` | Yes | Klaviyo private API key (starts with `pk_`) |
| `SHOPIFY_STORE` | For Shopify | Your `*.myshopify.com` domain |
| `SHOPIFY_CLIENT_ID` | For Shopify (Dev Dashboard) | App client ID |
| `SHOPIFY_CLIENT_SECRET` | For Shopify (Dev Dashboard) | App client secret (starts with `shpss_`) |
| `SHOPIFY_ACCESS_TOKEN` | For Shopify (Legacy) | Admin API access token (starts with `shpat_`) |
| `SHOPIFY_API_VERSION` | No | Shopify API version (default: `2026-01`) |
| `KLAVIYO_CONVERSION_METRIC_ID` | No | Override auto-discovered "Placed Order" metric ID |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` (default: `info`) |

## Tool Reference

### Klaviyo Tools

#### `klaviyo_campaign_summary`
Top campaigns ranked by metric. Returns name, send date, opens, clicks, revenue.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `channel` | `"email"` \| `"sms"` | required | Channel filter |
| `metric` | `"revenue"` \| `"open_rate"` \| `"click_rate"` \| `"recipients"` | `"revenue"` | Rank by |
| `days` | 1-365 | 30 | Lookback period |
| `limit` | 1-25 | 10 | Max results |

> "Show me my top email campaigns by revenue this month"

#### `klaviyo_campaign_detail`
Deep dive on one campaign: full metrics, subject line, audiences, send time.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `campaign_id` | string | required | Klaviyo campaign ID |

> "Give me the full breakdown on my Black Friday campaign"

#### `klaviyo_flow_summary`
Top flows by metric. Returns name, status, trigger, message count, revenue.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `metric` | `"revenue"` \| `"click_rate"` \| `"conversion_rate"` \| `"recipients"` | `"revenue"` | Rank by |
| `days` | 1-365 | 30 | Lookback period |
| `status` | `"live"` \| `"draft"` \| `"manual"` \| `"all"` | `"live"` | Filter by status |
| `limit` | 1-25 | 10 | Max results |

> "Which of my flows generates the most revenue?"

#### `klaviyo_flow_detail`
Deep dive on one flow: per-message performance breakdown.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `flow_id` | string | required | Klaviyo flow ID |
| `days` | 1-365 | 30 | Lookback period |

> "Show me the per-email breakdown of my welcome flow"

#### `klaviyo_subscriber_health`
List growth and engagement tier breakdown.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `list_id` | string | optional | Specific list, or all lists |

> "What's the health of my email list?"

#### `klaviyo_list_segments`
All lists and segments with sizes.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `type` | `"lists"` \| `"segments"` \| `"all"` | `"all"` | Filter by type |
| `cursor` | string | optional | Pagination cursor |

> "List all my Klaviyo segments and their sizes"

#### `klaviyo_search_profiles`
Find profiles by email, phone, or name.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Email, phone, or name |
| `limit` | 1-10 | 5 | Max results |

> "Look up the profile for john@example.com"

#### `klaviyo_recent_activity`
Recent events for a metric (e.g., Placed Order, Opened Email).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `metric_name` | string | `"Placed Order"` | Metric name |
| `days` | 1-90 | 7 | Lookback period |
| `limit` | 1-25 | 10 | Max events |
| `profile_email` | string | optional | Filter to one profile |

> "Show me the last 10 orders placed"

### Shopify Tools

#### `shopify_sales_summary`
Revenue (gross + net), orders, AOV for a period with comparison.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `days` | 1-90 | 30 | Lookback period |
| `compare_previous` | boolean | true | Include previous period comparison |

> "What were my sales last month compared to the month before?"

#### `shopify_sales_timeseries`
Revenue and orders broken down by day, week, or month.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `days` | 1-365 | 30 | Lookback period |
| `granularity` | `"daily"` \| `"weekly"` \| `"monthly"` | `"daily"` | Bucket size |

> "Show me daily revenue for this month"

#### `shopify_product_performance`
Top products by revenue or units sold.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `days` | 1-90 | 7 | Lookback period |
| `metric` | `"revenue"` \| `"units"` | `"revenue"` | Rank by |
| `limit` | 1-25 | 10 | Max results |

> "Which products sold the most units this week?"

#### `shopify_order_search`
Find orders by number, email, or status.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Order number, email, or `financial_status:paid` |
| `limit` | 1-25 | 10 | Max results |

> "Find order #1234"

#### `shopify_inventory_alerts`
Products with low or zero stock, sorted by most urgent.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `threshold` | number | 10 | Alert at or below this quantity |
| `limit` | 1-50 | 20 | Max results |

> "Which products are running low on stock?"

#### `shopify_customer_cohort`
New vs returning buyers. First-time vs repeat split.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `days` | 1-365 | 90 | Lookback period |
| `limit` | 1-500 | 250 | Max customers to analyze |

> "What percentage of orders this quarter came from new customers?"

#### `shopify_recent_orders`
Most recent orders. Quick snapshot of store activity.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | 1-25 | 10 | Max results |

> "Show me the last 10 orders"

### Cross-Platform Tools

#### `dtc_email_revenue_attribution`
Email/SMS revenue vs total Shopify revenue. Shows email marketing contribution.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `days` | 1-365 | 30 | Lookback period |

> "What percentage of my revenue came from email?"

#### `dtc_dashboard`
Complete DTC health dashboard: sales + email + subscriber metrics in one call.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `days` | 7-90 | 30 | Lookback period |

> "Give me the full business dashboard for last month"

## Example Queries

Here are questions you can ask Claude once dtc-mcp is connected:

- "How did my email campaigns perform this month?"
- "Which flow is generating the most revenue? Drill into the top one."
- "Show me daily revenue for this month so I can compare against my Shopify dashboard"
- "What's my gross vs net revenue for the past 30 days?"
- "Which products are my best sellers this week?"
- "Are any products running low on stock?"
- "What percentage of my revenue comes from email marketing?"
- "How many new vs returning customers did I have this quarter?"
- "Look up the customer profile for sarah@example.com"
- "Give me a complete health dashboard for my business"
- "Compare this month's sales to last month"
- "What are my top SMS campaigns by click rate?"

## Development

```bash
git clone https://github.com/rafaelsztutman/dtc-mcp.git
cd dtc-mcp
npm install
cp .env.example .env    # Fill in your API credentials
npm run build           # Compile TypeScript
npm test                # Run tests (31 tests)
npm run dev             # Watch mode
npm run inspect         # Open MCP Inspector for interactive testing
```

## License

MIT
