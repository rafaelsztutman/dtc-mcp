import { describe, it, expect } from "vitest";
import {
  transformCampaignSummary,
  transformCampaignDetail,
  transformFlowSummary,
  transformFlowDetail,
  transformSubscriberHealth,
  transformListSegments,
  transformProfiles,
  transformEvents,
} from "../src/platforms/klaviyo/transforms.js";
import {
  transformSalesSummary,
  transformSalesTimeSeries,
  transformProductPerformance,
  transformInventoryAlerts,
  transformCustomerCohort,
  transformRecentOrders,
} from "../src/platforms/shopify/transforms.js";
import type { SalesData } from "../src/platforms/shopify/transforms.js";
import type { RawSalesBucket } from "../src/platforms/shopify/client.js";

import campaignData from "./mock-data/klaviyo-campaigns.json";
import flowData from "./mock-data/klaviyo-flows.json";

// ---- Klaviyo Campaign Transforms ----

describe("transformCampaignSummary", () => {
  it("sorts campaigns by revenue descending", () => {
    const result = transformCampaignSummary(
      campaignData.campaigns as any,
      campaignData.report_rows as any,
      "revenue",
      10,
    );

    expect(result).toHaveLength(4);
    expect(result[0].name).toBe("Summer Sale 2025");
    expect(result[0].revenue).toBe(12500);
    expect(result[1].revenue).toBe(8200);
  });

  it("sorts by open_rate when requested", () => {
    const result = transformCampaignSummary(
      campaignData.campaigns as any,
      campaignData.report_rows as any,
      "open_rate",
      10,
    );

    // camp_001: 4200/15000 = 0.28, camp_002: 2800/12000 = 0.2333
    expect(result[0].id).toBe("camp_001");
    expect(result[0].open_rate).toBeCloseTo(0.28, 2);
  });

  it("respects limit", () => {
    const result = transformCampaignSummary(
      campaignData.campaigns as any,
      campaignData.report_rows as any,
      "revenue",
      2,
    );

    expect(result).toHaveLength(2);
  });

  it("handles empty campaigns", () => {
    const result = transformCampaignSummary([], [], "revenue", 10);
    expect(result).toHaveLength(0);
  });

  it("handles campaigns with no matching report data", () => {
    const result = transformCampaignSummary(
      campaignData.campaigns as any,
      [], // no report rows
      "revenue",
      10,
    );

    expect(result).toHaveLength(4);
    expect(result[0].revenue).toBe(0);
    expect(result[0].open_rate).toBe(0);
  });

  it("computes rates correctly avoiding division by zero", () => {
    const campaigns = [
      {
        id: "zero",
        attributes: {
          name: "Zero Recipients",
          status: "Sent",
          send_options: { use_smart_sending: true },
          send_time: null,
        },
      },
    ];
    const rows = [
      {
        groupings: { campaign_id: "zero" },
        statistics: { recipients: 0, opens: 0, clicks: 0, conversion_value: 0 },
      },
    ];

    const result = transformCampaignSummary(campaigns as any, rows as any, "revenue", 10);
    expect(result[0].open_rate).toBe(0);
    expect(result[0].click_rate).toBe(0);
  });
});

describe("transformCampaignDetail", () => {
  it("returns full campaign detail with computed rates", () => {
    const result = transformCampaignDetail(
      campaignData.detail_campaign as any,
      campaignData.detail_messages as any,
      [campaignData.report_rows[0]] as any,
      ["VIP Customers"],
    );

    expect(result.name).toBe("Summer Sale 2025");
    expect(result.subject_line).toBe(
      "🌞 50% Off Everything — Summer Sale Starts Now!",
    );
    expect(result.audiences).toEqual(["VIP Customers"]);
    expect(result.recipients).toBe(15000);
    expect(result.open_rate).toBeCloseTo(0.28, 2);
    expect(result.click_rate).toBeCloseTo(0.05, 2);
    expect(result.revenue).toBe(12500);
    expect(result.bounce_rate).toBeCloseTo(0.005, 3);
  });
});

// ---- Klaviyo Flow Transforms ----

describe("transformFlowSummary", () => {
  it("sorts flows by revenue descending", () => {
    const result = transformFlowSummary(
      flowData.flows as any,
      flowData.report_rows as any,
      "revenue",
      10,
    );

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("Abandoned Cart");
    expect(result[0].revenue).toBe(45000);
    // Welcome Series: 6500 + 3200 = 9700, Post-Purchase: 8000
    expect(result[1].name).toBe("Welcome Series");
  });

  it("aggregates stats across flow messages for summary", () => {
    const result = transformFlowSummary(
      flowData.flows as any,
      flowData.report_rows as any,
      "revenue",
      10,
    );

    // Welcome Series has 2 report rows: 6500 + 3200 = 9700
    const welcomeFlow = result.find((f) => f.name === "Welcome Series");
    expect(welcomeFlow?.revenue).toBe(9700);
    expect(welcomeFlow?.recipients).toBe(14000); // 8000 + 6000
  });
});

