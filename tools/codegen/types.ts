/**
 * Shared types for the codegen scripts. These mirror the runtime DocChunk
 * shape in src/docs/loader.ts — kept in lockstep manually since the codegen
 * scripts run outside the main tsc compilation (no `src/` rootDir constraint).
 */
export interface DocChunk {
  id: string;
  title: string;
  platform: "klaviyo" | "shopify" | "guide";
  category: "method" | "guide" | "recipe" | "type";
  summary: string;
  content: string;
  tags?: string[];
}

export interface DocsIndex {
  version: string;
  generatedAt: string;
  chunks: DocChunk[];
}
