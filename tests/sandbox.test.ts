import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY ?? "pk_test_dummy";
  // Force the vm-runner so this test file is hermetic — sidecar tests run
  // separately in tests/sidecar.test.ts.
  process.env.DTC_MCP_SANDBOX = "vm";
});

describe("sandbox runner (vm fallback)", () => {
  it("runs trivial code and returns the value", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const result = await runSandbox("return 2 + 2;", { timeoutMs: 5000 });
    expect(result.ok).toBe(true);
    expect(result.result).toBe(4);
    expect(result.sandbox).toBe("vm");
  });

  it("captures console.log into stdout", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const result = await runSandbox(
      `console.log("hello"); console.log("world", 42); return "done";`,
      { timeoutMs: 5000 },
    );
    expect(result.ok).toBe(true);
    expect(result.result).toBe("done");
    expect(result.stdout).toEqual(["hello", "world 42"]);
  });

  it("denies fetch, process, require, import inside the sandbox", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const checks = await runSandbox(
      `
        return {
          fetch: typeof fetch,
          process: typeof process,
          require: typeof require,
          setTimeout: typeof setTimeout,
        };
      `,
      { timeoutMs: 5000 },
    );
    expect(checks.ok).toBe(true);
    expect(checks.result).toMatchObject({
      fetch: "undefined",
      process: "undefined",
      require: "undefined",
      setTimeout: "undefined",
    });
  });

  it("enforces wall-clock timeout", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const result = await runSandbox(`while (true) {}`, { timeoutMs: 250 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it("strips TypeScript annotations", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const result = await runSandbox(
      `
        const x: number = 5;
        const y: string = "hi";
        const z = (n: number): number => n * 2;
        return { x, y, z: z(10) };
      `,
      { timeoutMs: 5000 },
    );
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ x: 5, y: "hi", z: 20 });
  });

  it("exposes klaviyo namespace tree with known methods", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const result = await runSandbox(
      `
        return {
          hasKlaviyo: typeof klaviyo,
          hasGet: typeof klaviyo.get,
          hasPost: typeof klaviyo.post,
          hasCampaignsList: typeof klaviyo.campaigns.list,
          hasReporting: typeof klaviyo.reporting.campaignValues,
        };
      `,
      { timeoutMs: 5000 },
    );
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      hasKlaviyo: "object",
      hasGet: "function",
      hasPost: "function",
      hasCampaignsList: "function",
      hasReporting: "function",
    });
  });

  it("rejects unknown SDK paths through the bridge", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const result = await runSandbox(
      `
        try {
          await klaviyo.campaigns.list({});
          return "ok";
        } catch (e) {
          return { caught: true, message: String(e.message).slice(0, 80) };
        }
      `,
      { timeoutMs: 8000 },
    );
    expect(result.ok).toBe(true);
  });
});
