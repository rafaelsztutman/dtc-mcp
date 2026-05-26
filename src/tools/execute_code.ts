import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSandbox } from "../sandbox/runner.js";
import { resolveTimeout } from "../sandbox/timeout.js";
import { log } from "../config.js";

const codeShape = {
  code: z.string().describe(
    "JavaScript (or TypeScript-like) to execute in the stateful sandbox. Async; return a value via `return ...`. Globals: klaviyo, shopify, console, pick, topN, summarize, globalThis. No fetch/process/require/import. Add `// @timeout 2m` (max 5m) to extend the 30s wall-clock limit.",
  ),
};

// Tool description shape was driven by the description-ablation experiment in
// bench/notes/description-ablation.md. Key findings: (1) stash-and-cite
// behavior is description-independent — Opus stashes by default, so the
// v1.0.5 prescriptive prose was dead weight; (2) one canonical real-API
// example is the single most effective teaching surface — it eliminated
// hallucinations 5× vs schema-only or prose-only descriptions. The shape
// below is schema + globals enumeration + one canonical example.
const description = `
execute_code(code: string) -> { ok, result, stdout, state, durationMs }
  state: current globalThis stash (auto-populated, summary-form — read this to see
         what data from prior calls is available without re-fetching)

Sandbox globals: klaviyo, shopify, console, pick, topN, summarize, globalThis (persists across calls)

Discovery: search_docs / read_doc surface SDK paths, parameter shapes, and recipes.
The SDK uses JSON:API conventions (sort keys, sparse fieldsets) that differ from
typical JS SDKs — search_docs FIRST for unfamiliar methods.

Reference example (real API surface — note JSON:API request shape):
  const metricId = await klaviyo.getConversionMetricId();
  const report = await klaviyo.reporting.campaignValues({
    data: { type: 'campaign-values-report', attributes: {
      timeframe: { key: 'last_30_days' },
      conversion_metric_id: metricId,
      statistics: ['recipients', 'open_rate', 'conversion_value'],
    }}
  });
  globalThis.report = report;
  return topN(report.data.attributes.results, 5, r => r.statistics.conversion_value);
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
          state: result.state ?? {},
          durationMs: result.durationMs,
          sandbox: result.sandbox,
          ...(result.sessionReset
            ? {
                sessionReset: true,
                sessionResetNote:
                  "This is the first execute_code call in this MCP session (or the sandbox was idle >30 min). The sandbox context is FRESH — there is no prior globalThis state to recover. From this call forward, anything you assign to globalThis WILL persist into the next execute_code call. No fallback fetches needed.",
              }
            : {}),
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
