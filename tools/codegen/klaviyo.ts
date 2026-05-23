/**
 * Generate Klaviyo doc chunks from the official Klaviyo OpenAPI spec.
 *
 * Pulls https://raw.githubusercontent.com/klaviyo/openapi/main/openapi/stable.json
 * (versioned mirror of the live API) and emits one chunk per path+method into
 * tools/codegen/.cache/klaviyo.json. The docs.ts merger combines this with
 * the Shopify chunks and hand-curated guides into the final data/docs.json.
 *
 * Run via: npm run codegen:klaviyo
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocChunk } from "./types.js";

const SPEC_URL =
  process.env.KLAVIYO_OPENAPI_URL ??
  "https://raw.githubusercontent.com/klaviyo/openapi/main/openapi/stable.json";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, ".cache", "klaviyo.json");

interface OpenAPISpec {
  paths: Record<string, Record<string, OperationObject>>;
  components?: { schemas?: Record<string, unknown> };
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: { type?: string; enum?: string[] };
  }>;
}

async function main(): Promise<void> {
  console.log(`[klaviyo-codegen] fetching ${SPEC_URL}`);
  const res = await fetch(SPEC_URL);
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  }
  const spec = (await res.json()) as OpenAPISpec;

  const chunks: DocChunk[] = [];

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!["get", "post", "put", "delete", "patch"].includes(method)) continue;
      const opId = op.operationId ?? `${method}_${path}`;
      const params = (op.parameters ?? [])
        .filter((p) => p.in === "query" || p.in === "path")
        .map((p) => {
          const req = p.required ? " (required)" : "";
          const desc = p.description ? ` — ${p.description.split("\n")[0]}` : "";
          return `- \`${p.name}\`${req}${desc}`;
        })
        .slice(0, 30); // cap so chunks stay scannable

      // SDK example: the `klaviyo.get` / `klaviyo.post` SDK already prepends
      // the `/api/` base URL, so the example needs to strip the leading
      // `api/` from the OpenAPI path (e.g. `/api/campaign-messages/{id}` →
      // `campaign-messages/{id}`). Without this strip the LLM writes
      // `klaviyo.get('api/...')` and gets a `/api/api/...` 404 on the wire.
      const sdkPath = path.replace(/^\//, "").replace(/^api\//, "");
      const content = [
        `## ${method.toUpperCase()} ${path}`,
        "",
        op.description ?? op.summary ?? "",
        "",
        params.length ? "**Parameters:**" : "",
        ...params,
        "",
        `Use \`klaviyo.${method === "get" ? "get" : "post"}('${sdkPath}', ...)\` to call this endpoint. (Note: the SDK auto-prepends \`/api/\`, so do NOT include it in the path argument.)`,
      ]
        .filter((line) => line !== undefined)
        .join("\n");

      chunks.push({
        id: `klaviyo.openapi.${opId}`,
        title: `${method.toUpperCase()} ${path}`,
        platform: "klaviyo",
        category: "method",
        summary: op.summary ?? `${method.toUpperCase()} ${path}`,
        content,
        tags: ["klaviyo", "openapi", ...(op.tags ?? [])].slice(0, 8),
      });
    }
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(chunks, null, 2), "utf8");
  console.log(`[klaviyo-codegen] wrote ${chunks.length} chunks → ${OUT_PATH}`);
}

main().catch((e) => {
  console.error("[klaviyo-codegen] FAILED:", e);
  process.exit(1);
});
