import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { computeRevenueAttribution, computeDashboard } from "./correlator.js";
import { formatError, toolResult } from "../shared/errors.js";

const TOOL_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

export function registerCrossPlatformTools(server: McpServer): void {
  // ---- Tool 15: Email Revenue Attribution ----
  server.tool(
    "dtc_email_revenue_attribution",
    "Email/SMS revenue vs total Shopify revenue. Shows email marketing contribution.",
    {
      days: z.number().min(1).max(365).default(30),
    },
    TOOL_ANNOTATIONS,
    async ({ days }) => {
      try {
        const result = await computeRevenueAttribution(days);
        return toolResult(result);
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 16: DTC Dashboard ----
  server.tool(
    "dtc_dashboard",
    "Complete DTC health dashboard: sales + email + subscriber metrics in one call.",
    {
      days: z.number().min(7).max(90).default(30),
    },
    TOOL_ANNOTATIONS,
    async ({ days }) => {
      try {
        const result = await computeDashboard(days);
        return toolResult(result);
      } catch (error) {
        return formatError(error);
      }
    },
  );
}
