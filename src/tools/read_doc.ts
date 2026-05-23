import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readById, listPaths } from "../docs/search.js";

const readDocShape = {
  path: z
    .string()
    .optional()
    .describe(
      "Exact chunk ID to fetch (e.g. 'klaviyo.reporting.campaignValues', 'guide.output-discipline'). Omit to list all available paths.",
    ),
  platform: z
    .enum(["klaviyo", "shopify", "guide"])
    .optional()
    .describe(
      "When listing (no `path`), filter to one platform's docs only.",
    ),
};

const description = `
Fetch a specific SDK docs chunk by exact path, or list all available paths when called with no args.

Use this instead of search_docs when you already know the chunk ID — it's cheaper and more deterministic.
Common patterns:
  • read_doc({}) → list every chunk ID with one-line summaries (use this once at the start of a session to map the SDK surface)
  • read_doc({ path: "klaviyo.reporting.campaignValues" }) → fetch one method's full doc (signature + JSDoc + example) verbatim
  • read_doc({ platform: "shopify" }) → list only Shopify chunk IDs

This adopts the "filesystem-as-API" pattern from Anthropic's Code Execution with MCP research: LLMs are faster and more accurate when they can read a typed-source-of-truth doc page directly, rather than re-searching for it on every code generation.
`.trim();

export function registerReadDoc(server: McpServer): void {
  server.tool(
    "read_doc",
    description,
    readDocShape,
    {
      title: "Read SDK doc by path",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ path, platform }) => {
      if (path) {
        const { version, found, chunk } = await readById(path);
        const text = JSON.stringify(
          {
            docsVersion: version,
            found,
            chunk: chunk
              ? {
                  id: chunk.id,
                  title: chunk.title,
                  platform: chunk.platform,
                  category: chunk.category,
                  summary: chunk.summary,
                  content: chunk.content,
                  tags: chunk.tags,
                }
              : null,
            ...(found
              ? {}
              : {
                  hint: "Path not found. Use read_doc({}) to list all paths, or search_docs to find by query.",
                }),
          },
          null,
          2,
        );
        return {
          content: [{ type: "text", text }],
          isError: !found,
        };
      }

      const { version, count, paths } = await listPaths({ platform });
      const text = JSON.stringify(
        {
          docsVersion: version,
          count,
          paths,
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
