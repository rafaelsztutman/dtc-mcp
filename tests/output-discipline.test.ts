import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY ?? "pk_test_dummy";
  // Pin to the vm runner so this suite is hermetic.
  process.env.DTC_MCP_SANDBOX = "vm";
});

describe("sandbox helpers: pick", () => {
  it("projects flat objects", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(
      `return pick({a: 1, b: 2, c: 3}, {a: true, c: true});`,
      { timeoutMs: 5_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ a: 1, c: 3 });
  });

  it("projects nested objects", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(
      `return pick({a: 1, b: {x: 9, y: 10}, c: 3}, {b: {x: true}});`,
      { timeoutMs: 5_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ b: { x: 9 } });
  });

  it("projects array elements with a per-element schema", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(
      `return pick([{a:1,b:2}, {a:3,b:4}], {a: true});`,
      { timeoutMs: 5_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual([{ a: 1 }, { a: 3 }]);
  });

  it("ignores schema keys not present in the value", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(
      `return pick({a: 1}, {a: true, missing: true});`,
      { timeoutMs: 5_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ a: 1 });
  });
});

describe("sandbox helpers: topN", () => {
  it("returns the top N items by a numeric key, descending", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(
      `return topN([{r: 10}, {r: 30}, {r: 20}, {r: 5}], 2, "r");`,
      { timeoutMs: 5_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual([{ r: 30 }, { r: 20 }]);
  });

  it("treats missing keys as 0", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(
      `return topN([{r: 10}, {}, {r: 5}], 3, "r");`,
      { timeoutMs: 5_000 },
    );
    expect(r.ok).toBe(true);
    expect((r.result as Array<Record<string, unknown>>)[0]).toEqual({ r: 10 });
  });

  it("accepts a function for the key extractor", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(
      `return topN([{a:1,b:2},{a:5,b:1},{a:3,b:9}], 2, (x) => x.a + x.b);`,
      { timeoutMs: 5_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual([{ a: 3, b: 9 }, { a: 5, b: 1 }]);
  });
});

describe("sandbox helpers: summarize", () => {
  it("counts an array with no options", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(`return summarize([1, 2, 3, 4]);`, {
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ count: 4 });
  });

  it("computes total + min/max/avg when 'by' is set", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(
      `return summarize([{r: 10}, {r: 20}, {r: 30}], { by: "r" });`,
      { timeoutMs: 5_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({
      count: 3,
      total: 60,
      min: 10,
      max: 30,
      avg: 20,
    });
  });

  it("includes topN when requested", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(
      `return summarize([{r:5},{r:50},{r:25}], { by: "r", topN: 2 });`,
      { timeoutMs: 5_000 },
    );
    expect(r.ok).toBe(true);
    const result = r.result as { top: Array<{ r: number }> };
    expect(result.top).toEqual([{ r: 50 }, { r: 25 }]);
  });
});

describe("sandbox helpers: globals", () => {
  it("returns an empty object when nothing has been stashed", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(`return globals();`, { timeoutMs: 5_000 });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({});
  });

  it("lists user-added globals with type summaries", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(
      `
        globalThis.report = { data: [1, 2, 3], attributes: { total: 6 } };
        globalThis.topIds = ['a', 'b', 'c', 'd'];
        globalThis.metricId = 'abc123';
        globalThis.placeholder = null;
        return globals();
      `,
      { timeoutMs: 5_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({
      report: "Object(2 keys)",
      topIds: "Array(4)",
      metricId: '"abc123"',
      placeholder: "null",
    });
  });

  it("auto-populates the state field on RunResult after each call", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(
      `
        globalThis.v106report = { results: [1,2,3] };
        globalThis.v106metricId = 'abc123';
        return globalThis.v106report.results.length;
      `,
      { timeoutMs: 5_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toBe(3);
    // Session state from prior tests may also be present; assert the keys
    // this test created are reflected with the right summary shape.
    expect(r.state).toMatchObject({
      v106report: "Object(1 keys)",
      v106metricId: '"abc123"',
    });
  });

  it("hides built-in helpers and SDK namespaces from the listing", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(`return globals();`, { timeoutMs: 5_000 });
    expect(r.ok).toBe(true);
    const keys = Object.keys(r.result as Record<string, string>);
    expect(keys).not.toContain("klaviyo");
    expect(keys).not.toContain("shopify");
    expect(keys).not.toContain("console");
    expect(keys).not.toContain("pick");
    expect(keys).not.toContain("topN");
    expect(keys).not.toContain("summarize");
    expect(keys).not.toContain("globals");
  });
});

describe("response cap (host-side guard)", () => {
  it("passes small returns through unchanged", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(`return { ok: true, n: 42 };`, {
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ ok: true, n: 42 });
  });

  it("truncates oversized returns with a helpful envelope", async () => {
    // Build a ~200 KB return that exceeds the default 100 KB cap.
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r = await runSandbox(
      `
        const bloat = [];
        for (let i = 0; i < 5000; i++) {
          bloat.push({ id: i, payload: "x".repeat(40) });
        }
        return bloat;
      `,
      { timeoutMs: 10_000 },
    );
    expect(r.ok).toBe(true);
    const result = r.result as {
      truncated: boolean;
      originalBytes: number;
      cap: number;
      instructions: string;
      preview: string;
    };
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBeGreaterThan(100 * 1024);
    expect(result.cap).toBe(100 * 1024);
    expect(result.instructions).toMatch(/pick|summarize|topN/);
    expect(result.preview.length).toBeGreaterThan(0);
  });
});
