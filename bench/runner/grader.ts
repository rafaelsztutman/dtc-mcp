import type { CellResult, JudgeResult, Task } from "./types.js";

/**
 * In the natural-prompt benchmark, "grading" is just aggregating the
 * LLM-as-judge verdicts per criterion. Each criterion is graded
 * independently by a Sonnet sub-agent during the judge phase; this module
 * just sums the verdicts and assigns an aggregate 0–1 score.
 *
 * Score map: PASS = 1, PARTIAL = 0.5, FAIL = 0. Aggregate = mean over the
 * task's judge_criteria. Cells without any judge results (e.g. recorded
 * but judge phase not yet run) score undefined.
 */

export interface GradeOutcome {
  score: number;
}

export function gradeCell(cell: CellResult, _task: Task): GradeOutcome | undefined {
  if (cell.status === "failed" || cell.status === "invalid") return undefined;
  const verdicts = cell.judgeResults;
  if (!verdicts || verdicts.length === 0) return undefined;
  const score = mean(verdicts.map(verdictWeight));
  return { score };
}

export function verdictWeight(v: JudgeResult): number {
  switch (v.verdict) {
    case "PASS": return 1;
    case "PARTIAL": return 0.5;
    case "FAIL": return 0;
  }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Validate that a sub-agent stayed within its assigned MCP. Returns the
 * names of any tool calls that violated the prefix. Empty array = clean.
 */
export function constraintViolations(
  cell: CellResult,
  expectedPrefix: string,
): string[] {
  if (!cell.trajectory) return [];
  return cell.trajectory.toolCalls
    .map((tc) => tc.name)
    .filter((name) => !name.startsWith(expectedPrefix));
}
