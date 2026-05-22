import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY ?? "pk_test_dummy";
});

describe("bridge registry", () => {
  it("exposes a non-empty method registry", async () => {
    const { methodPaths } = await import("../src/sandbox/bridge.js");
    expect(methodPaths.length).toBeGreaterThan(10);
    // Spot check the core escape hatches and convenience helpers
    expect(methodPaths).toContain("klaviyo.get");
    expect(methodPaths).toContain("klaviyo.post");
    expect(methodPaths).toContain("klaviyo.campaigns.list");
    expect(methodPaths).toContain("klaviyo.reporting.campaignValues");
    expect(methodPaths).toContain("shopify.gql");
    expect(methodPaths).toContain("shopify.ql");
  });

  it("rejects unknown method paths", async () => {
    const { invoke } = await import("../src/sandbox/bridge.js");
    await expect(invoke("klaviyo.bogus.x", [])).rejects.toThrow(/Unknown SDK method/);
  });

  it("rejects shopify calls when not configured", async () => {
    const { invoke } = await import("../src/sandbox/bridge.js");
    // Default test env doesn't have SHOPIFY_STORE set
    delete process.env.SHOPIFY_STORE;
    delete process.env.SHOPIFY_ACCESS_TOKEN;
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
    await expect(invoke("shopify.gql", ["{ shop { name } }", undefined])).rejects.toThrow(/Shopify not configured/);
  });
});
