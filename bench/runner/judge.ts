/**
 * Judge runner. For each (cell × criterion) pair surfaced by judge-plan,
 * spawns a fresh `claude -p --model sonnet` child process, feeds it the
 * buildJudgePrompt as a single-message prompt, parses a JSON verdict out
 * of the assistant's response, and records the verdict into state.json
 * via the same path cmdRecordJudge takes.
 *
 * Sonnet (not Opus) is mandatory here to avoid self-enhancement bias:
 * the cells being judged were produced by Opus, so an Opus judge would
 * have a structural reason to rate its own outputs more favorably.
 *
 * Concurrency: a small pool (default 4) keeps total wall-clock low
 * without overwhelming the API. Each judge call is ~5-15s of Sonnet
 * inference + spawn overhead; 176 items at concurrency 4 ≈ 8-12 min.
 */

import { spawn } from "node:child_process";
import type { CellId, RunState, Task } from "./types.js";
import { buildJudgePrompt } from "./prompt-templates.js";
import { readState, writeState } from "./state.js";

interface JudgeWorkItem {
  cellId: CellId;
  criterionIndex: number;
  criterion: string;
  userQuestion: string;
  response: string;
}

interface JudgeVerdict {
  verdict: "PASS" | "FAIL" | "PARTIAL";
  reason: string;
}

/** Plan pending judge work (same logic as cmdJudgePlan, in-process). */
export function planJudgeWork(state: RunState, tasks: Task[]): JudgeWorkItem[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const work: JudgeWorkItem[] = [];
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
  return work;
}

const JUDGE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Spawn `claude -p <prompt> --model sonnet --output-format json` and parse
 * the verdict JSON from the final result text. Returns null if the spawn
 * failed or no parseable verdict was found.
 */
async function runJudge(item: JudgeWorkItem): Promise<JudgeVerdict | null> {
  const { prompt } = buildJudgePrompt(item.userQuestion, item.response, item.criterion);

  return new Promise((resolvePromise) => {
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

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolvePromise(null);
    }, JUDGE_TIMEOUT_MS);

    proc.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    proc.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    proc.on("error", () => {
      clearTimeout(timer);
      resolvePromise(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        process.stderr.write(
          `[judge] claude -p exited ${code}. stderr: ${stderr.slice(0, 200)}\n`,
        );
        resolvePromise(null);
        return;
      }
      try {
        const outer = JSON.parse(stdout) as { result?: string };
        const text = outer.result ?? stdout;
        // Pull the first {...} object out of the text. Sonnet sometimes
        // wraps the verdict in code fences or adds a trailing sentence.
        const match = text.match(/\{[^{}]*"verdict"[^{}]*\}/);
        if (!match) {
          process.stderr.write(
            `[judge] no verdict JSON found in: ${text.slice(0, 200)}\n`,
          );
          resolvePromise(null);
          return;
        }
        const verdict = JSON.parse(match[0]) as JudgeVerdict;
        resolvePromise(verdict);
      } catch (err) {
        process.stderr.write(`[judge] parse error: ${(err as Error).message}\n`);
        resolvePromise(null);
      }
    });
  });
}

/** Persist one verdict into state.json. */
async function persistVerdict(
  runDir: string,
  item: JudgeWorkItem,
  verdict: JudgeVerdict,
  tasks: Task[],
): Promise<void> {
  const state = await readState(runDir);
  const cell = state.cells[item.cellId];
  const task = tasks.find((t) => t.id === cell.taskId);
  if (!cell || !task) return;
  cell.judgeResults ??= [];
  cell.judgeResults[item.criterionIndex] = {
    criterion: task.judge_criteria[item.criterionIndex],
    verdict: verdict.verdict,
    reason: verdict.reason,
  };
  await writeState(runDir, state);
}

/**
 * Process all pending judge work in parallel batches. Each batch is up
 * to `concurrency` items run simultaneously; the function waits for one
 * batch to complete before starting the next. Verdicts are persisted as
 * they come in (one writeState per verdict — atomic-ish thanks to
 * writeState's tmp-file-rename, but this means concurrent writes within
 * a batch race the file). To avoid the race, persist sequentially after
 * each batch resolves.
 */
export async function runJudgePhase(
  runDir: string,
  state: RunState,
  tasks: Task[],
  concurrency = 4,
): Promise<{ processed: number; failed: number }> {
  const work = planJudgeWork(state, tasks);
  if (work.length === 0) {
    process.stderr.write("[judge] no pending work\n");
    return { processed: 0, failed: 0 };
  }

  process.stderr.write(
    `[judge] ${work.length} items pending, concurrency ${concurrency}\n`,
  );

  let processed = 0;
  let failed = 0;
  for (let i = 0; i < work.length; i += concurrency) {
    const batch = work.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (item) => {
        const verdict = await runJudge(item);
        return { item, verdict };
      }),
    );
    // Persist sequentially to avoid state.json write races.
    for (const { item, verdict } of results) {
      if (verdict) {
        await persistVerdict(runDir, item, verdict, tasks);
        processed++;
        process.stderr.write(
          `[judge] ${i + batch.indexOf(item) + 1}/${work.length} ` +
            `${item.cellId}[${item.criterionIndex}]: ${verdict.verdict}\n`,
        );
      } else {
        failed++;
        process.stderr.write(
          `[judge] ${i + batch.indexOf(item) + 1}/${work.length} ` +
            `${item.cellId}[${item.criterionIndex}]: FAILED (no verdict)\n`,
        );
      }
    }
  }
  return { processed, failed };
}
