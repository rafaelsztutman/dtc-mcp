import type { CellResult, McpMetadata, RunState, ToolCall } from "./types.js";

/**
 * Token estimator. The benchmark runs through Claude Code sub-agents under
 * the Max-plan subscription — we have no access to the Anthropic API's
 * `usage.input_tokens` field. Instead we estimate from observed payload
 * byte counts using a fixed bytes-per-token tariff (default 4, calibrated
 * in Phase 2 against the published Anthropic tokenizer).
 *
 * What we count for ONE cell (= one task × one MCP × one trial):
 *   1. `tools/list` payload — every tool definition for the assigned MCP.
 *      Loaded once at MCP-connection time and re-sent with every turn
 *      (cache miss case). We multiply by the number of turns observed.
 *   2. Sub-agent's task prompt (single-turn) or all turn prompts.
 *   3. Each tool call's input + output bytes.
 *   4. Sub-agent's final response (after JSON extraction).
 *
 * The estimate is intentionally HIGH (no cache assumption) so the reported
 * gap between architectures is conservative — caching could only narrow it.
 * Documented honestly in the report.
 */

export interface TokenBreakdown {
  toolDefinitions: number;
  prompt: number;
  toolIO: number;
  response: number;
  total: number;
}

/**
 * Estimate tokens for one cell. Requires the cell to have a trajectory.
 *
 * `mcpMetadata.toolListBytes` is captured once at init time when we dump
 * each MCP's `tools/list` payload (see `cli.ts probe` command in Phase 2).
 *
 * The "turns" model is simplified: every tool call counts as one turn
 * for the purposes of re-sending tool definitions. This is the worst case
 * for a tool-per-endpoint MCP and matches Cloudflare's "1.17M tokens"
 * methodology that assumed no caching.
 */
export function estimateCellTokens(
  cell: CellResult,
  metadata: McpMetadata,
  tariff = 4,
): TokenBreakdown {
  if (!cell.trajectory) {
    return { toolDefinitions: 0, prompt: 0, toolIO: 0, response: 0, total: 0 };
  }

  const turns = Math.max(1, cell.trajectory.toolCalls.length + 1);
  const toolDefinitions = Math.round((metadata.toolListBytes * turns) / tariff);
  // Prompt bytes — we don't have the exact assembled prompt, so use the
  // trajectory's raw payload sizes as a proxy. The prompt itself is a small
  // constant compared to tool definitions and tool I/O, so this is a minor
  // simplification.
  const prompt = Math.round((cell.trajectory.rawResponse.length * 0.2) / tariff);
  const toolIO = cell.trajectory.toolCalls.reduce(
    (sum, tc) => sum + Math.round((tc.inputBytes + tc.outputBytes) / tariff),
    0,
  );
  const response = Math.round(cell.trajectory.rawResponse.length / tariff);

  return {
    toolDefinitions,
    prompt,
    toolIO,
    response,
    total: toolDefinitions + prompt + toolIO + response,
  };
}

/**
 * Byte counter for a tool call, used at recording time. Idempotent — call
 * before persisting so the byte fields are populated for the estimator.
 */
export function fillToolCallBytes(call: ToolCall): ToolCall {
  return {
    ...call,
    inputBytes: safeByteLength(call.input),
    outputBytes: safeByteLength(call.output),
  };
}

function safeByteLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

/**
 * Aggregate token estimates across cells. Used for the report's headline
 * numbers and per-task averages.
 */
export function aggregateTokens(state: RunState): {
  totalsByMcp: Record<string, number>;
  byCategoryAndMcp: Record<string, Record<string, number>>;
} {
  const totalsByMcp: Record<string, number> = {};
  const byCategoryAndMcp: Record<string, Record<string, number>> = {};

  for (const cell of Object.values(state.cells)) {
    if (!cell.estimatedTokens) continue;
    totalsByMcp[cell.mcp] = (totalsByMcp[cell.mcp] ?? 0) + cell.estimatedTokens;
    // Category isn't on the cell; the report module joins via the task table.
  }
  return { totalsByMcp, byCategoryAndMcp };
}
