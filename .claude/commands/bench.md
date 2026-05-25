---
description: Run a benchmark batch — dtc-mcp vs Klaviyo official MCP. Takes optional --batch <A-D> and --retry <cellId>.
---

# /bench — head-to-head MCP benchmark driver

You are about to execute one batch of the dtc-mcp vs Klaviyo-MCP benchmark.
The benchmark is organized along the **conversation-length axis**: 1-turn
baseline, 2-turn short, 5-turn medium, 10-turn long. The hypothesis is
that MCPs not designed for conversation continuity pay a compounding cost
as turns grow, so dtc-mcp's stateful sandbox should outperform tool-list
MCPs more sharply at longer conversations.

**Execution model:** every cell — single-turn or multi-turn — is run via
`tsx bench/runner/cli.ts multiturn --cell <cellId>`. That command spawns
ONE `claude -p --input-format stream-json` process, feeds it the cell's
prompts over stdin, parses the streamed output for per-turn responses +
aggregate usage, then records the result. One `claude` process = one MCP
transport, so dtc-mcp's per-connection sandbox state persists across the
whole trajectory (the empirically-verified property that motivates the
whole benchmark).

Grading is **deferred to a separate LLM-as-judge phase** after recording
— there is no per-cell grading during a batch run.

## Args

- `--batch <A|B|C|D>` (default: A) — which batch to run
  - A = baseline (1 turn) × 3 tasks × 2 MCPs × 2 trials = 12 cells
  - B = short (2 turns) × 2 tasks × 2 MCPs × 2 trials = 8 cells
  - C = medium (5 turns) × 2 tasks × 2 MCPs × 2 trials = 8 cells
  - D = long (10 turns) × 2 tasks × 2 MCPs × 2 trials = 8 cells
- `--retry <cellId>` — re-run one failed/invalid cell, ignore others
- `--limit N` — only run the first N pending cells (useful for smoke tests)

## How to execute

1. **Verify the run is initialized.** If `bench/results/` has no recent
   `state.json`, instruct the user to run `tsx bench/runner/cli.ts init`
   first and stop.

2. **Verify both MCPs are configured at the user level** (`~/.claude.json`
   `mcpServers`) so the spawned `claude -p` child process sees them.
   There should be both `dtc-mcp` (or whatever they named it) and
   `klaviyo` (or similar). If not, instruct the user to add the missing
   one and stop.

3. **If the run's `mcpMetadata` for either MCP has `toolCount: 0`** or
   `prefix` is empty, ask the user to dump `tools/list` for each MCP into
   `bench/tools-list-dump.json`:
   ```
   {
     "dtc-mcp":     { "toolList": [<paste from /mcp tools/list>] },
     "klaviyo-mcp": { "toolList": [<paste>] }
   }
   ```
   Then run `tsx bench/runner/cli.ts probe bench/tools-list-dump.json` to
   populate metadata. The probe infers the canonical `mcp__<server>__`
   prefix and stores it on `mcpMetadata[mcp].prefix` so the constraint
   check uses the right one.

4. **Run `tsx bench/runner/cli.ts plan --batch <batch> [--limit N]`** to
   get the JSON plan. You only need the `cellId` list from it — the
   `multiturn` command pulls task + prompts directly from state.json and
   task definitions.

