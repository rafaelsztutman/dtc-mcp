/**
 * Core data shapes for the benchmark harness.
 *
 * The two design constraints driving these:
 *   1. The benchmark runs across multiple Claude Code sessions (Max-plan
 *      quota windows), so state.json must be a complete checkpoint — any
 *      session can resume from it without prior context.
 *   2. Grading is deferred for fuzzy-claim tasks (LLM-as-judge runs in the
 *      final batch), so a Result can be in `recorded` state without yet
 *      being `graded`.
 */

// ─── Task definitions (input) ──────────────────────────────────────────────

export type Category =
  | "single-fact"
  | "multi-step"
  | "cross-resource"
  | "output-discipline";

export type Mcp = "dtc-mcp" | "klaviyo-mcp";

export type ClaimType =
  /** The final answer should mention this exact string (case-insensitive). */
  | "contains-string"
  /** The final answer should contain this number, within `tolerance` (default 0). */
  | "contains-number"
  /** The final answer's parsed list should have this many items. */
  | "list-size"
  /** Each item in the parsed list should have these keys. */
  | "fields-present"
  /** Items should appear in this order ("descending" / "ascending" by some implied key). */
  | "ordering"
  /** Fuzzy: a Sonnet judge sub-agent decides whether the claim holds. */
  | "judge";

export interface Claim {
  type: ClaimType;
  /** Free-form expected value. Interpretation depends on `type`. */
  expected: unknown;
  /** Numeric tolerance — only used by `contains-number`. */
  tolerance?: number;
  /** Field name hint — only used by `ordering` to pin which field to sort
   * by. Without this, the grader guesses the first orderable field, which
   * can pick the wrong one when multiple fields look numeric or date-like. */
  field?: string;
  /** Human-readable description for the report. */
  description?: string;
}

export interface TaskTurn {
  /** Prompt text for this turn. */
  prompt: string;
  /** Optional claims specific to this turn's response. */
  claims?: Claim[];
}

export interface Task {
  /** Stable id, matches the filename prefix (e.g. "06-top-campaigns-by-revenue"). */
  id: string;
  /** Task category — used for category-level aggregation in the report. */
  category: Category;
  /** Headline prompt (single-turn tasks). For multi-turn, see `turns`. */
  prompt: string;
  /** Multi-turn tasks override `prompt` with an ordered list of turns. */
  turns?: TaskTurn[];
  /** Claims to verify on the final answer. */
  claims: Claim[];
  /** Which MCPs this task targets. Default: both. */
  applies_to?: Mcp[];
  /** Free-form notes for humans. Not used by the runner. */
  notes?: string;
  /** Hints to the runner: does this task hit reporting endpoints? Drives pacing. */
  reportingHeavy?: boolean;
}

// ─── Per-cell runtime state (one cell = one task × one MCP × one trial) ──

/** Identifier shape: `<task-id>::<mcp>::trial-<n>` */
export type CellId = string;

export interface Trajectory {
  /** Ordered tool invocations the sub-agent made during this trial. */
  toolCalls: ToolCall[];
  /** Sub-agent's textual response (post tool-use, after JSON extraction). */
  rawResponse: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

export interface ToolCall {
  /** Full MCP tool name as seen in Claude Code (e.g. `mcp__dtc-mcp__execute_code`). */
  name: string;
  /** Tool input arguments. */
  input: unknown;
  /** Tool output. May be redacted if the sub-agent only reported a summary. */
  output: unknown;
  /** Byte length of JSON.stringify(input) — used by the token estimator. */
  inputBytes: number;
  /** Byte length of JSON.stringify(output) — used by the token estimator. */
  outputBytes: number;
}

/** What the sub-agent returns when it finishes. */
export interface SubAgentReport {
  final_answer: string;
  claims: string[];
  /** Sub-agent's self-reported count. Ground truth comes from the trajectory. */
  tool_calls: number;
  succeeded: boolean;
  errors?: string[];
}

export interface CellResult {
  cellId: CellId;
  taskId: string;
  mcp: Mcp;
  trial: number;
  /** "pending" | "running" | "recorded" | "graded" | "failed" | "invalid" */
  status: CellStatus;
  startedAt?: string;
  finishedAt?: string;
  trajectory?: Trajectory;
  report?: SubAgentReport;
  /** Token estimate (input + output + tool I/O), see estimator.ts. */
  estimatedTokens?: number;
  /** Grades after Phase 5 (recorded → graded). */
  grades?: ClaimGrade[];
  /** Aggregate score from grades (0–1). */
  score?: number;
  /** Reason if status === "failed" or "invalid". */
  error?: string;
}

export type CellStatus =
  | "pending"
  | "running"
  | "recorded"
  | "graded"
  | "failed"
  | "invalid";

export interface ClaimGrade {
  claim: Claim;
  passed: boolean;
  /** Optional human-readable explanation from the grader. */
  reason?: string;
}

// ─── State.json (the run's checkpoint) ─────────────────────────────────────

export type Batch = "A" | "B" | "C" | "D" | "E" | "F";

export interface BatchPlan {
  batch: Batch;
  cellIds: CellId[];
  description: string;
}

export interface RunState {
  /** ISO timestamp of when this run was initialized. */
  runId: string;
  /** Schema version, in case we evolve this file. */
  schemaVersion: 1;
  /** Total cells planned for the full run. */
  totalCells: number;
  /** Static plan: which cells belong to which batch. */
  batches: BatchPlan[];
  /** Per-cell live state. */
  cells: Record<CellId, CellResult>;
  /** Token tariff used for byte → token conversion. */
  tokenTariff: number;
  /** Static MCP metadata captured at init time (tool counts, schema bytes). */
  mcpMetadata: Record<Mcp, McpMetadata>;
  /** Pacing config — drives sequential execution against Klaviyo's API. */
  pacing: PacingConfig;
}

export interface PacingConfig {
  /** Max concurrent sub-agents per batch. Default 1 (strictly sequential) to keep Klaviyo happy. */
  concurrency: number;
  /** Minimum gap between consecutive cells (ms). */
  baseDelayMs: number;
  /** Extra gap added BEFORE a reporting-heavy cell (Klaviyo's reporting endpoints are 1/s). */
  reportingDelayMs: number;
  /** Extra gap when switching from one MCP to the other. */
  mcpSwitchDelayMs: number;
}

export interface McpMetadata {
  toolCount: number;
  toolListBytes: number;
  /** Full tool names dumped by `cli.ts probe` (e.g. `mcp__dtc-mcp__execute_code`). */
  toolPrefixes: string[];
  /** Canonical prefix shared by all this MCP's tools, computed by probe.
   * Empty string means "not yet probed — use the static MCP_PREFIX default". */
  prefix: string;
  notes?: string;
}
