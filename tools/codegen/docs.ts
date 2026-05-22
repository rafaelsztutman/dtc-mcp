/**
 * Merge codegen outputs into the final data/docs.json that ships with the
 * package (and is served via jsDelivr from the dtc-mcp-docs repo).
 *
 * Inputs (all optional — missing ones are skipped):
 *   tools/codegen/.cache/klaviyo.json   ← from codegen:klaviyo
 *   tools/codegen/.cache/shopify.json   ← from codegen:shopify
 *   tools/codegen/guides.json           ← hand-curated guide + recipe chunks
 *
 * Output:
 *   data/docs.json
 *
 * The output is canonically sorted by chunk id, which keeps git diffs sane
 * across regenerations.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocChunk, DocsIndex } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CACHE_DIR = resolve(HERE, ".cache");

const SOURCES = [
  resolve(HERE, "guides.json"),
  resolve(CACHE_DIR, "klaviyo.json"),
  resolve(CACHE_DIR, "shopify.json"),
];

const OUT_PATH = resolve(REPO_ROOT, "data", "docs.json");

async function readChunksIfExists(path: string): Promise<DocChunk[]> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      console.warn(`[docs-codegen] ${path}: not an array, skipping`);
      return [];
    }
    return parsed as DocChunk[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`[docs-codegen] ${path}: not present, skipping`);
      return [];
    }
    throw e;
  }
}

function todayUtc(): string {
  return new Date().toISOString().split("T")[0];
}

async function main(): Promise<void> {
  const all: DocChunk[] = [];
  for (const src of SOURCES) {
    const chunks = await readChunksIfExists(src);
    all.push(...chunks);
    console.log(`[docs-codegen] ${src.replace(REPO_ROOT + "/", "")}: ${chunks.length} chunks`);
  }

  if (all.length === 0) {
    console.error(
      "[docs-codegen] no input chunks — run codegen:klaviyo / codegen:shopify first, or create tools/codegen/guides.json",
    );
    process.exit(1);
  }

  // De-dupe by id (last one wins — so a guide chunk overrides a generated one).
  const byId = new Map<string, DocChunk>();
  for (const chunk of all) byId.set(chunk.id, chunk);

  const sorted = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

  const index: DocsIndex = {
    version: process.env.DOCS_VERSION ?? `v${todayUtc()}`,
    generatedAt: new Date().toISOString(),
    chunks: sorted,
  };

  await writeFile(OUT_PATH, JSON.stringify(index, null, 2) + "\n", "utf8");
  console.log(
    `[docs-codegen] wrote ${sorted.length} chunks → ${OUT_PATH} (version=${index.version})`,
  );
}

main().catch((e) => {
  console.error("[docs-codegen] FAILED:", e);
  process.exit(1);
});
