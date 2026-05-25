#!/usr/bin/env tsx
/**
 * bench/runner/cli.ts — deterministic-bookkeeping CLI for the benchmark.
 *
 * The benchmark is split across two layers:
 *   1. THIS CLI handles the deterministic, no-LLM-needed bookkeeping:
 *        init / state / plan / record / grade / report / calibrate / probe
 *   2. The `/bench` slash command (in .claude/commands/bench.md) drives
 *      Claude Code to spawn sub-agents that actually run the trials, then
 *      pipes their results into `cli.ts record`.
 *
 * Why the split: the sub-agent invocation REQUIRES Claude Code (no API
 * access on this Max account), but everything else is plain Node code that
 * benefits from being scriptable, testable, and reproducible.
 *
 * Usage:
 *   tsx runner/cli.ts init                          # create a fresh run dir + state.json
 *   tsx runner/cli.ts state                         # print batch summary
 *   tsx runner/cli.ts plan --batch A [--limit N]    # print pending cells + sub-agent prompts
 *   tsx runner/cli.ts record --cell <id> <result.json>  # record one sub-agent's output
 *   tsx runner/cli.ts grade [--cell <id>]           # grade recorded cells (claims only)
 *   tsx runner/cli.ts report                        # render report.md
 *   tsx runner/cli.ts probe                         # dump tool-list metadata from both MCPs
 *   tsx runner/cli.ts calibrate                     # calibrate the byte→token tariff
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cellIdFor,
  delayBeforeCell,
  findOrCreateRunDir,
  initState,
  parseCellId,
  pendingCellsForBatch,
  readState,
  recordCell,
  statePath,
  summarizeBatches,
  writeState,
} from "./state.js";
import { estimateCellTokens, fillToolCallBytes } from "./estimator.js";
import { constraintViolations, gradeCell } from "./grader.js";
import { buildSubAgentPrompt, prefixFor } from "./prompt-templates.js";
import { writeReport } from "./report.js";
import type {
  Batch,
  CellId,
  CellResult,
  Mcp,
  McpMetadata,
  RunState,
  Task,
  ToolCall,
  Trajectory,
} from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = resolve(HERE, "..");
const TASKS_DIR = resolve(BENCH_DIR, "tasks");

// ─── Task loader ─────────────────────────────────────────────────────────

async function loadTasks(): Promise<Task[]> {
  if (!existsSync(TASKS_DIR)) return [];
  const files = (await readdir(TASKS_DIR))
    .filter((f) => f.endsWith(".json"))
    .sort();
  const out: Task[] = [];
  for (const f of files) {
    const raw = await readFile(join(TASKS_DIR, f), "utf8");
    out.push(JSON.parse(raw) as Task);
  }
  return out;
}

// ─── Commands ─────────────────────────────────────────────────────────────

async function cmdInit(): Promise<void> {
  const tasks = await loadTasks();
  if (tasks.length === 0) {
    console.error(
      "No tasks loaded from bench/tasks/. Add task definitions before init.",
    );
    process.exit(1);
  }

  const { runDir, isFresh } = findOrCreateRunDir(BENCH_DIR, true);
  if (!isFresh && existsSync(statePath(runDir))) {
    console.error(`Existing run found at ${runDir}. Re-using it.`);
    console.error(`To force a fresh run, remove the directory first.`);
    return;
  }

  // Placeholder MCP metadata — `cli.ts probe` fills this in once the user
  // has both MCPs running in Claude Code.
  const placeholderMeta: McpMetadata = {
    toolCount: 0,
    toolListBytes: 0,
    toolPrefixes: [],
    prefix: "",
    notes: "Run `cli.ts probe` to populate.",
  };

  const state = initState(tasks, {
    "dtc-mcp": placeholderMeta,
    "klaviyo-mcp": placeholderMeta,
  });
  await mkdir(runDir, { recursive: true });
  await writeState(runDir, state);
  console.log(`Initialized run at ${runDir}`);
  console.log(`Total cells: ${state.totalCells}`);
  console.log(`Tasks loaded: ${tasks.length}`);
}

async function cmdState(): Promise<void> {
  const runDir = mustFindRun();
  const state = await readState(runDir);
  console.log(`Run: ${runDir}`);
  console.log(`Total cells: ${state.totalCells}`);
  console.log("");
  console.log("Batch  Total  Pending  Recorded  Graded  Failed  Description");
  console.log("─────  ─────  ───────  ────────  ──────  ──────  ──────────────");
  for (const b of summarizeBatches(state)) {
    console.log(
      `  ${b.batch}      ${pad(b.total, 3)}    ${pad(b.pending, 3)}      ${pad(b.recorded, 3)}      ${pad(b.graded, 3)}     ${pad(b.failed, 3)}    ${b.description}`,
    );
  }
}

async function cmdPlan(args: { batch: Batch; limit?: number }): Promise<void> {
  const runDir = mustFindRun();
  const state = await readState(runDir);
  const tasks = await loadTasks();
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const pending = pendingCellsForBatch(state, args.batch).slice(
    0,
    args.limit ?? Infinity,
  );

  if (pending.length === 0) {
    console.log(`Batch ${args.batch}: no pending cells.`);
    return;
  }

  let prev: CellResult | undefined;
  const plan = pending.map((cell) => {
    const task = taskById.get(cell.taskId);
    if (!task) {
      return {
        cellId: cell.cellId,
        error: `Task ${cell.taskId} not loaded`,
      };
    }
    const metadata = state.mcpMetadata[cell.mcp];
    const subAgent = buildSubAgentPrompt(task, cell.mcp, cell.trial, metadata);
    const delay = delayBeforeCell(cell, prev, task, state.pacing);
    prev = cell;
    return {
      cellId: cell.cellId,
      mcp: cell.mcp,
      taskId: cell.taskId,
      trial: cell.trial,
      prefix: prefixFor(cell.mcp, metadata),
      delayBeforeMs: delay,
      reportingHeavy: !!task.reportingHeavy,
      description: subAgent.description,
      prompt: subAgent.prompt,
    };
  });

  // Print as JSON so the Claude Code-side caller can read it cleanly.
  console.log(
    JSON.stringify(
      {
        runDir,
        batch: args.batch,
        pacing: state.pacing,
        plan,
        totalEstSeconds: plan.reduce(
          (sum, p) => sum + ("delayBeforeMs" in p ? (p.delayBeforeMs ?? 0) / 1000 : 0) + 30,
          0,
        ),
      },
      null,
      2,
    ),
  );
}

async function cmdRecord(args: {
  cell: CellId;
  resultPath: string;
}): Promise<void> {
  const runDir = mustFindRun();
  const state = await readState(runDir);
  const cell = state.cells[args.cell];
  if (!cell) {
    console.error(`Unknown cell: ${args.cell}`);
    process.exit(1);
  }

  const raw = await readFile(args.resultPath, "utf8");
  const submission = JSON.parse(raw) as {
    /** Free-form text the sub-agent returned. */
    response: string;
    /** Real consumption parsed from the Agent tool's <usage> block. */
    usage: { totalTokens: number; toolUses: number; durationMs: number };
    /** Optional trajectory for constraint check + bench's byte-based estimator.
     * Pass `{ toolCalls: [{name: "mcp__x__..."}, ...], rawResponse, durationMs }`
     * with whatever tool names we can see in the Agent transcript. Empty/missing
     * trajectory skips the constraint check (we lose violation detection but
     * the response + usage are still recorded). */
    trajectory?: Trajectory;
    startedAt?: string;
    finishedAt?: string;
  };

  const metadata = state.mcpMetadata[cell.mcp];
  const prefix = prefixFor(cell.mcp, metadata);

  let estimatedTokens: number | undefined;
  let isInvalid = false;
  let violations: string[] = [];

  if (submission.trajectory && submission.trajectory.toolCalls.length > 0) {
    submission.trajectory.toolCalls = submission.trajectory.toolCalls.map(fillToolCallBytes);
    violations = constraintViolations(
      { ...cell, trajectory: submission.trajectory },
      prefix,
    );
    isInvalid = violations.length > 0;
    estimatedTokens = estimateCellTokens(
      { ...cell, trajectory: submission.trajectory },
      metadata,
      state.tokenTariff,
    ).total;
  }

  await recordCell(runDir, args.cell, {
    response: submission.response,
    usage: submission.usage,
    trajectory: submission.trajectory,
    estimatedTokens,
    status: isInvalid ? "invalid" : "recorded",
    error: isInvalid
      ? `Constraint violation: called tools outside ${prefix} — ${violations.join(", ")}`
      : undefined,
    startedAt: submission.startedAt,
    finishedAt: submission.finishedAt,
  });

  console.log(
    `Recorded ${args.cell} — status: ${isInvalid ? "invalid" : "recorded"}, real tokens: ${submission.usage.totalTokens}, duration: ${submission.usage.durationMs}ms${estimatedTokens !== undefined ? `, est: ${estimatedTokens}` : ""}`,
  );
  if (isInvalid) {
    console.log(`  Violations: ${violations.join(", ")}`);
  }
}

