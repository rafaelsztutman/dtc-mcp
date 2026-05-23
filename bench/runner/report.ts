import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CellResult, Mcp, RunState, Task } from "./types.js";
import { summarizeBatches } from "./state.js";

/**
 * Render the benchmark's final markdown report from state.json and the
 * loaded task definitions. Designed to be runnable at any point — partial
 * runs produce partial reports with clearly marked "pending" cells.
 *
 * The report has 5 sections:
 *   1. Headline numbers — total tokens, mean time, mean tool calls per MCP
 *   2. Per-category summary — single-fact / multi-step / cross-resource / output
 *   3. Per-task table — winner per dimension, side-by-side numbers
 *   4. Capability matrix — qualitative coverage differences (deferred fill)
 *   5. Methodology — how we ran it, token-estimation caveats, limitations
 */

const MCPS: Mcp[] = ["dtc-mcp", "klaviyo-mcp"];

export async function writeReport(
  runDir: string,
  state: RunState,
  tasks: Task[],
): Promise<string> {
  const reportPath = join(runDir, "report.md");
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const lines: string[] = [];

  lines.push("# dtc-mcp vs Klaviyo MCP — benchmark report");
  lines.push("");
  lines.push(`Run ID: \`${state.runId}\``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total cells planned: ${state.totalCells}`);
  const completed = countByStatus(state);
  lines.push(
    `Status: ${completed.graded} graded, ${completed.recorded} recorded, ${completed.pending} pending, ${completed.failed} failed`,
  );
  lines.push("");

  // ── 1. Headline numbers ────────────────────────────────────────────────
  lines.push("## Headline numbers");
  lines.push("");
  lines.push(renderHeadlineTable(state));
  lines.push("");

  // ── 2. Per-category summary ────────────────────────────────────────────
  lines.push("## By category");
  lines.push("");
  lines.push(renderCategoryTable(state, taskById));
  lines.push("");

  // ── 3. Per-task table ──────────────────────────────────────────────────
  lines.push("## Per-task results");
  lines.push("");
  lines.push(renderTaskTable(state, taskById));
  lines.push("");

  // ── 4. Batch status (so partial runs are clearly partial) ──────────────
  lines.push("## Batch progress");
  lines.push("");
  lines.push("| Batch | Total | Pending | Recorded | Graded | Failed | Description |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const b of summarizeBatches(state)) {
    lines.push(
      `| ${b.batch} | ${b.total} | ${b.pending} | ${b.recorded} | ${b.graded} | ${b.failed} | ${b.description} |`,
    );
  }
  lines.push("");

  // ── 5. Capability matrix (qualitative, hand-filled later) ──────────────
  lines.push("## Capability matrix");
  lines.push("");
  lines.push(
    "Coverage differences between dtc-mcp and Klaviyo's official MCP that are NOT measured in the benchmark (because they're either unique to one side or out of scope for analytics tasks).",
  );
  lines.push("");
  lines.push("> _To be filled in during Phase 4. See `bench/notes/capability-matrix.md` (TBD)._");
  lines.push("");

  // ── 6. Methodology ─────────────────────────────────────────────────────
  lines.push("## Methodology");
  lines.push("");
  lines.push(
    "Run via Claude Code sub-agents under a Max-plan subscription (no Anthropic API access). Each cell is one task × one MCP × one trial; 3 trials per cell. Sub-agents are constrained to one MCP's tool prefix and instructed to return a structured JSON response. Trajectories captured in `raw.jsonl`. Token counts are **estimated** from observed payload byte lengths (tool definitions × turns + tool I/O + responses), divided by the calibrated tariff (default 4 bytes/token). The estimate intentionally assumes NO prompt cache, so the reported gap between architectures is conservative. Klaviyo data was live during the run.",
  );
  lines.push("");
  lines.push("**Calibration**");
  lines.push("");
  lines.push(
    `Token tariff used: \`${state.tokenTariff}\` bytes/token. Calibration spread vs published Anthropic tokenizer: TBD (Phase 2 verification).`,
  );
  lines.push("");
  lines.push("**Limitations**");
  lines.push("");
  lines.push(
    "- Tokens are estimated, not measured. Reported numbers carry the calibration error margin documented above.",
  );
  lines.push(
    "- Live API data shifts between runs; we ran A+B back-to-back to minimize drift, but Klaviyo's reporting cache is 10+ minutes so most analytics responses are stable.",
  );
  lines.push(
    "- Sub-agent self-reported tool counts are checked against the captured trajectory; mismatches are flagged in `raw.jsonl`.",
  );
  lines.push(
    "- The benchmark targets Klaviyo-only tasks both MCPs can handle. Differential capabilities (cross-platform analytics in dtc-mcp; catalog/translations write-ops in Klaviyo MCP) are in the capability matrix, not the headline numbers.",
  );
  lines.push("");

  const content = lines.join("\n");
  await writeFile(reportPath, content, "utf8");
  return reportPath;
}

function countByStatus(state: RunState): {
  pending: number;
  recorded: number;
  graded: number;
  failed: number;
} {
  const cells = Object.values(state.cells);
  return {
    pending: cells.filter((c) => c.status === "pending").length,
    recorded: cells.filter((c) => c.status === "recorded").length,
    graded: cells.filter((c) => c.status === "graded").length,
    failed: cells.filter((c) => c.status === "failed" || c.status === "invalid").length,
  };
}

