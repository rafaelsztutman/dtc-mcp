import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { search } from "../docs/search.js";

const searchShape = {
  query: z.string().describe(
    "Natural-language or keyword query. Examples: 'list campaigns', 'shopifyql sales last 30 days', 'flow reporting', 'get conversion metric id'.",
  ),
  platform: z
    .enum(["klaviyo", "shopify"])
    .optional()
    .describe("Filter to one platform's docs."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Max results to return (default 5)."),
};

const description = `
Search the bundled SDK reference docs for Klaviyo and Shopify methods exposed inside the
execute_code sandbox. Returns ranked markdown chunks: method signatures, parameter
descriptions, and runnable code examples.

Use this BEFORE writing code in execute_code — the SDK surface is constrained to
registered methods (escape hatches are 'klaviyo.get/post/paginate' and 'shopify.gql/ql').

The docs index is refreshed daily from a CDN-backed source repo, so new Klaviyo/Shopify
API revisions land without requiring a new MCP release.
`.trim();

export function registerSearchDocs(server: McpServer): void {
  server.tool(
    "search_docs",
    description,
    searchShape,
    {
      title: "Search SDK docs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ query, platform, limit }) => {
      const { version, hits } = await search(query, { platform, limit });
      const text = JSON.stringify(
        {
          query,
          docsVersion: version,
          hits: hits.map((h) => ({
            id: h.id,
            title: h.title,
            platform: h.platform,
            category: h.category,
            summary: h.summary,
            content: h.content,
            score: Math.round(h.score * 100) / 100,
          })),
        },
        null,
        2,
      );
      return {
        content: [{ type: "text", text }],
      };
    },
  );
}
