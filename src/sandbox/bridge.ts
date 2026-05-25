import {
  klaviyoGet,
  klaviyoPost,
  klaviyoPaginate,
  getConversionMetricId,
} from "../sdk/klaviyo/host.js";
import {
  shopifyGql,
  shopifyQL,
  shopifyTimezone,
} from "../sdk/shopify/host.js";
import { isShopifyConfigured } from "../config.js";

type Handler = (args: unknown[]) => Promise<unknown>;

function requireShopify(): void {
  if (!isShopifyConfigured()) {
    throw new Error(
      "Shopify not configured. Set SHOPIFY_STORE + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET, or SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN (legacy).",
    );
  }
}

/**
 * Registry of methods the sandbox can invoke. Every entry is an exact path
 * that maps to a host function. Unknown paths are rejected — the sandbox can
 * never reach into arbitrary host code.
 *
 * Paths are also exported as `methodPaths` so the in-isolate proxy template
 * can mirror this surface as typed namespaces.
 */
const handlers: Record<string, Handler> = {
  // Low-level Klaviyo escape hatches
  "klaviyo.get": (args) => {
    const [path, options] = args as [string, { params?: Record<string, unknown>; tier?: "standard" | "reporting" } | undefined];
    return klaviyoGet(path, options);
  },
  "klaviyo.post": (args) => {
    const [path, body, options] = args as [
      string,
      Record<string, unknown>,
      { tier?: "standard" | "reporting" } | undefined,
    ];
    return klaviyoPost(path, body, options);
  },
  "klaviyo.paginate": (args) => {
    const [path, options] = args as [
      string,
      {
        params?: Record<string, unknown>;
        tier?: "standard" | "reporting";
        maxPages?: number;
      } | undefined,
    ];
    return klaviyoPaginate(path, options);
  },
  "klaviyo.getConversionMetricId": () => getConversionMetricId(),

  // Convenience helpers (sugar over the escape hatches; same rate-limit + cache path)
  "klaviyo.campaigns.list": (args) => {
    const [params] = args as [Record<string, unknown> | undefined];
    return klaviyoGet("campaigns", { params });
  },
  "klaviyo.campaigns.get": (args) => {
    const [id, params] = args as [string, Record<string, unknown> | undefined];
    return klaviyoGet(`campaigns/${id}`, { params });
  },
  "klaviyo.flows.list": (args) => {
    const [params] = args as [Record<string, unknown> | undefined];
    return klaviyoGet("flows", { params });
  },
  "klaviyo.flows.get": (args) => {
    const [id, params] = args as [string, Record<string, unknown> | undefined];
    return klaviyoGet(`flows/${id}`, { params });
  },
  "klaviyo.lists.list": (args) => {
    const [params] = args as [Record<string, unknown> | undefined];
    return klaviyoGet("lists", { params });
  },
  "klaviyo.segments.list": (args) => {
    const [params] = args as [Record<string, unknown> | undefined];
    return klaviyoGet("segments", { params });
  },
  "klaviyo.profiles.list": (args) => {
    const [params] = args as [Record<string, unknown> | undefined];
    return klaviyoGet("profiles", { params });
  },
  "klaviyo.events.list": (args) => {
    const [params] = args as [Record<string, unknown> | undefined];
    return klaviyoGet("events", { params });
  },
  "klaviyo.metrics.list": (args) => {
    const [params] = args as [Record<string, unknown> | undefined];
    return klaviyoGet("metrics", { params });
  },
  "klaviyo.reporting.campaignValues": (args) => {
    const [body] = args as [Record<string, unknown>];
    return klaviyoPost("campaign-values-reports", body, { tier: "reporting" });
  },
  "klaviyo.reporting.flowValues": (args) => {
    const [body] = args as [Record<string, unknown>];
    return klaviyoPost("flow-values-reports", body, { tier: "reporting" });
  },

  // Shopify
  "shopify.gql": (args) => {
    requireShopify();
    const [query, options] = args as [
      string,
      { variables?: Record<string, unknown>; estimatedCost?: number } | undefined,
    ];
    return shopifyGql(query, options);
  },
  "shopify.ql": (args) => {
    requireShopify();
    const [ql] = args as [string];
    return shopifyQL(ql);
  },
  "shopify.timezone": () => {
    requireShopify();
    return shopifyTimezone();
  },
};

/**
 * Aliases for method names an LLM is likely to guess based on common JS SDK
 * conventions (`getX`, `getAllX`, `findX`). These all route to the canonical
 * `.list()` / `.get()` handlers so a fat-fingered guess doesn't burn a
 * sandbox roundtrip + retry. Adding new aliases here is zero-risk: the
 * canonical paths still exist and stay authoritative.
 */
const METHOD_ALIASES: Record<string, string> = {
  // List → getX / getAllX / findX
  "klaviyo.campaigns.getCampaigns": "klaviyo.campaigns.list",
  "klaviyo.campaigns.getAllCampaigns": "klaviyo.campaigns.list",
  "klaviyo.campaigns.findCampaigns": "klaviyo.campaigns.list",
  "klaviyo.flows.getFlows": "klaviyo.flows.list",
  "klaviyo.flows.getAllFlows": "klaviyo.flows.list",
  "klaviyo.flows.findFlows": "klaviyo.flows.list",
  "klaviyo.lists.getLists": "klaviyo.lists.list",
  "klaviyo.lists.getAllLists": "klaviyo.lists.list",
  "klaviyo.segments.getSegments": "klaviyo.segments.list",
  "klaviyo.segments.getAllSegments": "klaviyo.segments.list",
  "klaviyo.profiles.getProfiles": "klaviyo.profiles.list",
  "klaviyo.profiles.getAllProfiles": "klaviyo.profiles.list",
  "klaviyo.events.getEvents": "klaviyo.events.list",
  "klaviyo.metrics.getMetrics": "klaviyo.metrics.list",
  "klaviyo.metrics.getAllMetrics": "klaviyo.metrics.list",
  // Get-by-id → getCampaign / getFlow / etc. (no plural; LLM may drop the trailing s)
  "klaviyo.campaigns.getCampaign": "klaviyo.campaigns.get",
  "klaviyo.flows.getFlow": "klaviyo.flows.get",
};

for (const [alias, canonical] of Object.entries(METHOD_ALIASES)) {
  handlers[alias] = handlers[canonical];
}

export const methodPaths: string[] = Object.keys(handlers);

export async function invoke(path: string, args: unknown[]): Promise<unknown> {
  const handler = handlers[path];
  if (!handler) {
    throw new Error(
      `Unknown SDK method: ${path}. Use search_docs to find valid methods.`,
    );
  }
  return handler(args);
}