describe("transformFlowDetail", () => {
  it("returns per-message breakdown", () => {
    const result = transformFlowDetail(
      { id: "flow_001", attributes: { name: "Welcome Series", status: "live", trigger_type: "List" } },
      flowData.flow_messages as any,
      flowData.report_rows.filter((r) => r.groupings.flow_id === "flow_001") as any,
    );

    expect(result.name).toBe("Welcome Series");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].message_name).toBe("Welcome Email 1");
    expect(result.messages[0].subject_line).toBe("Welcome to the family!");
    expect(result.total_revenue).toBe(9700);
  });
});

// ---- Klaviyo Subscriber/List Transforms ----

describe("transformSubscriberHealth", () => {
  it("aggregates list sizes and sorts by size", () => {
    const lists = [
      { id: "l1", attributes: { name: "Newsletter", profile_count: 5000, created: "2024-01-01", updated: "2025-01-01" } },
      { id: "l2", attributes: { name: "VIP", profile_count: 1200, created: "2024-06-01", updated: "2025-01-01" } },
      { id: "l3", attributes: { name: "All Customers", profile_count: 8000, created: "2024-01-01", updated: "2025-01-01" } },
    ];
    const segments = [
      { id: "s1", attributes: { name: "Engaged 30d", profile_count: 3000, created: "2024-01-01", updated: "2025-01-01" } },
    ];

    const result = transformSubscriberHealth(lists, segments);
    expect(result.total_subscribers).toBe(14200);
    expect(result.lists[0].name).toBe("All Customers");
    expect(result.segments[0].name).toBe("Engaged 30d");
  });
});

describe("transformListSegments", () => {
  it("combines lists and segments into unified items", () => {
    const lists = [
      { id: "l1", attributes: { name: "Newsletter", profile_count: 5000, created: "2024-01-01", updated: "2025-01-01" } },
    ];
    const segments = [
      { id: "s1", attributes: { name: "Engaged", profile_count: 3000, created: "2024-06-01", updated: "2025-01-01" } },
    ];

    const result = transformListSegments(lists, segments);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("list");
    expect(result[1].type).toBe("segment");
  });
});

// ---- Klaviyo Profile Transforms ----

describe("transformProfiles", () => {
  it("extracts key fields only", () => {
    const profiles = [
      {
        id: "p1",
        attributes: {
          email: "test@example.com",
          first_name: "Jane",
          last_name: "Doe",
          phone_number: "+1234567890",
          created: "2024-01-15T00:00:00Z",
          location: { city: "New York", country: "US" },
        },
      },
    ];

    const result = transformProfiles(profiles);
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe("test@example.com");
    expect(result[0].first_name).toBe("Jane");
    expect(result[0].city).toBe("New York");
  });

  it("handles null/missing fields", () => {
    const profiles = [
      { id: "p2", attributes: { email: null, created: "2024-01-01" } },
    ];

    const result = transformProfiles(profiles);
    expect(result[0].email).toBeNull();
    expect(result[0].first_name).toBeNull();
    expect(result[0].city).toBeNull();
  });
});

// ---- Klaviyo Event Transforms ----

describe("transformEvents", () => {
  it("strips event properties based on metric type", () => {
    const events = [
      {
        attributes: {
          datetime: "2025-07-15T10:00:00Z",
          event_properties: {
            "$value": 49.99,
            "Items": [{ name: "Widget" }],
            "Currency": "USD",
            "InternalTrackingId": "abc123",
            "SessionId": "sess_789",
          },
        },
        relationships: { profile: { data: { id: "prof_1" } } },
      },
    ];

    const profileMap = new Map([
      ["prof_1", { email: "buyer@test.com", first_name: "John", last_name: "Smith" }],
    ]);

    const result = transformEvents(events, profileMap, "Placed Order");
    expect(result[0].profile_email).toBe("buyer@test.com");
    expect(result[0].profile_name).toBe("John Smith");
    expect(result[0].event_properties).toHaveProperty("$value");
    expect(result[0].event_properties).toHaveProperty("Items");
    // Internal fields should be stripped
    expect(result[0].event_properties).not.toHaveProperty("InternalTrackingId");
    expect(result[0].event_properties).not.toHaveProperty("SessionId");
  });
});