5. **For each cell in the plan — STRICTLY SEQUENTIAL**, one at a time.
   Klaviyo's API will flag bursty access; the harness intentionally paces
   itself. Each cell's `delayBeforeMs` from the plan tells you how long
   to wait BEFORE spawning the next one. Do NOT run cells in parallel —
   the live Klaviyo account is shared and bursty access risks the account.

   For each cell:

   a. **Wait `delayBeforeMs` milliseconds** (skip on the first cell of a
      batch — there's nothing to space from). If you're starting batch X
      right after batch X-1 ended on a different MCP, add an extra 10s
      buffer to be safe.

   b. **Run the cell** with:
      ```
      tsx bench/runner/cli.ts multiturn --cell <cellId>
      ```
      This blocks until the cell is fully recorded (or fails). Typical
      durations: 1-turn ≈ 30–60s; 2-turn ≈ 60–90s; 5-turn ≈ 2–4 min;
      10-turn ≈ 4–8 min. Long-conversation cells can hit a 10-minute
      internal timeout — if that happens, the cell is marked `failed`
      and you can re-run with `--retry`.

   c. **Read the one-line stdout summary** the command prints —
      `Recorded <cellId> (multiturn) — status: …, real tokens: …,
      duration: …ms, turns: …, tool calls: …`. If `status: invalid`,
      the agent called tools outside the assigned MCP prefix; surface
      the violation list to the user and consider re-running.

6. **After all cells in the batch are recorded**, stop here. **Do NOT**
   run `tsx bench/runner/cli.ts grade` during a batch run — grading is
   deferred to the judge phase (below). The `grade` command does still
   exist but only aggregates already-recorded judge verdicts into a
   `score` field; calling it before any judge runs produces no useful
   output.

7. **Run `tsx bench/runner/cli.ts state`** and print the summary to the
   user. Tell them which batch is next and stop. Do NOT auto-continue —
   the user needs to manage their Max-plan quota window.

## Judge phase (after all batches recorded)

The runner separates recording from grading so all `claude -p` runs can
happen first and judging happens once at the end (one Sonnet sub-agent
per (cell, criterion) pair).

To run the judge phase:

1. **`tsx bench/runner/cli.ts judge-plan`** → emits a JSON list of pending
   judge work, one entry per (cell, criterion-index) pair. Each entry
   contains `cellId`, `criterionIndex`, `criterion`, `userQuestion`, and
   the recorded `response`.

2. **For each judge work item**, spawn a **Sonnet** sub-agent (not Opus —
   we want to avoid self-enhancement bias) via the `Agent` tool. Use
   `buildJudgePrompt()` from `bench/runner/prompt-templates.ts` as the
   template; it takes `(userQuestion, response, criterion)` and returns
   a prompt that asks for a single-line JSON verdict:
   `{"verdict": "PASS"|"FAIL"|"PARTIAL", "reason": "..."}`.

3. **Parse the judge's response** into the verdict JSON and write it to a
   tmp file. Then run:
   ```
   tsx bench/runner/cli.ts record-judge \
     --cell <cellId> --criterion-index <N> <verdict.json>
   ```

4. **After all judges are recorded**, run `tsx bench/runner/cli.ts grade`
   to aggregate the verdicts into per-cell scores (PASS=1, PARTIAL=0.5,
   FAIL=0, score = mean of criterion verdicts).

5. **Render the final report** with `tsx bench/runner/cli.ts report` →
   writes `bench/results/<runId>/report.md`.

## Special cases

- **`--retry`** skips the plan and just re-runs the one specified cell
  via `tsx bench/runner/cli.ts multiturn --cell <cellId>`. Useful for
  fixing constraint violations or transient failures without re-running
  an entire batch.

- **`--limit`** is for smoke tests: `--batch A --limit 2` runs just two
  cells of batch A.

## Honest reminders

- This is a **batched, resumable** runner. Never try to do all 36 cells
  in one Claude Code session — the user's Max-plan quota will exhaust,
  and the longest cells (batch D's 10-turn conversations) take 4–8
  minutes each just for the spawned `claude -p` to complete.
- The methodology captures **real** token consumption from the
  `<result>` event's `usage` block in claude's stream-json output:
  `input + cache_creation + output` (matches the `<usage>` footer
  convention; `cache_read` is excluded as nearly-free).
- If a cell's agent ignores the MCP-prefix constraint and uses tools
  from the OTHER MCP, the CLI flags it as `invalid` (the constraint
  check only inspects `mcp__*`-prefixed calls — Claude Code's own
  tools like Bash/Read are orthogonal and not flagged). Don't try to
  rationalize the result. The trial is wasted; re-run it.
- The cell prompts are **natural user questions**. Do not append
  benchmark framing or output-format demands — the harness already
  adds a minimal MCP routing hint to the first turn only, and that's
  the whole instrumentation envelope.
