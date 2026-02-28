import type {
  SalesSummary,
  SalesTimeSeries,
  SalesBucket,
  ProductPerformanceItem,
  OrderSearchItem,
  InventoryAlertItem,
  CustomerCohorts,
  CustomerSegments,
  SalesBreakdown,
  ProductAnalytics,
  TrafficSources,
  ReturnsAnalysis,
  RecentOrderItem,
} from "../../shared/types.js";
import type { RawSalesBucket } from "./client.js";

// ---- Sales Summary ----

export interface SalesData {
  grossRevenue: number;
  netRevenue: number;
  orderCount: number;
}

export function transformSalesSummary(
  current: SalesData,
  days: number,
  previous?: SalesData,
): SalesSummary {
  const result: SalesSummary = {
    period: `last_${days}_days`,
    gross_revenue: current.grossRevenue,
    net_revenue: current.netRevenue,
    order_count: current.orderCount,
    aov: current.orderCount > 0
      ? Math.round((current.netRevenue / current.orderCount) * 100) / 100
      : 0,
    currency: "USD",
  };

  if (previous) {
    const prevAov = previous.orderCount > 0
      ? Math.round((previous.netRevenue / previous.orderCount) * 100) / 100
      : 0;

    result.comparison = {
      gross_revenue_delta_pct: pctChange(previous.grossRevenue, current.grossRevenue),
      net_revenue_delta_pct: pctChange(previous.netRevenue, current.netRevenue),
      orders_delta_pct: pctChange(previous.orderCount, current.orderCount),
      aov_delta_pct: pctChange(prevAov, result.aov),
      previous_gross_revenue: previous.grossRevenue,
      previous_net_revenue: previous.netRevenue,
      previous_orders: previous.orderCount,
      previous_aov: prevAov,
    };
  }

  return result;
}

// ---- Product Performance ----

interface RawLineItem {
  name: string;
  product?: { id: string; title: string } | null;
  quantity: number;
  originalTotalSet?: {
    shopMoney?: { amount: string };
  };
}

interface RawOrder {
  lineItems: { nodes: RawLineItem[] };
}

export function transformProductPerformance(
  orders: RawOrder[],
  limit: number,
  metric: "revenue" | "units",
): ProductPerformanceItem[] {
  const productMap = new Map<
    string,
    {
      title: string;
      vendor: string | null;
      revenue: number;
      units: number;
      orderIds: Set<string>;
    }
  >();

  let orderIdx = 0;
  for (const order of orders) {
    orderIdx++;
    for (const item of order.lineItems.nodes) {
      const key = item.product?.id ?? item.name;
      const existing = productMap.get(key) ?? {
        title: item.product?.title ?? item.name,
        vendor: null,
        revenue: 0,
        units: 0,
        orderIds: new Set<string>(),
      };

      const price = parseFloat(item.originalTotalSet?.shopMoney?.amount ?? "0");
      existing.revenue += price;
      existing.units += item.quantity;
      existing.orderIds.add(String(orderIdx));
      productMap.set(key, existing);
    }
  }

  const products: ProductPerformanceItem[] = Array.from(
    productMap.values(),
  ).map((p) => ({
    product_title: p.title,
    vendor: p.vendor,
    revenue: Math.round(p.revenue * 100) / 100,
    units_sold: p.units,
    order_count: p.orderIds.size,
    avg_price:
      p.units > 0 ? Math.round((p.revenue / p.units) * 100) / 100 : 0,
  }));

  products.sort((a, b) =>
    metric === "revenue" ? b.revenue - a.revenue : b.units_sold - a.units_sold,
  );

  return products.slice(0, limit);
}

// ---- Order Search ----

interface RawSearchOrder {
  name: string;
  email?: string | null;
  createdAt: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  lineItems: {
    nodes: Array<{
      name: string;
      quantity: number;
      originalUnitPriceSet: { shopMoney: { amount: string } };
    }>;
  };
}

