import { isShopifyConfigured } from "../config.js";
import { getCampaignReport, getFlowReport } from "../platforms/klaviyo/client.js";
import { getAggregatedSales } from "../platforms/shopify/client.js";
import type { RevenueAttribution, Dashboard } from "../shared/types.js";

/**
 * Compare Klaviyo attributed revenue vs Shopify total revenue.
 */
export async function computeRevenueAttribution(
  days: number,
): Promise<RevenueAttribution> {
  // Fetch Klaviyo campaign + flow revenue (uses cached reporting data)
  const [campaignRows, flowRows] = await Promise.all([
    getCampaignReport(days),
    getFlowReport(days),
  ]);

  // Sum campaign revenue
  let campaignRevenue = 0;
  const campaignRevenueMap = new Map<string, { name: string; revenue: number }>();
  for (const row of campaignRows) {
    const revenue = row.statistics.conversion_value ?? 0;
    const id = String(row.groupings.campaign_id ?? "unknown");
    campaignRevenue += revenue;
    const existing = campaignRevenueMap.get(id);
    if (existing) {
      existing.revenue += revenue;
    } else {
      campaignRevenueMap.set(id, { name: id, revenue });
    }
  }

  // Sum flow revenue
  let flowRevenue = 0;
  const flowRevenueMap = new Map<string, { name: string; revenue: number }>();
  for (const row of flowRows) {
    const revenue = row.statistics.conversion_value ?? 0;
    const id = String(row.groupings.flow_id ?? "unknown");
    flowRevenue += revenue;
    const existing = flowRevenueMap.get(id);
    if (existing) {
      existing.revenue += revenue;
    } else {
      flowRevenueMap.set(id, { name: id, revenue });
    }
  }

  const emailTotalRevenue = campaignRevenue + flowRevenue;

  // Get Shopify total revenue
  let totalRevenue = emailTotalRevenue;
  if (isShopifyConfigured()) {
    try {
      const sales = await getAggregatedSales(days);
      totalRevenue = sales.netRevenue || emailTotalRevenue;
    } catch {
      // Shopify unavailable — use email revenue as total
    }
  }

  const emailPct = totalRevenue > 0
    ? Math.round((emailTotalRevenue / totalRevenue) * 10000) / 100
    : 0;

  const topCampaigns = Array.from(campaignRevenueMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  const topFlows = Array.from(flowRevenueMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  return {
    period_days: days,
    total_revenue: Math.round(totalRevenue * 100) / 100,
    email_campaign_revenue: Math.round(campaignRevenue * 100) / 100,
    flow_revenue: Math.round(flowRevenue * 100) / 100,
    email_total_revenue: Math.round(emailTotalRevenue * 100) / 100,
    email_pct_of_total: emailPct,
    flow_vs_campaign_split: {
      campaign_pct:
        emailTotalRevenue > 0
          ? Math.round((campaignRevenue / emailTotalRevenue) * 10000) / 100
          : 0,
      flow_pct:
        emailTotalRevenue > 0
          ? Math.round((flowRevenue / emailTotalRevenue) * 10000) / 100
          : 0,
    },
    top_revenue_campaigns: topCampaigns,
    top_revenue_flows: topFlows,
    note: "Revenue attribution uses Klaviyo's send-date model. Actual overlap with Shopify revenue may vary.",
  };
}

/**
 * Orchestrate a complete DTC health dashboard.
 * Uses cached results from sub-queries to minimize API calls.
 */
export async function computeDashboard(days: number): Promise<Dashboard> {
  // Run Klaviyo queries in parallel (these hit cache if recent calls were made)
  const [campaignRows, flowRows] = await Promise.all([
    getCampaignReport(days),
    getFlowReport(days),
  ]);

  // Sum email revenue
  let campaignRevenue = 0;
  const topCampaigns: Array<{ name: string; revenue: number; open_rate: number }> = [];
  const campaignMap = new Map<string, { revenue: number; opens: number; recipients: number }>();

  for (const row of campaignRows) {
    const id = String(row.groupings.campaign_id ?? "");
    const existing = campaignMap.get(id) ?? { revenue: 0, opens: 0, recipients: 0 };
    existing.revenue += row.statistics.conversion_value ?? 0;
    existing.opens += row.statistics.opens_unique ?? row.statistics.opens ?? 0;
    existing.recipients += row.statistics.recipients ?? 0;
    campaignMap.set(id, existing);
    campaignRevenue += row.statistics.conversion_value ?? 0;
  }

  for (const [name, stats] of campaignMap.entries()) {
    topCampaigns.push({
      name,
      revenue: Math.round(stats.revenue * 100) / 100,
      open_rate: stats.recipients > 0
        ? Math.round((stats.opens / stats.recipients) * 10000) / 10000
        : 0,
    });
  }
  topCampaigns.sort((a, b) => b.revenue - a.revenue);

  let flowRevenue = 0;
  const topFlows: Array<{ name: string; revenue: number }> = [];
  const flowMap = new Map<string, number>();

  for (const row of flowRows) {
    const id = String(row.groupings.flow_id ?? "");
    flowMap.set(id, (flowMap.get(id) ?? 0) + (row.statistics.conversion_value ?? 0));
    flowRevenue += row.statistics.conversion_value ?? 0;
  }

  for (const [name, revenue] of flowMap.entries()) {
    topFlows.push({ name, revenue: Math.round(revenue * 100) / 100 });
  }
  topFlows.sort((a, b) => b.revenue - a.revenue);

  const emailRevenue = campaignRevenue + flowRevenue;

  // Shopify sales
  let shopifyRevenue = emailRevenue;
  let orderCount = 0;
  let aov = 0;

  if (isShopifyConfigured()) {
    try {
      const sales = await getAggregatedSales(days);
      shopifyRevenue = sales.netRevenue || emailRevenue;
      orderCount = sales.orderCount;
      aov = orderCount > 0 ? Math.round((shopifyRevenue / orderCount) * 100) / 100 : 0;
    } catch {
      // Shopify unavailable
    }
  }

  return {
    period_days: days,
    sales: {
      revenue: Math.round(shopifyRevenue * 100) / 100,
      orders: orderCount,
      aov,
    },
    email: {
      email_revenue: Math.round(emailRevenue * 100) / 100,
      email_pct_of_total:
        shopifyRevenue > 0
          ? Math.round((emailRevenue / shopifyRevenue) * 10000) / 100
          : 0,
      top_campaigns: topCampaigns.slice(0, 5),
      top_flows: topFlows.slice(0, 5),
    },
    subscribers: {
      total: 0, // Would require a separate API call — omit to save rate limits
      list_count: 0,
    },
  };
}