async function cmdGrade(args: { cell?: CellId }): Promise<void> {
  const runDir = mustFindRun();
  const state = await readState(runDir);
  const tasks = await loadTasks();
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const cellsToGrade = args.cell
    ? [state.cells[args.cell]].filter(Boolean)
    : Object.values(state.cells).filter((c) => c.status === "recorded");

  let graded = 0;
  for (const cell of cellsToGrade) {
    const task = taskById.get(cell.taskId);
    if (!task) continue;
    const outcome = gradeCell(cell, task);
    if (!outcome) continue;
    cell.score = outcome.score;
    cell.status = "graded";
    graded++;
  }
  await writeState(runDir, state);
  console.log(`Graded ${graded} cells.`);
}

/**
 * Print pending judge work. Each (cell, criterion) needs one Sonnet
 * sub-agent run. The /bench skill (or the user manually) spawns those
 * and feeds results back via `cli.ts record-judge`.
 */
async function cmdJudgePlan(): Promise<void> {
  const runDir = mustFindRun();
  const state = await readState(runDir);
  const tasks = await loadTasks();
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const work: Array<{
    cellId: CellId;
    criterionIndex: number;
    criterion: string;
    userQuestion: string;
    response: string;
  }> = [];

  for (const cell of Object.values(state.cells)) {
    if (cell.status !== "recorded") continue;
    if (!cell.response) continue;
    const task = taskById.get(cell.taskId);
    if (!task) continue;
    const already = cell.judgeResults?.length ?? 0;
    for (let i = already; i < task.judge_criteria.length; i++) {
      work.push({
        cellId: cell.cellId,
        criterionIndex: i,
        criterion: task.judge_criteria[i],
        userQuestion: task.user_turns ? task.user_turns.join(" → ") : task.user_prompt,
        response: cell.response,
      });
    }
  }

  console.log(JSON.stringify({ runDir, pendingJudgeWork: work }, null, 2));
}

