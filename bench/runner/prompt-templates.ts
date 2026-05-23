import type { Mcp, McpMetadata, Task } from "./types.js";

/**
 * Build the system + user prompt pair for a sub-agent benchmark cell. The
 * critical constraint: the sub-agent must use ONLY tools matching the
 * assigned MCP's prefix. Violations are caught post-hoc by
 * `constraintViolations()` and the trial is invalidated.
 *
 * Claude Code exposes MCP tools with names like `mcp__<server>__<tool>`,
 * where `<server>` matches the key in the MCP config. The actual prefix
 * depends on how the user named their MCP entry — `mcp__dtc-mcp__*`,
 * `mcp__klaviyo__*`, `mcp__claude_ai_Klaviyo__*`, etc. The values below
 * are static defaults; `cli.ts probe` infers the real prefix from the
 * tools/list dump and stores it in `state.mcpMetadata[mcp].prefix`. The
 * prompt builder prefers the probed prefix when set.
 */

export const MCP_PREFIX: Record<Mcp, string> = {
  "dtc-mcp": "mcp__dtc-mcp__",
  "klaviyo-mcp": "mcp__klaviyo__",
};

export function prefixFor(mcp: Mcp, metadata: McpMetadata): string {
  return metadata.prefix || MCP_PREFIX[mcp];
}

export interface SubAgentPrompt {
  /** Becomes the sub-agent's `prompt` argument to the Agent tool. */
  prompt: string;
  /** Suggested `description` value for the Agent invocation. */
  description: string;
}

export function buildSubAgentPrompt(
  task: Task,
  mcp: Mcp,
  trial: number,
  metadata: McpMetadata,
): SubAgentPrompt {
  const prefix = prefixFor(mcp, metadata);
  const allowedTools = metadata.toolPrefixes
    .filter((name) => name.startsWith(prefix))
    .map((name) => `  • ${name}`)
    .join("\n");

  const turns = task.turns
    ? formatTurns(task.turns)
    : `Task: ${task.prompt}`;

  // The structured-output rule is the most important — without it, grading
  // becomes brittle. Multi-line block; we keep it terse but unambiguous.
  const prompt = `
You are evaluating an MCP server in a head-to-head benchmark.

# Rules — follow these exactly

1. You may use ONLY MCP tools whose name starts with: \`${prefix}\`
   • Available tools matching this prefix:
${allowedTools}
2. Do NOT call any other MCP tools — not even read_doc, search_docs, or any
   helper from a different server. If you find yourself reaching for one,
   stop and proceed with only the allowed prefix.
3. Solve the task entirely with the allowed tools. If the task is genuinely
   impossible with this MCP, you may say so in \`final_answer\` and set
   \`succeeded: false\`.
4. Be concise — the benchmark rewards minimal output. Do not pad the answer
   with explanations unless the task explicitly asks.

# The task

${turns}

# Required response format

Respond with EXACTLY one JSON object — no prose around it, no markdown
fences. Like this:

\`\`\`
{
  "final_answer": <string — the answer the task asked for, verbatim>,
  "claims": [<verifiable factual statements you made, as strings>],
  "tool_calls": <integer count of MCP tool calls you made>,
  "succeeded": <true|false>,
  "errors": [<any error messages you encountered, as strings>]
}
\`\`\`

This is trial ${trial} of 3 for task ${task.id}. Other trials are run
independently — do not assume any prior state from a previous trial.
`.trim();

  return {
    prompt,
    description: `Bench: ${task.id} on ${mcp} (trial ${trial})`,
  };
}

function formatTurns(turns: Task["turns"]): string {
  if (!turns) return "";
  return turns
    .map(
      (t, i) =>
        `Turn ${i + 1}: ${t.prompt}\n  ${
          t.claims
            ? `(claims for this turn: ${JSON.stringify(t.claims).slice(0, 200)})`
            : ""
        }`,
    )
    .join("\n\n");
}

/**
 * Build the LLM-as-judge prompt for a fuzzy claim. Used in batch F.
 *
 * Bias mitigations: judge sub-agent is Sonnet (not Opus, to avoid
 * self-enhancement); claim is presented first, answer second, with explicit
 * "answer YES/NO/UNCERTAIN" framing.
 */
export function buildJudgePrompt(
  claim: string,
  finalAnswer: string,
  taskContext: string,
): SubAgentPrompt {
  const prompt = `
You are an impartial grader evaluating whether a model's answer satisfies a
specific factual claim. You are NOT evaluating the answer's overall quality —
only whether the claim holds against the answer.

# Task context (for reference only, do not grade this)
${taskContext}

# Claim to verify
"${claim}"

# The model's answer
"""
${finalAnswer}
"""

# Decision

Does the answer satisfy the claim? Respond with EXACTLY one JSON object:

{
  "verdict": "YES" | "NO" | "UNCERTAIN",
  "reason": <one short sentence explaining why>
}

Rules:
- YES if the answer clearly supports the claim.
- NO if the answer clearly contradicts the claim or omits required information.
- UNCERTAIN only if the answer is ambiguous and you cannot decide.
- Bias yourself toward NO when in doubt. False positives are worse than
  false negatives for this benchmark.
`.trim();

  return {
    prompt,
    description: `Judge: ${claim.slice(0, 60)}...`,
  };
}
