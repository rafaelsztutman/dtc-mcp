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

/** Per-criterion verdict from the LLM-as-judge phase. */
export type JudgeVerdict = "PASS" | "FAIL" | "PARTIAL";

export interface JudgeResult {
  criterion: string;
  verdict: JudgeVerdict;
  reason: string;
}

export interface Task {
  /** Stable id, matches the filename prefix (e.g. "06-top-campaigns-by-revenue"). */
  id: string;
  /** Task category — used for category-level aggregation in the report. */
  category: Category;
  /** The exact prompt a real user would type. No format demands, no benchmark
   * framing. Single-turn tasks use this; multi-turn ones use `user_turns`. */
  user_prompt: string;
  /** Multi-turn tasks: each entry is one user turn. Overrides user_prompt. */
  user_turns?: string[];
  /** Pass/fail criteria the LLM-as-judge evaluates against the sub-agent's
   * free-form response. Each criterion is graded independently. */
  judge_criteria: string[];
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

/** Real consumption stats parsed from the Agent tool's <usage> block. */
export interface AgentUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
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
  /** Free-form text the sub-agent returned to the natural user prompt. */
  response?: string;
  /** Real consumption from the sub-agent's <usage> block — the ground-truth
   * token cost, distinct from `estimatedTokens` (the bench's byte-based
   * estimator that only sees trajectory I/O). */
  usage?: AgentUsage;
  trajectory?: Trajectory;
  /** Bench's byte-based token estimate. Useful for trajectory-side comparisons
   * but `usage.totalTokens` is the real number. */
  estimatedTokens?: number;
  /** LLM-as-judge verdicts, one per task.judge_criteria entry. */
  judgeResults?: JudgeResult[];
  /** Aggregate 0–1 score: fraction of criteria with PASS (PARTIAL = 0.5). */
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
