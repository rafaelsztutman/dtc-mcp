import { config, log } from "../../config.js";
import { ShopifyApiError } from "../../shared/errors.js";
import { TTLCache } from "../../shared/cache.js";

const cache = new TTLCache<unknown>(5 * 60 * 1000); // 5-minute TTL

// ---- Token Manager (Client Credentials Grant) ----

class ShopifyTokenManager {
  private accessToken: string | null = null;
  private expiresAt = 0;

  async getAccessToken(): Promise<string> {
    // Legacy mode: return static token directly
    if (config.shopifyAuthMode === "legacy") {
      return config.shopifyAccessToken!;
    }

    // Client credentials mode: use cached token if still valid
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) {
      return this.accessToken;
    }

    return this.refreshToken();
  }

  private async refreshToken(): Promise<string> {
    log("info", "Acquiring Shopify access token via Client Credentials Grant");

    const url = `https://${config.shopifyStore}/admin/oauth/access_token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.shopifyClientId!,
      client_secret: config.shopifyClientSecret!,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ShopifyApiError(
        `Token request failed (${response.status}): ${text}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    log("info", "Shopify access token acquired", {
      expiresIn: `${Math.round(data.expires_in / 3600)}h`,
    });

    return this.accessToken;
  }
}

const tokenManager = new ShopifyTokenManager();

// ---- Cost-based Rate Limiting ----

class CostTracker {
  private availablePoints = 1000;
  private lastUpdated = Date.now();
  private readonly restoreRate = 50; // points per second

  async waitForCapacity(estimatedCost: number): Promise<void> {
    this.restorePoints();

    if (this.availablePoints >= estimatedCost) return;

    const deficit = estimatedCost - this.availablePoints;
    const waitMs = (deficit / this.restoreRate) * 1000 + 100;
    log("debug", `Shopify rate limit: waiting ${Math.round(waitMs)}ms for ${deficit} points`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.restorePoints();
  }

  updateFromResponse(extensions?: {
    cost?: {
      requestedQueryCost?: number;
      actualQueryCost?: number;
      throttleStatus?: { currentlyAvailable?: number };
    };
  }): void {
    if (extensions?.cost?.throttleStatus?.currentlyAvailable !== undefined) {
      this.availablePoints = extensions.cost.throttleStatus.currentlyAvailable;
      this.lastUpdated = Date.now();
    }
  }

  private restorePoints(): void {
    const elapsed = (Date.now() - this.lastUpdated) / 1000;
    this.availablePoints = Math.min(
      1000,
      this.availablePoints + elapsed * this.restoreRate,
    );
    this.lastUpdated = Date.now();
  }
}

const costTracker = new CostTracker();

// ---- GraphQL Client ----

function getEndpoint(): string {
  return `https://${config.shopifyStore}/admin/api/${config.shopifyApiVersion}/graphql.json`;
}

async function buildHeaders(): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": await tokenManager.getAccessToken(),
  };
}

/**
 * Execute a GraphQL query against Shopify Admin API.
 */
export async function shopifyQuery<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
  estimatedCost = 10,
): Promise<T> {
  await costTracker.waitForCapacity(estimatedCost);

  const response = await fetchWithRetry(query, variables);
  const json = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
    extensions?: {
      cost?: {
        requestedQueryCost?: number;
        actualQueryCost?: number;
        throttleStatus?: { currentlyAvailable?: number };
      };
    };
  };

  costTracker.updateFromResponse(json.extensions);

  if (json.errors?.length) {
    const throttled = json.errors.find(
      (e) => e.extensions?.code === "THROTTLED",
    );
    if (throttled) {
      // Wait and retry once
      log("debug", "Shopify THROTTLED, retrying...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return shopifyQuery(query, variables, estimatedCost);
    }
    throw new ShopifyApiError(
      json.errors.map((e) => e.message).join("; "),
    );
  }

  if (!json.data) {
    throw new ShopifyApiError("No data in GraphQL response");
  }

  return json.data;
}

