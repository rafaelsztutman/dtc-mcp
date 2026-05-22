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
