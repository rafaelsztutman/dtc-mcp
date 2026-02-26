import { config, log } from "../../config.js";
import { TTLCache, buildCacheKey } from "../../shared/cache.js";
import { KlaviyoApiError } from "../../shared/errors.js";
import { decodeCursor } from "../../shared/pagination.js";
import type { RateLimitTier } from "../../shared/types.js";

const BASE_URL = "https://a.klaviyo.com/api";

// ---- Caching ----

const REPORTING_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const reportingCache = new TTLCache<unknown>(REPORTING_CACHE_TTL);
const metricIdCache = new TTLCache<string>(Number.MAX_SAFE_INTEGER); // server lifetime

// ---- Rate Limiting ----

class RateLimiter {
  private recentTimestamps: number[] = [];

  constructor(
    private burstPerSecond: number,
    private steadyPerMinute: number,
  ) {}

  async acquire(): Promise<void> {
    const now = Date.now();

    // Clean timestamps older than 60s
    this.recentTimestamps = this.recentTimestamps.filter(
      (t) => now - t < 60_000,
    );

    // Check steady (per-minute) limit
    if (this.recentTimestamps.length >= this.steadyPerMinute) {
      const oldest = this.recentTimestamps[0];
      const waitMs = 60_000 - (now - oldest) + jitter();
      log("debug", `Rate limiter: steady limit hit, waiting ${waitMs}ms`);
      await sleep(waitMs);
    }

    // Check burst (per-second) limit
    const recentSecond = this.recentTimestamps.filter(
      (t) => Date.now() - t < 1_000,
    );
    if (recentSecond.length >= this.burstPerSecond) {
      const waitMs = 1_000 - (Date.now() - recentSecond[0]) + jitter();
      log("debug", `Rate limiter: burst limit hit, waiting ${waitMs}ms`);
      await sleep(waitMs);
    }

    this.recentTimestamps.push(Date.now());
  }
}

// Standard tier: 10/s burst, 150/m steady (campaigns, flows, profiles, etc.)
const standardLimiter = new RateLimiter(10, 150);
// Reporting tier: 1/s burst, 2/m steady (campaign-values-reports, flow-values-reports)
const reportingLimiter = new RateLimiter(1, 2);

function getLimiter(tier: RateLimitTier): RateLimiter {
  return tier === "reporting" ? reportingLimiter : standardLimiter;
}

// ---- HTTP Helpers ----

function buildHeaders(): Record<string, string> {
  return {
    Authorization: `Klaviyo-API-Key ${config.klaviyoApiKey}`,
    revision: config.klaviyoRevision,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function handleResponse(response: Response): Promise<unknown> {
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    throw new KlaviyoApiError(
      429,
      `Rate limited${retryAfter ? `. Retry after ${retryAfter}s` : ""}`,
    );
  }

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body.errors?.[0]?.detail) {
        message = body.errors[0].detail;
      }
    } catch {
      // ignore parse errors
    }
    throw new KlaviyoApiError(response.status, message);
  }

  return response.json();
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (
        error instanceof KlaviyoApiError &&
        error.status === 429 &&
        attempt < maxRetries
      ) {
        const backoff = Math.pow(2, attempt) * 1000 + jitter();
        log("debug", `Retry ${attempt + 1}/${maxRetries} after ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

// ---- Public API ----

/**
 * GET request to Klaviyo API with rate limiting and sparse fieldsets.
 */
export async function klaviyoGet(
  path: string,
  params?: Record<string, string>,
  tier: RateLimitTier = "standard",
): Promise<{
  data: Array<{ id: string; attributes: Record<string, unknown>; relationships?: Record<string, unknown> }>;
  links?: { self?: string; next?: string; prev?: string };
  included?: Array<{ id: string; type: string; attributes: Record<string, unknown> }>;
}> {
  const limiter = getLimiter(tier);

  return withRetry(async () => {
    await limiter.acquire();

    // Build URL with unencoded bracket notation (page[size], fields[campaign], etc.)
    // URLSearchParams percent-encodes brackets which Klaviyo doesn't handle correctly
    let urlStr = `${BASE_URL}/${path.replace(/^\//, "")}`;
    if (params && Object.keys(params).length) {
      const qs = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");
      urlStr += `?${qs}`;
    }

    log("debug", "Klaviyo GET", { url: urlStr });
    const response = await fetch(urlStr, { headers: buildHeaders() });
    return handleResponse(response) as ReturnType<typeof klaviyoGet>;
  });
}

/**
 * POST request to Klaviyo API (primarily for reporting endpoints).
 * Results are cached with 10-minute TTL for reporting tier.
 */
export async function klaviyoPost(
  path: string,
  body: Record<string, unknown>,
  tier: RateLimitTier = "standard",
): Promise<{ results: Array<{ groupings: Record<string, unknown>; statistics: Record<string, number> }> }> {
  // Check cache for reporting requests
  if (tier === "reporting") {
    const cacheKey = buildCacheKey(path, body);
    const cached = reportingCache.get(cacheKey);
    if (cached) {
      log("debug", "Klaviyo POST cache hit", { path });
      return cached as ReturnType<typeof klaviyoPost>;
    }
  }

  const limiter = getLimiter(tier);

  const rawResult = await withRetry(async () => {
    await limiter.acquire();

    const url = `${BASE_URL}/${path.replace(/^\//, "")}`;
    log("debug", "Klaviyo POST", { url, body });

    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(body),
    });
    return handleResponse(response) as unknown as Record<string, unknown>;
  });

  // Unwrap JSON:API envelope: { data: { attributes: { results: [...] } } }
  type ReportResults = Array<{ groupings: Record<string, unknown>; statistics: Record<string, number> }>;
  const data = rawResult.data as Record<string, unknown> | undefined;
  const attributes = data?.attributes as Record<string, unknown> | undefined;
  const result = { results: (attributes?.results ?? []) as ReportResults };

  log("debug", "Klaviyo POST response", {
    hasData: !!data,
    hasAttributes: !!attributes,
    resultCount: result.results.length,
    firstResult: result.results[0] ? JSON.stringify(result.results[0]).slice(0, 300) : "none",
  });

  // Cache reporting results
  if (tier === "reporting") {
    const cacheKey = buildCacheKey(path, body);
    reportingCache.set(cacheKey, result);
  }

  return result;
}