export function transformOrders(orders: RawSearchOrder[]): OrderSearchItem[] {
  return orders.map((o) => ({
    order_number: o.name,
    email: o.email ?? null,
    date: o.createdAt,
    total: o.totalPriceSet.shopMoney.amount,
    currency: o.totalPriceSet.shopMoney.currencyCode,
    financial_status: o.displayFinancialStatus,
    fulfillment_status: o.displayFulfillmentStatus || null,
    items: o.lineItems.nodes.map((li) => ({
      title: li.name,
      quantity: li.quantity,
      price: li.originalUnitPriceSet.shopMoney.amount,
    })),
  }));
}

// ---- Inventory Alerts ----

interface RawVariant {
  displayName: string;
  sku: string | null;
  inventoryQuantity: number;
  product: { title: string };
}

export function transformInventoryAlerts(
  variants: RawVariant[],
  threshold: number,
): InventoryAlertItem[] {
  return variants
    .filter((v) => v.inventoryQuantity <= threshold)
    .sort((a, b) => a.inventoryQuantity - b.inventoryQuantity)
    .map((v) => ({
      product_title: v.product.title,
      variant_title: v.displayName,
      sku: v.sku,
      inventory_quantity: v.inventoryQuantity,
    }));
}

// ---- Customer Cohorts (ShopifyQL-powered) ----

export function transformCustomerCohorts(
  rows: Record<string, string>[],
  granularity: "monthly" | "quarterly",
  months: number,
): CustomerCohorts {
  const cohortKey = granularity === "monthly" ? "customer_cohort_month" : "customer_cohort_quarter";
  const now = new Date();

  const cohorts = rows.map((row) => {
    const newCust = parseInt(row.new_customer_records) || 0;
    const totalRev = parseFloat(row.total_amount_spent) || 0;
    const totalOrders = parseFloat(row.total_number_of_orders) || 0;
    const avgDays = parseFloat(row.days_since_last_order) || 0;
    const cohortDate = row[cohortKey] ?? "";

    return {
      cohort: cohortDate,
      months_since_acquisition: monthsDiff(cohortDate, now),
      new_customers: newCust,
      total_revenue: round2(totalRev),
      avg_revenue_per_customer: newCust > 0 ? round2(totalRev / newCust) : 0,
      orders_per_customer: newCust > 0 ? round2(totalOrders / newCust) : 0,
      avg_days_since_last_order: round2(avgDays),
    };
  });

  const totalNew = cohorts.reduce((sum, c) => sum + c.new_customers, 0);

  // Best LTV cohort = highest avg_revenue_per_customer with at least some customers
  const bestLtv = cohorts
    .filter((c) => c.new_customers >= 1)
    .sort((a, b) => b.avg_revenue_per_customer - a.avg_revenue_per_customer)[0];

  // Trend: compare first half avg LTV vs second half avg LTV
  const mid = Math.floor(cohorts.length / 2);
  const recentHalf = cohorts.slice(0, Math.max(mid, 1));
  const olderHalf = cohorts.slice(Math.max(mid, 1));
  const recentAvgLtv = avgOf(recentHalf.map((c) => c.avg_revenue_per_customer));
  const olderAvgLtv = avgOf(olderHalf.map((c) => c.avg_revenue_per_customer));
  const ltvDelta = olderAvgLtv > 0 ? (recentAvgLtv - olderAvgLtv) / olderAvgLtv : 0;

  let trend: "improving" | "declining" | "stable" = "stable";
  if (ltvDelta > 0.1) trend = "improving";
  else if (ltvDelta < -0.1) trend = "declining";

  // LTV benchmarks: use cohorts at ~3, ~6, ~12 months age
  const ltv_benchmarks = computeLtvBenchmarks(cohorts);

  return {
    granularity,
    months,
    total_new_customers: totalNew,
    best_ltv_cohort: bestLtv?.cohort ?? null,
    trend,
    ltv_benchmarks,
    cohorts,
  };
}

