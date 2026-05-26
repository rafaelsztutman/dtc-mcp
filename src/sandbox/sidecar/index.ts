/**
 * Sidecar entrypoint — spawned by the main MCP server as a child Node process.
 *
 * Why it exists: Claude Desktop is Electron with hardened runtime + Library
 * Validation, which refuses to dlopen native modules whose code signature
 * doesn't share Anthropic's Team ID. `isolated-vm` therefore can't be loaded
 * directly inside the main MCP server. A child process spawned from the
 * user's system `node` binary has no such restriction, so we load
 * isolated-vm here and proxy execute requests to/from main via stdio.
 *
 * Protocol: newline-delimited JSON, see ../protocol.ts.
 *   stdin  ← MainToSidecar messages
 *   stdout → SidecarToMain messages
 *   stderr → diagnostic logs only (not protocol)
 */

import { createInterface } from "node:readline";
import { SANDBOX_HELPERS_SOURCE } from "../sandbox-helpers.js";
import type {
  ExecuteRequestMessage,
  HostCallResponseMessage,
  InitMessage,
  MainToSidecar,
  SidecarToMain,
} from "../protocol.js";

function send(msg: SidecarToMain): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function logErr(line: string): void {
  process.stderr.write(`[sidecar] ${line}\n`);
}

// Step 1: try to load isolated-vm. If this throws, we tell main and exit so it
// can fall back to the in-process node:vm runner.
let ivmModule: typeof import("isolated-vm");
try {
  ivmModule = await import("isolated-vm").then((m) => m.default ?? m);
} catch (e) {
  send({
    type: "fatal",
    reason: `isolated-vm load failed: ${e instanceof Error ? e.message : String(e)}`,
  });
  process.exit(1);
}
const ivm = ivmModule as unknown as typeof import("isolated-vm");
const ivmVersion =
  (ivmModule as unknown as { version?: string }).version ?? "unknown";

// Step 2: emit ready. Main will follow with an `init` message giving us the
// method-path registry to mirror into the isolate's globals.
send({ type: "ready", ivmVersion });

let methodPaths: string[] = [];
let proxyScript: string | null = null;

// Track host-call resolves per (execId, callId). Each isolate execute can fan
// out many host calls in parallel (Promise.all in user code), so we need
// per-call resolution rather than per-execute.
const pendingHostCalls = new Map<
  string, // `${execId}:${callId}`
  (resultJson: string) => void
>();

// ---- Stateful session ----
//
// One isolate per sidecar process = one MCP connection. Bootstrap runs once;
// each execute reuses the same context so user variables (`globalThis.x =
// ...`) persist across calls. After 30 min idle the isolate is disposed and
// the next execute recreates it with `sessionReset: true` in the result.
const IDLE_TTL_MS = 30 * 60_000;
const HEAP_LIMIT_MB = 256;

interface IsolateSession {
  isolate: import("isolated-vm").Isolate;
  context: import("isolated-vm").Context;
  callCounter: number;
}

