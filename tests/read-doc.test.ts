import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY ?? "pk_test_dummy";
  process.env.DTC_MCP_DOCS_REFRESH = "0";
});

describe("docs: readById", () => {
  it("returns a known guide chunk verbatim", async () => {
    const { readById } = await import("../src/docs/search.js");
    const result = await readById("guide.output-discipline");
    expect(result.found).toBe(true);
    expect(result.chunk?.id).toBe("guide.output-discipline");
    expect(result.chunk?.content).toMatch(/pick|topN|summarize/);
  });

  it("returns found=false for unknown IDs", async () => {
    const { readById } = await import("../src/docs/search.js");
    const result = await readById("totally.bogus.path");
    expect(result.found).toBe(false);
    expect(result.chunk).toBeUndefined();
  });

  it("returns a Klaviyo method chunk", async () => {
    const { readById } = await import("../src/docs/search.js");
    const result = await readById("klaviyo.campaigns.list");
    expect(result.found).toBe(true);
    expect(result.chunk?.platform).toBe("klaviyo");
  });
});

describe("docs: listPaths", () => {
  it("lists all chunks with a count", async () => {
    const { listPaths } = await import("../src/docs/search.js");
    const result = await listPaths();
    expect(result.count).toBeGreaterThan(20);
    expect(result.paths.length).toBe(result.count);
    expect(result.paths[0]).toHaveProperty("id");
    expect(result.paths[0]).toHaveProperty("title");
    expect(result.paths[0]).toHaveProperty("platform");
    expect(result.paths[0]).toHaveProperty("summary");
  });

  it("filters by platform", async () => {
    const { listPaths } = await import("../src/docs/search.js");
    const result = await listPaths({ platform: "guide" });
    for (const p of result.paths) {
      expect(p.platform.toLowerCase()).toBe("guide");
    }
  });

  it("paths are sorted alphabetically", async () => {
    const { listPaths } = await import("../src/docs/search.js");
    const result = await listPaths();
    const ids = result.paths.map((p) => p.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});
