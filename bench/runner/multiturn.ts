/**
 * Multi-turn cell runner. Spawns `claude -p --input-format stream-json
 * --output-format stream-json --verbose` ONCE per cell, feeds N user
 * messages over stdin, parses the streamed stdout for per-turn assistant
 * responses + aggregate usage. Crucially, one CLI invocation = one MCP
 * connection = dtc-mcp's per-connection sandbox state survives across
 * turns (verified empirically — `globalThis.*` persists between user
 * messages within a single invocation, but NOT across separate `claude
 * -p --resume` calls, because each `claude` process respawns its MCP
 * servers).
 *
 * Why this exists (vs the sub-agent based runner): the parent agent
 * orchestrator (driving the bench from inside Claude Code) cannot reach
 * the SendMessage tool, so true cross-turn agent continuity isn't
 * possible through Agent. The `claude -p` CLI in stream-json mode
 * implements exactly the τ²-bench / BFCL v3 pattern — one process holds
 * the chat history list AND the tool transport open for the whole
 * trajectory.
 *
 * Schema: writes a tmp file in the same shape `cli.ts record` expects
 * ({ response, usage, turns?, trajectory, startedAt, finishedAt }) and
 * then invokes record directly via the in-process function (no separate
 * shell step).
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentUsage,
  CellId,
  CellTurn,
  Mcp,
  Task,
  ToolCall,
} from "./types.js";
import { prefixFor, MCP_PREFIX } from "./prompt-templates.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = resolve(HERE, "..");
const PROJECT_ROOT = resolve(BENCH_DIR, "..");

/** Default claude -p timeout. Multi-turn cells with reporting endpoints
 * can run 2-3 min easily; 10-turn long-conversation cells against the
 * segments resource (where dtc-mcp's agent has to discover Klaviyo's
 * `additional-fields[segment]=profile_count` workaround each run, then
 * fetch with the 1/s rate limit) have been observed at 9+ min. Set
 * roomy enough that no legitimate completion gets cut off. */
const CLAUDE_TIMEOUT_MS = 20 * 60 * 1000;

export interface MultiturnSubmission {
  response: string;
  usage: AgentUsage;
  turns: CellTurn[];
  trajectory: {
    toolCalls: ToolCall[];
    rawResponse: string;
    durationMs: number;
  };
  startedAt: string;
  finishedAt: string;
}

/**
 * Build the per-turn prompts for a cell. Preamble (MCP routing hint) is
 * appended to the FIRST turn only — turns 2+ are bare follow-up
 * questions, as a real user would type them once already in the
 * conversation.
 */
export function buildTurnPrompts(
  task: Task,
  mcp: Mcp,
  prefix: string,
): string[] {
  const preamble = `Use the \`${prefix}*\` MCP tools to answer this question. Respond as you naturally would.`;

  const turns = task.user_turns
    ? task.user_turns
    : task.user_prompt_session_2
      ? [task.user_prompt, task.user_prompt_session_2]
      : [task.user_prompt];

  return turns.map((t, i) => (i === 0 ? `${preamble}\n\n${t}` : t));
}

/** Lines of stream-json stdin: one user message per line. */
export function buildStreamJsonStdin(prompts: string[]): string {
  return (
    prompts
      .map((p) =>
        JSON.stringify({
          type: "user",
          message: { role: "user", content: p },
        }),
      )
      .join("\n") + "\n"
  );
}

interface ClaudeEvent {
  type: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Walk the event stream and group assistant events by user-turn boundary.
 * Each user event in input starts a new turn; the assistant events
 * between it and the next user event are that turn's response.
 *
 * Returns: per-turn `{ response, toolCalls }` plus a flat list of all
 * tool calls (for the trajectory's constraint check) and the aggregate
 * usage from the final `result` event.
 */
export function parseClaudeStream(events: ClaudeEvent[], prompts: string[]): {
  turns: Array<{ prompt: string; response: string; toolUses: number }>;
  allToolCalls: ToolCall[];
  finalResult: ClaudeEvent | undefined;
} {
  const finalResult = events.find((e) => e.type === "result");
  const allToolCalls: ToolCall[] = [];

  // Walk events, partition by user-event boundaries.
  type TurnAccum = { prompt: string; textParts: string[]; toolUses: number };
  const turns: TurnAccum[] = [];
  let userIdx = -1;

  for (const ev of events) {
    if (ev.type === "user") {
      // Tool results also come as `user` events but their content blocks
      // are `tool_result` type. We only want the events that echo our
      // OWN prompts (turned on via --replay-user-messages). Detect those
      // by content being either a string OR an array whose only block is
      // a plain text/string block — NOT tool_result blocks.
      const content = ev.message?.content as unknown;
      let isOurPrompt = false;
      if (typeof content === "string") {
        isOurPrompt = true;
      } else if (Array.isArray(content)) {
        const isAllText = content.every(
          (b: any) => b && (b.type === "text" || typeof b === "string"),
        );
        const hasToolResult = content.some(
          (b: any) => b && b.type === "tool_result",
        );
        isOurPrompt = isAllText && !hasToolResult;
      }
      if (isOurPrompt) {
        userIdx++;
        turns.push({
          prompt: prompts[userIdx] ?? "(unparseable user content)",
          textParts: [],
          toolUses: 0,
        });
      }
    } else if (ev.type === "assistant" && userIdx >= 0) {
      const blocks = ev.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          turns[userIdx]!.textParts.push(block.text);
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          turns[userIdx]!.toolUses++;
          allToolCalls.push({
            name: block.name,
            input: block.input ?? {},
            output: {},
            inputBytes: 0,
            outputBytes: 0,
          });
        }
      }
    }
  }

