/**
 * Opaque cursor pagination helpers.
 * Both Klaviyo and Shopify cursors are encoded into opaque base64url strings
 * so the LLM never sees platform-specific pagination parameters.
 */

export function encodeCursor(raw: string): string {
  return Buffer.from(raw).toString("base64url");
}

export function decodeCursor(opaque: string): string {
  return Buffer.from(opaque, "base64url").toString();
}

/**
 * Extract and encode cursor from Klaviyo's JSON:API `links.next` URL.
 * Klaviyo returns: links.next = "https://a.klaviyo.com/api/campaigns?page[cursor]=XXXX"
 */
export function extractKlaviyoCursor(links?: {
  next?: string;
}): string | null {
  if (!links?.next) return null;
  try {
    const url = new URL(links.next);
    const cursor = url.searchParams.get("page[cursor]");
    return cursor ? encodeCursor(cursor) : null;
  } catch {
    return null;
  }
}

/**
 * Extract and encode cursor from Shopify GraphQL pageInfo.
 */
export function extractShopifyCursor(pageInfo?: {
  hasNextPage: boolean;
  endCursor?: string | null;
}): string | null {
  if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return null;
  return encodeCursor(pageInfo.endCursor);
}
