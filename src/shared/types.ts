// ---- MCP Tool Response ----

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ---- Pagination ----

export interface PaginatedResponse<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

// ---- Rate Limiting ----

export type RateLimitTier = "standard" | "reporting";

// ---- Klaviyo Transformed Types ----

export interface CampaignSummaryItem {
  id: string;
  name: string;
  channel: string;
  status: string;
  send_date: string | null;
  recipients: number;
  open_rate: number;
  click_rate: number;
  revenue: number;
  unsubscribe_rate: number;
}

export interface CampaignDetail {
  id: string;
  name: string;
  channel: string;
  status: string;
  subject_line: string | null;
  send_date: string | null;
  audiences: string[];
  recipients: number;
  open_rate: number;
  click_rate: number;
  click_through_rate: number;
  revenue: number;
  unsubscribe_rate: number;
  bounce_rate: number;
  spam_rate: number;
}

export interface FlowSummaryItem {
  id: string;
  name: string;
  status: string;
  trigger_type: string;
  message_count: number;
  recipients: number;
  click_rate: number;
  revenue: number;
  conversion_rate: number;
}

export interface FlowDetailMessage {
  message_id: string;
  message_name: string;
  subject_line: string | null;
  status: string;
  recipients: number;
  open_rate: number;
  click_rate: number;
  revenue: number;
}

export interface FlowDetail {
  id: string;
  name: string;
  status: string;
  trigger_type: string;
  total_revenue: number;
  total_recipients: number;
  messages: FlowDetailMessage[];
}

export interface SubscriberHealth {
  total_subscribers: number;
  lists: Array<{
    id: string;
    name: string;
    size: number;
  }>;
  segments: Array<{
    id: string;
    name: string;
    estimated_size: number;
  }>;
}

export interface ListSegmentItem {
  id: string;
  name: string;
  type: "list" | "segment";
  size: number;
  created_at: string;
  updated_at: string;
}

export interface ProfileResult {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone_number: string | null;
  city: string | null;
  country: string | null;
  created_at: string;
}

export interface ActivityEvent {
  timestamp: string;
  profile_email: string | null;
  profile_name: string | null;
  event_properties: Record<string, unknown>;
}

// ---- Shopify Transformed Types ----

export interface SalesSummary {
  period: string;
  gross_revenue: number;
  net_revenue: number;
  order_count: number;
  aov: number;
  currency: string;
  comparison?: {
    gross_revenue_delta_pct: number;
    net_revenue_delta_pct: number;
    orders_delta_pct: number;
    aov_delta_pct: number;
    previous_gross_revenue: number;
    previous_net_revenue: number;
    previous_orders: number;
    previous_aov: number;
  };
}

export interface ProductPerformanceItem {
  product_title: string;
  vendor: string | null;
  revenue: number;
  units_sold: number;
  order_count: number;
  avg_price: number;
}

export interface OrderSearchItem {
  order_number: string;
  email: string | null;
  date: string;
  total: string;
  currency: string;
  financial_status: string;
  fulfillment_status: string | null;
  items: Array<{
    title: string;
    quantity: number;
    price: string;
  }>;
}

export interface InventoryAlertItem {
  product_title: string;
  variant_title: string;
  sku: string | null;
  inventory_quantity: number;
}

export interface CustomerCohort {
  period_days: number;
  total_customers: number;
  new_customers: number;
  returning_customers: number;
  repeat_rate: number;
  avg_orders_per_customer: number;
  cohorts: Array<{
    label: string;
    count: number;
    avg_spent: number;
  }>;
  top_customers: Array<{
    email: string | null;
    orders: number;
    total_spent: number;
  }>;
}

export interface RecentOrderItem {
  order_number: string;
  email: string | null;
  date: string;
  total: string;
  currency: string;
  financial_status: string;
  fulfillment_status: string | null;
}

export interface SalesBucket {
  date: string;
  gross_revenue: number;
  net_revenue: number;
  order_count: number;
  aov: number;
}

export interface SalesTimeSeries {
  period_days: number;
  granularity: "daily" | "weekly" | "monthly";
  timezone: string;
  currency: string;
  buckets: SalesBucket[];
  totals: { revenue: number; order_count: number; aov: number };
}

// ---- Cross-Platform Types ----

export interface RevenueAttribution {
  period_days: number;
  total_revenue: number;
  email_campaign_revenue: number;
  flow_revenue: number;
  email_total_revenue: number;
  email_pct_of_total: number;
  flow_vs_campaign_split: {
    campaign_pct: number;
    flow_pct: number;
  };
  top_revenue_campaigns: Array<{ name: string; revenue: number }>;
  top_revenue_flows: Array<{ name: string; revenue: number }>;
  note: string;
}

export interface Dashboard {
  period_days: number;
  sales: {
    revenue: number;
    orders: number;
    aov: number;
  };
  email: {
    email_revenue: number;
    email_pct_of_total: number;
    top_campaigns: Array<{ name: string; revenue: number; open_rate: number }>;
    top_flows: Array<{ name: string; revenue: number }>;
  };
  subscribers: {
    total: number;
    list_count: number;
  };
}
