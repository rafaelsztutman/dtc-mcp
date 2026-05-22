import { config, log } from "../../config.js";
import { ShopifyApiError } from "../../shared/errors.js";
import { TTLCache } from "../../shared/cache.js";

const qlCache = new TTLCache<unknown>(5 * 60 * 1000);

// ---- Token Manager: dual-mode auth (Client Credentials / legacy) ----
//
// Client Credentials Grant: exchange client_id/secret for a short-lived access
// token. We cache with a 60s buffer before expiry to avoid mid-flight refresh races.
// Legacy: a static `shpat_...` token, passed through.
class TokenManager {
  private accessToken: string | null = null;
  private expiresAt = 0;

  async get(): Promise<string> {
    if (config.shopifyAuthMode === "legacy") {
      return config.shopifyAccessToken!;
    }
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) {
      return this.accessToken;
    }
    return this.refresh();
  }

  private async refresh(): Promise<string> {
    log("info", "Acquiring Shopify access token (Client Credentials)");
    const url = `https://${config.shopifyStore}/admin/oauth/access_token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.shopifyClientId!,
      client_secret: config.shopifyClientSecret!,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new ShopifyApiError(`Token request failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    log("info", "Shopify token acquired", {
      expiresIn: `${Math.round(data.expires_in / 3600)}h`,
    });
    return this.accessToken;
  }
}

const tokenManager = new TokenManager();

// ---- Cost-based throttle (Shopify GraphQL cost budget) ----
//
// Shopify returns `extensions.cost.throttleStatus.currentlyAvailable` on every
// GraphQL response. We mirror their bucket (1000 capacity, 50/s restore) and
// wait when a query would overdraw it. Misjudging this = hard throttle errors,
// so we keep the original implementation's tuning.
class CostTracker {
  private available = 1000;
  private lastUpdated = Date.now();
  private readonly restoreRate = 50;

  async wait(estimatedCost: number): Promise<void> {
    this.restore();
    if (this.available >= estimatedCost) return;
    const deficit = estimatedCost - this.available;
    const wait = (deficit / this.restoreRate) * 1000 + 100;
    log("debug", `Shopify wait ${Math.round(wait)}ms for ${deficit} cost`);
    await new Promise((r) => setTimeout(r, wait));
    this.restore();
  }

  update(ext?: {
    cost?: { throttleStatus?: { currentlyAvailable?: number } };
  }): void {
    const v = ext?.cost?.throttleStatus?.currentlyAvailable;
    if (v !== undefined) {
      this.available = v;
      this.lastUpdated = Date.now();
    }
  }

  private restore(): void {
    const elapsed = (Date.now() - this.lastUpdated) / 1000;
    this.available = Math.min(1000, this.available + elapsed * this.restoreRate);
    this.lastUpdated = Date.now();
  }
}

const costTracker = new CostTracker();

function endpoint(): string {
  return `https://${config.shopifyStore}/admin/api/${config.shopifyApiVersion}/graphql.json`;
}

async function gqlHeaders(): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": await tokenManager.get(),
  };
}

export interface ShopifyGqlOptions {
  variables?: Record<string, unknown>;
  estimatedCost?: number;
}

/**
 * Run a GraphQL query against Shopify Admin API. Cost-budget aware: waits
 * until enough capacity restores before sending. Auto-retries once on THROTTLED.
 */
export async function shopifyGql<T = unknown>(
  query: string,
  options: ShopifyGqlOptions = {},
): Promise<T> {
  const cost = options.estimatedCost ?? 10;
  await costTracker.wait(cost);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(endpoint(), {
        method: "POST",
        headers: await gqlHeaders(),
        body: JSON.stringify({ query, variables: options.variables }),
      });
      if (res.status === 429) {
        const ra = res.headers.get("Retry-After");
        await new Promise((r) =>
          setTimeout(r, ra ? parseInt(ra) * 1000 : 2000),
        );
        continue;
      }
      if (!res.ok) {
        throw new ShopifyApiError(`HTTP ${res.status}: ${res.statusText}`);
      }
      const json = (await res.json()) as {
        data?: T;
        errors?: Array<{ message: string; extensions?: { code?: string } }>;
        extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number } } };
      };
      costTracker.update(json.extensions);

      if (json.errors?.length) {
        const throttled = json.errors.find(
          (e) => e.extensions?.code === "THROTTLED",
        );
        if (throttled && attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw new ShopifyApiError(json.errors.map((e) => e.message).join("; "));
      }
      if (!json.data) {
        throw new ShopifyApiError("No data in GraphQL response");
      }
      return json.data;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }
  throw lastErr;
}

export interface ShopifyQLTable {
  columns: Array<{ name: string; dataType: string; displayName: string }>;
  rows: Record<string, string>[];
}

/**
 * Run a ShopifyQL query. Results cached 5 minutes — repeat queries from the
 * LLM (common when it's iterating an analysis) skip the API round-trip.
 */
export async function shopifyQL(ql: string): Promise<ShopifyQLTable> {
  const key = `ql:${ql}`;
  const cached = qlCache.get(key) as ShopifyQLTable | undefined;
  if (cached) return cached;

  const data = await shopifyGql<{
    shopifyqlQuery: {
      tableData?: { columns: ShopifyQLTable["columns"]; rows: ShopifyQLTable["rows"] };
      parseErrors?: string[];
    };
  }>(
    `query ShopifyQL($q: String!) {
      shopifyqlQuery(query: $q) {
        tableData { columns { name dataType displayName } rows }
        parseErrors
      }
    }`,
    { variables: { q: ql }, estimatedCost: 5 },
  );

  if (data.shopifyqlQuery.parseErrors?.length) {
    throw new ShopifyApiError(
      `ShopifyQL parse error: ${data.shopifyqlQuery.parseErrors.join(", ")}`,
    );
  }
  if (!data.shopifyqlQuery.tableData) {
    throw new ShopifyApiError("No table data");
  }
  const result: ShopifyQLTable = {
    columns: data.shopifyqlQuery.tableData.columns,
    rows: data.shopifyqlQuery.tableData.rows,
  };
  qlCache.set(key, result);
  return result;
}

let tzCache: string | null = null;
export async function shopifyTimezone(): Promise<string> {
  if (tzCache) return tzCache;
  const data = await shopifyGql<{ shop: { ianaTimezone: string } }>(
    `{ shop { ianaTimezone } }`,
    { estimatedCost: 1 },
  );
  tzCache = data.shop.ianaTimezone;
  return tzCache;
}
