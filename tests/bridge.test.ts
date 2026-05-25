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

  it("registers JS-idiomatic method aliases routing to canonical handlers", async () => {
    const { methodPaths } = await import("../src/sandbox/bridge.js");
    // A handful of common aliases the LLM tends to guess
    expect(methodPaths).toContain("klaviyo.campaigns.getCampaigns");
    expect(methodPaths).toContain("klaviyo.flows.getFlows");
    expect(methodPaths).toContain("klaviyo.lists.getLists");
    expect(methodPaths).toContain("klaviyo.campaigns.getCampaign");
    expect(methodPaths).toContain("klaviyo.flows.getFlow");
  });
});

describe("normalizeKlaviyoParams", () => {
  it("passes canonical bracket params through unchanged", async () => {
    const { normalizeKlaviyoParams } = await import("../src/sdk/klaviyo/host.js");
    expect(normalizeKlaviyoParams({ "page[size]": "20", "fields[campaign]": "name,status" }))
      .toEqual({ "page[size]": "20", "fields[campaign]": "name,status" });
  });

  it("translates pageSize → page[size] and pageCursor → page[cursor]", async () => {
    const { normalizeKlaviyoParams } = await import("../src/sdk/klaviyo/host.js");
    expect(normalizeKlaviyoParams({ pageSize: 20, pageCursor: "abc123" }))
      .toEqual({ "page[size]": "20", "page[cursor]": "abc123" });
  });

  it("translates nested fields object to bracket form", async () => {
    const { normalizeKlaviyoParams } = await import("../src/sdk/klaviyo/host.js");
    expect(normalizeKlaviyoParams({ fields: { campaign: ["name", "status"], flow: ["trigger_type"] } }))
      .toEqual({ "fields[campaign]": "name,status", "fields[flow]": "trigger_type" });
  });

  it("rewrites sort=-send_time to -scheduled_at (send_time isn't a valid Klaviyo sort key)", async () => {
    const { normalizeKlaviyoParams } = await import("../src/sdk/klaviyo/host.js");
    expect(normalizeKlaviyoParams({ sort: "-send_time" })).toEqual({ sort: "-scheduled_at" });
    expect(normalizeKlaviyoParams({ sort: "send_time" })).toEqual({ sort: "scheduled_at" });
  });

  it("leaves valid sort values alone", async () => {
    const { normalizeKlaviyoParams } = await import("../src/sdk/klaviyo/host.js");
    expect(normalizeKlaviyoParams({ sort: "-scheduled_at" })).toEqual({ sort: "-scheduled_at" });
    expect(normalizeKlaviyoParams({ sort: "name" })).toEqual({ sort: "name" });
  });
});
