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
import { buildSubAgentPrompt, MCP_PREFIX } from "./prompt-templates.js";
import { writeReport } from "./report.js";
import type {
  Batch,
  CellId,
  CellResult,
  Mcp,
  McpMetadata,
  RunState,
  SubAgentReport,
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
    return {
      cellId: cell.cellId,
      mcp: cell.mcp,
      taskId: cell.taskId,
      trial: cell.trial,
      prefix: MCP_PREFIX[cell.mcp],
      description: subAgent.description,
      prompt: subAgent.prompt,
    };
  });

  // Print as JSON so the Claude Code-side caller can read it cleanly.
  console.log(JSON.stringify({ runDir, batch: args.batch, plan }, null, 2));
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
    trajectory: Trajectory;
    report: SubAgentReport;
    startedAt?: string;
    finishedAt?: string;
  };

  // Fill byte counts on every tool call so the estimator can run.
  submission.trajectory.toolCalls = submission.trajectory.toolCalls.map(
    fillToolCallBytes,
  );

  // Constraint check before grading — invalid trials don't get scored.
  const violations = constraintViolations(
    { ...cell, trajectory: submission.trajectory },
    MCP_PREFIX[cell.mcp],
  );
  const isInvalid = violations.length > 0;

  const metadata = state.mcpMetadata[cell.mcp];
  const tokens = estimateCellTokens(
    { ...cell, trajectory: submission.trajectory },
    metadata,
    state.tokenTariff,
  );

  await recordCell(runDir, args.cell, {
    trajectory: submission.trajectory,
    report: submission.report,
    estimatedTokens: tokens.total,
    status: isInvalid ? "invalid" : "recorded",
    error: isInvalid
      ? `Constraint violation: called tools outside ${MCP_PREFIX[cell.mcp]} — ${violations.join(", ")}`
      : undefined,
    startedAt: submission.startedAt,
    finishedAt: submission.finishedAt,
  });

  console.log(
    `Recorded ${args.cell} — status: ${isInvalid ? "invalid" : "recorded"}, est. tokens: ${tokens.total}, tool calls: ${submission.trajectory.toolCalls.length}`,
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
    cell.grades = outcome.grades;
    cell.score = outcome.score;
    cell.status = "graded";
    graded++;
  }
  await writeState(runDir, state);
  console.log(`Graded ${graded} cells.`);
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
    state.mcpMetadata[mcp] = {
      toolCount: names.length,
      toolListBytes: bytes,
      toolPrefixes: names,
      notes: entry.notes,
    };
    console.log(`${mcp}: ${names.length} tools, ${bytes} bytes`);
  }
  await writeState(runDir, state);
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
    default:
      console.error(
        "Commands: init | state | plan | record | grade | report | probe | calibrate",
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("[bench/cli] error:", e);
  process.exit(1);
});
