import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as nodeFsSync from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  Batch,
  BatchPlan,
  CellId,
  CellResult,
  Mcp,
  McpMetadata,
  PacingConfig,
  RunState,
  Task,
} from "./types.js";

/**
 * Default pacing — strictly sequential, with extra breathing room for
 * Klaviyo's tier-throttled reporting endpoints (1/s burst, 2/min sustained
 * on `campaign-values-reports` and `flow-values-reports`). The benchmark
 * runs against a real production account; getting flagged would be a much
 * bigger problem than a slow benchmark.
 */
const DEFAULT_PACING: PacingConfig = {
  concurrency: 1,           // one sub-agent at a time, full stop
  baseDelayMs: 3000,        // 3s pause between any two cells
  reportingDelayMs: 8000,   // +8s before a reporting-heavy task (=11s total)
  mcpSwitchDelayMs: 10000,  // +10s when flipping dtc-mcp ↔ klaviyo-mcp
};

/**
 * State.json is the single source of truth for a benchmark run. Every
 * sub-agent invocation, grade, and aggregate read from it; every cell
 * completion writes to it. Atomic write semantics (write to temp file then
 * rename) so a crash mid-update doesn't corrupt the checkpoint.
 */

/**
 * Two trials per cell — enough to spot variance, light enough to fit a
 * single Max-plan quota window for the full 36-cell sweep. If two trials
 * disagree wildly, the runner can be invoked with a manual `--retry` for
 * a third trial on the disputed cell.
 */
const TRIALS_PER_CELL = 2;

/**
 * Batches are organized along the conversation-length axis (baseline →
 * long). Each batch runs both MCPs back-to-back so reporting-endpoint
 * cache warming and time-of-day drift affect both sides equally. The
 * hypothesis under test: as turn count grows, dtc-mcp's stateful sandbox
 * keeps tokens flat or shrinking (results from prior turns live in
 * globalThis) while tool-list MCPs re-serialize full payloads each turn,
 * so the gap should compound with conversation length.
 */
const BATCH_DEFINITIONS: Record<
  Batch,
  { tasks: string[]; mcps: Mcp[]; description: string }
> = {
  A: {
    tasks: ["01", "02", "03"],
    mcps: ["dtc-mcp", "klaviyo-mcp"],
    description: "Baseline (1 turn) — 3 tasks × 2 MCPs × 2 trials = 12 cells",
  },
  B: {
    tasks: ["04", "05"],
    mcps: ["dtc-mcp", "klaviyo-mcp"],
    description: "Short conversation (2 turns) — 2 × 2 × 2 = 8 cells",
  },
  C: {
    tasks: ["06", "07"],
    mcps: ["dtc-mcp", "klaviyo-mcp"],
    description: "Medium conversation (5 turns) — 2 × 2 × 2 = 8 cells",
  },
  D: {
    tasks: ["08", "09"],
    mcps: ["dtc-mcp", "klaviyo-mcp"],
    description: "Long conversation (10 turns) — 2 × 2 × 2 = 8 cells",
  },
};

export function cellIdFor(taskId: string, mcp: Mcp, trial: number): CellId {
  return `${taskId}::${mcp}::trial-${trial}`;
}

export function parseCellId(id: CellId): {
  taskId: string;
  mcp: Mcp;
  trial: number;
} {
  const [taskId, mcp, trialPart] = id.split("::");
  return {
    taskId,
    mcp: mcp as Mcp,
    trial: parseInt(trialPart.replace("trial-", ""), 10),
  };
}

/**
 * Build a fresh RunState from a set of loaded tasks. Doesn't touch disk;
 * caller is responsible for writing.
 */
export function initState(
  tasks: Task[],
  mcpMetadata: Record<Mcp, McpMetadata>,
): RunState {
  const taskById = new Map(tasks.map((t) => [extractTaskNumber(t.id), t]));
  const cells: Record<CellId, CellResult> = {};
  const batches: BatchPlan[] = [];

  for (const [batchName, def] of Object.entries(BATCH_DEFINITIONS) as Array<
    [Batch, (typeof BATCH_DEFINITIONS)[Batch]]
  >) {
    const cellIds: CellId[] = [];
    for (const taskNumber of def.tasks) {
      const task = taskById.get(taskNumber);
      if (!task) {
        // Tasks not yet written are skipped silently; the runner will surface
        // the gap when it tries to plan a batch.
        continue;
      }
      // Order: trial → mcp (so within a task we get
      // dtc/1, klv/1, dtc/2, klv/2 — incremental head-to-head signal
      // surfaces after every pair instead of after every full task).
      for (let trial = 1; trial <= TRIALS_PER_CELL; trial++) {
        for (const mcp of def.mcps) {
          if (task.applies_to && !task.applies_to.includes(mcp)) continue;
          const id = cellIdFor(task.id, mcp, trial);
          cellIds.push(id);
          cells[id] = {
            cellId: id,
            taskId: task.id,
            mcp,
            trial,
            status: "pending",
          };
        }
      }
    }
    batches.push({ batch: batchName, cellIds, description: def.description });
  }

  return {
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    schemaVersion: 1,
    totalCells: Object.keys(cells).length,
    batches,
    cells,
    tokenTariff: 4, // bytes per token estimate; calibrated in Phase 2
    mcpMetadata,
    pacing: { ...DEFAULT_PACING },
  };
}

