import { runSandboxVm, type RunResult } from "./vm-runner.js";
import { getSidecarStatus, runSandboxSidecar } from "./sidecar-runner.js";
import { log } from "../config.js";

/**
 * Public sandbox runner. Routes between the sidecar (isolated-vm) and the
 * in-process vm-runner (node:vm) based on availability.
 *
 * Selection logic:
 *   - DTC_MCP_SANDBOX=vm        → always use node:vm
 *   - DTC_MCP_SANDBOX=sidecar   → require sidecar; error if unavailable
 *   - DTC_MCP_SANDBOX=auto      → default: prefer sidecar, fall back to vm
 *
 * The active mode is logged once at first use so users can see in the debug
 * log which sandbox is actually executing their code.
 */

export type { RunResult } from "./vm-runner.js";

export type SandboxMode = "sidecar" | "vm";

let activeMode: SandboxMode | null = null;

async function pickMode(): Promise<SandboxMode> {
  const override = (process.env.DTC_MCP_SANDBOX ?? "auto").toLowerCase();

  if (override === "vm") return "vm";

  const status = await getSidecarStatus();
  if (override === "sidecar") {
    if (!status.available) {
      // Caller asked for sidecar specifically; throwing here would break
      // execute_code. We log the failure and fall back so the tool stays
      // usable — but the log makes it obvious.
      log("error", "DTC_MCP_SANDBOX=sidecar but sidecar unavailable", {
        reason: status.reason,
      });
    }
    return status.available ? "sidecar" : "vm";
  }

  // auto
  return status.available ? "sidecar" : "vm";
}

/**
 * Cap user code's return payload so an over-eager LLM that returns a raw
 * 380 KB JSON blob doesn't burn through the conversation's context window.
 * Stainless's own benchmark caps factuality at 53% across all code-mode
 * MCPs because "models tend toward verbose responses beyond what's strictly
 * necessary." This is the host-side enforcement; the in-sandbox `pick` /
 * `summarize` / `topN` helpers are the LLM-friendly remediation.
 */
const MAX_RESPONSE_BYTES = (() => {
  const raw = process.env.DTC_MCP_MAX_RESPONSE_KB;
  if (raw) {
    const kb = parseInt(raw, 10);
    if (Number.isFinite(kb) && kb > 0) return kb * 1024;
  }
  return 100 * 1024;
})();

function applyResponseCap(result: RunResult): RunResult {
  if (!result.ok || result.result === undefined || result.result === null) {
    return result;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(result.result);
  } catch {
    // If the value isn't JSON-serializable, leave it for the upstream
    // JSON.stringify (in execute_code.ts) to surface the error.
    return result;
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_RESPONSE_BYTES) return result;

  // Capture a leading slice as a preview so the LLM can still see the shape.
  // Truncate at ~90% of the cap to leave room for the truncation envelope.
  const previewLimit = Math.floor(MAX_RESPONSE_BYTES * 0.9);
  const preview = serialized.slice(0, previewLimit);

  log("warn", "Response capped", {
    originalBytes: bytes,
    cap: MAX_RESPONSE_BYTES,
  });

  return {
    ...result,
    result: {
      truncated: true,
      originalBytes: bytes,
      cap: MAX_RESPONSE_BYTES,
      preview,
      instructions:
        "Output exceeded the response cap. Use `pick(value, schema)` to project specific fields, `topN(arr, n, key)` for top items, or `summarize(arr, { by, topN })` for aggregate stats. See search_docs('output discipline') for examples.",
    },
  };
}

export async function runSandbox(
  code: string,
  options: { timeoutMs: number },
): Promise<RunResult & { sandbox: SandboxMode }> {
  if (!activeMode) {
    activeMode = await pickMode();
    log("info", "Sandbox mode selected", { mode: activeMode });
  }

  const result =
    activeMode === "sidecar"
      ? await runSandboxSidecar(code, options)
      : await runSandboxVm(code, options);

  // If the sidecar died mid-session (e.g., child crashed), gracefully drop
  // to vm-runner for THIS call and every future call.
  if (
    activeMode === "sidecar" &&
    !result.ok &&
    typeof result.error === "string" &&
    result.error.startsWith("Sidecar unavailable")
  ) {
    log("warn", "Sidecar dropped; falling back to vm-runner", {
      error: result.error,
    });
    activeMode = "vm";
    const fallback = await runSandboxVm(code, options);
    return { ...applyResponseCap(fallback), sandbox: "vm" };
  }

  return { ...applyResponseCap(result), sandbox: activeMode };
}
