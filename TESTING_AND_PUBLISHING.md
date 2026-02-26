# Testing & Publishing Guide for dtc-mcp

## Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [Step 1: Unit Tests](#2-step-1-unit-tests)
3. [Step 2: Get Your API Keys](#3-step-2-get-your-api-keys)
4. [Step 3: Test with MCP Inspector](#4-step-3-test-with-mcp-inspector)
5. [Step 4: Test in Claude Desktop](#5-step-4-test-in-claude-desktop)
6. [Step 5: Test in Claude Code (Direct MCP)](#6-step-5-test-in-claude-code-direct-mcp)
6b. [Step 5b: Test as Plugin (Slash Commands + Skills)](#6b-step-5b-test-as-claude-code-plugin-slash-commands--skills)
7. [Step 6: Test Graceful Degradation](#7-step-6-test-graceful-degradation)
8. [Step 7: Publish to npm](#8-step-7-publish-to-npm)
9. [Step 8: Publish to GitHub](#9-step-8-publish-to-github)
10. [Testing Checklist](#10-testing-checklist)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Prerequisites

Before testing, make sure you have:

```bash
node --version   # Must be >= 20.0.0
npm --version    # Any recent version

# Build the project
cd /Users/roliveira/dtc-mcp
npm run build
```

You should see no errors. The `dist/` directory should exist with compiled `.js` files.

---

## 2. Step 1: Unit Tests

These test the transform functions with mock data — no API keys needed.

```bash
npm test
```

**Expected output**: 26 tests passing. These cover:
- Campaign summary sorting and rate computation
- Flow summary aggregation across messages
- Division-by-zero edge cases (zero recipients)
- Empty result handling
- Shopify sales summary with period comparison
- Product performance aggregation from line items
- Inventory alert filtering and sorting
- Customer cohort bucketing

If any fail, fix before proceeding.

---

## 3. Step 2: Get Your API Keys

### Klaviyo (Required)

1. Log into [Klaviyo](https://www.klaviyo.com/) → **Settings** → **API Keys**
2. Create a new **Private API Key** (starts with `pk_`)
3. Required scopes: **Read** access for:
   - Campaigns
   - Flows
   - Lists
   - Segments
   - Profiles
   - Metrics
   - Events
4. Note: The reporting endpoints (`campaign-values-reports`, `flow-values-reports`) require the Campaigns and Flows read scopes

### Shopify (Optional — Klaviyo-only mode works fine)

Two auth modes are supported. Use whichever matches your app type:

#### Option A: Dev Dashboard app (recommended, required for new apps since Jan 2026)

1. Go to the [Shopify Partners Dashboard](https://partners.shopify.com/) or [Shopify Dev Dashboard](https://dev.shopify.com/)
2. Create a new app → choose **Custom app** distribution
3. Under **Configuration** → **API access**, enable Admin API scopes:
   - `read_orders`
   - `read_products`
   - `read_inventory`
   - `read_customers`
4. Under **Client credentials**, copy:
   - **Client ID** — a hex string
   - **Client Secret** — starts with `shpss_`
5. Install the app on your store
6. Note your store domain: `your-store.myshopify.com`

#### Option B: Legacy custom app (existing apps created before Jan 2026)

1. Log into your Shopify store admin
2. Go to **Settings** → **Apps and sales channels** → **Develop apps**
3. Use your existing custom app
4. Copy the **Admin API access token** (starts with `shpat_`)
5. Note your store domain: `your-store.myshopify.com`

> **Note**: As of January 2026, Shopify no longer allows creating new legacy custom apps. Use Option A for new setups.

### Create a `.env` file

```bash
cp .env.example .env
```

Edit `.env` with your actual keys:

```bash
KLAVIYO_API_KEY=pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Dev Dashboard app (Option A):
SHOPIFY_STORE=your-store.myshopify.com
SHOPIFY_CLIENT_ID=your_client_id
SHOPIFY_CLIENT_SECRET=shpss_your_secret

# Legacy app (Option B) — use these INSTEAD of CLIENT_ID/SECRET, not both:
# SHOPIFY_STORE=your-store.myshopify.com
# SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

LOG_LEVEL=debug    # Use debug during testing to see API calls
```

---

## 4. Step 3: Test with MCP Inspector

The MCP Inspector is an interactive web UI that lets you call each tool individually and see responses.

### Launch the inspector

```bash
# Load your env vars and run the inspector
source .env && npx @modelcontextprotocol/inspector node dist/index.js
```

Or if you prefer to pass env vars inline:

```bash
KLAVIYO_API_KEY=pk_xxx npx @modelcontextprotocol/inspector node dist/index.js
```

This opens a browser window (typically at `http://localhost:6274`).

### What to test in the Inspector

Work through each tool in order. The inspector lets you fill in parameters and see raw responses.

#### Klaviyo Tools (test these first)

**Tool 1: `klaviyo_campaign_summary`**
```json
{ "channel": "email", "metric": "revenue", "days": 30, "limit": 5 }
```
✅ Verify: Returns an array of campaigns with name, send_date, revenue, open_rate, click_rate
✅ Verify: Revenue values are numbers (not strings)
✅ Verify: Rates are decimals between 0-1 (e.g., 0.28 = 28%)
✅ Verify: Response is compact (not raw API dump)

**Tool 2: `klaviyo_campaign_detail`**
- Use a `campaign_id` from the previous response
```json
{ "campaign_id": "01XXXXXX" }
```
✅ Verify: Returns subject_line, audiences, full metrics breakdown
✅ Verify: bounce_rate and spam_rate are present

**Tool 3: `klaviyo_flow_summary`**
```json
{ "metric": "revenue", "days": 30, "status": "live", "limit": 5 }
```
✅ Verify: Returns flows with message_count, trigger_type, revenue
✅ Verify: Revenue is aggregated across all flow messages

**Tool 4: `klaviyo_flow_detail`**
- Use a `flow_id` from the previous response
```json
{ "flow_id": "XXXXXX", "days": 30 }
```
✅ Verify: Returns per-message breakdown with subject_lines and individual metrics

**Tool 5: `klaviyo_subscriber_health`**
```json
{}
```
✅ Verify: Returns total_subscribers, lists sorted by size, segments

**Tool 6: `klaviyo_list_segments`**
```json
{ "type": "all" }
```
✅ Verify: Returns combined list of lists and segments with sizes and types

**Tool 7: `klaviyo_search_profiles`**
```json
{ "query": "your-real-email@example.com" }
```
✅ Verify: Returns profile with email, name, phone, city, country
✅ Verify: No raw API fields (no `$id`, no `$organization`, no internal timestamps)

**Tool 8: `klaviyo_recent_activity`**
```json
{ "metric_name": "Placed Order", "days": 7, "limit": 5 }
```
✅ Verify: Returns events with timestamp, profile info, and stripped event properties
✅ Verify: For "Placed Order", you see $value, Items, Currency — NOT internal tracking fields

#### Shopify Tools (skip if Shopify not configured)

**Tool 9: `shopify_sales_summary`**
```json
{ "days": 30, "compare_previous": true }
```
✅ Verify: Returns revenue, order_count, aov
✅ Verify: Comparison deltas show percentage changes
✅ Verify: Fast response (uses ShopifyQL, not individual order fetching)

**Tool 10: `shopify_product_performance`**
```json
{ "days": 7, "metric": "revenue", "limit": 5 }
```
✅ Verify: Returns products aggregated by revenue with units_sold, avg_price
⚠️ Note: This tool fetches order line items — may take a few seconds for busy stores

**Tool 11: `shopify_order_search`**
```json
{ "query": "financial_status:paid", "limit": 5 }
```
✅ Verify: Returns compact order summaries
Also try: `{ "query": "#1001" }` or `{ "query": "customer@email.com" }`

**Tool 12: `shopify_inventory_alerts`**
```json
{ "threshold": 10, "limit": 10 }
```
✅ Verify: Returns low-stock items sorted by quantity ascending

**Tool 13: `shopify_customer_cohort`**
```json
{ "days": 90, "limit": 100 }
```
✅ Verify: Returns cohort breakdown (1 order, 2-3, 4-10, 10+), repeat rate, top customers

**Tool 14: `shopify_recent_orders`**
```json
{ "limit": 5 }
```
✅ Verify: Most recent orders with compact fields

#### Cross-Platform Tools

**Tool 15: `dtc_email_revenue_attribution`**
```json
{ "days": 30 }
```
✅ Verify: Shows email_pct_of_total, flow vs campaign split
✅ Verify: Includes the attribution model caveat note

**Tool 16: `dtc_dashboard`**
```json
{ "days": 30 }
```
✅ Verify: Combined view with sales, email metrics, and subscriber data
✅ Verify: This should be fast if you already ran campaign/flow summaries (cached reporting data)

### Rate Limit Test

Run `klaviyo_campaign_summary` then immediately run `klaviyo_flow_summary`. Check the debug logs (in terminal where inspector is running):
- Second call should show "Klaviyo POST cache hit" if reporting data is cached
- If not cached, the rate limiter should add a delay (visible in debug logs)

---

## 5. Step 4: Test in Claude Desktop

### Configure Claude Desktop

Edit your Claude Desktop config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add the `dtc-mcp` server:

```json
{
  "mcpServers": {
    "dtc-mcp": {
      "command": "node",
      "args": ["/Users/roliveira/dtc-mcp/dist/index.js"],
      "env": {
        "KLAVIYO_API_KEY": "pk_your_key_here",
        "SHOPIFY_STORE": "your-store.myshopify.com",
        "SHOPIFY_CLIENT_ID": "your_client_id",
        "SHOPIFY_CLIENT_SECRET": "shpss_your_secret"
      }
    }
  }
}
```

For legacy Shopify apps (existing `shpat_` tokens):

```json
{
  "mcpServers": {
    "dtc-mcp": {
      "command": "node",
      "args": ["/Users/roliveira/dtc-mcp/dist/index.js"],
      "env": {
        "KLAVIYO_API_KEY": "pk_your_key_here",
        "SHOPIFY_STORE": "your-store.myshopify.com",
        "SHOPIFY_ACCESS_TOKEN": "shpat_your_token_here"
      }
    }
  }
}
```

For Klaviyo-only (no Shopify), just omit the Shopify env vars:

```json
{
  "mcpServers": {
    "dtc-mcp": {
      "command": "node",
      "args": ["/Users/roliveira/dtc-mcp/dist/index.js"],
      "env": {
        "KLAVIYO_API_KEY": "pk_your_key_here"
      }
    }
  }
}
```

### Restart Claude Desktop

Quit and reopen Claude Desktop. You should see the tools icon showing 16 tools available.

### Test prompts to try

Start simple, then escalate:

```
Show me my top 5 email campaigns from the last 30 days
```

```
Give me a full performance report for my DTC brand this week
```

```
Which of my Klaviyo flows is generating the most revenue?
Drill into the top performer and show me the per-message breakdown
```

```
What percentage of my total revenue comes from email marketing?
```

```
Are there any campaigns with concerning unsubscribe rates?
```

```
Show me products with low inventory that need restocking
```

### What to verify
- Claude correctly selects the right tool for each question
- Responses are concise (not massive JSON dumps)
- Claude uses the summary→drill-down pattern naturally
- Error messages are clear if something goes wrong

---

## 6. Step 5: Test in Claude Code (Direct MCP)

This approach configures dtc-mcp as a standalone MCP server. You get the 16 tools but **not** the slash commands or skills.

### Configure via CLI

```bash
claude mcp add dtc-mcp \
  -e KLAVIYO_API_KEY=pk_your_key_here \
  -e SHOPIFY_STORE=your-store.myshopify.com \
  -e SHOPIFY_CLIENT_ID=your_client_id \
  -e SHOPIFY_CLIENT_SECRET=shpss_your_secret \
  -- node /Users/roliveira/dtc-mcp/dist/index.js
```

Or add to your project's `.claude/settings.json` manually:

```json
{
  "mcpServers": {
    "dtc-mcp": {
      "command": "node",
      "args": ["/Users/roliveira/dtc-mcp/dist/index.js"],
      "env": {
        "KLAVIYO_API_KEY": "pk_your_key_here",
        "SHOPIFY_STORE": "your-store.myshopify.com",
        "SHOPIFY_CLIENT_ID": "your_client_id",
        "SHOPIFY_CLIENT_SECRET": "shpss_your_secret"
      }
    }
  }
}
```

### Verify

Run `claude` and type `/mcp` — you should see `dtc-mcp` listed with 16 tools.

---

## 6b. Step 5b: Test as Claude Code Plugin (Slash Commands + Skills)

Plugin mode gives you everything: the 16 MCP tools **plus** slash commands and auto-invoked skills. This is the recommended way to use dtc-mcp.

### What you get in plugin mode

| Feature | Direct MCP | Plugin Mode |
|---------|-----------|-------------|
| 16 MCP tools | Yes | Yes |
| Slash commands (`/dtc-mcp:weekly-report`, etc.) | No | Yes |
| Auto-invoked skills (metrics reference, analysis guide) | No | Yes |
| Bundled as single unit | No | Yes |

### Prerequisites

Your API keys must be available as environment variables in your shell **before** launching Claude Code:

```bash
# Add to your ~/.zshrc or ~/.bashrc:
export KLAVIYO_API_KEY=pk_your_key_here
export SHOPIFY_STORE=your-store.myshopify.com
export SHOPIFY_CLIENT_ID=your_client_id
export SHOPIFY_CLIENT_SECRET=shpss_your_secret
```

Then reload your shell: `source ~/.zshrc`

### Load the plugin

```bash
# From any directory — pass the path to the dtc-mcp project root
claude --plugin-dir /Users/roliveira/dtc-mcp
```

You can combine this with opening a project:

```bash
cd /path/to/your/project
claude --plugin-dir /Users/roliveira/dtc-mcp
```

> **Note**: The `--plugin-dir` flag loads the plugin for the current session only. You need to pass it each time you launch Claude Code.

### Available slash commands

Once loaded as a plugin, these slash commands become available (namespaced with the plugin name):

| Command | What it does |
|---------|-------------|
| `/dtc-mcp:weekly-report` | Generates a structured weekly performance report with revenue, email, flow, subscriber, and attribution data |
| `/dtc-mcp:campaign-review` | Analyzes recent campaigns against benchmarks, flags underperformers, identifies trends |
| `/dtc-mcp:flow-audit` | Checks for missing core flows (Welcome, Cart, Browse, Post-Purchase, Winback) and optimization opportunities |

### Available skills (auto-invoked)

These skills are automatically used by Claude when relevant:

- **ecommerce-analysis** — Framework for analyzing DTC brand performance (benchmarks, recommended tool sequence)
- **dtc-metrics** — Reference for key DTC metrics with healthy/warning/critical thresholds

### Test the plugin

1. Launch with the plugin:
   ```bash
   claude --plugin-dir /Users/roliveira/dtc-mcp
   ```

2. Verify tools loaded — type `/mcp` and confirm `dtc-mcp` appears with 16 tools

3. Try a slash command:
   ```
   /dtc-mcp:weekly-report
   ```
   Claude should call the `dtc_dashboard` tool and generate a structured report.

4. Try a natural language query:
   ```
   Audit my Klaviyo flows and tell me which core flows I'm missing
   ```
   Claude should use the `ecommerce-analysis` skill's flow checklist automatically.

---

## 7. Step 6: Test Graceful Degradation

### Klaviyo-only mode

Start the server with only Klaviyo keys:

```bash
KLAVIYO_API_KEY=pk_xxx npx @modelcontextprotocol/inspector node dist/index.js
```

Call any Shopify tool (e.g., `shopify_sales_summary`):
✅ Verify: Returns "Shopify not configured. Set SHOPIFY_STORE + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard app), or SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN (legacy app)."
✅ Verify: `isError: true` in the response

### Invalid API key

```bash
KLAVIYO_API_KEY=pk_invalid npx @modelcontextprotocol/inspector node dist/index.js
```

Call `klaviyo_campaign_summary`:
✅ Verify: Returns an actionable error message mentioning the API key

### Missing required key

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```
✅ Verify: Server fails to start with: "Missing required environment variable: KLAVIYO_API_KEY..."

---

## 8. Step 7: Publish to npm

Once all tests pass and you're happy with the behavior:

### Pre-publish checklist

```bash
# Make sure everything is clean
npm run build
npm test

# Verify the dist output looks right
ls dist/
head -1 dist/index.js   # Should show: #!/usr/bin/env node

# Check what will be published
npm pack --dry-run
```

Review the `npm pack --dry-run` output. It should include:
- `dist/**/*.js` and `dist/**/*.d.ts` — compiled code
- `package.json` — manifest
- NOT: `.env`, `node_modules/`, `src/` (source), `tests/`

### Add a .npmignore (if not already present)

Create `.npmignore` to keep the package lean:

```
src/
tests/
.env
.env.example
tsconfig.json
CLAUDE.md
TESTING_AND_PUBLISHING.md
.claude/
.claude-plugin/
skills/
commands/
```

### Login to npm

```bash
npm login
```

Follow the prompts to authenticate. If you don't have an npm account, create one at https://www.npmjs.com/signup.

### Publish

```bash
npm publish
```

If the name `dtc-mcp` is taken, you can either:
- Use a scoped name: change `"name"` in package.json to `"@yourusername/dtc-mcp"` and run `npm publish --access public`
- Pick a different name

### Verify the publish

```bash
# Test that it works via npx (from a different directory)
cd /tmp
KLAVIYO_API_KEY=pk_xxx npx dtc-mcp
```

It should start the MCP server (waiting for stdio input). Press Ctrl+C to exit.

### Update Claude Desktop config to use published package

Once published, update your Claude Desktop config to use npx:

```json
{
  "mcpServers": {
    "dtc-mcp": {
      "command": "npx",
      "args": ["dtc-mcp"],
      "env": {
        "KLAVIYO_API_KEY": "pk_your_key_here"
      }
    }
  }
}
```

---

## 9. Step 8: Publish to GitHub

### Initialize git (if not already done)

```bash
cd /Users/roliveira/dtc-mcp
git init
git add -A
git commit -m "Initial release: dtc-mcp v0.1.0

Context-optimized MCP server for DTC e-commerce brands.
16 tools across Klaviyo, Shopify (GraphQL), and cross-platform analytics.
Tiered rate limiting, 10-minute reporting cache, and transform-based context optimization."
```

### Create GitHub repo and push

```bash
# Create repo on GitHub (requires gh CLI)
gh repo create dtc-mcp --public --description "Context-optimized MCP server for DTC e-commerce (Klaviyo + Shopify)" --source .

# Or manually create on github.com, then:
git remote add origin https://github.com/yourusername/dtc-mcp.git
git branch -M main
git push -u origin main
```

### Add the repo URL to package.json

Before your next npm publish, add the `repository` field:

```json
{
  "repository": {
    "type": "git",
    "url": "https://github.com/yourusername/dtc-mcp.git"
  }
}
```

---

## 10. Testing Checklist

Use this checklist to track your testing progress:

### Unit Tests
- [ ] `npm test` — all 26 tests pass

### MCP Inspector — Klaviyo
- [ ] `klaviyo_campaign_summary` — returns compact campaign list
- [ ] `klaviyo_campaign_detail` — returns full detail for one campaign
- [ ] `klaviyo_flow_summary` — returns flows with aggregated metrics
- [ ] `klaviyo_flow_detail` — returns per-message breakdown
- [ ] `klaviyo_subscriber_health` — returns list sizes and segments
- [ ] `klaviyo_list_segments` — returns combined list/segment inventory
- [ ] `klaviyo_search_profiles` — finds profile by email
- [ ] `klaviyo_recent_activity` — returns stripped events

### MCP Inspector — Shopify (skip if not configured)
- [ ] `shopify_sales_summary` — uses ShopifyQL, returns fast
- [ ] `shopify_product_performance` — aggregated product revenue
- [ ] `shopify_order_search` — finds orders by query
- [ ] `shopify_inventory_alerts` — low stock items
- [ ] `shopify_customer_cohort` — cohort breakdown with repeat rate
- [ ] `shopify_recent_orders` — latest orders

### MCP Inspector — Cross-Platform
- [ ] `dtc_email_revenue_attribution` — email % of total revenue
- [ ] `dtc_dashboard` — combined health dashboard

### Behavior Verification
- [ ] Rate limiting: second reporting call shows cache hit in logs
- [ ] Graceful degradation: Shopify tools return helpful error without keys
- [ ] Error messages: invalid API key gives actionable error
- [ ] Context size: summary responses are concise (~500 tokens or less)

### Claude Desktop / Claude Code (Direct MCP)
- [ ] Config loads correctly, 16 tools visible
- [ ] Natural language queries select the right tools
- [ ] Summary → drill-down pattern works conversationally

### Claude Code Plugin Mode
- [ ] `claude --plugin-dir /path/to/dtc-mcp` — plugin loads without errors
- [ ] `/mcp` shows dtc-mcp with 16 tools
- [ ] `/dtc-mcp:weekly-report` — slash command runs and generates report
- [ ] `/dtc-mcp:campaign-review` — slash command runs
- [ ] `/dtc-mcp:flow-audit` — slash command runs

### Publishing
- [ ] `npm pack --dry-run` — includes dist/, excludes src/ and tests/
- [ ] `npm publish` — succeeds
- [ ] `npx dtc-mcp` — starts correctly from published package

---

## 11. Troubleshooting

### "Missing required environment variable: KLAVIYO_API_KEY"
You need to pass env vars. In the inspector:
```bash
KLAVIYO_API_KEY=pk_xxx npx @modelcontextprotocol/inspector node dist/index.js
```

### MCP Inspector shows "Server disconnected"
Check the terminal where you launched the inspector for error output. Common causes:
- Config validation error (missing or mismatched env vars)
- TypeScript build is stale (run `npm run build` again)

### "Rate limited. Retry after Xs"
The Klaviyo reporting endpoints have very strict limits (2 requests/minute). The cache should prevent most hits, but if you're testing rapidly:
- Wait 30 seconds between reporting tool calls
- Or restart the server (clears cache) and call one tool at a time

### Shopify "HTTP 401" or "HTTP 403"
- **Dev Dashboard app**: Verify `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` (starts with `shpss_`) are correct
- **Legacy app**: Verify `SHOPIFY_ACCESS_TOKEN` starts with `shpat_`
- Verify your app has the required scopes (`read_orders`, `read_products`, `read_inventory`, `read_customers`)
- Verify `SHOPIFY_STORE` is just the domain (e.g., `mystore.myshopify.com`), not a full URL
- **Do not set both** `SHOPIFY_ACCESS_TOKEN` and `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET` — use one auth mode

### Shopify "Token request failed"
- This occurs in Client Credentials mode when the token acquisition fails
- Verify `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` are correct
- Verify the app is installed on the store
- Check that the store domain is correct

### "Could not discover Placed Order metric ID"
Your Klaviyo account may not have a "Placed Order" metric (common if you don't have a Shopify/e-commerce integration). Fix:
1. Check your Klaviyo metrics: go to **Analytics** → **Metrics** and find the exact name of your conversion metric
2. Get its ID from the URL or API
3. Set `KLAVIYO_CONVERSION_METRIC_ID=your_metric_id` in your env

### Claude Desktop doesn't show the tools
- Make sure you restarted Claude Desktop after editing the config
- Check the config JSON is valid (no trailing commas, proper quotes)
- Verify the path to `dist/index.js` is absolute and correct
- Check Claude Desktop logs for MCP connection errors