/** Record one judge verdict for one (cell, criterion-index) pair. */
async function cmdRecordJudge(args: {
  cell: CellId;
  criterionIndex: number;
  resultPath: string;
}): Promise<void> {
  const runDir = mustFindRun();
  const state = await readState(runDir);
  const cell = state.cells[args.cell];
  if (!cell) {
    console.error(`Unknown cell: ${args.cell}`);
    process.exit(1);
  }
  const tasks = await loadTasks();
  const task = tasks.find((t) => t.id === cell.taskId);
  if (!task) {
    console.error(`No task definition for ${cell.taskId}`);
    process.exit(1);
  }

  const raw = await readFile(args.resultPath, "utf8");
  const verdict = JSON.parse(raw) as {
    verdict: "PASS" | "FAIL" | "PARTIAL";
    reason: string;
  };

  cell.judgeResults ??= [];
  cell.judgeResults[args.criterionIndex] = {
    criterion: task.judge_criteria[args.criterionIndex],
    verdict: verdict.verdict,
    reason: verdict.reason,
  };
  await writeState(runDir, state);
  console.log(
    `Recorded judge verdict — ${args.cell}[${args.criterionIndex}]: ${verdict.verdict}`,
  );
}

async function cmdReport(): Promise<void> {
  const runDir = mustFindRun();
  const state = await readState(runDir);
  const tasks = await loadTasks();
  const reportPath = await writeReport(runDir, state, tasks);
  console.log(`Wrote ${reportPath}`);
}