  return {
    turns: turns.map((t) => ({
      prompt: t.prompt,
      response: t.textParts.join("\n").trim(),
      toolUses: t.toolUses,
    })),
    allToolCalls,
    finalResult,
  };
}

/**
 * Aggregate usage from `result.usage`. The `result` event reports
 * cumulative usage across all turns of the invocation; per-turn breakdown
 * isn't easily accessible from stream-json output. For per-turn we record
 * tool-use counts (which we DO parse from assistant events) and split
 * the aggregate token total proportionally as an approximation if a
 * single-turn-per-turn breakdown is needed.
 */
export function aggregateUsage(finalResult: ClaudeEvent | undefined, turnCount: number): {
  total: AgentUsage;
  perTurnApprox: AgentUsage[];
} {
  const u = finalResult?.usage ?? {};
  // Match the Claude Code `<usage>` footer convention: count billable
  // tokens only — input + cache_creation + output. Cache reads (the bulk
  // of replayed-context bytes) are nearly free and don't belong in a
  // cost-comparable headline. The bench uses this `totalTokens` field
  // for head-to-head comparison, so consistency with prior runs matters.
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const output = u.output_tokens ?? 0;
  const totalTokens = input + output;
  const durationMs = finalResult?.duration_ms ?? 0;

  const total: AgentUsage = {
    totalTokens,
    toolUses: 0, // filled in from per-turn parsing
    durationMs,
  };

  // Per-turn approximation: evenly split aggregate token/duration across
  // turns. This is rough — the first turn carries the tool-definition
  // load and is typically the most expensive — but it's the best we can
  // do without per-turn instrumentation.
  const perTurnTokens = turnCount > 0 ? Math.round(totalTokens / turnCount) : totalTokens;
  const perTurnDuration = turnCount > 0 ? Math.round(durationMs / turnCount) : durationMs;
  const perTurnApprox: AgentUsage[] = Array.from({ length: turnCount }, () => ({
    totalTokens: perTurnTokens,
    toolUses: 0,
    durationMs: perTurnDuration,
  }));

  return { total, perTurnApprox };
}

/**
 * Run a cell end-to-end: spawn claude, stream the prompts, parse output,
 * return a submission shaped for `cli.ts record`.
 */
export async function runMultiturnCell(
  task: Task,
  mcp: Mcp,
  prefix: string,
): Promise<MultiturnSubmission> {
  const prompts = buildTurnPrompts(task, mcp, prefix);
  const stdinPayload = buildStreamJsonStdin(prompts);

  const startedAt = new Date().toISOString();
  const stdoutText = await spawnClaude(stdinPayload);
  const finishedAt = new Date().toISOString();

  const events: ClaudeEvent[] = stdoutText
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as ClaudeEvent;
      } catch {
        return { type: "_unparseable" };
      }
    })
    .filter((ev) => ev.type !== "_unparseable");

  const parsed = parseClaudeStream(events, prompts);
  const { total: aggregateUsage_, perTurnApprox } = aggregateUsage(
    parsed.finalResult,
    parsed.turns.length,
  );
  aggregateUsage_.toolUses = parsed.allToolCalls.length;

  // Stitch per-turn data
  const turns: CellTurn[] = parsed.turns.map((t, i) => ({
    prompt: t.prompt,
    response: t.response,
    usage: {
      ...perTurnApprox[i]!,
      toolUses: t.toolUses,
    },
  }));

  const finalResponse = turns[turns.length - 1]?.response ?? parsed.finalResult?.result ?? "";

  return {
    response: finalResponse,
    usage: aggregateUsage_,
    turns,
    trajectory: {
      toolCalls: parsed.allToolCalls,
      rawResponse: "(stream-json; see turns[] for per-turn responses)",
      durationMs: aggregateUsage_.durationMs,
    },
    startedAt,
    finishedAt,
  };
}

/**
 * Spawn `claude -p --input-format stream-json --output-format stream-json
 * --verbose` from the project root (so dtc-mcp loads). Returns stdout as
 * a single string.
 */
function spawnClaude(stdin: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "claude",
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        // Echo user messages back as stream events. Without this we can't
        // tell where turn boundaries are (the only `user` events in the
        // default output are tool-result echoes).
        "--replay-user-messages",
        // Auto-approve every tool call in the child process. The bench
        // harness is fully scripted — prompts come from versioned JSON in
        // bench/tasks/, not user input — so there's no interactive human
        // to approve permission prompts. Without this flag, MCP tools
        // that aren't in the user's existing allowlist (e.g. klaviyo's
        // get_segments) silently get denied and the agent's response is
        // "I can't do this without permission", which looks like a tool
        // failure but is really a permission gate. The risk surface: a
        // prompt injection from API data could try to call an unintended
        // tool. Mitigated by the read-only task scope and the fact that
        // these MCPs only expose Klaviyo/Shopify APIs that don't have
        // destructive write paths the agent would reach from a read flow.
        "--dangerously-skip-permissions",
      ],
      {
        cwd: PROJECT_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`claude -p timed out after ${CLAUDE_TIMEOUT_MS}ms`));
    }, CLAUDE_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `claude -p exited with code ${code}. stderr: ${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }
      resolvePromise(stdout);
    });

    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

/** Sanity-check the static MCP prefix fallback when metadata is empty. */
export function prefixForOrDefault(mcp: Mcp, prefix: string | undefined): string {
  return prefix || MCP_PREFIX[mcp];
}
