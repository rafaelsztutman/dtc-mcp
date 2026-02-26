import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isShopifyConfigured } from "../../config.js";
import {
  shopifyQuery,
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
  transformCustomerCohort,
  transformRecentOrders,
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

  // ---- Tool 13: Customer Cohort ----
  server.tool(
    "shopify_customer_cohort",
    "New vs returning buyers in the period. Shows first-time vs repeat split.",
    {
      days: z.number().min(1).max(365).default(90),
      limit: z
        .number()
        .min(1)
        .max(500)
        .default(250)
        .describe("Max customers to analyze"),
    },
    async ({ days, limit }) => {
      if (!isShopifyConfigured()) return shopifyNotConfigured();

      try {
        const tz = await getStoreTimezone();
        const sinceDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - days);
        const sinceDateStr = sinceDate.toLocaleDateString("en-CA", { timeZone: tz });

        const query = `
          query($first: Int!, $after: String, $queryStr: String!) {
            customers(first: $first, after: $after, query: $queryStr) {
              nodes {
                id
                email
                numberOfOrders
                amountSpent { amount currencyCode }
                createdAt
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        `;

        const customers = await paginateGraphQL(
          query,
          {
            first: Math.min(limit, 250),
            queryStr: `last_order_date:>=${sinceDateStr}`,
          },
          (data) => {
            const c = data.customers as {
              nodes: unknown[];
              pageInfo: { hasNextPage: boolean; endCursor?: string };
            };
            return { nodes: c.nodes, pageInfo: c.pageInfo };
          },
          Math.ceil(limit / 250),
        );

        const result = transformCustomerCohort(
          customers as Array<{
            id: string;
            email?: string | null;
            numberOfOrders: string;
            amountSpent: { amount: string; currencyCode: string };
            createdAt: string;
          }>,
          days,
        );

        return toolResult(result);
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
