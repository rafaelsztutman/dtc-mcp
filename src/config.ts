export type LogLevel = "debug" | "info" | "warn" | "error";

export type ShopifyAuthMode = "client_credentials" | "legacy" | null;

export interface Config {
  // Required
  readonly klaviyoApiKey: string;
  readonly klaviyoRevision: string;

  // Optional - Shopify
  readonly shopifyStore: string | null;
  readonly shopifyAccessToken: string | null;
  readonly shopifyClientId: string | null;
  readonly shopifyClientSecret: string | null;
  readonly shopifyAuthMode: ShopifyAuthMode;
  readonly shopifyApiVersion: string;

  // Optional - Overrides
  readonly klaviyoConversionMetricId: string | null;
  readonly logLevel: LogLevel;
}

function getRequired(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Warn instead of throwing — allows the server to start and return
    // actionable errors when tools are called without credentials
    console.error(
      `[dtc-mcp] warn: Missing environment variable: ${name}. ` +
        `Tools requiring this key will return an error when called.`,
    );
    return "";
  }
  return value;
}

function getOptional(name: string): string | null {
  const raw = process.env[name];
  if (!raw) return null;
  // Claude Desktop may pass placeholder values for unfilled optional fields
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return null;
  return trimmed;
}

function loadConfig(): Config {
  const klaviyoApiKey = getRequired("KLAVIYO_API_KEY");

  const shopifyStore = getOptional("SHOPIFY_STORE");
  const shopifyAccessToken = getOptional("SHOPIFY_ACCESS_TOKEN");
  const shopifyClientId = getOptional("SHOPIFY_CLIENT_ID");
  const shopifyClientSecret = getOptional("SHOPIFY_CLIENT_SECRET");

  // Determine auth mode
  const hasLegacy = shopifyAccessToken !== null;
  const hasClientCredentials =
    shopifyClientId !== null && shopifyClientSecret !== null;

  let shopifyAuthMode: ShopifyAuthMode = null;
  if (hasLegacy && hasClientCredentials) {
    // Both set — prefer client_credentials (recommended), ignore legacy token
    console.error(
      "[dtc-mcp] warn: Both SHOPIFY_ACCESS_TOKEN and SHOPIFY_CLIENT_ID/SECRET are set. Using Client Credentials (recommended). Remove ACCESS_TOKEN to silence this warning.",
    );
    shopifyAuthMode = "client_credentials";
  } else if (hasClientCredentials) {
    shopifyAuthMode = "client_credentials";
  } else if (hasLegacy) {
    shopifyAuthMode = "legacy";
  }

  // Warn (don't throw) if store is missing when auth is configured
  if (shopifyAuthMode && !shopifyStore) {
    console.error(
      "[dtc-mcp] warn: Shopify credentials are set but SHOPIFY_STORE is missing. Shopify tools will be disabled.",
    );
    shopifyAuthMode = null;
  }

  // Warn (don't throw) for partial client credentials
  if (
    (shopifyClientId && !shopifyClientSecret) ||
    (!shopifyClientId && shopifyClientSecret)
  ) {
    console.error(
      "[dtc-mcp] warn: Only one of SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET is set. Both are required. Shopify client credentials auth will be disabled.",
    );
  }

  const rawLogLevel = (process.env.LOG_LEVEL || "info") as LogLevel;
  const validLevels: LogLevel[] = ["debug", "info", "warn", "error"];
  const logLevel = validLevels.includes(rawLogLevel) ? rawLogLevel : "info";
  if (!validLevels.includes(rawLogLevel)) {
    console.error(
      `[dtc-mcp] warn: Invalid LOG_LEVEL "${rawLogLevel}", defaulting to "info".`,
    );
  }

  return Object.freeze({
    klaviyoApiKey,
    klaviyoRevision: "2026-01-15",
    shopifyStore,
    shopifyAccessToken: shopifyAuthMode === "legacy" ? shopifyAccessToken : null,
    shopifyClientId:
      shopifyAuthMode === "client_credentials" ? shopifyClientId : null,
    shopifyClientSecret:
      shopifyAuthMode === "client_credentials" ? shopifyClientSecret : null,
    shopifyAuthMode,
    shopifyApiVersion: process.env.SHOPIFY_API_VERSION || "2026-01",
    klaviyoConversionMetricId: getOptional("KLAVIYO_CONVERSION_METRIC_ID"),
    logLevel,
  });
}

export const config = loadConfig();

export function isShopifyConfigured(): boolean {
  return config.shopifyStore !== null && config.shopifyAuthMode !== null;
}

export function log(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  const levels: LogLevel[] = ["debug", "info", "warn", "error"];
  if (levels.indexOf(level) < levels.indexOf(config.logLevel)) return;

  const entry = data
    ? `[dtc-mcp] ${level}: ${message} ${JSON.stringify(data)}`
    : `[dtc-mcp] ${level}: ${message}`;

  // Always log to stderr — stdout is the MCP transport channel
  console.error(entry);
}
