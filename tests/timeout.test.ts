import { describe, it, expect } from "vitest";
import { resolveTimeout, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "../src/sandbox/timeout.js";

describe("resolveTimeout", () => {
  it("defaults to 30s when no annotation present", () => {
    expect(resolveTimeout("return 1;")).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("parses second suffix", () => {
    expect(resolveTimeout("// @timeout 45s\nreturn 1;")).toBe(45_000);
  });

  it("parses minute suffix", () => {
    expect(resolveTimeout("// @timeout 2m\nreturn 1;")).toBe(120_000);
    expect(resolveTimeout("// @timeout 3min\nreturn 1;")).toBe(180_000);
  });

  it("parses raw milliseconds", () => {
    expect(resolveTimeout("// @timeout 7500\nreturn 1;")).toBe(7_500);
  });

  it("clamps to 5-minute max", () => {
    expect(resolveTimeout("// @timeout 10m\nreturn 1;")).toBe(MAX_TIMEOUT_MS);
  });

  it("clamps to 1-second min", () => {
    expect(resolveTimeout("// @timeout 0\nreturn 1;")).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeout("// @timeout 50ms\nreturn 1;")).toBe(1_000);
  });

  it("ignores annotations beyond the first 20 lines", () => {
    const padding = Array(25).fill("").join("\n");
    expect(resolveTimeout(`${padding}\n// @timeout 5m\nreturn 1;`)).toBe(
      DEFAULT_TIMEOUT_MS,
    );
  });

  it("only honors the first annotation", () => {
    const code = `// @timeout 10s\n// @timeout 5m\nreturn 1;`;
    expect(resolveTimeout(code)).toBe(10_000);
  });
});
