import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isShopifyConfigured } from "../../config.js";
import {
  shopifyQuery,
  shopifyqlQuery,
  getAggregatedSales,
  getTimeSeriesSales,
  getStoreTimezone,
  paginateGraphQL,
} from "./client.js";
import {
  transformSalesSummary,
  transformSalesTimeSeries,
  transformProductPerformance,
  transformOrders,
  transformInventoryAlerts,
  transformRecentOrders,
  transformCustomerCohorts,
  transformCustomerSegments,
  transformSalesBreakdown,
  transformProductAnalytics,
  transformTrafficSources,
  transformReturnsAnalysis,
} from "./transforms.js";
import {
  formatError,
  shopifyNotConfigured,
  toolResult,
} from "../../shared/errors.js";

export function registerShopifyTools(server: McpServer): void {
  // ---- Tool 9: Sales Summary ----
  server.tool(
    "shopify_sales_summary",
    "Revenue, orders, AOV for a period with comparison.",
    {
      days: z.number().min(1).max(90).default(30),
      compare_previous: z
        .boolean()
        .default(true)
        .describe("Include previous period comparison"),
    },
    async ({ days, compare_previous }) => {
      if (!isShopifyConfigured()) return shopifyNotConfigured();

      try {
        const current = await getAggregatedSales(days);

        let previous;
        if (compare_previous) {
          // Fetch double the range and subtract current to get previous period
          const doublePeriod = await getAggregatedSales(days * 2);
          previous = {
            grossRevenue: Math.max(0, doublePeriod.grossRevenue - current.grossRevenue),
            netRevenue: Math.max(0, doublePeriod.netRevenue - current.netRevenue),
            orderCount: Math.max(0, doublePeriod.orderCount - current.orderCount),
          };
        }

        const result = transformSalesSummary(current, days, previous);
        return toolResult({ ...result, data_source: current.source });
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 10: Product Performance ----
  server.tool(
    "shopify_product_performance",
    "Top products by revenue or units. Default 7d — longer periods may be slow.",
    {
      days: z.number().min(1).max(90).default(7),
      metric: z.enum(["revenue", "units"]).default("revenue"),
      limit: z.number().min(1).max(25).default(10),
    },
    async ({ days, metric, limit }) => {
      if (!isShopifyConfigured()) return shopifyNotConfigured();

      try {
        const tz = await getStoreTimezone();
        const sinceDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - days);
        const sinceDateStr = sinceDate.toLocaleDateString("en-CA", { timeZone: tz });
        const query = `
          query($first: Int!, $after: String, $queryStr: String!) {
            orders(first: $first, after: $after, query: $queryStr) {
              nodes {
                lineItems(first: 50) {
                  nodes {
                    name
                    product { id title }
                    quantity
                    originalTotalSet { shopMoney { amount } }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        `;

        const orders = await paginateGraphQL(
          query,
          {
            first: 50,
            queryStr: `created_at:>=${sinceDateStr}`,
          },
          (data) => {
            const orders = data.orders as {
              nodes: unknown[];
              pageInfo: { hasNextPage: boolean; endCursor?: string };
            };
            return { nodes: orders.nodes, pageInfo: orders.pageInfo };
          },
          days <= 7 ? 10 : 5, // fewer pages for longer periods
        );

        const result = transformProductPerformance(
          orders as Array<{
            lineItems: {
              nodes: Array<{
                name: string;
                product?: { id: string; title: string } | null;
                quantity: number;
                originalTotalSet?: { shopMoney?: { amount: string } };
              }>;
            };
          }>,
          limit,
          metric,
        );

        return toolResult({
          products: result,
          period_days: days,
          ranked_by: metric,
        });
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 11: Order Search ----
  server.tool(
    "shopify_order_search",
    "Find orders by number, email, or status. Key fields only.",
    {
      query: z
        .string()
        .describe(
          "Search query: order number (#1001), email, or financial_status:paid",
        ),
      limit: z.number().min(1).max(25).default(10),
    },
    async ({ query: searchQuery, limit }) => {
      if (!isShopifyConfigured()) return shopifyNotConfigured();

      try {
        const gqlQuery = `
          query($first: Int!, $queryStr: String!) {
            orders(first: $first, query: $queryStr) {
              nodes {
                name
                email
                createdAt
                totalPriceSet { shopMoney { amount currencyCode } }
                displayFinancialStatus
                displayFulfillmentStatus
                lineItems(first: 10) {
                  nodes {
                    name
                    quantity
                    originalUnitPriceSet { shopMoney { amount } }
                  }
                }
              }
            }
          }
        `;

        const data = await shopifyQuery<{
          orders: {
            nodes: Array<{
              name: string;
              email?: string | null;
              createdAt: string;
              totalPriceSet: {
                shopMoney: { amount: string; currencyCode: string };
              };
              displayFinancialStatus: string;
              displayFulfillmentStatus: string;
              lineItems: {
                nodes: Array<{
                  name: string;
                  quantity: number;
                  originalUnitPriceSet: { shopMoney: { amount: string } };
                }>;
              };
            }>;
          };
        }>(gqlQuery, { first: limit, queryStr: searchQuery });

        const result = transformOrders(data.orders.nodes);
        return toolResult({ orders: result });
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 12: Inventory Alerts ----
  server.tool(
    "shopify_inventory_alerts",
    "Products with low or zero stock. Sorted by most urgent first.",
    {
      threshold: z
        .number()
        .default(10)
        .describe("Alert when inventory at or below this number"),
      limit: z.number().min(1).max(50).default(20),
    },
    async ({ threshold, limit }) => {
      if (!isShopifyConfigured()) return shopifyNotConfigured();

      try {
        const query = `
          query($first: Int!, $after: String) {
            productVariants(first: $first, after: $after) {
              nodes {
                displayName
                sku
                inventoryQuantity
                product { title }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        `;

        const variants = await paginateGraphQL(
          query,
          { first: 250 },
          (data) => {
            const pv = data.productVariants as {
              nodes: unknown[];
              pageInfo: { hasNextPage: boolean; endCursor?: string };
            };
            return { nodes: pv.nodes, pageInfo: pv.pageInfo };
          },
          3,
        );

        const alerts = transformInventoryAlerts(
          variants as Array<{
            displayName: string;
            sku: string | null;
            inventoryQuantity: number;
            product: { title: string };
          }>,
          threshold,
        );

        return toolResult({ alerts: alerts.slice(0, limit) });
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 13: Customer Cohorts (ShopifyQL) ----
  server.tool(
    "shopify_customer_cohorts",
    "Monthly/quarterly acquisition cohorts with LTV and retention.",
    {
      granularity: z
        .enum(["monthly", "quarterly"])
        .default("monthly")
        .describe("Cohort grouping"),
      months: z.number().min(1).max(36).default(24),
    },
    async ({ granularity, months }) => {
      if (!isShopifyConfigured()) return shopifyNotConfigured();

      try {
        const cohortKey = granularity === "monthly" ? "customer_cohort_month" : "customer_cohort_quarter";
        // Fetch months+1 to buffer for partial oldest month, then trim it
        const ql = `FROM customers SHOW new_customer_records, total_amount_spent, total_amount_spent_per_order, total_number_of_orders, days_since_last_order GROUP BY ${cohortKey} SINCE -${months + 1}m UNTIL today ORDER BY ${cohortKey} DESC`;
        const result = await shopifyqlQuery(ql);
        const rows = result.rows.length > 1 ? result.rows.slice(0, -1) : result.rows;
        return toolResult(transformCustomerCohorts(rows, granularity, months));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 13b: Customer Segments (ShopifyQL) ----
  server.tool(
    "shopify_customer_segments",
    "Customer distribution by RFM, spend tier, country, or tags.",
    {
      dimension: z
        .enum([
          "rfm_group",
          "predicted_spend_tier",
          "customer_email_subscription_status",
          "customer_sms_subscription_status",
          "customer_country",
          "customer_tag",
          "customer_number_of_orders",
        ])
        .describe("Segmentation dimension"),
      months: z.number().min(1).max(24).default(12),
      limit: z.number().min(1).max(50).default(20),
    },
    async ({ dimension, months, limit }) => {
      if (!isShopifyConfigured()) return shopifyNotConfigured();

      try {
        const ql = `FROM customers SHOW percent_of_customers, total_amount_spent, total_number_of_orders, new_customer_records GROUP BY ${dimension} SINCE -${months}m UNTIL today ORDER BY total_amount_spent DESC LIMIT ${limit}`;
        const result = await shopifyqlQuery(ql);
        return toolResult(transformCustomerSegments(result.rows, dimension, months));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 13c: Sales Breakdown (ShopifyQL) ----
  server.tool(
    "shopify_sales_breakdown",
    "Revenue/orders by country, channel, vendor, or traffic source.",
    {
      dimension: z
        .enum([
          "billing_country",
          "billing_region",
          "channel_name",
          "product_vendor",
          "referrer_source",
          "referring_channel",
          "referring_platform",
          "traffic_type",
          "shipping_country",
        ])
        .describe("Breakdown dimension"),
      days: z.number().min(1).max(365).default(30),
      metric: z
        .enum(["total_sales", "net_sales", "orders", "average_order_value", "gross_profit"])
        .default("net_sales"),
      limit: z.number().min(1).max(50).default(10),
    },
    async ({ dimension, days, metric, limit }) => {
      if (!isShopifyConfigured()) return shopifyNotConfigured();

      try {
        const ql = `FROM sales SHOW ${metric}, orders GROUP BY ${dimension} SINCE -${days}d UNTIL today ORDER BY ${metric} DESC LIMIT ${limit}`;
        const result = await shopifyqlQuery(ql);
        return toolResult(transformSalesBreakdown(result.rows, dimension, metric, days));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 13d: Product Analytics (ShopifyQL) ----
  server.tool(
    "shopify_product_analytics",
    "Product performance with margins, returns, and quantities.",
    {
      days: z.number().min(1).max(365).default(30),
      metric: z
        .enum(["net_sales", "gross_sales", "orders", "gross_profit"])
        .default("net_sales")
        .describe("Sort products by this metric"),
      limit: z.number().min(1).max(50).default(10),
    },
    async ({ days, metric, limit }) => {
      if (!isShopifyConfigured()) return shopifyNotConfigured();

      try {
        const ql = `FROM sales SHOW net_sales, gross_sales, orders, gross_profit, quantity_ordered, returns GROUP BY product_title SINCE -${days}d UNTIL today ORDER BY ${metric} DESC LIMIT ${limit}`;
        const result = await shopifyqlQuery(ql);
        return toolResult(transformProductAnalytics(result.rows, days, metric));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 13e: Traffic Sources (ShopifyQL) ----
  server.tool(
    "shopify_traffic_sources",
    "Sessions by source, landing page, or daily trend.",
    {
      mode: z
        .enum(["sources", "landing_pages", "trend"])
        .default("sources")
        .describe("Analysis mode"),
      days: z.number().min(1).max(365).default(30),
      limit: z.number().min(1).max(50).default(10),
    },
    async ({ mode, days, limit }) => {
      if (!isShopifyConfigured()) return shopifyNotConfigured();

      try {
        let ql: string;
        let sourceField: string;

        if (mode === "sources") {
          sourceField = "referrer_source";
          ql = `FROM sessions SHOW sessions GROUP BY referrer_source SINCE -${days}d UNTIL today ORDER BY sessions DESC LIMIT ${limit}`;
        } else if (mode === "landing_pages") {
          sourceField = "session_landing_page";
          ql = `FROM sessions SHOW sessions GROUP BY session_landing_page SINCE -${days}d UNTIL today ORDER BY sessions DESC LIMIT ${limit}`;
        } else {
          sourceField = "day";
          ql = `FROM sessions SHOW sessions GROUP BY day SINCE -${days}d UNTIL today ORDER BY day ASC`;
        }

        const result = await shopifyqlQuery(ql);
        return toolResult(transformTrafficSources(result.rows, mode, days, sourceField));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 13f: Returns Analysis (ShopifyQL) ----
  server.tool(
    "shopify_returns_analysis",
    "Return rates, costs, and most-returned products.",
    {
      mode: z
        .enum(["summary", "by_product"])
        .default("summary")
        .describe("Summary totals or per-product breakdown"),
      days: z.number().min(1).max(365).default(30),
      limit: z.number().min(1).max(50).default(10),
    },
    async ({ mode, days, limit }) => {
      if (!isShopifyConfigured()) return shopifyNotConfigured();

      try {
        let ql: string;

        if (mode === "summary") {
          ql = `FROM sales SHOW returns, total_returns, gross_returns, net_returns, quantity_returned, returned_quantity_rate, return_fees SINCE -${days}d UNTIL today`;
        } else {
          ql = `FROM sales SHOW returns, quantity_returned, net_sales, quantity_ordered GROUP BY product_title SINCE -${days}d UNTIL today ORDER BY returns ASC LIMIT ${limit}`;
        }

        const result = await shopifyqlQuery(ql);
        return toolResult(transformReturnsAnalysis(result.rows, mode, days));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 14: Recent Orders ----
  server.tool(
    "shopify_recent_orders",
    "Most recent orders. Quick snapshot of store activity.",
    {
      limit: z.number().min(1).max(25).default(10),
    },
    async ({ limit }) => {
      if (!isShopifyConfigured()) return shopifyNotConfigured();

      try {
        const query = `
          query($first: Int!) {
            orders(first: $first, sortKey: CREATED_AT, reverse: true) {
              nodes {
                name
                email
                createdAt
                totalPriceSet { shopMoney { amount currencyCode } }
                displayFinancialStatus
                displayFulfillmentStatus
              }
            }
          }
        `;

        const data = await shopifyQuery<{
          orders: {
            nodes: Array<{
              name: string;
              email?: string | null;
              createdAt: string;
              totalPriceSet: {
                shopMoney: { amount: string; currencyCode: string };
              };
              displayFinancialStatus: string;
              displayFulfillmentStatus: string;
            }>;
          };
        }>(query, { first: limit });

        const result = transformRecentOrders(data.orders.nodes);
        return toolResult({ orders: result });
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 15: Sales Time Series ----
  server.tool(
    "shopify_sales_timeseries",
    "Revenue and orders broken down by day, week, or month.",
    {
      days: z.number().min(1).max(365).default(30),
      granularity: z
        .enum(["daily", "weekly", "monthly"])
        .default("daily")
        .describe("Time bucket size"),
    },
    async ({ days, granularity }) => {
      if (!isShopifyConfigured()) return shopifyNotConfigured();

      try {
        const tz = await getStoreTimezone();
        const { buckets, source } = await getTimeSeriesSales(days, granularity);
        const result = transformSalesTimeSeries(buckets, days, granularity, tz);
        return toolResult({ ...result, data_source: source });
      } catch (error) {
        return formatError(error);
      }
    },
  );
}
