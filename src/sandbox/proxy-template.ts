/**
 * Build the JavaScript source that runs INSIDE the `node:vm` context to
 * reconstruct the `klaviyo` and `shopify` namespace trees as thin async stubs.
 *
 * Each leaf method serializes its args to JSON, calls the host bridge function
 * (`__host_invoke`) injected into the context, and awaits the host's promise.
 * The host re-runs the request with real rate limiting, auth, and caching.
 *
 * JSON-encoded args are used (rather than passing the raw array) because:
 *   - `node:vm` shares the V8 heap with the host, so objects could leak the
 *     prototype chain across the boundary if passed directly. JSON normalizes
 *     everything to plain data.
 *   - Behavior matches what we'd do across a worker boundary if we later
 *     swap the runtime for a stricter sandbox.
 */
export function buildProxyScript(methodPaths: string[]): string {
  type Node = { [key: string]: Node | string };
  const tree: Node = {};
  for (const path of methodPaths) {
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
    const resultJson = await __host_invoke(path, argsJson);
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

  const __sdk = ${emit(tree)};
  for (const k of Object.keys(__sdk)) {
    globalThis[k] = __sdk[k];
  }
})();
`;
}
