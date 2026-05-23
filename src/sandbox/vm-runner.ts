import * as vm from "node:vm";
import { transform } from "sucrase";
import { invoke, methodPaths } from "./bridge.js";
import { buildProxyScript } from "./proxy-template.js";
import { log } from "../config.js";

/**
 * Run user-supplied JavaScript (TypeScript syntax accepted, stripped via sucrase)
 * inside a constrained `node:vm` context.
 *
 * Threat model: this sandbox is a **mistake fence**, not a security boundary.
 *   - User installs this MCP locally, supplies their own Klaviyo/Shopify creds
 *   - The "untrusted" code originates from the user's own LLM client (Claude),
 *     not from an internet attacker
 *   - Goal: prevent accidental access to `fetch`/`process`/`fs`/`env` so a
 *     buggy LLM call doesn't exfiltrate creds or hammer the network
 *   - Non-goal: stop a determined attacker — `node:vm` is well-known to be
 *     escapable via prototype-chain walks; if hostile code is a concern,
 *     run the server as an isolated child process or behind a real sandbox.
 *
 * Why not `isolated-vm`: it works perfectly stand-alone, but Claude Desktop is
 * Electron and Electron's hardened runtime refuses to dlopen native modules
 * whose Team ID doesn't match the host's. We can't sign with Anthropic's cert,
 * and ad-hoc signatures (no Team ID) are also rejected. `node:vm` is built-in,
 * no native dep, no code-signing concerns.
 */

export interface RunResult {
  ok: boolean;
  result?: unknown;
  stdout: string[];
  error?: string;
  durationMs: number;
}

export async function runSandboxVm(
  code: string,
  options: { timeoutMs: number },
): Promise<RunResult> {
  const start = Date.now();

  // The context object IS the sandbox's globalThis. Anything not on it is
  // genuinely unreachable from sandbox code (modulo prototype-chain tricks).
  // We deliberately omit `process`, `Buffer`, `require`, `module`, `fetch`,
  // `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`,
  // `WebAssembly`, `clearTimeout`, and anything else that could be misused.
  const context: Record<string, unknown> = {
    // Host bridge — the one and only way out of the sandbox.
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
    // Standard JS globals that don't reach into Node internals.
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

  // Define globalThis as a self-reference so the proxy template can attach
  // namespaces (`globalThis.klaviyo = ...`) without us pre-declaring each one.
  vm.createContext(context);
  (context as { globalThis: unknown }).globalThis = context;

  // Bootstrap: install console capture + the `klaviyo`/`shopify` namespace tree.
  try {
    vm.runInContext(buildProxyScript(methodPaths), context as vm.Context);
  } catch (e) {
    return {
      ok: false,
      error: `Failed to bootstrap sandbox: ${e instanceof Error ? e.message : String(e)}`,
      stdout: [],
      durationMs: Date.now() - start,
    };
  }

  // Sucrase strips TS-only syntax (annotations, interfaces, casts, generics).
  let jsCode: string;
  try {
    jsCode = transform(code, {
      transforms: ["typescript"],
      disableESTransforms: true,
      production: true,
    }).code;
  } catch {
    // Fall through with the original source so V8 gives the user a real
    // parser error rather than a vague transform failure.
    jsCode = code;
  }

  // Wrap in an async IIFE; the IIFE's return becomes the sandbox result.
  const wrapped = `(async () => {
  const __result = await (async () => {
${jsCode}
  })();
  return JSON.stringify({
    result: __result === undefined ? null : __result,
    stdout: __getStdout(),
  });
})();`;

  // node:vm's `timeout` only catches synchronous code; async code doesn't honor
  // it. We race the IIFE promise against a manual timer instead. NOTE: a
  // runaway sync loop (`while(true)`) IS caught by the `timeout` option below;
  // a runaway async loop (`while(true) await something`) is caught by the race.
  // In either case the rejected promise tells the LLM to add `// @timeout`.
  let userPromise: Promise<unknown>;
  try {
    userPromise = vm.runInContext(wrapped, context as vm.Context, {
      timeout: options.timeoutMs,
    }) as Promise<unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("debug", "Sandbox sync error", { error: msg });
    const isTimeout = msg.includes("Script execution timed out");
    return {
      ok: false,
      error: isTimeout
        ? `Code timed out after ${options.timeoutMs}ms. Add \`// @timeout 2m\` (max 5m) at the top of your code to extend.`
        : msg,
      stdout: [],
      durationMs: Date.now() - start,
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
    };
    return {
      ok: true,
      result: parsed.result,
      stdout: parsed.stdout,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: msg,
      stdout: [],
      durationMs: Date.now() - start,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
