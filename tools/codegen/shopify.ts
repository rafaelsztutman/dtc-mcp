/**
 * Generate Shopify doc chunks from the Admin GraphQL schema.
 *
 * Shopify doesn't publish their schema publicly — introspection requires a
 * live store + access token. So this codegen runs against a real shop when
 * `SHOPIFY_STORE` + auth env vars are set. In CI (dtc-mcp-docs repo) those
 * come from repo secrets pointing at a dev store.
 *
 * Without creds, this script emits a minimal placeholder so the merger
 * still has something to work with.
 *
 * Run via: npm run codegen:shopify
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocChunk } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, ".cache", "shopify.json");

const STORE = process.env.SHOPIFY_STORE;
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-04";
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const INTROSPECTION_QUERY = `
  query Introspect {
    __schema {
      queryType { name }
      types {
        name
        kind
        description
        fields(includeDeprecated: false) {
          name
          description
          args { name description type { name kind ofType { name kind } } }
          type { name kind ofType { name kind } }
        }
      }
    }
  }
`;

interface IntrospectedType {
  name: string;
  kind: string;
  description: string | null;
  fields:
    | Array<{
        name: string;
        description: string | null;
        args: Array<{ name: string; description: string | null; type: TypeRef }>;
        type: TypeRef;
      }>
    | null;
}

interface TypeRef {
  name: string | null;
  kind: string;
  ofType: TypeRef | null;
}

function renderType(t: TypeRef): string {
  if (t.kind === "NON_NULL") return `${renderType(t.ofType!)}!`;
  if (t.kind === "LIST") return `[${renderType(t.ofType!)}]`;
  return t.name ?? "?";
}

async function fetchSchema(): Promise<IntrospectedType[]> {
  if (!STORE || !ACCESS_TOKEN) {
    console.warn(
      "[shopify-codegen] SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN not set; emitting placeholder only",
    );
    return [];
  }
  const url = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;
  console.log(`[shopify-codegen] introspecting ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });
  if (!res.ok) {
    throw new Error(`introspect failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as {
    data?: { __schema: { types: IntrospectedType[]; queryType: { name: string } } };
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) throw new Error("no introspection data");
  return json.data.__schema.types;
}

async function main(): Promise<void> {
  const types = await fetchSchema();
  const chunks: DocChunk[] = [];

  // Emit one chunk per QueryRoot field — those are the actually-callable
  // top-level operations. (Mutations could be added similarly when needed.)
  const queryRoot = types.find((t) => t.name === "QueryRoot");
  if (queryRoot?.fields) {
    for (const field of queryRoot.fields) {
      const argLines =
        field.args.length === 0
          ? ""
          : field.args
              .map((a) => {
                const tp = renderType(a.type);
                const desc = a.description
                  ? ` — ${a.description.split("\n")[0]}`
                  : "";
                return `  - \`${a.name}: ${tp}\`${desc}`;
              })
              .join("\n");
      const content = [
        `## Query.${field.name}`,
        "",
        field.description ?? "",
        "",
        argLines ? "**Arguments:**" : "",
        argLines,
        "",
        `**Returns:** \`${renderType(field.type)}\``,
        "",
        "Call via `shopify.gql(query, { variables })`. See https://shopify.dev/docs/api/admin-graphql for full schema.",
      ].join("\n");

      chunks.push({
        id: `shopify.query.${field.name}`,
        title: `Query.${field.name}`,
        platform: "shopify",
        category: "method",
        summary: (field.description ?? "").split("\n")[0].slice(0, 140),
        content,
        tags: ["shopify", "graphql", "query"],
      });
    }
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(chunks, null, 2), "utf8");
  console.log(`[shopify-codegen] wrote ${chunks.length} chunks → ${OUT_PATH}`);
}

main().catch((e) => {
  console.error("[shopify-codegen] FAILED:", e);
  process.exit(1);
});