/**
 * Auto-paginate a Klaviyo GET endpoint.
 * Returns all items up to maxPages pages.
 */
export async function klaviyoPaginateAll(
  path: string,
  params?: Record<string, string>,
  maxPages = 3,
  tier: RateLimitTier = "standard",
): Promise<Array<{ id: string; attributes: Record<string, unknown>; relationships?: Record<string, unknown> }>> {
  const allItems: Array<{ id: string; attributes: Record<string, unknown>; relationships?: Record<string, unknown> }> = [];
  let currentParams = { ...params };
  let pages = 0;

  while (pages < maxPages) {
    const response = await klaviyoGet(path, currentParams, tier);
    allItems.push(...(response.data || []));
    pages++;

    if (!response.links?.next) break;

    // Extract cursor from next link
    try {
      const nextUrl = new URL(response.links.next);
      const cursor = nextUrl.searchParams.get("page[cursor]");
      if (!cursor) break;
      currentParams = { ...params, "page[cursor]": cursor };
    } catch {
      break;
    }
  }

  return allItems;
}

/**
 * Fetch a single page with an opaque cursor.
 * Used by tools that expose pagination to the LLM.
 */
export async function klaviyoGetPage(
  path: string,
  params: Record<string, string>,
  cursor?: string,
  tier: RateLimitTier = "standard",
) {
  const pageParams = { ...params };
  if (cursor) {
    pageParams["page[cursor]"] = decodeCursor(cursor);
  }
  return klaviyoGet(path, pageParams, tier);
}

// ---- Conversion Metric ID Discovery ----

/**
 * Get the "Placed Order" metric ID for use in reporting requests.
 * Cached for server lifetime.
 *
 * Discovery strategy (name is not filterable in 2026-01-15 revision):
 * 1. Check KLAVIYO_CONVERSION_METRIC_ID env var
 * 2. Fetch all metrics, search by exact name ("Placed Order", etc.)
 * 3. Fuzzy fallback excluding refund/cancel metrics
 */
export async function getConversionMetricId(): Promise<string> {
  // Check env var override first
  if (config.klaviyoConversionMetricId) {
    log("debug", "Using env var conversion metric ID", { id: config.klaviyoConversionMetricId });
    metricIdCache.set("placed_order", config.klaviyoConversionMetricId);
    return config.klaviyoConversionMetricId;
  }

  const cached = metricIdCache.get("placed_order");
  if (cached) {
    log("debug", "Using cached conversion metric ID", { id: cached });
    return cached;
  }

  // Fetch all metrics — name is not filterable in 2026-01-15 revision,
  // so we paginate and search client-side
  try {
    const allMetrics = await klaviyoPaginateAll("metrics", {
      "fields[metric]": "name",
    });

    log("debug", "Fetched metrics for discovery", {
      count: allMetrics.length,
      names: allMetrics.map((m) => String(m.attributes.name)).slice(0, 20),
    });

    // Priority 1: exact name match
    const candidateNames = ["Placed Order", "Order Placed", "Shopify Placed Order"];
    for (const name of candidateNames) {
      const match = allMetrics.find(
        (m) => String(m.attributes.name ?? "").toLowerCase() === name.toLowerCase(),
      );
      if (match) {
        metricIdCache.set("placed_order", match.id);
        log("info", "Discovered conversion metric (exact match)", {
          name: String(match.attributes.name),
          id: match.id,
        });
        return match.id;
      }
    }

    // Priority 2: fuzzy match — prefer "placed order", exclude refund/cancel
    const fuzzyMatch = allMetrics.find((m) => {
      const n = String(m.attributes.name ?? "").toLowerCase();
      if (n.includes("refund") || n.includes("cancel")) return false;
      return (n.includes("placed") && n.includes("order")) || n.includes("purchase");
    });

    if (fuzzyMatch) {
      metricIdCache.set("placed_order", fuzzyMatch.id);
      log("info", "Discovered conversion metric (fuzzy match)", {
        name: String(fuzzyMatch.attributes.name),
        id: fuzzyMatch.id,
      });
      return fuzzyMatch.id;
    }

    // Log available metrics for debugging
    const names = allMetrics.map((m) => String(m.attributes.name)).slice(0, 20);
    log("warn", "No conversion metric found. Available metrics:", { metrics: names });
  } catch (error) {
    log("warn", "Failed to list metrics for discovery", {
      error: String(error),
    });
  }

  throw new KlaviyoApiError(
    500,
    'Could not find "Placed Order" metric. Set KLAVIYO_CONVERSION_METRIC_ID in your .env ' +
      "to the ID of your conversion metric (find it in Klaviyo → Analytics → Metrics).",
  );
}