// ---- Shopify Transforms ----

describe("transformSalesSummary", () => {
  const mockData: SalesData = { grossRevenue: 55000, netRevenue: 52500, orderCount: 350 };

  it("returns gross and net revenue with AOV based on net", () => {
    const result = transformSalesSummary(mockData, 30);
    expect(result.gross_revenue).toBe(55000);
    expect(result.net_revenue).toBe(52500);
    expect(result.order_count).toBe(350);
    expect(result.aov).toBe(150);
    expect(result.period).toBe("last_30_days");
  });

  it("computes comparison deltas for both gross and net", () => {
    const previousData: SalesData = { grossRevenue: 53000, netRevenue: 50000, orderCount: 300 };

    const result = transformSalesSummary(mockData, 30, previousData);
    expect(result.comparison).toBeDefined();
    expect(result.comparison!.gross_revenue_delta_pct).toBeCloseTo(3.77, 1);
    expect(result.comparison!.net_revenue_delta_pct).toBe(5);
    expect(result.comparison!.orders_delta_pct).toBeCloseTo(16.67, 1);
    expect(result.comparison!.previous_gross_revenue).toBe(53000);
    expect(result.comparison!.previous_net_revenue).toBe(50000);
  });

  it("handles empty result", () => {
    const empty: SalesData = { grossRevenue: 0, netRevenue: 0, orderCount: 0 };
    const result = transformSalesSummary(empty, 30);
    expect(result.gross_revenue).toBe(0);
    expect(result.net_revenue).toBe(0);
    expect(result.order_count).toBe(0);
    expect(result.aov).toBe(0);
  });
});

describe("transformProductPerformance", () => {
  const mockOrders = [
    {
      lineItems: {
        nodes: [
          {
            name: "Widget A",
            product: { id: "prod_1", title: "Widget A" },
            quantity: 2,
            originalTotalSet: { shopMoney: { amount: "50.00" } },
          },
          {
            name: "Widget B",
            product: { id: "prod_2", title: "Widget B" },
            quantity: 1,
            originalTotalSet: { shopMoney: { amount: "30.00" } },
          },
        ],
      },
    },
    {
      lineItems: {
        nodes: [
          {
            name: "Widget A",
            product: { id: "prod_1", title: "Widget A" },
            quantity: 3,
            originalTotalSet: { shopMoney: { amount: "75.00" } },
          },
        ],
      },
    },
  ];

  it("aggregates by product and sorts by revenue", () => {
    const result = transformProductPerformance(mockOrders, 10, "revenue");
    expect(result[0].product_title).toBe("Widget A");
    expect(result[0].revenue).toBe(125);
    expect(result[0].units_sold).toBe(5);
    expect(result[0].order_count).toBe(2);
    expect(result[0].avg_price).toBe(25);
  });

  it("sorts by units when requested", () => {
    const result = transformProductPerformance(mockOrders, 10, "units");
    expect(result[0].product_title).toBe("Widget A");
    expect(result[0].units_sold).toBe(5);
  });

  it("respects limit", () => {
    const result = transformProductPerformance(mockOrders, 1, "revenue");
    expect(result).toHaveLength(1);
  });
});

describe("transformInventoryAlerts", () => {
  const variants = [
    { displayName: "Widget A - Red", sku: "WA-RED", inventoryQuantity: 0, product: { title: "Widget A" } },
    { displayName: "Widget A - Blue", sku: "WA-BLU", inventoryQuantity: 5, product: { title: "Widget A" } },
    { displayName: "Widget B - Default", sku: "WB-DEF", inventoryQuantity: 50, product: { title: "Widget B" } },
    { displayName: "Widget C - Small", sku: "WC-SM", inventoryQuantity: 8, product: { title: "Widget C" } },
  ];

  it("filters below threshold and sorts ascending", () => {
    const result = transformInventoryAlerts(variants, 10);
    expect(result).toHaveLength(3);
    expect(result[0].inventory_quantity).toBe(0);
    expect(result[1].inventory_quantity).toBe(5);
    expect(result[2].inventory_quantity).toBe(8);
  });

  it("returns empty when all above threshold", () => {
    const result = transformInventoryAlerts(variants, -1);
    expect(result).toHaveLength(0);
  });
});