let session: IsolateSession | null = null;
let idleTimer: NodeJS.Timeout | null = null;
// Pulls the current execute's id so the host-call bridge can tag outbound
// messages. Set in handleExecute before user code runs.
let currentExecId: string | null = null;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: MainToSidecar;
  try {
    msg = JSON.parse(line) as MainToSidecar;
  } catch (e) {
    logErr(`bad JSON from main: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  switch (msg.type) {
    case "init":
      handleInit(msg);
      break;
    case "execute":
      void handleExecute(msg);
      break;
    case "host-result":
      handleHostResult(msg);
      break;
    case "shutdown":
      process.exit(0);
      break;
    default:
      logErr(`unknown msg type: ${(msg as { type: string }).type}`);
  }
});

rl.on("close", () => {
  // Stdin closed → main process is gone or shutting us down. Exit cleanly.
  process.exit(0);
});

function handleInit(msg: InitMessage): void {
  methodPaths = msg.methodPaths;
  proxyScript = buildIsolateProxyScript(methodPaths);
}

function handleHostResult(msg: HostCallResponseMessage): void {
  const key = `${msg.execId}:${msg.callId}`;
  const resolver = pendingHostCalls.get(key);
  if (!resolver) {
    logErr(`stale host-result for ${key}`);
    return;
  }
  pendingHostCalls.delete(key);
  resolver(msg.resultJson);
}

async function ensureSession(): Promise<{ wasReset: boolean }> {
  if (session && !session.isolate.isDisposed) {
    refreshIdleTimer();
    return { wasReset: false };
  }
  if (!proxyScript) {
    throw new Error("Sidecar not initialized (missing init message)");
  }
  logErr("creating new isolate session");
  const isolate = new ivm.Isolate({ memoryLimit: HEAP_LIMIT_MB });
  const context = await isolate.createContext();
  const jail = context.global;
  await jail.set("global", jail.derefInto());

  // The host-bridge Reference is installed ONCE on the persistent context.
  // It reads currentExecId at call time so calls across executes get tagged
  // with their owning execute's id.
  const invokeRef = new ivm.Reference(
    async (path: string, argsJson: string) => {
      const execId = currentExecId;
      if (!execId) {
        return `__ERROR__host call made outside of an execute context`;
      }
      const s = session;
      if (!s) {
        return `__ERROR__session unavailable`;
      }
      const callId = `c${s.callCounter++}`;
      const key = `${execId}:${callId}`;
      const promise = new Promise<string>((resolveCall) => {
        pendingHostCalls.set(key, resolveCall);
      });
      send({
        type: "host-call",
        execId,
        callId,
        path,
        argsJson,
      });
      return promise;
    },
  );
  await jail.set("__host_invoke", invokeRef);

  // Bootstrap: install proxy + console capture + sandbox helpers. Runs once.
  const bootstrap = await isolate.compileScript(proxyScript);
  await bootstrap.run(context);

  session = { isolate, context, callCounter: 0 };
  refreshIdleTimer();
  return { wasReset: true };
}

function refreshIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    logErr("idle TTL hit; disposing isolate");
    disposeSession();
  }, IDLE_TTL_MS);
  idleTimer.unref?.();
}

function disposeSession(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (session) {
    try {
      session.isolate.dispose();
    } catch {
      // already disposed
    }
    session = null;
  }
}

async function handleExecute(msg: ExecuteRequestMessage): Promise<void> {
  const start = Date.now();

  let wasReset = false;
  try {
    ({ wasReset } = await ensureSession());
  } catch (e) {
    send({
      type: "execute-result",
      id: msg.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      stdout: [],
      durationMs: Date.now() - start,
    });
    return;
  }

  const s = session;
  if (!s) {
    send({
      type: "execute-result",
      id: msg.id,
      ok: false,
      error: "session disposed before execute could run",
      stdout: [],
      durationMs: Date.now() - start,
    });
    return;
  }

  currentExecId = msg.id;
  try {
    // Reset stdout for this call; user-declared globals on `globalThis`
    // persist across calls (the whole point of stateful sessions).
    // Strip TS in the main process before sending — we don't ship sucrase
    // to the sidecar (see sidecar-runner.ts).
    const wrapped = `
(async () => {
  __resetStdout();
  const __result = await (async () => {
${msg.code}
  })();
  return JSON.stringify({
    result: __result === undefined ? null : __result,
    stdout: __getStdout(),
    state: typeof globalThis.globals === 'function' ? globalThis.globals() : {},
  });
})();
`;

    const userScript = await s.isolate.compileScript(wrapped);
    const resultJson = (await userScript.run(s.context, {
      timeout: msg.timeoutMs,
      promise: true,
    })) as string;
    const parsed = JSON.parse(resultJson) as {
      result: unknown;
      stdout: string[];
      state?: Record<string, string>;
    };

    send({
      type: "execute-result",
      id: msg.id,
      ok: true,
      resultJson: JSON.stringify(parsed.result ?? null),
      stdout: parsed.stdout,
      state: parsed.state ?? {},
      durationMs: Date.now() - start,
      ...(wasReset ? { sessionReset: true } : {}),
    });
  } catch (e) {
    const msgStr = e instanceof Error ? e.message : String(e);
    const isTimeout = msgStr.includes("Script execution timed out");
    const isOOM =
      msgStr.includes("memory") || msgStr.includes("Array buffer allocation");
    // Memory limit kills the isolate. Drop the session so the next call
    // builds a fresh one (the LLM will see sessionReset on it).
    if (isOOM) {
      disposeSession();
    }
    send({
      type: "execute-result",
      id: msg.id,
      ok: false,
      error: isTimeout
        ? `Code timed out after ${msg.timeoutMs}ms. Add \`// @timeout 2m\` (max 5m) at the top of your code to extend.`
        : msgStr,
      stdout: [],
      durationMs: Date.now() - start,
      ...(wasReset ? { sessionReset: true } : {}),
    });
  } finally {
    currentExecId = null;
    // Don't dispose the isolate — that's the whole point of stateful sessions.
    // Clean up any orphaned pending host calls for this execute.
    for (const key of pendingHostCalls.keys()) {
      if (key.startsWith(`${msg.id}:`)) pendingHostCalls.delete(key);
    }
    refreshIdleTimer();
  }
}

/**
 * Build the JS that runs INSIDE the isolated-vm isolate. Different from the
 * node:vm proxy template because isolated-vm requires Reference.apply with
 * explicit `arguments.copy` / `result.promise` options to cross the isolate
 * boundary. Args travel as JSON strings to avoid prototype-chain leaks.
 */
function buildIsolateProxyScript(paths: string[]): string {
  type Node = { [key: string]: Node | string };
  const tree: Node = {};
  for (const path of paths) {
    const segments = path.split(".");
    let cursor = tree;
    for (let i = 0; i < segments.length - 1; i++) {
      const key = segments[i];
      if (typeof cursor[key] !== "object") cursor[key] = {};
      cursor = cursor[key] as Node;
    }
    cursor[segments[segments.length - 1]] = path;
  }
  function emit(node: Node): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string") {
        parts.push(
          `${JSON.stringify(key)}: (...args) => __invoke(${JSON.stringify(value)}, args)`,
        );
      } else {
        parts.push(`${JSON.stringify(key)}: ${emit(value)}`);
      }
    }
    return `{${parts.join(",")}}`;
  }

  return `
(function () {
  const __invoke = async function (path, args) {
    const argsJson = JSON.stringify(args);
    const resultJson = await __host_invoke.apply(undefined, [path, argsJson], {
      arguments: { copy: false },
      result: { promise: true }
    });
    if (typeof resultJson === 'string' && resultJson.startsWith('__ERROR__')) {
      throw new Error(resultJson.slice(9));
    }
    return resultJson ? JSON.parse(resultJson) : undefined;
  };

  const __stdout = [];
  globalThis.console = {
    log: (...args) => {
      __stdout.push(args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    },
    error: (...args) => {
      __stdout.push('[err] ' + args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    },
    warn: (...args) => {
      __stdout.push('[warn] ' + args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    },
    info: (...args) => {
      __stdout.push(args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    },
  };
  globalThis.__getStdout = () => __stdout;
  globalThis.__resetStdout = () => { __stdout.length = 0; };

  const __sdk = ${emit(tree)};
  for (const k of Object.keys(__sdk)) {
    globalThis[k] = __sdk[k];
  }
})();

${SANDBOX_HELPERS_SOURCE}
`;
}
