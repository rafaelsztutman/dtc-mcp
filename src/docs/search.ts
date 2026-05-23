import MiniSearch from "minisearch";
import { loadDocs, refreshDocs, type DocChunk, type DocsIndex } from "./loader.js";

interface IndexState {
  index: MiniSearch<DocChunk>;
  chunks: Map<string, DocChunk>;
  version: string;
}

let state: IndexState | null = null;
let loadPromise: Promise<IndexState> | null = null;

function buildIndex(docs: DocsIndex): IndexState {
  const index = new MiniSearch<DocChunk>({
    idField: "id",
    fields: ["title", "summary", "content", "tags", "platform"],
    storeFields: ["title", "platform", "category", "summary"],
    searchOptions: {
      boost: { title: 3, summary: 2, content: 1, platform: 1.5 },
      fuzzy: 0.2,
      prefix: true,
      combineWith: "AND",
    },
  });
  index.addAll(docs.chunks);
  const chunks = new Map(docs.chunks.map((c) => [c.id, c]));
  return { index, chunks, version: docs.version };
}

async function ensureIndex(): Promise<IndexState> {
  if (state) return state;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const docs = await loadDocs();
    state = buildIndex(docs);

    // Fire-and-forget background refresh. If a newer version is available
    // we swap the in-memory index for it without blocking the first query.
    void refreshDocs().then((next) => {
      if (next) state = buildIndex(next);
    });

    return state;
  })();

  return loadPromise;
}

export interface SearchHit {
  id: string;
  title: string;
  platform: string;
  category: string;
  summary: string;
  /** Full markdown body of the chunk. */
  content: string;
  score: number;
}

export async function search(
  query: string,
  options: { limit?: number; platform?: string } = {},
): Promise<{ version: string; hits: SearchHit[] }> {
  const limit = options.limit ?? 5;
  const st = await ensureIndex();
  const trimmed = query.trim();
  if (!trimmed) {
    return { version: st.version, hits: [] };
  }
  const results = st.index.search(trimmed, {
    filter: options.platform
      ? (r) => (r.platform as string).toLowerCase() === options.platform!.toLowerCase()
      : undefined,
  });

  const hits: SearchHit[] = results.slice(0, limit).map((r) => {
    const chunk = st.chunks.get(r.id as string);
    return {
      id: r.id as string,
      title: chunk?.title ?? (r.title as string),
      platform: chunk?.platform ?? (r.platform as string),
      category: chunk?.category ?? (r.category as string),
      summary: chunk?.summary ?? (r.summary as string),
      content: chunk?.content ?? "",
      score: r.score,
    };
  });

  return { version: st.version, hits };
}

export interface DocByIdResult {
  version: string;
  found: boolean;
  chunk?: DocChunk;
}

/**
 * Fetch one chunk by exact ID. Used by the `read_doc` MCP tool — Anthropic's
 * "filesystem-as-API" pattern adapted to the docs layer. Cheaper and more
 * deterministic than `search` when the LLM already knows the path.
 */
export async function readById(id: string): Promise<DocByIdResult> {
  const st = await ensureIndex();
  const chunk = st.chunks.get(id);
  return {
    version: st.version,
    found: !!chunk,
    chunk,
  };
}

export interface DocListResult {
  version: string;
  count: number;
  paths: Array<{
    id: string;
    title: string;
    platform: string;
    category: string;
    summary: string;
  }>;
}

/**
 * List all chunk IDs (with one-line summaries). Used by `read_doc()` with no
 * argument so the LLM can discover what's available without a search query.
 */
export async function listPaths(
  options: { platform?: string } = {},
): Promise<DocListResult> {
  const st = await ensureIndex();
  const platform = options.platform?.toLowerCase();
  const paths: DocListResult["paths"] = [];
  for (const chunk of st.chunks.values()) {
    if (platform && chunk.platform.toLowerCase() !== platform) continue;
    paths.push({
      id: chunk.id,
      title: chunk.title,
      platform: chunk.platform,
      category: chunk.category,
      summary: chunk.summary,
    });
  }
  paths.sort((a, b) => a.id.localeCompare(b.id));
  return { version: st.version, count: paths.length, paths };
}
