import { describe, it, expect, beforeAll, beforeEach } from "vitest";

beforeAll(() => {
  process.env.KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY ?? "pk_test_dummy";
  // Pin to the vm runner so this suite is hermetic and doesn't depend on
  // having Node ≥ 20 in PATH. Sidecar statefulness is tested separately
  // (it shares the same protocol shape).
  process.env.DTC_MCP_SANDBOX = "vm";
});

// Reset the live context before every test so previous tests' globals don't
// leak. In real life this happens automatically when the MCP connection
// closes; in vitest we share one process across tests.
beforeEach(async () => {
  const { resetVmSessionForTests } = await import(
    "../src/sandbox/vm-runner.js"
  );
  resetVmSessionForTests();
});

describe("vm-runner: stateful sessions", () => {
  it("globalThis assignments persist across calls", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r1 = await runSandbox(`globalThis.x = 42; return 'set';`, {
      timeoutMs: 5_000,
    });
    expect(r1.ok).toBe(true);
    expect(r1.sessionReset).toBe(true); // first call after reset

    const r2 = await runSandbox(`return globalThis.x;`, { timeoutMs: 5_000 });
    expect(r2.ok).toBe(true);
    expect(r2.result).toBe(42);
    expect(r2.sessionReset).toBeUndefined();
  });

  it("variables can be incremented across multiple calls", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    await runSandbox(`globalThis.counter = 0;`, { timeoutMs: 5_000 });
    await runSandbox(`globalThis.counter++;`, { timeoutMs: 5_000 });
    await runSandbox(`globalThis.counter++;`, { timeoutMs: 5_000 });
    const r = await runSandbox(`return globalThis.counter;`, {
      timeoutMs: 5_000,
    });
    expect(r.result).toBe(2);
  });

  it("klaviyo/shopify/console + helpers stay installed across calls", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    await runSandbox(`globalThis.marker = 1;`, { timeoutMs: 5_000 });
    const r = await runSandbox(
      `
        return {
          klaviyo: typeof klaviyo,
          shopify: typeof shopify,
          console: typeof console,
          pick: typeof pick,
          topN: typeof topN,
          summarize: typeof summarize,
          marker: globalThis.marker,
        };
      `,
      { timeoutMs: 5_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({
      klaviyo: "object",
      shopify: "object",
      console: "object",
      pick: "function",
      topN: "function",
      summarize: "function",
      marker: 1,
    });
  });

  it("stdout is reset per call but variables persist", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r1 = await runSandbox(
      `globalThis.savedValue = 'persistent'; console.log('call 1 line'); return 'ok';`,
      { timeoutMs: 5_000 },
    );
    expect(r1.stdout).toEqual(["call 1 line"]);

    const r2 = await runSandbox(
      `console.log('call 2 line'); return savedValue;`,
      { timeoutMs: 5_000 },
    );
    expect(r2.stdout).toEqual(["call 2 line"]); // no carry-over from call 1
    expect(r2.result).toBe("persistent");
  });

  it("emits sessionReset=true after the test-helper reset", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const r1 = await runSandbox(`return 1;`, { timeoutMs: 5_000 });
    expect(r1.sessionReset).toBe(true);

    const r2 = await runSandbox(`return 2;`, { timeoutMs: 5_000 });
    expect(r2.sessionReset).toBeUndefined();

    const { resetVmSessionForTests } = await import(
      "../src/sandbox/vm-runner.js"
    );
    resetVmSessionForTests();

    const r3 = await runSandbox(`return 3;`, { timeoutMs: 5_000 });
    expect(r3.sessionReset).toBe(true);
  });

  it("local consts/lets are NOT shared (only globalThis is)", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    await runSandbox(`const localOnly = 'temp';`, { timeoutMs: 5_000 });
    const r = await runSandbox(
      `return typeof localOnly !== 'undefined' ? localOnly : 'undefined';`,
      { timeoutMs: 5_000 },
    );
    expect(r.result).toBe("undefined");
  });
});
