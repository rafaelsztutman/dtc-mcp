import * as vm from "node:vm";
import { transform } from "sucrase";
import { invoke, methodPaths } from "./bridge.js";
import { buildProxyScript } from "./proxy-template.js";
import { log } from "../config.js";

/**
 * Run user-supplied JavaScript (TypeScript syntax accepted, stripped via sucrase)
 * inside a constrained `node:vm` context.
 *
 * State model: **stateful, per MCP connection**. We keep a single long-lived
 * `vm.Context` at module scope for the lifetime of the MCP server process,
 * which equals one Claude Desktop "connect to extension" session. User code
 * that assigns to `globalThis.foo = ...` (or declares `var foo = ...`) will
 * still be visible in the next `execute_code` call. After 30 minutes of
 * idleness the context is destroyed and recreated; the next call's result
 * envelope includes `sessionReset: true` so the LLM knows prior state is gone.
 *
 * Threat model: this sandbox is a **mistake fence**, not a security boundary.
 *   - User installs this MCP locally, supplies their own Klaviyo/Shopify creds
 *   - The "untrusted" code originates from the user's own LLM client (Claude),
 *     not from an internet attacker
 *   - Goal: prevent accidental access to `fetch`/`process`/`fs`/`env` so a
 *     buggy LLM call doesn't exfiltrate creds or hammer the network
 *   - Non-goal: stop a determined attacker — `node:vm` is well-known to be
 *     escapable via prototype-chain walks
 */

export interface RunResult {
  ok: boolean;
  result?: unknown;
  stdout: string[];
  error?: string;
  durationMs: number;
  /** Current globalThis stash summary (post-execution snapshot). Maps user-added
   * global names → short type summaries (e.g. "Array(5000)", "Object(2 keys)").
   * Empty object when nothing is stashed. Auto-populated; agent can read it
   * from the response to see what data is available for the next call. */
  state?: Record<string, string>;
  /** True when the underlying context was recreated since the last call. */
  sessionReset?: boolean;
}

const IDLE_TTL_MS = 30 * 60_000; // 30 minutes

interface VmSession {
  context: vm.Context;
  idleTimer: NodeJS.Timeout | null;
  callCount: number;
}

let session: VmSession | null = null;

function newContext(): vm.Context {
  const context: Record<string, unknown> = {
    __host_invoke: async (path: string, argsJson: string): Promise<string> => {
      try {
        const args = JSON.parse(argsJson) as unknown[];
        const result = await invoke(path, args);
        return JSON.stringify(result ?? null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `__ERROR__${msg}`;
      }
    },
    Promise,
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    URIError,
    ReferenceError,
    Infinity,
    NaN,
    undefined: undefined,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    structuredClone:
      typeof globalThis.structuredClone === "function"
        ? globalThis.structuredClone
        : undefined,
  };

  vm.createContext(context);
  (context as { globalThis: unknown }).globalThis = context;

  // Bootstrap once at session creation: install console capture, the
  // klaviyo/shopify namespace tree, and the output-discipline helpers.
  vm.runInContext(buildProxyScript(methodPaths), context as vm.Context);

  return context as vm.Context;
}

function refreshIdleTimer(s: VmSession): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    log("info", "vm-runner: session idle, destroying context");
    session = null;
  }, IDLE_TTL_MS);
  // Don't keep the event loop alive just for the idle timer.
  s.idleTimer.unref?.();
}

function ensureSession(): { session: VmSession; wasReset: boolean } {
  if (session) {
    refreshIdleTimer(session);
    return { session, wasReset: false };
  }
  log("debug", "vm-runner: creating new session context");
  session = { context: newContext(), idleTimer: null, callCount: 0 };
  refreshIdleTimer(session);
  return { session, wasReset: true };
}

/** Test/dev hook: drop the live context so the next call gets a fresh one. */
export function resetVmSessionForTests(): void {
  if (session?.idleTimer) clearTimeout(session.idleTimer);
  session = null;
}

export async function runSandboxVm(
  code: string,
  options: { timeoutMs: number },
): Promise<RunResult> {
  const start = Date.now();
  const { session: s, wasReset } = ensureSession();
  s.callCount++;

  // After the first call, the proxy bootstrap script's IIFE has already run
  // and console / klaviyo / etc. are installed. We only need to wrap user
  // code in an async IIFE per call. Stdout is captured per-call via the
  // closure inside the bootstrap (re-installed below as a fresh array so
  // calls don't share stdout).
  // The bootstrap installs __getStdout but the inner __stdout array survives
  // across calls — we explicitly reset it for each call.
  const wrapped = `(async () => {
  // Reset stdout for this call (state-sharing isn't useful for log lines).
  globalThis.__resetStdout?.();
  const __result = await (async () => {
${transformIfTs(code)}
  })();
  return JSON.stringify({
    result: __result === undefined ? null : __result,
    stdout: __getStdout(),
    state: typeof globalThis.globals === 'function' ? globalThis.globals() : {},
  });
})();`;

  // First-call hook: install __resetStdout. We do this lazily so the
  // bootstrap script doesn't need to know about session semantics.
  if (s.callCount === 1) {
    vm.runInContext(
      `globalThis.__resetStdout = () => { while (__getStdout().length) __getStdout().pop(); };`,
      s.context,
    );
  }

  let userPromise: Promise<unknown>;
  try {
    userPromise = vm.runInContext(wrapped, s.context, {
      timeout: options.timeoutMs,
    }) as Promise<unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = msg.includes("Script execution timed out");
    return {
      ok: false,
      error: isTimeout
        ? `Code timed out after ${options.timeoutMs}ms. Add \`// @timeout 2m\` (max 5m) at the top of your code to extend.`
        : msg,
      stdout: [],
      durationMs: Date.now() - start,
      ...(wasReset ? { sessionReset: true } : {}),
    };
  }

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Code timed out after ${options.timeoutMs}ms. Add \`// @timeout 2m\` (max 5m) at the top of your code to extend.`,
        ),
      );
    }, options.timeoutMs);
  });

  try {
    const resultJson = (await Promise.race([userPromise, timeoutPromise])) as string;
    const parsed = JSON.parse(resultJson) as {
      result: unknown;
      stdout: string[];
      state?: Record<string, string>;
    };
    return {
      ok: true,
      result: parsed.result,
      stdout: parsed.stdout,
      state: parsed.state ?? {},
      durationMs: Date.now() - start,
      ...(wasReset ? { sessionReset: true } : {}),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: msg,
      stdout: [],
      durationMs: Date.now() - start,
      ...(wasReset ? { sessionReset: true } : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function transformIfTs(src: string): string {
  try {
    return transform(src, {
      transforms: ["typescript"],
      disableESTransforms: true,
      production: true,
    }).code;
  } catch {
    return src;
  }
}