function renderHeadlineTable(state: RunState): string {
  const totals = MCPS.map((mcp) => ({
    mcp,
    cells: Object.values(state.cells).filter((c) => c.mcp === mcp),
  }));

  const lines = [
    "| | dtc-mcp | klaviyo-mcp |",
    "|---|---|---|",
    `| Total cells | ${totals[0].cells.length} | ${totals[1].cells.length} |`,
    `| Completed (graded) | ${countComplete(totals[0].cells)} | ${countComplete(totals[1].cells)} |`,
    `| Mean est. tokens / task (sum across 3 trials) | ${meanTokens(totals[0].cells)} | ${meanTokens(totals[1].cells)} |`,
    `| Mean tool calls / task | ${meanToolCalls(totals[0].cells)} | ${meanToolCalls(totals[1].cells)} |`,
    `| Mean wall-clock / task (s) | ${meanWallClock(totals[0].cells)} | ${meanWallClock(totals[1].cells)} |`,
    `| Pass rate (any-claim) | ${passRate(totals[0].cells)} | ${passRate(totals[1].cells)} |`,
  ];
  return lines.join("\n");
}

function renderCategoryTable(
  state: RunState,
  taskById: Map<string, Task>,
): string {
  const cats: Record<string, { dtc: number[]; klv: number[] }> = {};
  for (const cell of Object.values(state.cells)) {
    const task = taskById.get(cell.taskId);
    if (!task) continue;
    const slot = (cats[task.category] ??= { dtc: [], klv: [] });
    if (cell.estimatedTokens === undefined) continue;
    if (cell.mcp === "dtc-mcp") slot.dtc.push(cell.estimatedTokens);
    else slot.klv.push(cell.estimatedTokens);
  }
  const rows = [
    "| Category | dtc-mcp tokens (mean) | klaviyo-mcp tokens (mean) | Ratio |",
    "|---|---|---|---|",
  ];
  for (const [cat, slot] of Object.entries(cats)) {
    const a = mean(slot.dtc);
    const b = mean(slot.klv);
    const ratio = a > 0 && b > 0 ? `${(b / a).toFixed(2)}x` : "—";
    rows.push(`| ${cat} | ${fmt(a)} | ${fmt(b)} | ${ratio} |`);
  }
  return rows.join("\n");
}

function renderTaskTable(
  state: RunState,
  taskById: Map<string, Task>,
): string {
  const rows: string[] = [
    "| Task | Category | dtc-mcp tokens | klaviyo tokens | dtc calls | klv calls | dtc pass | klv pass | Winner (tokens) |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  const taskIds = [...new Set(Object.values(state.cells).map((c) => c.taskId))].sort();
  for (const id of taskIds) {
    const task = taskById.get(id);
    if (!task) continue;
    const dtcCells = Object.values(state.cells).filter(
      (c) => c.taskId === id && c.mcp === "dtc-mcp",
    );
    const klvCells = Object.values(state.cells).filter(
      (c) => c.taskId === id && c.mcp === "klaviyo-mcp",
    );
    const dtcT = mean(dtcCells.map((c) => c.estimatedTokens ?? NaN).filter(Number.isFinite));
    const klvT = mean(klvCells.map((c) => c.estimatedTokens ?? NaN).filter(Number.isFinite));
    const winner = dtcT > 0 && klvT > 0 ? (dtcT < klvT ? "dtc-mcp" : "klaviyo-mcp") : "—";
    rows.push(
      `| ${id} | ${task.category} | ${fmt(dtcT)} | ${fmt(klvT)} | ${meanToolCalls(dtcCells)} | ${meanToolCalls(klvCells)} | ${passRate(dtcCells)} | ${passRate(klvCells)} | ${winner} |`,
    );
  }
  return rows.join("\n");
}

// ── helpers ──────────────────────────────────────────────────────────────

function countComplete(cells: CellResult[]): number {
  return cells.filter((c) => c.status === "graded").length;
}
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function meanTokens(cells: CellResult[]): string {
  return fmt(mean(cells.map((c) => c.estimatedTokens ?? NaN).filter(Number.isFinite)));
}
function meanToolCalls(cells: CellResult[]): string {
  return fmt(
    mean(
      cells
        .map((c) => c.trajectory?.toolCalls.length ?? NaN)
        .filter(Number.isFinite),
    ),
  );
}
function meanWallClock(cells: CellResult[]): string {
  const v = mean(
    cells.map((c) => c.trajectory?.durationMs ?? NaN).filter(Number.isFinite),
  );
  return v ? (v / 1000).toFixed(1) : "—";
}
function passRate(cells: CellResult[]): string {
  const graded = cells.filter((c) => typeof c.score === "number");
  if (graded.length === 0) return "—";
  const passed = graded.filter((c) => (c.score ?? 0) > 0.5).length;
  return `${Math.round((100 * passed) / graded.length)}%`;
}
function fmt(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "—";
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`;
  return n.toFixed(0);
}