function computeLtvBenchmarks(
  cohorts: Array<{ months_since_acquisition: number; avg_revenue_per_customer: number; new_customers: number }>,
): CustomerCohorts["ltv_benchmarks"] {
  const meaningful = cohorts.filter((c) => c.new_customers >= 5);
  if (meaningful.length === 0) return null;

  function ltvAtAge(targetMonths: number): number | null {
    // Find cohort closest to target age (within ±1 month)
    const candidates = meaningful.filter(
      (c) => Math.abs(c.months_since_acquisition - targetMonths) <= 1,
    );
    if (candidates.length === 0) return null;
    return round2(avgOf(candidates.map((c) => c.avg_revenue_per_customer)));
  }

  const avg3 = ltvAtAge(3);
  const avg6 = ltvAtAge(6);
  const avg12 = ltvAtAge(12);

  if (avg3 === null && avg6 === null && avg12 === null) return null;

  return { avg_3m_ltv: avg3, avg_6m_ltv: avg6, avg_12m_ltv: avg12 };
}

function monthsDiff(dateStr: string, now: Date): number {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 0;
  // Use UTC methods — Shopify dates are date-only strings parsed as UTC
  return (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + (now.getUTCMonth() - d.getUTCMonth());
}

// ---- Customer Segments (ShopifyQL-powered) ----

export function transformCustomerSegments(
  rows: Record<string, string>[],
  dimension: string,
  months: number,
): CustomerSegments {
  const segments = rows.map((row) => ({
    segment: row[dimension] ?? "(unknown)",
    pct_of_customers: round2(parseFloat(row.percent_of_customers) || 0),
    total_revenue: round2(parseFloat(row.total_amount_spent) || 0),
    total_orders: round2(parseFloat(row.total_number_of_orders) || 0),
    customer_count: parseInt(row.new_customer_records) || 0,
  }));

  const totalCustomers = segments.reduce((sum, s) => sum + s.customer_count, 0);

  return { dimension, months, total_customers: totalCustomers, segments };
}

// ---- Sales Breakdown (ShopifyQL-powered) ----

export function transformSalesBreakdown(
  rows: Record<string, string>[],
  dimension: string,
  metric: string,
  days: number,
): SalesBreakdown {
  const parsed = rows.map((row) => ({
    dimension_value: row[dimension] ?? "(unknown)",
    metric_value: parseFloat(row[metric]) || 0,
    orders: parseInt(row.orders) || 0,
    pct_of_total: 0,
  }));

  const total = parsed.reduce((sum, r) => sum + r.metric_value, 0);
  for (const row of parsed) {
    row.metric_value = round2(row.metric_value);
    row.pct_of_total = total > 0 ? round2((row.metric_value / total) * 100) : 0;
  }

  return { dimension, metric, days, total: round2(total), rows: parsed };
}

// ---- Product Analytics (ShopifyQL-powered) ----

export function transformProductAnalytics(
  rows: Record<string, string>[],
  days: number,
  metric: string,
): ProductAnalytics {
  const products = rows.map((row) => {
    const grossSales = parseFloat(row.gross_sales) || 0;
    const grossProfit = parseFloat(row.gross_profit) || 0;
    return {
      product_title: row.product_title ?? "(unknown)",
      net_sales: round2(parseFloat(row.net_sales) || 0),
      gross_sales: round2(grossSales),
      orders: parseInt(row.orders) || 0,
      gross_profit: round2(grossProfit),
      margin_pct: grossSales > 0 ? round2((grossProfit / grossSales) * 100) : 0,
      quantity_ordered: parseInt(row.quantity_ordered) || 0,
      returns: round2(parseFloat(row.returns) || 0),
    };
  });

  return { days, metric, products };
}

// ---- Traffic Sources (ShopifyQL-powered) ----

export function transformTrafficSources(
  rows: Record<string, string>[],
  mode: string,
  days: number,
  sourceField: string,
): TrafficSources {
  const data = rows.map((row) => ({
    source: row[sourceField] ?? "(unknown)",
    sessions: parseInt(row.sessions) || 0,
    pct_of_total: 0,
  }));

  const totalSessions = data.reduce((sum, r) => sum + r.sessions, 0);
  for (const row of data) {
    row.pct_of_total = totalSessions > 0 ? round2((row.sessions / totalSessions) * 100) : 0;
  }

  return { mode, days, total_sessions: totalSessions, data };
}

// ---- Returns Analysis (ShopifyQL-powered) ----

export function transformReturnsAnalysis(
  rows: Record<string, string>[],
  mode: "summary" | "by_product",
  days: number,
): ReturnsAnalysis {
  if (mode === "summary" && rows.length > 0) {
    const row = rows[0];
    return {
      mode, days,
      summary: {
        returns: round2(parseFloat(row.returns) || 0),
        total_returns: round2(parseFloat(row.total_returns) || 0),
        gross_returns: round2(parseFloat(row.gross_returns) || 0),
        net_returns: round2(parseFloat(row.net_returns) || 0),
        quantity_returned: parseInt(row.quantity_returned) || 0,
        returned_quantity_rate: round2((parseFloat(row.returned_quantity_rate) || 0) * 100),
        return_fees: round2(parseFloat(row.return_fees) || 0),
      },
    };
  }

  const byProduct = rows.map((row) => {
    const netSales = parseFloat(row.net_sales) || 0;
    const qtyOrdered = parseInt(row.quantity_ordered) || 0;
    const qtyReturned = Math.abs(parseInt(row.quantity_returned) || 0);
    return {
      product_title: row.product_title ?? "(unknown)",
      returns: round2(parseFloat(row.returns) || 0),
      quantity_returned: parseInt(row.quantity_returned) || 0,
      net_sales: round2(netSales),
      return_rate_pct: qtyOrdered > 0 ? round2((qtyReturned / qtyOrdered) * 100) : 0,
    };
  });

  return { mode, days, by_product: byProduct };
}

// ---- Recent Orders ----

interface RawRecentOrder {
  name: string;
  email?: string | null;
  createdAt: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
}

export function transformRecentOrders(
  orders: RawRecentOrder[],
): RecentOrderItem[] {
  return orders.map((o) => ({
    order_number: o.name,
    email: o.email ?? null,
    date: o.createdAt,
    total: o.totalPriceSet.shopMoney.amount,
    currency: o.totalPriceSet.shopMoney.currencyCode,
    financial_status: o.displayFinancialStatus,
    fulfillment_status: o.displayFulfillmentStatus || null,
  }));
}

// ---- Sales Time Series ----

export function transformSalesTimeSeries(
  buckets: RawSalesBucket[],
  days: number,
  granularity: "daily" | "weekly" | "monthly",
  timezone: string,
): SalesTimeSeries {
  let totalGross = 0;
  let totalNet = 0;
  let totalOrders = 0;

  const transformed: SalesBucket[] = buckets.map((b) => {
    totalGross += b.grossRevenue;
    totalNet += b.netRevenue;
    totalOrders += b.orderCount;
    return {
      date: b.date,
      gross_revenue: Math.round(b.grossRevenue * 100) / 100,
      net_revenue: Math.round(b.netRevenue * 100) / 100,
      order_count: b.orderCount,
      aov: b.orderCount > 0 ? Math.round((b.netRevenue / b.orderCount) * 100) / 100 : 0,
    };
  });

  totalGross = Math.round(totalGross * 100) / 100;
  totalNet = Math.round(totalNet * 100) / 100;

  return {
    period_days: days,
    granularity,
    timezone,
    currency: "USD",
    buckets: transformed,
    totals: {
      revenue: totalNet,
      order_count: totalOrders,
      aov: totalOrders > 0 ? Math.round((totalNet / totalOrders) * 100) / 100 : 0,
    },
  };
}

// ---- Helpers ----

function pctChange(previous: number, current: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / previous) * 10000) / 100;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function avgOf(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
