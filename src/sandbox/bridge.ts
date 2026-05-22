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
    const [path, options] = args as [string, { params?: Record<string, string>; tier?: "standard" | "reporting" } | undefined];
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
        params?: Record<string, string>;
        tier?: "standard" | "reporting";
        maxPages?: number;
      } | undefined,
    ];
    return klaviyoPaginate(path, options);
  },
  "klaviyo.getConversionMetricId": () => getConversionMetricId(),

  // Convenience helpers (sugar over the escape hatches; same rate-limit + cache path)
  "klaviyo.campaigns.list": (args) => {
    const [params] = args as [Record<string, string> | undefined];
    return klaviyoGet("campaigns", { params });
  },
  "klaviyo.campaigns.get": (args) => {
    const [id, params] = args as [string, Record<string, string> | undefined];
    return klaviyoGet(`campaigns/${id}`, { params });
  },
  "klaviyo.flows.list": (args) => {
    const [params] = args as [Record<string, string> | undefined];
    return klaviyoGet("flows", { params });
  },
  "klaviyo.flows.get": (args) => {
    const [id, params] = args as [string, Record<string, string> | undefined];
    return klaviyoGet(`flows/${id}`, { params });
  },
  "klaviyo.lists.list": (args) => {
    const [params] = args as [Record<string, string> | undefined];
    return klaviyoGet("lists", { params });
  },
  "klaviyo.segments.list": (args) => {
    const [params] = args as [Record<string, string> | undefined];
    return klaviyoGet("segments", { params });
  },
  "klaviyo.profiles.list": (args) => {
    const [params] = args as [Record<string, string> | undefined];
    return klaviyoGet("profiles", { params });
  },
  "klaviyo.events.list": (args) => {
    const [params] = args as [Record<string, string> | undefined];
    return klaviyoGet("events", { params });
  },
  "klaviyo.metrics.list": (args) => {
    const [params] = args as [Record<string, string> | undefined];
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