async function fetchWithRetry(
  query: string,
  variables?: Record<string, unknown>,
  maxRetries = 3,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(getEndpoint(), {
        method: "POST",
        headers: await buildHeaders(),
        body: JSON.stringify({ query, variables }),
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 2000;
        log("debug", `Shopify 429, waiting ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      if (!response.ok) {
        throw new ShopifyApiError(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const backoff = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  throw lastError;
}

// ---- ShopifyQL Helper ----

export interface ShopifyQLColumn {
  name: string;
  dataType: string;
  displayName: string;
}

export interface ShopifyQLResult {
  columns: ShopifyQLColumn[];
  rows: Record<string, string>[];
}

/**
 * Execute a ShopifyQL query for pre-aggregated analytics data.
 */
export async function shopifyqlQuery(ql: string): Promise<ShopifyQLResult> {
  const cacheKey = `shopifyql:${ql}`;
  const cached = cache.get(cacheKey) as ShopifyQLResult | undefined;
  if (cached) return cached;

  const query = `
    query ShopifyQL($query: String!) {
      shopifyqlQuery(query: $query) {
        tableData {
          columns {
            name
            dataType
            displayName
          }
          rows
        }
        parseErrors
      }
    }
  `;

  const data = await shopifyQuery<{
    shopifyqlQuery: {
      tableData?: { columns: ShopifyQLColumn[]; rows: Record<string, string>[] };
      parseErrors?: string[];
    };
  }>(query, { query: ql }, 5);

  if (data.shopifyqlQuery.parseErrors?.length) {
    throw new ShopifyApiError(
      `ShopifyQL parse error: ${data.shopifyqlQuery.parseErrors.join(", ")}`,
    );
  }

  if (!data.shopifyqlQuery.tableData) {
    throw new ShopifyApiError("No table data in ShopifyQL response");
  }

  const result: ShopifyQLResult = {
    columns: data.shopifyqlQuery.tableData.columns,
    rows: data.shopifyqlQuery.tableData.rows,
  };

  cache.set(cacheKey, result);
  return result;
}

// ---- Store Timezone ----

let storeTimezoneCache: string | null = null;

export async function getStoreTimezone(): Promise<string> {
  if (storeTimezoneCache) return storeTimezoneCache;

  const data = await shopifyQuery<{ shop: { ianaTimezone: string } }>(
    `{ shop { ianaTimezone } }`,
    undefined,
    1,
  );

  storeTimezoneCache = data.shop.ianaTimezone;
  log("debug", "Store timezone", { tz: storeTimezoneCache });
  return storeTimezoneCache;
}

/**
 * Get a YYYY-MM-DD date string in the store's timezone, offset by N days from today.
 */
function dateInTimezone(tz: string, offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() - offsetDays);
  // en-CA locale gives YYYY-MM-DD format
  return date.toLocaleDateString("en-CA", { timeZone: tz });
}

// ---- Aggregated Sales (ShopifyQL → GraphQL fallback) ----

export type SalesSource = "shopifyql" | "graphql_orders";

export async function getAggregatedSales(
  days: number,
): Promise<{ grossRevenue: number; netRevenue: number; orderCount: number; source: SalesSource }> {
  const tz = await getStoreTimezone();

  // Try ShopifyQL first (fast, single API call, server-side aggregation)
  try {
    const ql = `FROM sales SHOW gross_sales, net_sales, orders SINCE -${days}d UNTIL today`;
    const result = await shopifyqlQuery(ql);
    if (result.rows?.length) {
      const row = result.rows[0];
      return {
        grossRevenue: parseFloat(row.gross_sales) || 0,
        netRevenue: parseFloat(row.net_sales) || 0,
        orderCount: parseInt(row.orders) || 0,
        source: "shopifyql",
      };
    }
  } catch (error) {
    log("debug", "ShopifyQL unavailable, falling back to GraphQL orders", {
      error: String(error),
    });
  }

  // Fallback: paginate orders via GraphQL and sum client-side
  const sinceDate = dateInTimezone(tz, days);

  const query = `
    query($first: Int!, $after: String, $queryStr: String!) {
      orders(first: $first, after: $after, query: $queryStr, sortKey: CREATED_AT) {
        nodes {
          subtotalPriceSet { shopMoney { amount } }
          currentSubtotalPriceSet { shopMoney { amount } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const orders = await paginateGraphQL(
    query,
    {
      first: 250,
      queryStr: `created_at:>=${sinceDate} -status:cancelled`,
    },
    (data) => {
      const o = data.orders as {
        nodes: unknown[];
        pageInfo: { hasNextPage: boolean; endCursor?: string };
      };
      return { nodes: o.nodes, pageInfo: o.pageInfo };
    },
    10, // max 2500 orders
  );

  let grossRevenue = 0;
  let netRevenue = 0;
  for (const order of orders as Array<{
    subtotalPriceSet: { shopMoney: { amount: string } };
    currentSubtotalPriceSet: { shopMoney: { amount: string } };
  }>) {
    grossRevenue += parseFloat(order.subtotalPriceSet.shopMoney.amount) || 0;
    netRevenue += parseFloat(order.currentSubtotalPriceSet.shopMoney.amount) || 0;
  }

  return {
    grossRevenue: Math.round(grossRevenue * 100) / 100,
    netRevenue: Math.round(netRevenue * 100) / 100,
    orderCount: orders.length,
    source: "graphql_orders",
  };
}

// ---- Time-Series Sales (ShopifyQL → GraphQL fallback) ----

export interface RawSalesBucket {
  date: string;
  grossRevenue: number;
  netRevenue: number;
  orderCount: number;
}

type Granularity = "daily" | "weekly" | "monthly";

const SHOPIFYQL_GROUP: Record<Granularity, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
};

/**
 * Get sales data broken down by day, week, or month.
 */
export async function getTimeSeriesSales(
  days: number,
  granularity: Granularity,
): Promise<{ buckets: RawSalesBucket[]; source: SalesSource }> {
  const tz = await getStoreTimezone();

  // Try ShopifyQL first (server-side aggregation)
  try {
    const groupBy = SHOPIFYQL_GROUP[granularity];
    const ql = `FROM sales SHOW gross_sales, net_sales, orders GROUP BY ${groupBy} SINCE -${days}d UNTIL today ORDER BY ${groupBy} ASC`;
    const result = await shopifyqlQuery(ql);

    if (result.rows?.length) {
      const buckets: RawSalesBucket[] = result.rows.map((row) => ({
        date: row[groupBy] ?? "",
        grossRevenue: parseFloat(row.gross_sales) || 0,
        netRevenue: parseFloat(row.net_sales) || 0,
        orderCount: parseInt(row.orders) || 0,
      }));

      return { buckets, source: "shopifyql" };
    }
  } catch (error) {
    log("debug", "ShopifyQL unavailable for time-series, falling back to GraphQL", {
      error: String(error),
    });
  }

  // Fallback: paginate orders and bucket client-side
  const sinceDate = dateInTimezone(tz, days);

  const query = `
    query($first: Int!, $after: String, $queryStr: String!) {
      orders(first: $first, after: $after, query: $queryStr, sortKey: CREATED_AT) {
        nodes {
          createdAt
          subtotalPriceSet { shopMoney { amount } }
          currentSubtotalPriceSet { shopMoney { amount } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const orders = await paginateGraphQL(
    query,
    {
      first: 250,
      queryStr: `created_at:>=${sinceDate} -status:cancelled`,
    },
    (data) => {
      const o = data.orders as {
        nodes: unknown[];
        pageInfo: { hasNextPage: boolean; endCursor?: string };
      };
      return { nodes: o.nodes, pageInfo: o.pageInfo };
    },
    10,
  );

  // Group into buckets
  const bucketMap = new Map<string, { grossRevenue: number; netRevenue: number; orderCount: number }>();

  for (const order of orders as Array<{
    createdAt: string;
    subtotalPriceSet: { shopMoney: { amount: string } };
    currentSubtotalPriceSet: { shopMoney: { amount: string } };
  }>) {
    const key = bucketKey(order.createdAt, granularity, tz);
    const existing = bucketMap.get(key) ?? { grossRevenue: 0, netRevenue: 0, orderCount: 0 };
    existing.grossRevenue += parseFloat(order.subtotalPriceSet.shopMoney.amount) || 0;
    existing.netRevenue += parseFloat(order.currentSubtotalPriceSet.shopMoney.amount) || 0;
    existing.orderCount += 1;
    bucketMap.set(key, existing);
  }

  const buckets: RawSalesBucket[] = Array.from(bucketMap.entries())
    .map(([date, data]) => ({
      date,
      grossRevenue: data.grossRevenue,
      netRevenue: data.netRevenue,
      orderCount: data.orderCount,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { buckets, source: "graphql_orders" };
}

function bucketKey(createdAt: string, granularity: Granularity, tz: string): string {
  const dateStr = new Date(createdAt).toLocaleDateString("en-CA", { timeZone: tz });
  if (granularity === "daily") return dateStr;
  if (granularity === "monthly") return dateStr.substring(0, 7);
  // weekly: find Monday of that week
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().substring(0, 10);
}

// ---- Pagination Helper ----

interface PageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}

/**
 * Auto-paginate a Shopify GraphQL query.
 */
export async function paginateGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  extractPage: (data: Record<string, unknown>) => {
    nodes: T[];
    pageInfo: PageInfo;
  },
  maxPages = 5,
  estimatedCostPerPage = 10,
): Promise<T[]> {
  const allItems: T[] = [];
  let cursor: string | null = null;
  let pages = 0;

  while (pages < maxPages) {
    const vars = { ...variables, after: cursor };
    const data = await shopifyQuery<Record<string, unknown>>(
      query,
      vars,
      estimatedCostPerPage,
    );

    const page = extractPage(data);
    allItems.push(...page.nodes);
    pages++;

    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
    cursor = page.pageInfo.endCursor;
  }

  return allItems;
}
