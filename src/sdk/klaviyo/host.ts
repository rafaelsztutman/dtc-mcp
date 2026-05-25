import { config, log } from "../../config.js";
import { TTLCache, buildCacheKey } from "../../shared/cache.js";
import { KlaviyoApiError } from "../../shared/errors.js";

const BASE_URL = "https://a.klaviyo.com/api";
const REPORTING_CACHE_TTL = 10 * 60 * 1000;

const reportingCache = new TTLCache<unknown>(REPORTING_CACHE_TTL);
const metricIdCache = new TTLCache<string>(Number.MAX_SAFE_INTEGER);

export type RateLimitTier = "standard" | "reporting";

// Klaviyo's per-endpoint tiers aren't surfaced uniformly in their docs;
// the reporting POST endpoints are a strict 1/s + 2/min, while everything
// else gets the much friendlier 10/s + 150/min.
class RateLimiter {
  private recent: number[] = [];
  constructor(
    private burstPerSecond: number,
    private steadyPerMinute: number,
  ) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 60_000);

    if (this.recent.length >= this.steadyPerMinute) {
      const wait = 60_000 - (now - this.recent[0]) + jitter();
      await sleep(wait);
    }

    const last1s = this.recent.filter((t) => Date.now() - t < 1_000);
    if (last1s.length >= this.burstPerSecond) {
      const wait = 1_000 - (Date.now() - last1s[0]) + jitter();
      await sleep(wait);
    }

    this.recent.push(Date.now());
  }
}

const standardLimiter = new RateLimiter(10, 150);
const reportingLimiter = new RateLimiter(1, 2);

function limiterFor(tier: RateLimitTier) {
  return tier === "reporting" ? reportingLimiter : standardLimiter;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Klaviyo-API-Key ${config.klaviyoApiKey}`,
    revision: config.klaviyoRevision,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function handleResponse(res: Response): Promise<unknown> {
  if (res.status === 429) {
    const ra = res.headers.get("Retry-After");
    throw new KlaviyoApiError(
      429,
      `Rate limited${ra ? `. Retry after ${ra}s` : ""}`,
    );
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { errors?: Array<{ detail?: string }> };
      if (body.errors?.[0]?.detail) msg = body.errors[0].detail;
    } catch {
      // ignore
    }
    throw new KlaviyoApiError(res.status, msg);
  }
  return res.json();
}

async function withRetry<T>(fn: () => Promise<T>, max = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= max; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e instanceof KlaviyoApiError && e.status === 429 && i < max) {
        await sleep(Math.pow(2, i) * 1000 + jitter());
        continue;
      }
      throw e;
    }
  }
  throw last;
}

export interface KlaviyoGetOptions {
  /** Query params. Accepts both JSON:API canonical (`'page[size]': '20'`)
   * and JS-idiomatic shapes (`pageSize: 20`, `fields: { campaign: [...] }`);
   * `normalizeKlaviyoParams()` translates the latter at call time. */
  params?: Record<string, unknown>;
  tier?: RateLimitTier;
}

export interface KlaviyoPostOptions {
  tier?: RateLimitTier;
}

/**
 * GET a Klaviyo endpoint. Returns the raw JSON:API response.
 * Bracket params (`page[size]`, `fields[campaign]`) are NOT percent-encoded
 * because Klaviyo's parser doesn't handle the encoded form.
 *
 * `params` is normalized through `normalizeKlaviyoParams()` so common
 * JS-idiomatic forms (`pageSize`, `fields: {campaign: [...]}`) translate
 * to the JSON:API bracket forms Klaviyo actually accepts.
 */
export async function klaviyoGet(
  path: string,
  options: KlaviyoGetOptions = {},
): Promise<unknown> {
  const tier = options.tier ?? "standard";
  const params = normalizeKlaviyoParams(options.params ?? {});
  return withRetry(async () => {
    await limiterFor(tier).acquire();
    let url = `${BASE_URL}/${path.replace(/^\//, "")}`;
    if (Object.keys(params).length) {
      url +=
        "?" +
        Object.entries(params)
          .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
          .join("&");
    }
    log("debug", "Klaviyo GET", { url });
    return handleResponse(await fetch(url, { headers: headers() }));
  });
}

/**
 * Translate LLM-friendly param shapes to Klaviyo's JSON:API bracket form.
 * Accepts both shapes so agents that reach for camelCase or nested objects
 * don't waste a roundtrip + retry. Rules:
 *   - `pageSize` → `page[size]`, `pageCursor` → `page[cursor]`
 *   - `fields: { campaign: ['name','status'] }` → `'fields[campaign]': 'name,status'`
 *   - `sort: '-send_time'` → `sort: '-scheduled_at'` (send_time is a response
 *     field but not a valid sort key on /campaigns — silent rewrite spares
 *     a wasted API call + retry. See KLAVIYO_SORT_ALIASES.)
 *   - Any value that's not a string is coerced via String() (booleans/numbers
 *     are valid query values; arrays become comma-joined strings)
 * Already-canonical bracket keys pass through unchanged.
 */
export function normalizeKlaviyoParams(
  input: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null) continue;

    if (key === "fields" && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [resource, value] of Object.entries(raw as Record<string, unknown>)) {
        out[`fields[${resource}]`] = Array.isArray(value)
          ? (value as unknown[]).join(",")
          : String(value);
      }
      continue;
    }
    if (key === "page" && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [sub, value] of Object.entries(raw as Record<string, unknown>)) {
        out[`page[${sub}]`] = String(value);
      }
      continue;
    }

    const alias = KLAVIYO_PARAM_ALIASES[key];
    const canonicalKey = alias ?? key;
    let value = Array.isArray(raw) ? (raw as unknown[]).join(",") : String(raw);
    if (canonicalKey === "sort") {
      value = KLAVIYO_SORT_ALIASES[value] ?? value;
    }
    out[canonicalKey] = value;
  }
  return out;
}

