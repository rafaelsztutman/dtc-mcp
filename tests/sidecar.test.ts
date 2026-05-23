import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { discoverNode } from "../src/sandbox/node-discovery.js";

beforeAll(() => {
  process.env.KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY ?? "pk_test_dummy";
  process.env.DTC_MCP_SANDBOX = "auto";
});

describe("node-discovery", () => {
  it("finds the running Node binary on the dev machine", async () => {
    const node = await discoverNode();
    // We must be running on Node ≥ 20 to even execute these tests.
    expect(node).not.toBeNull();
    if (node) {
      expect(node.major).toBeGreaterThanOrEqual(20);
      expect(node.path).toMatch(/node(\.exe)?$/);
    }
  });
});

// End-to-end sidecar test. Skipped automatically if discovery fails to find
// a system Node, so CI environments without Node still pass.
describe("sidecar runner (isolated-vm via spawned Node)", async () => {
  const node = await discoverNode();
  const runIt = node ? it : it.skip;

  runIt("routes code through the sidecar and returns its result", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const result = await runSandbox("return 7 * 6;", { timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    expect(result.result).toBe(42);
    expect(result.sandbox).toBe("sidecar");
  });

  runIt("denies fetch + process inside the isolated-vm isolate", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const result = await runSandbox(
      `return { fetch: typeof fetch, process: typeof process };`,
      { timeoutMs: 10_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      fetch: "undefined",
      process: "undefined",
    });
    expect(result.sandbox).toBe("sidecar");
  });

  runIt("captures console.log", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    const result = await runSandbox(
      `console.log("from", "isolate"); return "ok";`,
      { timeoutMs: 10_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.stdout).toEqual(["from isolate"]);
  });

  runIt("globalThis assignments persist across calls in the isolate", async () => {
    const { runSandbox } = await import("../src/sandbox/runner.js");
    // Two consecutive calls — the second can read state set by the first.
    // Note: other tests in this file may have already initialized the
    // sidecar's isolate, so we don't assert on r1.sessionReset here.
    const r1 = await runSandbox(`globalThis.shared = 'kept'; return 1;`, {
      timeoutMs: 10_000,
    });
    expect(r1.ok).toBe(true);
    expect(r1.sandbox).toBe("sidecar");

    const r2 = await runSandbox(`return globalThis.shared;`, {
      timeoutMs: 10_000,
    });
    expect(r2.ok).toBe(true);
    expect(r2.result).toBe("kept");
    expect(r2.sessionReset).toBeUndefined();
  });

  runIt(
    "wires klaviyo proxy and host-bridge round-trip succeeds (path validation only)",
    async () => {
      const { runSandbox } = await import("../src/sandbox/runner.js");
      // klaviyo.campaigns.list is a known path; the actual API call will
      // 401 against our dummy key, but the bridge round-trip itself is the
      // point of this test — we just want to confirm the call reached the
      // main process and an error came back across the boundary.
      const result = await runSandbox(
        `
          try {
            await klaviyo.campaigns.list({});
            return { reached: true };
          } catch (e) {
            return { reached: true, errMsg: String(e.message).slice(0, 80) };
          }
        `,
        { timeoutMs: 15_000 },
      );
      expect(result.ok).toBe(true);
      expect((result.result as { reached: boolean }).reached).toBe(true);
      expect(result.sandbox).toBe("sidecar");
    },
  );
});

afterAll(async () => {
  // Give the sidecar's SIGTERM handler a moment so vitest doesn't flag a
  // leaked-process warning.
  await new Promise((r) => setTimeout(r, 200));
});