/** Compute the delay that should be applied BEFORE the next cell runs. */
export function delayBeforeCell(
  next: CellResult,
  prev: CellResult | undefined,
  task: Task | undefined,
  pacing: PacingConfig,
): number {
  let delay = pacing.baseDelayMs;
  if (task?.reportingHeavy) {
    delay += pacing.reportingDelayMs;
  }
  if (prev && prev.mcp !== next.mcp) {
    delay += pacing.mcpSwitchDelayMs;
  }
  return delay;
}

/**
 * Map task-file prefix (e.g. "06-top-campaigns-by-revenue") to the leading
 * number so the batch defs can reference tasks by "01", "06", etc.
 */
function extractTaskNumber(taskId: string): string {
  return taskId.split("-")[0];
}

export function statePath(runDir: string): string {
  return join(runDir, "state.json");
}

export async function readState(runDir: string): Promise<RunState> {
  const path = statePath(runDir);
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text) as RunState;
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `Unsupported state.json schema version ${parsed.schemaVersion} at ${path}`,
    );
  }
  return parsed;
}

export async function writeState(runDir: string, state: RunState): Promise<void> {
  const path = statePath(runDir);
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  // Atomic-ish rename (POSIX rename is atomic on the same filesystem).
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}

/**
 * Find or create a results directory. If no recent in-progress run exists,
 * we create a fresh one keyed by timestamp.
 */
export function findOrCreateRunDir(
  benchDir: string,
  preferExisting = true,
): { runDir: string; isFresh: boolean } {
  const resultsDir = resolve(benchDir, "results");

  if (preferExisting && existsSync(resultsDir)) {
    // Most recent timestamped subdir wins.
    const { readdirSync, statSync } = nodeFsSync;
    const subs = readdirSync(resultsDir)
      .map((name) => ({ name, full: join(resultsDir, name) }))
      .filter((entry) => statSync(entry.full).isDirectory())
      .sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const sub of subs) {
      if (existsSync(statePath(sub.full))) {
        return { runDir: sub.full, isFresh: false };
      }
    }
  }

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  return { runDir: resolve(resultsDir, stamp), isFresh: true };
}

/** Mark a cell as running; refresh state on disk. */
export async function markRunning(
  runDir: string,
  cellId: CellId,
): Promise<void> {
  const state = await readState(runDir);
  const cell = state.cells[cellId];
  if (!cell) throw new Error(`Unknown cellId ${cellId}`);
  cell.status = "running";
  cell.startedAt = new Date().toISOString();
  await writeState(runDir, state);
}

/** Update a cell with the recorded result; persists state. */
export async function recordCell(
  runDir: string,
  cellId: CellId,
  patch: Partial<CellResult>,
): Promise<CellResult> {
  const state = await readState(runDir);
  const cell = state.cells[cellId];
  if (!cell) throw new Error(`Unknown cellId ${cellId}`);
  Object.assign(cell, patch);
  cell.finishedAt = new Date().toISOString();
  if (!cell.status || cell.status === "pending" || cell.status === "running") {
    cell.status = "recorded";
  }
  await writeState(runDir, state);
  return cell;
}

/** Return pending cells for a batch (in canonical order). */
export function pendingCellsForBatch(
  state: RunState,
  batch: Batch,
): CellResult[] {
  const plan = state.batches.find((b) => b.batch === batch);
  if (!plan) return [];
  return plan.cellIds
    .map((id) => state.cells[id])
    .filter((c) => c && (c.status === "pending" || c.status === "failed"));
}

/** Convenience: list all batches with quick summaries. */
export function summarizeBatches(state: RunState): Array<{
  batch: Batch;
  total: number;
  pending: number;
  recorded: number;
  graded: number;
  failed: number;
  description: string;
}> {
  return state.batches.map((plan) => {
    const cells = plan.cellIds.map((id) => state.cells[id]).filter(Boolean);
    return {
      batch: plan.batch,
      total: cells.length,
      pending: cells.filter((c) => c.status === "pending").length,
      recorded: cells.filter((c) => c.status === "recorded").length,
      graded: cells.filter((c) => c.status === "graded").length,
      failed: cells.filter((c) => c.status === "failed" || c.status === "invalid").length,
      description: plan.description,
    };
  });
}
