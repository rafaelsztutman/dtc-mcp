/**
 * Newline-delimited JSON-RPC protocol shared between the main MCP server
 * and the spawned sidecar Node process. Each message is one JSON object
 * per line on stdin/stdout.
 *
 * Flow:
 *   1. Sidecar starts, tries to `require('isolated-vm')`.
 *      - On failure → sends FatalMessage and exits 1.
 *      - On success → sends ReadyMessage with isolated-vm version.
 *   2. Main sends InitMessage with the method-path registry.
 *   3. Main sends ExecuteRequestMessage to run user code.
 *   4. During execution, the sandbox's bridge calls round-trip:
 *      sidecar → HostCallRequestMessage → main → HostCallResponseMessage → sidecar.
 *   5. Sidecar sends ExecuteResponseMessage when done.
 *   6. On shutdown, main sends ShutdownMessage (or just closes stdin).
 */

export interface ReadyMessage {
  type: "ready";
  /** isolated-vm package version, for diagnostics. */
  ivmVersion: string;
}

export interface FatalMessage {
  type: "fatal";
  reason: string;
}

export interface LogMessage {
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface InitMessage {
  type: "init";
  /** Method-path registry to mirror as the in-isolate SDK surface. */
  methodPaths: string[];
}

export interface ExecuteRequestMessage {
  type: "execute";
  /** Correlation ID set by the main process. */
  id: string;
  code: string;
  timeoutMs: number;
}

export interface HostCallRequestMessage {
  type: "host-call";
  /** ID of the in-flight execute that owns this call. */
  execId: string;
  /** Unique per host call within a single execute. */
  callId: string;
  path: string;
  argsJson: string;
}

export interface HostCallResponseMessage {
  type: "host-result";
  execId: string;
  callId: string;
  /** JSON-encoded result, or `__ERROR__<msg>` sentinel for thrown errors. */
  resultJson: string;
}

export interface ExecuteResponseMessage {
  type: "execute-result";
  id: string;
  ok: boolean;
  /** JSON-encoded user return value, only meaningful when ok=true. */
  resultJson?: string;
  stdout: string[];
  error?: string;
  durationMs: number;
  /** True when the underlying isolate was recreated since the last call. */
  sessionReset?: boolean;
}

export interface ShutdownMessage {
  type: "shutdown";
}

export type MainToSidecar =
  | InitMessage
  | ExecuteRequestMessage
  | HostCallResponseMessage
  | ShutdownMessage;

export type SidecarToMain =
  | ReadyMessage
  | FatalMessage
  | LogMessage
  | ExecuteResponseMessage
  | HostCallRequestMessage;

export function encodeLine(msg: MainToSidecar | SidecarToMain): string {
  return JSON.stringify(msg) + "\n";
}
