import type {
  SalesSummary,
  SalesTimeSeries,
  SalesBucket,
  ProductPerformanceItem,
  OrderSearchItem,
  InventoryAlertItem,
  CustomerCohort,
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

// ---- Customer Cohort ----

interface RawCustomer {
  id: string;
  email?: string | null;
  numberOfOrders: string;
  amountSpent: { amount: string; currencyCode: string };
  createdAt: string;
}

export function transformCustomerCohort(
  customers: RawCustomer[],
  days: number,
): CustomerCohort {
  // Customers are pre-filtered to those who ordered in the period (via last_order_date query).
  // "New" = first-time buyer (only 1 lifetime order, so this period IS their first).
  // "Returning" = repeat buyer (2+ lifetime orders, meaning they ordered before this period too).
  const newCustomers = customers.filter(
    (c) => parseInt(c.numberOfOrders) <= 1,
  );
  const returning = customers.filter(
    (c) => parseInt(c.numberOfOrders) > 1,
  );

  const cohortBuckets = [
    { label: "First-time buyer", min: 1, max: 1, count: 0, totalSpent: 0 },
    { label: "2-3 lifetime orders", min: 2, max: 3, count: 0, totalSpent: 0 },
    { label: "4-10 lifetime orders", min: 4, max: 10, count: 0, totalSpent: 0 },
    { label: "10+ lifetime orders", min: 11, max: Infinity, count: 0, totalSpent: 0 },
  ];

  let totalOrders = 0;

  for (const customer of customers) {
    const orders = parseInt(customer.numberOfOrders) || 0;
    const spent = parseFloat(customer.amountSpent.amount) || 0;
    totalOrders += orders;

    for (const bucket of cohortBuckets) {
      if (orders >= bucket.min && orders <= bucket.max) {
        bucket.count++;
        bucket.totalSpent += spent;
        break;
      }
    }
  }

  // Top customers by total spent
  const sorted = [...customers].sort(
    (a, b) =>
      parseFloat(b.amountSpent.amount) - parseFloat(a.amountSpent.amount),
  );

  return {
    period_days: days,
    total_customers: customers.length,
    new_customers: newCustomers.length,
    returning_customers: returning.length,
    repeat_rate:
      customers.length > 0
        ? Math.round((returning.length / customers.length) * 10000) / 10000
        : 0,
    avg_orders_per_customer:
      customers.length > 0
        ? Math.round((totalOrders / customers.length) * 100) / 100
        : 0,
    cohorts: cohortBuckets
      .filter((b) => b.count > 0)
      .map((b) => ({
        label: b.label,
        count: b.count,
        avg_spent:
          b.count > 0
            ? Math.round((b.totalSpent / b.count) * 100) / 100
            : 0,
      })),
    top_customers: sorted.slice(0, 5).map((c) => ({
      email: c.email ?? null,
      orders: parseInt(c.numberOfOrders) || 0,
      total_spent: parseFloat(c.amountSpent.amount) || 0,
    })),
  };
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
