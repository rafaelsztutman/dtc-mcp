import type { ToolResponse } from "./types.js";

export class KlaviyoApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "KlaviyoApiError";
  }
}

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    public extensions?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Format any error into an MCP tool error response.
 * All errors are actionable — they include what the user needs to do.
 */
export function formatError(error: unknown): ToolResponse {
  if (error instanceof KlaviyoApiError) {
    let advice = "";
    if (error.status === 401) {
      advice =
        " Check that KLAVIYO_API_KEY is a valid private key (starts with pk_).";
    } else if (error.status === 429) {
      advice = " Rate limited. Try again in a few seconds.";
    } else if (error.status === 403) {
      advice =
        " Your API key may not have the required scopes. Check Klaviyo API key permissions.";
    }
    return {
      content: [
        {
          type: "text",
          text: `Klaviyo API Error (${error.status}): ${error.message}${advice}`,
        },
      ],
      isError: true,
    };
  }

  if (error instanceof ShopifyApiError) {
    return {
      content: [
        {
          type: "text",
          text: `Shopify API Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }

  if (error instanceof ConfigError) {
    return {
      content: [{ type: "text", text: error.message }],
      isError: true,
    };
  }

  const msg = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Error: ${msg}` }],
    isError: true,
  };
}

/**
 * Return a "not configured" error for Shopify tools when credentials are missing.
 */
export function shopifyNotConfigured(): ToolResponse {
  return {
    content: [
      {
        type: "text",
        text: "Shopify not configured. Set SHOPIFY_STORE + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard app), or SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN (legacy app).",
      },
    ],
    isError: true,
  };
}

/**
 * Create a successful tool response from a JSON-serializable value.
 */
export function toolResult(data: unknown): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}
