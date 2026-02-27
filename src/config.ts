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
  return process.env[name] || null;
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

  if (hasLegacy && hasClientCredentials) {
    throw new Error(
      "Ambiguous Shopify config: both SHOPIFY_ACCESS_TOKEN and SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET are set. Use one auth mode, not both.",
    );
  }

  let shopifyAuthMode: ShopifyAuthMode = null;
  if (hasClientCredentials) {
    shopifyAuthMode = "client_credentials";
  } else if (hasLegacy) {
    shopifyAuthMode = "legacy";
  }

  // Validate that store is set when any auth is configured
  if (shopifyAuthMode && !shopifyStore) {
    throw new Error(
      "SHOPIFY_STORE is required when Shopify credentials are configured.",
    );
  }

  // Validate partial client credentials
  if (
    (shopifyClientId && !shopifyClientSecret) ||
    (!shopifyClientId && shopifyClientSecret)
  ) {
    throw new Error(
      "Both SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set together.",
    );
  }

  const logLevel = (process.env.LOG_LEVEL || "info") as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new Error(
      `Invalid LOG_LEVEL: ${logLevel}. Must be one of: debug, info, warn, error`,
    );
  }

  return Object.freeze({
    klaviyoApiKey,
    klaviyoRevision: "2026-01-15",
    shopifyStore,
    shopifyAccessToken,
    shopifyClientId,
    shopifyClientSecret,
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
