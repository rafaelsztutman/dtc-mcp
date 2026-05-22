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