const KLAVIYO_PARAM_ALIASES: Record<string, string> = {
  pageSize: "page[size]",
  pageCursor: "page[cursor]",
  pageCount: "page[count]",
};

/** Sort-value aliases. The LLM reflexively reaches for response-field names
 * (`send_time`, `open_time`, etc.) when sorting, but Klaviyo's API only
 * accepts a narrow allowlist. We silently rewrite the common misreaches to
 * their semantically-equivalent valid sort keys. Both `send_time` and
 * `scheduled_at` order sent campaigns identically in practice, so the
 * rewrite is loss-free for the typical "most recent campaigns" use case. */
const KLAVIYO_SORT_ALIASES: Record<string, string> = {
  send_time: "scheduled_at",
  "-send_time": "-scheduled_at",
};

/**
 * POST to a Klaviyo endpoint. Used primarily for reporting endpoints.
 * Reporting POSTs are cached with a 10-minute TTL — without this, the LLM
 * will re-fetch the slowest endpoints on every sandbox call.
 */
export async function klaviyoPost(
  path: string,
  body: Record<string, unknown>,
  options: KlaviyoPostOptions = {},
): Promise<unknown> {
  const tier = options.tier ?? "standard";
  if (tier === "reporting") {
    const key = buildCacheKey(path, body);
    const cached = reportingCache.get(key);
    if (cached !== undefined) {
      log("debug", "Klaviyo POST cache hit", { path });
      return cached;
    }
  }

  const result = await withRetry(async () => {
    await limiterFor(tier).acquire();
    const url = `${BASE_URL}/${path.replace(/^\//, "")}`;
    log("debug", "Klaviyo POST", { url });
    const res = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    return handleResponse(res);
  });

  if (tier === "reporting") {
    reportingCache.set(buildCacheKey(path, body), result);
  }
  return result;
}

/**
 * Auto-paginate a GET endpoint. Useful for iterating all metrics, lists, etc.
 * Capped at `maxPages` (default 5 → 500 items at default page size) so a runaway
 * loop in the sandbox can't hammer the API.
 */
export async function klaviyoPaginate(
  path: string,
  options: KlaviyoGetOptions & { maxPages?: number } = {},
): Promise<{
  items: Array<{ id: string; type: string; attributes: unknown }>;
  truncated: boolean;
}> {
  const maxPages = options.maxPages ?? 5;
  const items: Array<{ id: string; type: string; attributes: unknown }> = [];
  let params = { ...(options.params ?? {}) };
  let pages = 0;

  while (pages < maxPages) {
    const raw = (await klaviyoGet(path, { params, tier: options.tier })) as {
      data?: Array<{ id: string; type: string; attributes: unknown }>;
      links?: { next?: string };
    };
    items.push(...(raw.data ?? []));
    pages++;

    const nextUrl = raw.links?.next;
    if (!nextUrl) return { items, truncated: false };
    try {
      const cursor = new URL(nextUrl).searchParams.get("page[cursor]");
      if (!cursor) return { items, truncated: false };
      params = { ...(options.params ?? {}), "page[cursor]": cursor };
    } catch {
      return { items, truncated: false };
    }
  }
  return { items, truncated: true };
}

/**
 * Discover the "Placed Order" conversion metric ID required by reporting endpoints.
 * Cached for server lifetime — never changes per-store.
 *
 * The 2026-01-15 revision doesn't allow filtering metrics by name, so we paginate
 * and match client-side. Exact match first, then fuzzy fallback.
 */
export async function getConversionMetricId(): Promise<string> {
  if (config.klaviyoConversionMetricId) {
    metricIdCache.set("placed_order", config.klaviyoConversionMetricId);
    return config.klaviyoConversionMetricId;
  }

  const cached = metricIdCache.get("placed_order");
  if (cached) return cached;

  const { items } = await klaviyoPaginate("metrics", {
    params: { "fields[metric]": "name" },
  });

  const exactNames = ["Placed Order", "Order Placed", "Shopify Placed Order"];
  for (const wanted of exactNames) {
    const m = items.find(
      (item) =>
        String((item.attributes as { name?: string }).name ?? "").toLowerCase() ===
        wanted.toLowerCase(),
    );
    if (m) {
      metricIdCache.set("placed_order", m.id);
      log("info", "Conversion metric discovered (exact)", {
        name: (m.attributes as { name?: string }).name,
        id: m.id,
      });
      return m.id;
    }
  }

  const fuzzy = items.find((item) => {
    const n = String((item.attributes as { name?: string }).name ?? "").toLowerCase();
    if (n.includes("refund") || n.includes("cancel")) return false;
    return (n.includes("placed") && n.includes("order")) || n.includes("purchase");
  });
  if (fuzzy) {
    metricIdCache.set("placed_order", fuzzy.id);
    log("info", "Conversion metric discovered (fuzzy)", {
      name: (fuzzy.attributes as { name?: string }).name,
      id: fuzzy.id,
    });
    return fuzzy.id;
  }

  throw new KlaviyoApiError(
    500,
    'Could not find "Placed Order" metric. Set KLAVIYO_CONVERSION_METRIC_ID to override.',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(): number {
  return Math.floor(Math.random() * 200);
}
