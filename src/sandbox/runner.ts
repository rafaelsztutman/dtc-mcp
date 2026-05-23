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
    return { ...fallback, sandbox: "vm" };
  }

  return { ...result, sandbox: activeMode };
}