async function cmdProbe(args: { input: string }): Promise<void> {
  // Reads a JSON file the user supplies (dumped from MCP Inspector or a
  // manual /mcp listing). The file should be:
  //   { "dtc-mcp": { toolList: [...], notes?: ... },
  //     "klaviyo-mcp": { toolList: [...], notes?: ... } }
  const runDir = mustFindRun();
  const state = await readState(runDir);
  const raw = await readFile(args.input, "utf8");
  const dump = JSON.parse(raw) as Record<
    Mcp,
    { toolList: Array<{ name: string }>; notes?: string }
  >;

  for (const mcp of ["dtc-mcp", "klaviyo-mcp"] as Mcp[]) {
    const entry = dump[mcp];
    if (!entry) continue;
    const names = entry.toolList.map((t) => t.name);
    const bytes = Buffer.byteLength(JSON.stringify(entry.toolList), "utf8");
    const prefix = inferCommonPrefix(names);
    if (!prefix) {
      console.error(
        `${mcp}: could not infer a common prefix from ${names.length} tools — got ${JSON.stringify(names.slice(0, 3))}`,
      );
      process.exit(1);
    }
    state.mcpMetadata[mcp] = {
      toolCount: names.length,
      toolListBytes: bytes,
      toolPrefixes: names,
      prefix,
      notes: entry.notes,
    };
    console.log(`${mcp}: ${names.length} tools, ${bytes} bytes, prefix=${prefix}`);
  }
  await writeState(runDir, state);
}

/**
 * Compute the longest common `mcp__<server>__` prefix shared by all tool
 * names. Returns "" if the inputs don't all share an `mcp__*__` prefix, so
 * the caller can fail loudly instead of silently using a useless empty
 * string as a constraint.
 */
function inferCommonPrefix(toolNames: string[]): string {
  if (toolNames.length === 0) return "";
  const first = toolNames[0];
  if (!first.startsWith("mcp__")) return "";
  const afterMcp = first.slice("mcp__".length);
  const sep = afterMcp.indexOf("__");
  if (sep === -1) return "";
  const candidate = "mcp__" + afterMcp.slice(0, sep) + "__";
  return toolNames.every((n) => n.startsWith(candidate)) ? candidate : "";
}

async function cmdCalibrate(): Promise<void> {
  // Stub for Phase 2. The actual calibration compares our byte/4 estimate
  // against a known tokenizer on a few sample payloads, then sets state.tokenTariff.
  console.log(
    "Calibration not yet implemented. Default tariff (4 bytes/token) is in use.",
  );
}

// ─── Arg parsing + dispatch ───────────────────────────────────────────────

function mustFindRun(): string {
  const { runDir } = findOrCreateRunDir(BENCH_DIR, true);
  if (!existsSync(statePath(runDir))) {
    console.error(
      "No active run found. Run `cli.ts init` first.",
    );
    process.exit(1);
  }
  return runDir;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else if (!out._positional) {
      out._positional = a;
    } else {
      // ignore extras
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (cmd) {
    case "init":
      await cmdInit();
      break;
    case "state":
      await cmdState();
      break;
    case "plan":
      if (!args.batch) {
        console.error("Usage: cli.ts plan --batch <A|B|C|D|E|F> [--limit N]");
        process.exit(1);
      }
      await cmdPlan({
        batch: args.batch as Batch,
        limit: args.limit ? parseInt(args.limit as string, 10) : undefined,
      });
      break;
    case "record":
      if (!args.cell || !args._positional) {
        console.error("Usage: cli.ts record --cell <cellId> <result.json>");
        process.exit(1);
      }
      await cmdRecord({
        cell: args.cell as CellId,
        resultPath: args._positional as string,
      });
      break;
    case "grade":
      await cmdGrade({ cell: args.cell as CellId | undefined });
      break;
    case "report":
      await cmdReport();
      break;
    case "probe":
      if (!args._positional) {
        console.error("Usage: cli.ts probe <tool-list-dump.json>");
        process.exit(1);
      }
      await cmdProbe({ input: args._positional as string });
      break;
    case "calibrate":
      await cmdCalibrate();
      break;
    case "judge-plan":
      await cmdJudgePlan();
      break;
    case "record-judge":
      if (!args.cell || args["criterion-index"] === undefined || !args._positional) {
        console.error(
          "Usage: cli.ts record-judge --cell <cellId> --criterion-index <N> <verdict.json>",
        );
        process.exit(1);
      }
      await cmdRecordJudge({
        cell: args.cell as CellId,
        criterionIndex: parseInt(args["criterion-index"] as string, 10),
        resultPath: args._positional as string,
      });
      break;
    default:
      console.error(
        "Commands: init | state | plan | record | grade | report | probe | calibrate | judge-plan | record-judge",
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("[bench/cli] error:", e);
  process.exit(1);
});
