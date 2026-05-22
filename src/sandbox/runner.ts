import ivm from "isolated-vm";
import { transform } from "sucrase";
import { invoke, methodPaths } from "./bridge.js";
import { buildProxyScript } from "./proxy-template.js";
import { log } from "../config.js";

const HEAP_LIMIT_MB = 128;

export interface RunResult {
  ok: boolean;
  /** Return value of the user's code, or undefined if none */
  result?: unknown;
  /** Captured console.{log,warn,error,info} lines */
  stdout: string[];
  /** Error message if ok=false */
  error?: string;
  /** Wall-clock duration in ms */
  durationMs: number;
}

/**
 * Run TypeScript-ish user code inside a fresh isolated-vm V8 isolate.
 *
 * The isolate has no `fetch`, no `process`, no `require`/`import` resolution,
 * no filesystem, no env. The only way out is the host bridge — and the host
 * bridge accepts only paths in the method registry, every call routes
 * through real auth + rate limiting + caching.
 *
 * `code` is wrapped in an async IIFE and the IIFE's return value becomes
 * `result`. TypeScript annotations are stripped (V8 doesn't parse them) by
 * a minimal pre-processing pass — for anything more complex than that, the
 * LLM is expected to write plain JS.
 */
export async function runSandbox(
  code: string,
  options: { timeoutMs: number },
): Promise<RunResult> {
  const start = Date.now();
  const isolate = new ivm.Isolate({ memoryLimit: HEAP_LIMIT_MB });

  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set("global", jail.derefInto());

    // Host bridge: every sandbox SDK call ends up here. We stringify the
    // result so the wire format is uniform; errors come back with the
    // `__ERROR__` sentinel so the proxy stub can re-throw inside the isolate.
    const invokeRef = new ivm.Reference(async (path: string, argsJson: string) => {
      try {
        const args = JSON.parse(argsJson) as unknown[];
        const result = await invoke(path, args);
        return JSON.stringify(result ?? null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `__ERROR__${msg}`;
      }
    });
    await jail.set("__host_invoke", invokeRef);

    // Bootstrap: install the typed SDK namespace tree + a console capture.
    const bootstrap = await isolate.compileScript(buildProxyScript(methodPaths));
    await bootstrap.run(context);

    // Strip TypeScript-only syntax so the LLM can write idiomatic-looking TS.
    // Sucrase is a tiny (~200KB), zero-dep transpiler that only does
    // type-stripping — no full type checking, no plugin pipeline. Safe to
    // run on every request.
    const jsCode = stripTypeAnnotations(code);

    // Wrap in async IIFE; serialize the result via JSON for transport.
    const wrapped = `
(async () => {
  const __result = await (async () => {
${jsCode}
  })();
  return JSON.stringify({
    result: __result === undefined ? null : __result,
    stdout: __getStdout(),
  });
})();
`;

    const userScript = await isolate.compileScript(wrapped);
    const resultJson = (await userScript.run(context, {
      timeout: options.timeoutMs,
      promise: true,
    })) as string;

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
    log("debug", "Sandbox error", { error: msg });

    // isolated-vm signals timeouts with a specific message.
    const isTimeout = msg.includes("Script execution timed out");
    return {
      ok: false,
      error: isTimeout
        ? `Code timed out after ${options.timeoutMs}ms. Add \`// @timeout 2m\` (max 5m) to the top of your code to extend.`
        : msg,
      stdout: [],
      durationMs: Date.now() - start,
    };
  } finally {
    isolate.dispose();
  }
}

function stripTypeAnnotations(src: string): string {
  try {
    const { code } = transform(src, {
      transforms: ["typescript"],
      // The user code is inlined into our async wrapper; we don't want sucrase
      // to inject a "use strict" directive or any ESM machinery.
      disableESTransforms: true,
      production: true,
    });
    return code;
  } catch (e) {
    // If sucrase fails (e.g. syntax error), let V8 see the original source so
    // the user gets a real parser error message rather than a vague transform
    // failure.
    log("debug", "sucrase transform failed; passing source through", {
      error: e instanceof Error ? e.message : String(e),
    });
    return src;
  }
}
