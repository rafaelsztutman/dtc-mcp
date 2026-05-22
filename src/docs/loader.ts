import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../config.js";

export interface DocChunk {
  /** Stable ID, used as MiniSearch primary key. */
  id: string;
  /** Short display title (e.g. "klaviyo.campaigns.list"). */
  title: string;
  /** "klaviyo" | "shopify" | "guide" */
  platform: string;
  /** "method" | "guide" | "type" — for filter UI down the road. */
  category: string;
  /** 1-line summary. */
  summary: string;
  /** Full markdown body (usage, params, example). */
  content: string;
  /** Optional tags for ranking boost. */
  tags?: string[];
}

export interface DocsIndex {
  version: string;
  generatedAt: string;
  chunks: DocChunk[];
}

const DEFAULT_DOCS_URL =
  "https://cdn.jsdelivr.net/gh/rafaelsztutman/dtc-mcp-docs@latest/docs.json";

function bundledPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "data", "docs.json");
}

function cacheDir(): string {
  return resolve(homedir(), ".cache", "dtc-mcp");
}

function cacheFile(): string {
  return resolve(cacheDir(), "docs.json");
}

function etagFile(): string {
  return resolve(cacheDir(), "docs.etag");
}

async function readJsonIfExists(path: string): Promise<DocsIndex | null> {
  try {
    await stat(path);
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as DocsIndex;
  } catch {
    return null;
  }
}

async function readEtag(): Promise<string | null> {
  try {
    return (await readFile(etagFile(), "utf8")).trim();
  } catch {
    return null;
  }
}

/**
 * Load the docs index from the most recent source available:
 *   1. ~/.cache/dtc-mcp/docs.json
 *   2. bundled data/docs.json (always present in the package)
 *
 * The cache check happens first so docs can be updated independently of npm
 * releases — the dtc-mcp-docs repo refreshes the CDN copy on a daily cron.
 */
export async function loadDocs(): Promise<DocsIndex> {
  const cached = await readJsonIfExists(cacheFile());
  if (cached) {
    log("debug", "Docs loaded from cache", { version: cached.version });
    return cached;
  }
  const bundled = await readJsonIfExists(bundledPath());
  if (bundled) {
    log("debug", "Docs loaded from bundle", { version: bundled.version });
    return bundled;
  }
  throw new Error(
    `No docs index found. Expected ${bundledPath()} to be present in the package.`,
  );
}

/**
 * Try to refresh the docs from the configured CDN. Returns the new index if
 * it changed, null if 304 / unchanged / unreachable. Never throws — refresh
 * failures must not break the MCP server, which can always fall back to the
 * cached or bundled copy.
 *
 * Configure via `DTC_MCP_DOCS_URL`; set `DTC_MCP_DOCS_REFRESH=0` to disable
 * background refreshes (offline mode).
 */
export async function refreshDocs(): Promise<DocsIndex | null> {
  if (process.env.DTC_MCP_DOCS_REFRESH === "0") return null;
  const url = process.env.DTC_MCP_DOCS_URL ?? DEFAULT_DOCS_URL;

  try {
    const etag = await readEtag();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (etag) headers["If-None-Match"] = etag;

    const res = await fetch(url, { headers });
    if (res.status === 304) {
      log("debug", "Docs unchanged (304)");
      return null;
    }
    if (!res.ok) {
      log("warn", "Docs refresh failed", { status: res.status });
      return null;
    }
    const text = await res.text();
    const next = JSON.parse(text) as DocsIndex;
    if (!Array.isArray(next.chunks)) {
      log("warn", "Docs refresh returned malformed payload");
      return null;
    }

    await mkdir(cacheDir(), { recursive: true });
    await writeFile(cacheFile(), text, "utf8");
    const newEtag = res.headers.get("etag");
    if (newEtag) await writeFile(etagFile(), newEtag, "utf8");

    log("info", "Docs refreshed", {
      version: next.version,
      chunks: next.chunks.length,
    });
    return next;
  } catch (e) {
    log("debug", "Docs refresh error", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
