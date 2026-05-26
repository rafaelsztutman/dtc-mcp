/**
 * Round 3 ablation. Three experiments sharing one harness:
 *
 *  3A — scenario variation: does F (v1.0.6 control) win consistently across
 *       lookup, revenue, and cross-resource task shapes? Or only on the one
 *       scenario Rounds 1-2 tested? Compares F vs O (Round 2 sleeper win
 *       on length/duration) across 3 distinct scenarios.
 *
 *  3B — cost-annotated example: does inline cost metadata as code comments
 *       (NOT prose) change agent decisions? Tests one new candidate
 *       (F-with-cost-comments) on the revenue scenario.
 *
 *  3C — tool-name framing: does renaming `execute_code` to a more
 *       semantically loaded name change call patterns? Tests F's description
 *       under 3 alternative tool names (analyze / klaviyo_query / dtc).
 *
 * No Klaviyo API hit. Pure description-effects ablation via Sonnet.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { methodPaths } from "../../src/sandbox/bridge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../notes/probe-round3-results");

// ─── Candidate descriptions ────────────────────────────────────────────────

const CANDIDATES: Record<string, { name: string; desc: string }> = {
  F: {
    name: "v1.0.6 control (schema + 1 canonical example)",
    desc: `<TOOL>(code: string) -> { ok, result, stdout, state, durationMs }
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
  O: {
    name: "npm README markdown",
    desc: `# <TOOL>

Run JavaScript against typed Klaviyo + Shopify SDKs in a stateful V8 sandbox.

## Usage

\`\`\`js
// Top 3 campaigns by revenue, last 30 days
const metricId = await klaviyo.getConversionMetricId();
const report = await klaviyo.reporting.campaignValues({
  data: { type: 'campaign-values-report', attributes: {
    timeframe: { key: 'last_30_days' },
    conversion_metric_id: metricId,
    statistics: ['conversion_value'],
  }}
});
globalThis.report = report;
return topN(report.data.attributes.results, 3, r => r.statistics.conversion_value);
\`\`\`

## Parameters

- \`code\` (string): JS/TS to execute. Async. Return values via \`return ...\`.

## Returns

\`{ ok, result?, stdout, state, durationMs }\` — \`state\` is the current \`globalThis\` stash, auto-populated.

## Sandbox globals

\`klaviyo\`, \`shopify\`, \`console\`, \`pick\`, \`topN\`, \`summarize\`, \`globalThis\` (persists across calls in this session).

## Discovery

Use \`search_docs\` and \`read_doc\` for SDK paths and parameter shapes.`,
  },
  F_cost: {
    name: "F + cost annotations in example (structured metadata)",
    desc: `<TOOL>(code: string) -> { ok, result, stdout, state, durationMs }
  state: current globalThis stash (auto-populated, summary-form)

Sandbox globals: klaviyo, shopify, console, pick, topN, summarize, globalThis (persists across calls)

// Reference example (inline annotations show cost; note JSON:API request shape):
const metricId = await klaviyo.getConversionMetricId();       // 1 call, cached forever after first call
const report = await klaviyo.reporting.campaignValues({       // ~30-50kb response, throttled 2/min sustained
  data: { type: 'campaign-values-report', attributes: {
    timeframe: { key: 'last_30_days' },
    conversion_metric_id: metricId,
    statistics: ['recipients', 'open_rate', 'conversion_value'],
  }}
});
globalThis.report = report;                                    // stash for follow-up turns (re-reading: free)
return topN(report.data.attributes.results, 3, r => r.statistics.conversion_value);`,
  },
};

// ─── Scenarios ─────────────────────────────────────────────────────────────

interface Scenario {
  id: string;
  name: string;
  turns: string[];
}

const SCENARIOS: Record<string, Scenario> = {
  lookup: {
    id: "lookup",
    name: "Simple lookup (single turn)",
    turns: ["Show me my 5 most recently sent email campaigns."],
  },
  revenue: {
    id: "revenue",
    name: "Revenue analysis (3 turns)",
    turns: [
      "What were my top 3 email campaigns by revenue in the last 30 days?",
      "How does that compare to the prior 30 days?",
      "Which one of the top 3 had the biggest revenue drop?",
    ],
  },
  cross: {
    id: "cross",
    name: "Cross-resource (3 turns)",
    turns: [
      "What's my largest active segment, and how many profiles are in it?",
      "Of my last 10 sent email campaigns, how many targeted that segment?",
      "Which of those targeted campaigns had the best open rate?",
    ],
  },
};

// ─── Test plan ─────────────────────────────────────────────────────────────

interface Cell {
  experimentId: string;       // "3A" / "3B" / "3C"
  candidateId: string;
  scenarioId: string;
  toolName: string;
  trial: number;
  cellId: string;
}

const TRIALS = 3;

function buildPlan(): Cell[] {
  const plan: Cell[] = [];

  // 3A: F + O across 3 scenarios × 3 trials = 18 cells
  for (const cand of ["F", "O"]) {
    for (const scn of ["lookup", "revenue", "cross"]) {
      for (let t = 1; t <= TRIALS; t++) {
        plan.push({
          experimentId: "3A",
          candidateId: cand,
          scenarioId: scn,
          toolName: "execute_code",
          trial: t,
          cellId: `3A_${cand}_${scn}_t${t}`,
        });
      }
    }
  }

  // 3B: F_cost on revenue scenario × 3 trials = 3 cells
  for (let t = 1; t <= TRIALS; t++) {
    plan.push({
      experimentId: "3B",
      candidateId: "F_cost",
      scenarioId: "revenue",
      toolName: "execute_code",
      trial: t,
      cellId: `3B_Fcost_revenue_t${t}`,
    });
  }

  // 3C: F under 3 alternative tool names × revenue scenario × 3 trials = 9 cells
  for (const name of ["analyze", "klaviyo_query", "dtc"]) {
    for (let t = 1; t <= TRIALS; t++) {
      plan.push({
        experimentId: "3C",
        candidateId: "F",
        scenarioId: "revenue",
        toolName: name,
        trial: t,
        cellId: `3C_F_${name}_revenue_t${t}`,
      });
    }
  }

  return plan;
}

// ─── Prompt construction ───────────────────────────────────────────────────

function buildPrompt(desc: string, toolName: string, scenario: Scenario): string {
  const descWithName = desc.replace(/<TOOL>/g, toolName);
  const turnList = scenario.turns
    .map((t, i) => `Turn ${i + 1}: "${t}"`)
    .join("\n");

  const expectedSections = scenario.turns
    .map((_, i) => `## Turn ${i + 1}\n\`\`\`js\n[code]\n\`\`\`\nOne-line comment.`)
    .join("\n\n");

  return `You have access to a tool called \`${toolName}\`. Here is its complete definition (everything the host gave you about it):

---
${descWithName}
---

Imagine you're using this tool across a ${scenario.turns.length}-turn conversation. The user's turns are:

${turnList}

For EACH turn, write the JS code you would pass to ${toolName} as the \`code\` argument. Do NOT actually invoke any tools — just write the code as you would compose it. After each turn's code, assume the result is available for the next turn.

Format strictly as:

${expectedSections}`;
}

// ─── Runner ────────────────────────────────────────────────────────────────

interface Result extends Cell {
  text: string;
  durationMs: number;
}

const JUDGE_TIMEOUT_MS = 2 * 60 * 1000;

async function runProbe(cell: Cell): Promise<Result> {
  const candidate = CANDIDATES[cell.candidateId];
  const scenario = SCENARIOS[cell.scenarioId];
  const prompt = buildPrompt(candidate.desc, cell.toolName, scenario);

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
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      rej(new Error(`probe timed out (${JUDGE_TIMEOUT_MS}ms)`));
    }, JUDGE_TIMEOUT_MS);

    proc.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    proc.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (code !== 0) {
        rej(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
        return;
      }
      try {
        const parsed = JSON.parse(out) as { result?: string };
        res({ ...cell, text: parsed.result ?? out, durationMs });
      } catch {
        res({ ...cell, text: out, durationMs });
      }
    });
  });
}

// ─── Scoring ───────────────────────────────────────────────────────────────

const VALID_PATHS = new Set(methodPaths);

interface Score extends Result {
  length: number;
  stashedTurn1: boolean;
  referencedLater: boolean;
  callCount: number;
  callsByTurn: number[];
  hallucinated: string[];
}

function findMethodCalls(text: string, root: "klaviyo" | "shopify"): string[] {
  const re = new RegExp(`\\b${root}((?:\\.[a-zA-Z_$][\\w$]*)+)\\s*\\(`, "g");
  const found: string[] = [];
  for (const m of text.matchAll(re)) found.push(root + m[1]);
  return found;
}

function scoreResult(r: Result): Score {
  const scenario = SCENARIOS[r.scenarioId];
  const numTurns = scenario.turns.length;

  // Split by Turn markers
  const turns = r.text.split(/##\s*Turn\s*\d+/i).slice(1);
  while (turns.length < numTurns) turns.push("");
  const turn1 = turns[0] ?? "";
  const laterTurns = turns.slice(1).join("");

  const stashedTurn1 = /globalThis\.[a-zA-Z_$][\w$]*\s*=/.test(turn1);
  const referencedLater =
    numTurns > 1 &&
    /globalThis\.[a-zA-Z_$][\w$]*(?!\s*=)/.test(laterTurns) &&
    /globalThis\.[a-zA-Z_$][\w$]*[^=]/.test(laterTurns);

  const calls = [
    ...findMethodCalls(r.text, "klaviyo"),
    ...findMethodCalls(r.text, "shopify"),
  ];
  const hallucinated = calls.filter((c) => !VALID_PATHS.has(c));

  const callsByTurn = turns.slice(0, numTurns).map(
    (tu) =>
      findMethodCalls(tu, "klaviyo").length + findMethodCalls(tu, "shopify").length,
  );

  return {
    ...r,
    length: r.text.length,
    stashedTurn1,
    referencedLater,
    callCount: calls.length,
    callsByTurn,
    hallucinated: [...new Set(hallucinated)],
  };
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

async function runBatched<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map(fn));
    for (const r of results) {
      if (r.status === "fulfilled") out.push(r.value);
      else process.stderr.write(`[probe] failed: ${r.reason}\n`);
    }
    process.stderr.write(
      `[probe] batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(items.length / concurrency)} done\n`,
    );
  }
  return out;
}

function fmt(n: number, places = 1): string {
  return Number(n).toFixed(places);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let concurrency = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--concurrency") concurrency = parseInt(args[i + 1] ?? "5", 10);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const plan = buildPlan();
  process.stderr.write(
    `[probe] ${plan.length} cells (3A: 18, 3B: 3, 3C: 9), concurrency ${concurrency}\n`,
  );

  const results = await runBatched(plan, concurrency, async (cell) => {
    const r = await runProbe(cell);
    writeFileSync(resolve(OUT_DIR, `${cell.cellId}.txt`), r.text);
    return r;
  });
  const scored = results.map(scoreResult);

  writeFileSync(
    resolve(OUT_DIR, "summary.json"),
    JSON.stringify(scored, null, 2),
  );

  // ─── 3A summary: F vs O across scenarios ─────────────────────────────────

  console.log("\n=== 3A: Scenario variation (F vs O across 3 scenarios) ===\n");
  console.log(
    "| Scenario | Cand | stash | refed | calls/T | hallc | len  | dur(s) |",
  );
  console.log(
    "|----------|------|-------|-------|---------|-------|------|--------|",
  );
  for (const scnId of ["lookup", "revenue", "cross"]) {
    for (const candId of ["F", "O"]) {
      const runs = scored.filter(
        (s) => s.experimentId === "3A" && s.scenarioId === scnId && s.candidateId === candId,
      );
      if (runs.length === 0) continue;
      const scenario = SCENARIOS[scnId];
      const numTurns = scenario.turns.length;
      const stash = numTurns > 1 ? `${runs.filter((r) => r.stashedTurn1).length}/${runs.length}` : "n/a";
      const refed = numTurns > 1 ? `${runs.filter((r) => r.referencedLater).length}/${runs.length}` : "n/a";
      const calls = fmt(runs.reduce((s, r) => s + r.callCount, 0) / runs.length);
      const halluc = runs.flatMap((r) => r.hallucinated).length;
      const len = Math.round(runs.reduce((s, r) => s + r.length, 0) / runs.length);
      const dur = fmt(runs.reduce((s, r) => s + r.durationMs, 0) / runs.length / 1000);
      console.log(
        `| ${scnId.padEnd(8)} | ${candId}    | ${stash.padStart(5)} | ${refed.padStart(5)} | ${calls.padStart(6)}  | ${String(halluc).padStart(5)} | ${String(len).padStart(4)} | ${dur.padStart(6)} |`,
      );
    }
  }

  // ─── 3B summary: F vs F_cost on revenue ─────────────────────────────────

  console.log("\n=== 3B: Cost-annotated example (F vs F_cost, revenue scenario) ===\n");
  console.log(
    "| Cand    | stash | refed | calls/T | hallc | len  | dur(s) |",
  );
  console.log(
    "|---------|-------|-------|---------|-------|------|--------|",
  );
  for (const candId of ["F", "F_cost"]) {
    const runs = scored.filter(
      (s) =>
        s.scenarioId === "revenue" &&
        s.candidateId === candId &&
        (s.experimentId === "3A" || s.experimentId === "3B") &&
        s.toolName === "execute_code",
    );
    if (runs.length === 0) continue;
    const stash = `${runs.filter((r) => r.stashedTurn1).length}/${runs.length}`;
    const refed = `${runs.filter((r) => r.referencedLater).length}/${runs.length}`;
    const calls = fmt(runs.reduce((s, r) => s + r.callCount, 0) / runs.length);
    const halluc = runs.flatMap((r) => r.hallucinated).length;
    const len = Math.round(runs.reduce((s, r) => s + r.length, 0) / runs.length);
    const dur = fmt(runs.reduce((s, r) => s + r.durationMs, 0) / runs.length / 1000);
    console.log(
      `| ${candId.padEnd(7)} | ${stash.padStart(5)} | ${refed.padStart(5)} | ${calls.padStart(6)}  | ${String(halluc).padStart(5)} | ${String(len).padStart(4)} | ${dur.padStart(6)} |`,
    );
  }

  // ─── 3C summary: tool-name framing ──────────────────────────────────────

  console.log("\n=== 3C: Tool-name framing (F on revenue, 4 names) ===\n");
  console.log(
    "| Tool name        | stash | refed | calls/T | hallc | len  | dur(s) |",
  );
  console.log(
    "|------------------|-------|-------|---------|-------|------|--------|",
  );
  for (const name of ["execute_code", "analyze", "klaviyo_query", "dtc"]) {
    const runs = scored.filter(
      (s) =>
        s.candidateId === "F" &&
        s.scenarioId === "revenue" &&
        s.toolName === name &&
        (s.experimentId === "3A" || s.experimentId === "3C"),
    );
    if (runs.length === 0) continue;
    const stash = `${runs.filter((r) => r.stashedTurn1).length}/${runs.length}`;
    const refed = `${runs.filter((r) => r.referencedLater).length}/${runs.length}`;
    const calls = fmt(runs.reduce((s, r) => s + r.callCount, 0) / runs.length);
    const halluc = runs.flatMap((r) => r.hallucinated).length;
    const len = Math.round(runs.reduce((s, r) => s + r.length, 0) / runs.length);
    const dur = fmt(runs.reduce((s, r) => s + r.durationMs, 0) / runs.length / 1000);
    console.log(
      `| ${name.padEnd(16)} | ${stash.padStart(5)} | ${refed.padStart(5)} | ${calls.padStart(6)}  | ${String(halluc).padStart(5)} | ${String(len).padStart(4)} | ${dur.padStart(6)} |`,
    );
  }

  // ─── Hallucinations roll-up ──────────────────────────────────────────────

  console.log("\n=== Hallucinations (all rounds) ===");
  for (const exp of ["3A", "3B", "3C"]) {
    const runs = scored.filter((s) => s.experimentId === exp);
    const halluc = [...new Set(runs.flatMap((r) => r.hallucinated))];
    if (halluc.length > 0) {
      console.log(`  ${exp}: ${halluc.slice(0, 10).join(", ")}${halluc.length > 10 ? "..." : ""}`);
    }
  }

  console.log(`\nFull transcripts: ${OUT_DIR}/*.txt`);
  console.log(`Detailed scores: ${OUT_DIR}/summary.json`);
}

main().catch((e) => {
  console.error("[probe]", e);
  process.exit(1);
});
