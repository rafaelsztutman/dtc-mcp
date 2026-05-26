/**
 * LLM-native tool-description ablation. For each of N candidate
 * descriptions, spawn 3 fresh Sonnet sub-agents (claude -p), give each
 * the same 3-turn scenario, ask it to write the code it WOULD pass to
 * execute_code (without actually invoking anything), then score the
 * responses on behavior dimensions that matter:
 *
 *   - stash      : did turn-1 code assign to globalThis?
 *   - referenced : did turn-2/3 code read from globalThis without re-fetching?
 *   - callCount  : total klaviyo.* / shopify.* calls across all 3 turns
 *   - hallucinated: count of method names not in the bridge registry
 *   - length     : total response chars (proxy for elaboration cost)
 *
 * No Klaviyo API hit. No production sandbox spawned. Pure description-
 * effects ablation.
 *
 * Usage:
 *   tsx bench/runner/probe-descriptions.ts [--concurrency N]
 *
 * Writes per-trial transcripts to bench/notes/probe-results/<id>-<trial>.txt
 * and prints a summary table to stdout.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { methodPaths } from "../../src/sandbox/bridge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_OUT = resolve(HERE, "../notes/probe-results");

// ─── Candidate descriptions ─────────────────────────────────────────────

const CANDIDATES: Record<string, { name: string; desc: string }> = {
  A: {
    name: "Minimal (v1.0.4 baseline)",
    desc: `Execute JavaScript against the typed Klaviyo + Shopify SDKs in a stateful V8 sandbox.
Variables assigned to globalThis persist across calls within this MCP session.

Available globals: klaviyo, shopify, console, pick, topN, summarize, globalThis`,
  },
  B: {
    name: "Schema-first (TypeScript signature)",
    desc: `execute_code(code: string): Promise<{
  ok: boolean
  result?: unknown
  error?: string
  stdout: string[]
  state: { [k: string]: string }  // current globalThis stash (auto-populated)
  durationMs: number
}>

// Globals in sandbox:
declare const klaviyo: KlaviyoSDK
declare const shopify: ShopifySDK
declare function pick<T>(v: T, schema: Schema): T
declare function topN<T>(arr: T[], n: number, by: string | ((t:T)=>number)): T[]
declare function summarize(arr, opts): Summary
// globalThis persists across calls in this MCP session`,
  },
  C: {
    name: "Example-first (code only, ~zero prose)",
    desc: `// Execute JS in a stateful sandbox. Examples:

// 1. List
return await klaviyo.campaigns.list({ sort: '-scheduled_at' });

// 2. Stash for next call
globalThis.report = await klaviyo.reporting.flowValues({ data: { ... } });
return summarize(globalThis.report.data.attributes.results, { by: 'value', topN: 3 });

// 3. Read prior call's stash
return globalThis.report.data.attributes.results[0].name;

// Available: klaviyo, shopify, console, pick, topN, summarize, globalThis (persists)`,
  },
  D: {
    name: "Ultra-compressed (token-minimized)",
    desc: `JS sandbox, stateful per connection.
Globals: klaviyo|shopify|console|pick|topN|summarize|globalThis(persists).
Use search_docs for method shapes.`,
  },
  E: {
    name: "Hybrid (schema + 1 example, response-side teaching)",
    desc: `execute_code(code: string) -> { ok, result, stdout, state, durationMs }
  where state is the current globalThis stash (auto-populated, summary-form)

Sandbox globals: klaviyo, shopify, console, pick, topN, summarize, globalThis

// globalThis persists across calls; results from prior calls remain available:
globalThis.report = await klaviyo.reporting.flowValues({ data: { ... } });
// next call: globalThis.report is still there`,
  },
  F: {
    name: "Proposed v1.0.6 (schema + canonical example, real API surface)",
    desc: `execute_code(code: string) -> { ok, result, stdout, state, durationMs }
  state: current globalThis stash (auto-populated, summary-form)

Sandbox globals: klaviyo, shopify, console, pick, topN, summarize, globalThis (persists across calls)

// Reference example (note the JSON:API request shape):
const metricId = await klaviyo.getConversionMetricId();
const report = await klaviyo.reporting.campaignValues({
  data: { type: 'campaign-values-report', attributes: {
    timeframe: { key: 'last_30_days' },
    conversion_metric_id: metricId,
    statistics: ['recipients', 'open_rate', 'conversion_value'],
  }}
});
globalThis.report = report;
return topN(report.data.attributes.results, 3, r => r.statistics.conversion_value);`,
  },
};

const TRIALS = 3;

const SCENARIO = `Imagine you're using this tool across a 3-turn conversation. The user's turns are:

Turn 1: "What were my top 3 email campaigns by revenue in the last 30 days?"
Turn 2: "How does that compare to the prior 30 days?"
Turn 3: "Which one of the top 3 had the biggest revenue drop?"

For EACH turn, write the JS code you would pass to execute_code as the \`code\` argument. Do NOT actually invoke any tools — just write the code as you would compose it. After each turn's code, assume the result is available for the next turn.

Format strictly as:

## Turn 1
\`\`\`js
[code]
\`\`\`
One-line comment on approach.

## Turn 2
\`\`\`js
[code]
\`\`\`
One-line comment.

## Turn 3
\`\`\`js
[code]
\`\`\`
One-line comment.`;

function makePrompt(desc: string): string {
  return `You have access to a tool called \`execute_code\`. Here is its complete definition (everything the host gave you about it):

---
${desc}
---

${SCENARIO}`;
}

// ─── Probe runner ───────────────────────────────────────────────────────

interface ProbeRun {
  candidateId: string;
  trial: number;
  text: string;
  durationMs: number;
}

async function runProbe(candidateId: string, trial: number, desc: string): Promise<ProbeRun> {
  const prompt = makePrompt(desc);
  const start = Date.now();
  return new Promise((res, rej) => {
    const proc = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--model",
        "claude-sonnet-4-6",
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    proc.on("error", rej);
    proc.on("close", (code) => {
      const durationMs = Date.now() - start;
      if (code !== 0) {
        rej(new Error(`claude -p exited ${code}: ${err.slice(0, 200)}`));
        return;
      }
      try {
        const parsed = JSON.parse(out) as { result?: string };
        res({ candidateId, trial, text: parsed.result ?? out, durationMs });
      } catch {
        res({ candidateId, trial, text: out, durationMs });
      }
    });
  });
}

// ─── Scoring ────────────────────────────────────────────────────────────

const VALID_PATHS = new Set(methodPaths);
// Permit common JS/SDK constructs that look like method calls but aren't:
const ALWAYS_VALID = new Set(["klaviyo.get", "klaviyo.post"]);
for (const p of ALWAYS_VALID) VALID_PATHS.add(p);

function findMethodCalls(text: string, root: "klaviyo" | "shopify"): string[] {
  // Match `klaviyo.x.y.z(` or `klaviyo.x(` — capture the dotted path.
  const re = new RegExp(`\\b${root}((?:\\.[a-zA-Z_$][\\w$]*)+)\\s*\\(`, "g");
  const found: string[] = [];
  for (const m of text.matchAll(re)) {
    found.push(root + m[1]);
  }
  return found;
}

interface Score {
  candidateId: string;
  trial: number;
  length: number;
  stashedTurn1: boolean;
  referencedLater: boolean;
  callCount: number;
  callsByTurn: number[];
  hallucinated: string[];
  durationMs: number;
}

function scoreResponse(run: ProbeRun): Score {
  const t = run.text;
  // Split by turn markers
  const turns = t.split(/##\s*Turn\s*\d+/i).slice(1);
  while (turns.length < 3) turns.push("");
  const turn1 = turns[0] ?? "";
  const laterTurns = (turns[1] ?? "") + (turns[2] ?? "");

  const stashedTurn1 = /globalThis\.[a-zA-Z_$][\w$]*\s*=/.test(turn1);
  // Reference to globalThis.foo in turn 2+ where it's NOT being assigned for the first time
  const referencedLater =
    /globalThis\.[a-zA-Z_$][\w$]*(?!\s*=)/.test(laterTurns) &&
    /globalThis\.[a-zA-Z_$][\w$]*[^=]/.test(laterTurns);

  const calls = [
    ...findMethodCalls(t, "klaviyo"),
    ...findMethodCalls(t, "shopify"),
  ];
  const hallucinated = calls.filter((c) => !VALID_PATHS.has(c));

  // Per-turn call count
  const callsByTurn = turns.slice(0, 3).map((tu) => {
    return findMethodCalls(tu, "klaviyo").length + findMethodCalls(tu, "shopify").length;
  });

  return {
    candidateId: run.candidateId,
    trial: run.trial,
    length: t.length,
    stashedTurn1,
    referencedLater,
    callCount: calls.length,
    callsByTurn,
    hallucinated: [...new Set(hallucinated)],
    durationMs: run.durationMs,
  };
}

// ─── Orchestrator ───────────────────────────────────────────────────────

async function runBatched<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(fn));
    out.push(...results);
    process.stderr.write(
      `[probe] batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(items.length / concurrency)} done\n`,
    );
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let concurrency = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--concurrency") concurrency = parseInt(args[i + 1] ?? "5", 10);
  }

  mkdirSync(PROBE_OUT, { recursive: true });

  const tasks: Array<{ id: string; trial: number; desc: string }> = [];
  for (const [id, c] of Object.entries(CANDIDATES)) {
    for (let t = 1; t <= TRIALS; t++) {
      tasks.push({ id, trial: t, desc: c.desc });
    }
  }
  process.stderr.write(
    `[probe] spawning ${tasks.length} probes (${Object.keys(CANDIDATES).length} candidates × ${TRIALS} trials), concurrency ${concurrency}\n`,
  );

  const runs = await runBatched(tasks, concurrency, async (task) => {
    const run = await runProbe(task.id, task.trial, task.desc);
    writeFileSync(resolve(PROBE_OUT, `${task.id}-${task.trial}.txt`), run.text);
    return run;
  });

  const scores = runs.map(scoreResponse);

  // Aggregate per candidate
  console.log("\n=== Behavior summary (means across 3 trials) ===\n");
  console.log(
    "| Cand | Name                                | stash | refed | calls/T | calls/turn         | hallc | len   | dur(s) |",
  );
  console.log(
    "|------|-------------------------------------|-------|-------|---------|--------------------|-------|-------|--------|",
  );
  for (const id of Object.keys(CANDIDATES)) {
    const runs = scores.filter((s) => s.candidateId === id);
    const stash = runs.filter((r) => r.stashedTurn1).length;
    const refed = runs.filter((r) => r.referencedLater).length;
    const avgCalls = (runs.reduce((s, r) => s + r.callCount, 0) / runs.length).toFixed(1);
    const meanTurnCalls = [0, 1, 2].map((ti) =>
      (runs.reduce((s, r) => s + (r.callsByTurn[ti] ?? 0), 0) / runs.length).toFixed(1),
    );
    const halluc = runs.flatMap((r) => r.hallucinated);
    const avgLen = Math.round(runs.reduce((s, r) => s + r.length, 0) / runs.length);
    const avgDur = (runs.reduce((s, r) => s + r.durationMs, 0) / runs.length / 1000).toFixed(1);
    console.log(
      `|  ${id}   | ${CANDIDATES[id].name.padEnd(35)} | ${stash}/${TRIALS}   | ${refed}/${TRIALS}   | ${avgCalls.padStart(6)}  | ${meanTurnCalls.join("/")}             | ${halluc.length}     | ${String(avgLen).padStart(5)} | ${avgDur} |`,
    );
  }

  // Hallucinations detail
  console.log("\n=== Hallucinated method names (by candidate) ===");
  for (const id of Object.keys(CANDIDATES)) {
    const runs = scores.filter((s) => s.candidateId === id);
    const halluc = [...new Set(runs.flatMap((r) => r.hallucinated))];
    if (halluc.length > 0) {
      console.log(`  ${id}: ${halluc.join(", ")}`);
    }
  }

  // Per-trial detail to /notes
  const detail = scores.map((s) => ({
    candidate: s.candidateId,
    candidateName: CANDIDATES[s.candidateId]?.name,
    trial: s.trial,
    length: s.length,
    stashedTurn1: s.stashedTurn1,
    referencedLater: s.referencedLater,
    callCount: s.callCount,
    callsByTurn: s.callsByTurn,
    hallucinated: s.hallucinated,
    durationMs: s.durationMs,
  }));
  writeFileSync(
    resolve(PROBE_OUT, "summary.json"),
    JSON.stringify(detail, null, 2),
  );
  console.log(`\nFull transcripts: ${PROBE_OUT}/*.txt`);
  console.log(`Detailed scores: ${PROBE_OUT}/summary.json`);
}

main().catch((e) => {
  console.error("[probe]", e);
  process.exit(1);
});