// ---- Reporting Helpers ----

/**
 * Build timeframe object for Klaviyo reporting API.
 */
export function buildTimeframe(days: number): Record<string, unknown> {
  if (days <= 7) return { key: "last_7_days" };
  if (days <= 30) return { key: "last_30_days" };
  if (days <= 90) return { key: "last_90_days" };
  if (days <= 365) return { key: "last_365_days" };
  return { key: "last_12_months" };
}

/**
 * Fetch campaign reporting data.
 * Uses reporting tier rate limiting and caching.
 */
export async function getCampaignReport(
  days: number,
  campaignIds?: string[],
): Promise<Array<{ groupings: Record<string, unknown>; statistics: Record<string, number> }>> {
  // Klaviyo limits contains-any filters to 100 items — batch if needed
  if (campaignIds && campaignIds.length > 100) {
    const allResults: Array<{ groupings: Record<string, unknown>; statistics: Record<string, number> }> = [];
    for (let i = 0; i < campaignIds.length; i += 100) {
      const chunk = campaignIds.slice(i, i + 100);
      const chunkResults = await getCampaignReport(days, chunk);
      allResults.push(...chunkResults);
    }
    return allResults;
  }

  const conversionMetricId = await getConversionMetricId();

  const body: Record<string, unknown> = {
    data: {
      type: "campaign-values-report",
      attributes: {
        timeframe: buildTimeframe(days),
        conversion_metric_id: conversionMetricId,
        statistics: [
          "recipients",
          "opens",
          "opens_unique",
          "open_rate",
          "clicks",
          "clicks_unique",
          "click_rate",
          "conversion_value",
          "conversions",
          "conversion_rate",
          "unsubscribes",
          "unsubscribe_rate",
          "bounced",
          "bounce_rate",
          "spam_complaints",
          "spam_complaint_rate",
        ],
        ...(campaignIds?.length
          ? {
              filter: `contains-any(campaign_id,[${campaignIds.map((id) => `"${id}"`).join(",")}])`,
            }
          : {}),
      },
    },
  };

  const result = await klaviyoPost(
    "campaign-values-reports",
    body,
    "reporting",
  );
  return result.results ?? [];
}

/**
 * Fetch flow reporting data.
 * Uses reporting tier rate limiting and caching.
 */
export async function getFlowReport(
  days: number,
  flowIds?: string[],
): Promise<Array<{ groupings: Record<string, unknown>; statistics: Record<string, number> }>> {
  // Klaviyo limits contains-any filters to 100 items — batch if needed
  if (flowIds && flowIds.length > 100) {
    const allResults: Array<{ groupings: Record<string, unknown>; statistics: Record<string, number> }> = [];
    for (let i = 0; i < flowIds.length; i += 100) {
      const chunk = flowIds.slice(i, i + 100);
      const chunkResults = await getFlowReport(days, chunk);
      allResults.push(...chunkResults);
    }
    return allResults;
  }

  const conversionMetricId = await getConversionMetricId();

  const body: Record<string, unknown> = {
    data: {
      type: "flow-values-report",
      attributes: {
        timeframe: buildTimeframe(days),
        conversion_metric_id: conversionMetricId,
        statistics: [
          "recipients",
          "opens",
          "opens_unique",
          "clicks",
          "clicks_unique",
          "conversion_value",
          "conversions",
          "conversion_rate",
          "unsubscribes",
        ],
        ...(flowIds?.length
          ? {
              filter: `contains-any(flow_id,[${flowIds.map((id) => `"${id}"`).join(",")}])`,
            }
          : {}),
      },
    },
  };

  const result = await klaviyoPost("flow-values-reports", body, "reporting");
  return result.results ?? [];
}

// ---- Utilities ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(): number {
  return Math.floor(Math.random() * 200);
}
