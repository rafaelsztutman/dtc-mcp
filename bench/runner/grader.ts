import type { CellResult, Claim, ClaimGrade, Task } from "./types.js";

/**
 * Claim-based grading for benchmark cells. Each task defines a list of
 * verifiable claims; we check whether the sub-agent's final answer
 * satisfies each one.
 *
 * Claim types supported in this module:
 *   - contains-string — case-insensitive substring match
 *   - contains-number — substring match against the number as a string, with
 *     optional `tolerance` (rounded comparison)
 *   - list-size — final answer parses to a JSON array of `expected` length
 *   - fields-present — every item in the parsed array has the expected keys
 *   - ordering — ordering of the parsed array along a numeric key
 *
 * The `judge` claim type is deferred to the LLM-as-judge phase (batch F)
 * and is reported as `passed: undefined` until then.
 */

export interface GradeOutcome {
  grades: ClaimGrade[];
  score: number;
}

export function gradeCell(
  cell: CellResult,
  task: Task,
): GradeOutcome | undefined {
  if (cell.status === "failed" || cell.status === "invalid") {
    // Failures don't get graded; the report counts them as 0.
    return undefined;
  }
  if (!cell.report) return undefined;

  const grades: ClaimGrade[] = task.claims.map((claim) =>
    gradeClaim(claim, cell.report!.final_answer),
  );
  const decided = grades.filter((g) => typeof g.passed === "boolean");
  const score =
    decided.length === 0
      ? 0
      : decided.filter((g) => g.passed === true).length / decided.length;
  return { grades, score };
}

function gradeClaim(claim: Claim, finalAnswer: string): ClaimGrade {
  switch (claim.type) {
    case "contains-string":
      return matchContainsString(claim, finalAnswer);
    case "contains-number":
      return matchContainsNumber(claim, finalAnswer);
    case "list-size":
      return matchListSize(claim, finalAnswer);
    case "fields-present":
      return matchFieldsPresent(claim, finalAnswer);
    case "ordering":
      return matchOrdering(claim, finalAnswer);
    case "judge":
      // Deferred — LLM judge handles this in batch F.
      return { claim, passed: false, reason: "deferred to LLM judge" };
    default:
      return { claim, passed: false, reason: `unknown claim type` };
  }
}

function matchContainsString(claim: Claim, text: string): ClaimGrade {
  const expected = String(claim.expected).toLowerCase();
  const got = text.toLowerCase();
  return {
    claim,
    passed: got.includes(expected),
    reason: `expected substring "${expected}"`,
  };
}

function matchContainsNumber(claim: Claim, text: string): ClaimGrade {
  const expected = Number(claim.expected);
  if (!Number.isFinite(expected)) {
    return { claim, passed: false, reason: `expected is not a number` };
  }
  const tolerance = Number(claim.tolerance ?? 0);
  // Pull out all numbers from the text and look for any within tolerance.
  const found = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const ok = found.some((n) => Math.abs(n - expected) <= tolerance);
  return {
    claim,
    passed: ok,
    reason: `expected ${expected} ± ${tolerance}; found ${found.length} numbers`,
  };
}

function matchListSize(claim: Claim, text: string): ClaimGrade {
  const expected = Number(claim.expected);
  const parsed = tryParseList(text);
  if (parsed === null) {
    return { claim, passed: false, reason: `no parseable list found` };
  }
  return {
    claim,
    passed: parsed.length === expected,
    reason: `expected list of ${expected}, got ${parsed.length}`,
  };
}

function matchFieldsPresent(claim: Claim, text: string): ClaimGrade {
  const expectedFields = Array.isArray(claim.expected)
    ? (claim.expected as string[])
    : [];
  const parsed = tryParseList(text);
  if (parsed === null) {
    return { claim, passed: false, reason: `no parseable list found` };
  }
  if (parsed.length === 0) {
    return { claim, passed: false, reason: `empty list` };
  }
  const allOk = parsed.every((item) =>
    expectedFields.every(
      (f) => item && typeof item === "object" && f in (item as object),
    ),
  );
  return {
    claim,
    passed: allOk,
    reason: `expected fields ${expectedFields.join(", ")}`,
  };
}

function matchOrdering(claim: Claim, text: string): ClaimGrade {
  const expected = String(claim.expected).toLowerCase();
  const parsed = tryParseList(text);
  if (parsed === null) {
    return { claim, passed: false, reason: `no parseable list found` };
  }
  const numericKey = findNumericKey(parsed);
  if (!numericKey) {
    return { claim, passed: false, reason: `no numeric field to check ordering` };
  }
  const values = parsed.map((item) => Number((item as Record<string, unknown>)[numericKey]));
  let ok = true;
  for (let i = 1; i < values.length; i++) {
    if (expected.startsWith("desc") && values[i] > values[i - 1]) {
      ok = false;
      break;
    }
    if (expected.startsWith("asc") && values[i] < values[i - 1]) {
      ok = false;
      break;
    }
  }
  return {
    claim,
    passed: ok,
    reason: `expected ${expected} order on field "${numericKey}"`,
  };
}

/**
 * Sub-agents are instructed to return a single JSON object, but real
 * responses often wrap that object in prose. This extractor looks for a
 * top-level array, or for a `list` / `results` / `top` field inside the
 * response JSON.
 */
function tryParseList(text: string): unknown[] | null {
  // Try parsing the whole thing first.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      for (const key of ["list", "items", "results", "top", "data"]) {
        const v = (parsed as Record<string, unknown>)[key];
        if (Array.isArray(v)) return v;
      }
    }
  } catch {
    // Fall through to bracket-scan.
  }

  // Find the largest `[ ... ]` blob and try parsing it.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const blob = text.slice(start, end + 1);
    const parsed = JSON.parse(blob);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function findNumericKey(items: unknown[]): string | null {
  if (items.length === 0) return null;
  const first = items[0];
  if (!first || typeof first !== "object") return null;
  for (const [k, v] of Object.entries(first as Record<string, unknown>)) {
    if (typeof v === "number") return k;
    if (typeof v === "string" && Number.isFinite(Number(v))) return k;
  }
  return null;
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