describe("transformCustomerCohort", () => {
  // These represent customers who ordered in the period (pre-filtered by last_order_date query)
  const customers = [
    { id: "c1", email: "a@test.com", numberOfOrders: "5", amountSpent: { amount: "500.00", currencyCode: "USD" }, createdAt: "2020-01-01T00:00:00Z" },
    { id: "c2", email: "b@test.com", numberOfOrders: "1", amountSpent: { amount: "50.00", currencyCode: "USD" }, createdAt: new Date().toISOString() },
    { id: "c3", email: "c@test.com", numberOfOrders: "2", amountSpent: { amount: "120.00", currencyCode: "USD" }, createdAt: "2020-01-01T00:00:00Z" },
    { id: "c4", email: "d@test.com", numberOfOrders: "15", amountSpent: { amount: "2000.00", currencyCode: "USD" }, createdAt: "2020-01-01T00:00:00Z" },
  ];

  it("classifies new vs returning buyers", () => {
    const result = transformCustomerCohort(customers, 90);
    expect(result.total_customers).toBe(4);
    expect(result.new_customers).toBe(1); // c2 has 1 lifetime order = first-time buyer
    expect(result.returning_customers).toBe(3); // c1, c3, c4 have >1 lifetime orders
    expect(result.repeat_rate).toBeCloseTo(0.75, 2);
  });

  it("buckets by lifetime order count with correct labels", () => {
    const result = transformCustomerCohort(customers, 90);
    expect(result.cohorts.length).toBeGreaterThan(0);
    expect(result.cohorts[0].label).toBe("First-time buyer");
    expect(result.cohorts[0].count).toBe(1); // c2
  });

  it("identifies top customers by spending", () => {
    const result = transformCustomerCohort(customers, 90);
    expect(result.top_customers[0].email).toBe("d@test.com");
    expect(result.top_customers[0].total_spent).toBe(2000);
  });
});

describe("transformRecentOrders", () => {
  it("extracts key fields", () => {
    const orders = [
      {
        name: "#1001",
        email: "test@example.com",
        createdAt: "2025-07-15T10:00:00Z",
        totalPriceSet: { shopMoney: { amount: "99.99", currencyCode: "USD" } },
        displayFinancialStatus: "PAID",
        displayFulfillmentStatus: "FULFILLED",
      },
    ];

    const result = transformRecentOrders(orders);
    expect(result[0].order_number).toBe("#1001");
    expect(result[0].total).toBe("99.99");
    expect(result[0].financial_status).toBe("PAID");
  });
});

// ---- Sales Time Series ----

describe("transformSalesTimeSeries", () => {
  const mockBuckets: RawSalesBucket[] = [
    { date: "2026-02-01", grossRevenue: 1300, netRevenue: 1200.5, orderCount: 10 },
    { date: "2026-02-02", grossRevenue: 900, netRevenue: 800.75, orderCount: 6 },
    { date: "2026-02-03", grossRevenue: 0, netRevenue: 0, orderCount: 0 },
    { date: "2026-02-04", grossRevenue: 1600, netRevenue: 1500.25, orderCount: 12 },
  ];

  it("returns gross and net revenue per bucket with AOV based on net", () => {
    const result = transformSalesTimeSeries(mockBuckets, 30, "daily", "America/New_York");
    expect(result.buckets).toHaveLength(4);
    expect(result.buckets[0].gross_revenue).toBe(1300);
    expect(result.buckets[0].net_revenue).toBe(1200.5);
    expect(result.buckets[0].order_count).toBe(10);
    expect(result.buckets[0].aov).toBe(120.05);
    expect(result.totals.revenue).toBe(3501.5);
    expect(result.totals.order_count).toBe(28);
    expect(result.totals.aov).toBe(125.05);
  });

  it("handles zero-order buckets without division error", () => {
    const result = transformSalesTimeSeries(mockBuckets, 30, "daily", "America/New_York");
    const emptyBucket = result.buckets[2];
    expect(emptyBucket.order_count).toBe(0);
    expect(emptyBucket.aov).toBe(0);
    expect(emptyBucket.gross_revenue).toBe(0);
    expect(emptyBucket.net_revenue).toBe(0);
  });

  it("sets metadata fields correctly", () => {
    const result = transformSalesTimeSeries(mockBuckets, 7, "weekly", "Europe/London");
    expect(result.period_days).toBe(7);
    expect(result.granularity).toBe("weekly");
    expect(result.timezone).toBe("Europe/London");
    expect(result.currency).toBe("USD");
  });

  it("handles empty buckets array", () => {
    const result = transformSalesTimeSeries([], 30, "monthly", "UTC");
    expect(result.buckets).toHaveLength(0);
    expect(result.totals.revenue).toBe(0);
    expect(result.totals.order_count).toBe(0);
    expect(result.totals.aov).toBe(0);
  });
});
