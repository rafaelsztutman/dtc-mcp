import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY ?? "pk_test_dummy";
  // Disable network refresh so the test runs offline and deterministically.
  process.env.DTC_MCP_DOCS_REFRESH = "0";
});

describe("docs search", () => {
  it("returns relevant chunks for a campaign query", async () => {
    const { search } = await import("../src/docs/search.js");
    const { version, hits } = await search("campaigns");
    expect(version).toMatch(/^v/);
    expect(hits.length).toBeGreaterThan(0);
    const topIds = hits.map((h) => h.id);
    expect(topIds.some((id) => id.includes("campaign"))).toBe(true);
  });

  it("returns ShopifyQL doc when searching for sales analytics", async () => {
    const { search } = await import("../src/docs/search.js");
    const { hits } = await search("shopifyql sales");
    expect(hits[0]?.id).toBe("shopify.ql");
  });

  it("filters by platform", async () => {
    const { search } = await import("../src/docs/search.js");
    const { hits } = await search("list", { platform: "shopify" });
    for (const h of hits) {
      expect(h.platform.toLowerCase()).toBe("shopify");
    }
  });

  it("returns empty hits for blank query", async () => {
    const { search } = await import("../src/docs/search.js");
    const { hits } = await search("   ");
    expect(hits).toEqual([]);
  });

  it("respects the limit option", async () => {
    const { search } = await import("../src/docs/search.js");
    const { hits } = await search("klaviyo", { limit: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});
