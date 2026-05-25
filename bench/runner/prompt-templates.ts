import type { Mcp, McpMetadata, Task } from "./types.js";

/**
 * Build the prompt handed to each benchmark sub-agent. Design principle:
 * the sub-agent should see something as close to a real user question as
 * possible. No mention of "benchmark", no "respond with a JSON object",
 * no list of allowed tools — the only harness leak is the MCP routing
 * hint, because we still need to enforce single-MCP isolation for the
 * head-to-head to mean anything. Post-hoc constraint check in record
 * catches violations.
 *
 * The MCP_PREFIX values are static defaults; cli.ts probe stores the
 * actual prefix from the live tools/list dump in mcpMetadata.prefix and
 * prefixFor prefers that.
 */

export const MCP_PREFIX: Record<Mcp, string> = {
  "dtc-mcp": "mcp__dtc-mcp__",
  "klaviyo-mcp": "mcp__klaviyo__",
};

export function prefixFor(mcp: Mcp, metadata: McpMetadata): string {
  return metadata.prefix || MCP_PREFIX[mcp];
}

export interface SubAgentPrompt {
  prompt: string;
  description: string;
}

export function buildSubAgentPrompt(
  task: Task,
  mcp: Mcp,
  trial: number,
  metadata: McpMetadata,
): SubAgentPrompt {
  const prefix = prefixFor(mcp, metadata);

  const userContent = task.user_turns
    ? task.user_turns.map((t, i) => `Turn ${i + 1}: ${t}`).join("\n\n")
    : task.user_prompt;

  // The routing hint is the only benchmark-related text. Kept short and
  // framed as a tool preference, not a constraint, so it reads naturally.
  const prompt = `Use the \`${prefix}*\` MCP tools to answer this question. Respond as you naturally would.

${userContent}`;

  return {
    prompt,
    description: `Bench: ${task.id} on ${mcp} (trial ${trial})`,
  };
}

/**
 * Judge prompt for the LLM-as-judge phase. Each (cell, criterion) pair is
 * scored independently by a Sonnet sub-agent. Bias mitigations:
 *   - judge is Sonnet, not Opus, to avoid self-enhancement bias
 *   - criterion appears first, response second, with explicit ternary verdict
 *   - PARTIAL exists so the judge doesn't have to force-fit ambiguous cases
 */
export function buildJudgePrompt(
  userQuestion: string,
  response: string,
  criterion: string,
): SubAgentPrompt {
  const prompt = `
You are an impartial grader evaluating whether a model's free-form answer to a
user's question satisfies a specific success criterion.

# The user's question
"""
${userQuestion}
"""

# The model's answer
"""
${response}
"""

# Criterion to evaluate
"${criterion}"

# Your decision

Does the answer satisfy the criterion? Respond with EXACTLY one JSON object on
a single line — no prose around it, no markdown fence:

{"verdict": "PASS" | "FAIL" | "PARTIAL", "reason": "<one short sentence>"}

Rules:
- PASS: the answer clearly satisfies the criterion.
- FAIL: the answer clearly does not satisfy it, or omits required information.
- PARTIAL: the answer addresses the criterion but only partially (e.g. answers
  the right question with the wrong precision, or covers most but not all of
  what was asked).
- When uncertain between PASS and FAIL, prefer FAIL. When uncertain between
  PARTIAL and the others, prefer PARTIAL.
`.trim();

  return {
    prompt,
    description: `Judge: ${criterion.slice(0, 60)}...`,
  };
}
