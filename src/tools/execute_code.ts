import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSandbox } from "../sandbox/runner.js";
import { resolveTimeout } from "../sandbox/timeout.js";
import { log } from "../config.js";

const codeShape = {
  code: z.string().describe(
    "TypeScript-like JavaScript to execute. Wrap top-level await calls naturally — the code runs in an async context. Return a value via `return ...` to receive it as the tool result. Globals available: `klaviyo`, `shopify`, `console`. No `fetch`/`process`/`require`/`import`. Add `// @timeout 2m` (max 5m) at the top to extend the default 30s wall-clock limit. Discover SDK methods via the `search_docs` tool.",
  ),
};

const description = `
Execute JavaScript against the typed Klaviyo + Shopify SDKs in an isolated V8 sandbox.

The sandbox replaces 22 hand-built tools from v0.2 — write whatever query, aggregation,
or cross-platform composition you need in code. The host applies rate limits, auth, and
caching transparently.

Available globals:
- klaviyo: { get, post, paginate, campaigns, flows, lists, segments, profiles, events, metrics, reporting }
- shopify: { gql, ql, timezone } — Shopify Admin GraphQL + ShopifyQL
- console: { log, error, warn, info } — captured and returned as stdout

Use search_docs first to find the SDK method that fits your task. Method calls return
the raw API JSON (JSON:API for Klaviyo, GraphQL response for Shopify) — destructure
or transform inline.

Example (top 5 campaigns by revenue last 30d):
  const metricId = await klaviyo.getConversionMetricId();
  const report = await klaviyo.reporting.campaignValues({
    data: { type: "campaign-values-report", attributes: {
      timeframe: { key: "last_30_days" },
      conversion_metric_id: metricId,
      statistics: ["recipients", "open_rate", "click_rate", "conversion_value"],
    }}
  });
  return report.data.attributes.results.sort((a, b) => b.statistics.conversion_value - a.statistics.conversion_value).slice(0, 5);
`.trim();

export function registerExecuteCode(server: McpServer): void {
  server.tool(
    "execute_code",
    description,
    codeShape,
    {
      title: "Execute code (sandboxed)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ code }) => {
      const timeoutMs = resolveTimeout(code);
      log("debug", "execute_code", { length: code.length, timeoutMs });

      const result = await runSandbox(code, { timeoutMs });

      const text = JSON.stringify(
        {
          ok: result.ok,
          ...(result.ok ? { result: result.result } : { error: result.error }),
          stdout: result.stdout,
          durationMs: result.durationMs,
        },
        null,
        2,
      );

      return {
        content: [{ type: "text", text }],
        isError: !result.ok,
      };
    },
  );
}
