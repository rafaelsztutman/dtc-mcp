---
description: Run a benchmark batch — dtc-mcp vs Klaviyo official MCP. Takes optional --batch <A-F> and --retry <cellId>.
---

# /bench — head-to-head MCP benchmark driver

You are about to execute one batch of the dtc-mcp vs Klaviyo-MCP benchmark.
The benchmark is run via Claude Code sub-agents (no Anthropic API access);
this command coordinates them and the deterministic bookkeeping CLI.

**Methodology note:** sub-agents receive a *natural user question* — no
benchmark framing, no JSON-format mandate. The runner captures whatever
free-form text the sub-agent returns, plus the real `<usage>` tokens /
duration / tool-use count from the Agent tool's response footer. Grading
is **deferred to a separate LLM-as-judge phase** after recording — there
is no per-cell grading during a batch run.

## Args

- `--batch <A|B|C|D|E|F>` (default: A) — which batch to run
- `--retry <cellId>` — re-run one failed/invalid cell, ignore others
- `--limit N` — only run the first N pending cells (useful for smoke tests)

## How to execute

1. **Verify the run is initialized.** If `bench/results/` has no recent
   `state.json`, instruct the user to run `tsx bench/runner/cli.ts init`
   first and stop.

2. **Verify both MCPs are configured.** Run `/mcp` in the user's session
   (or check `~/.claude.json` mcpServers block) — there should be both
   `dtc-mcp` (or whatever they named it) and `klaviyo` (or similar). If
   not, instruct the user to add the missing one and stop.

3. **If the run's `mcpMetadata` for either MCP has `toolCount: 0`** or
   `prefix` is empty, ask the user to dump `tools/list` for each MCP into
   a JSON file like `bench/tools-list-dump.json`:
   ```
   {
     "dtc-mcp": { "toolList": [<paste from /mcp tools/list>] },
     "klaviyo-mcp": { "toolList": [<paste>] }
   }
   ```
   Then run `tsx bench/runner/cli.ts probe bench/tools-list-dump.json`
   to populate metadata. The probe infers the canonical `mcp__<server>__`
   prefix automatically and stores it on `mcpMetadata[mcp].prefix` so
   downstream constraint checks use the right one.

4. **Run `tsx bench/runner/cli.ts plan --batch <batch> [--limit N]`** to
   get the JSON plan. Parse it — it's an array of pending cells, each
   with a fully-built natural-prompt for the sub-agent.

5. **For each cell in the plan — STRICTLY SEQUENTIAL**, one at a time.
   Klaviyo's API will flag bursty access; the harness intentionally paces
   itself. The plan JSON includes a `delayBeforeMs` field on every cell:
   wait that many milliseconds BEFORE spawning the cell's sub-agent. Do
   NOT run sub-agents in parallel for this benchmark — even though the
   `Agent` tool supports it.

   a. **Wait `delayBeforeMs` milliseconds** (skip on the first cell of
      a batch — there's nothing to space from). If you're starting a
      batch right after another one that used a different MCP, add an
      extra 10s buffer to be safe — Klaviyo's per-account rate limiter
      doesn't care which MCP made the calls.
   b. Capture `startedAt = new Date().toISOString()`.
   c. Spawn a sub-agent via the `Agent` tool. Use `subagent_type: claude`,
      `description` from the plan, `prompt` from the plan. The sub-agent
      will run autonomously and return its free-form answer as its message.
   d. Capture `finishedAt`.
   e. **The sub-agent's response is free-form text** — there is no JSON
      contract to validate. Capture the entire returned message body as
      the `response` field.
   f. **Parse the `<usage>` footer** appended to the Agent tool result.
      It looks like:
      ```
      <usage>total_tokens: 25027
      tool_uses: 3
      duration_ms: 34064</usage>
      ```
      Extract `total_tokens`, `tool_uses`, and `duration_ms`.
   g. **Optionally capture a trajectory.** The Agent tool doesn't expose
      per-tool input/output, but you usually know which tool names were
      used from the agent's reasoning. Provide a `toolCalls` array with
      `{name, input: {}, output: {}, inputBytes: 0, outputBytes: 0}` for
      each call — the CLI uses this only for the MCP-prefix constraint
      check, so even stub entries with just `name` are useful. Skipping
      the trajectory entirely is allowed; you lose the constraint check
      but the response + usage still record.
   h. Write the result to `bench/results/<runId>/tmp/<cellId>.json` with
      this schema:
      ```json
      {
        "response": "<free-form text the sub-agent returned>",
        "usage": {
          "totalTokens": 25027,
          "toolUses": 3,
          "durationMs": 34064
        },
        "trajectory": {
          "toolCalls": [
            { "name": "mcp__dtc-mcp__execute_code",
              "input": {}, "output": {},
              "inputBytes": 0, "outputBytes": 0 }
          ],
          "rawResponse": "<copy of response — kept for raw.jsonl>",
          "durationMs": 34064
        },
        "startedAt": "...",
        "finishedAt": "..."
      }
      ```
      Filename: use `__` (double underscore) instead of `::` in cell IDs
      since `::` is awkward in shell paths. e.g.
      `01-list-recent-campaigns__dtc-mcp__trial-1.json`.
   i. Run `tsx bench/runner/cli.ts record --cell <cellId> <tmpfile>` to
      persist + check constraint violations.

6. **After all cells in the batch are recorded**, stop here. **Do NOT**
   run `tsx bench/runner/cli.ts grade` during a batch run — grading is
   deferred to the judge phase (see Batch F below). The `grade` command
   does still exist but only aggregates already-recorded judge verdicts
   into a `score` field; calling it before any judge runs produces no
   useful output.

7. **Run `tsx bench/runner/cli.ts state`** and print the summary to the
   user. Tell them which batch is next and stop. Do NOT auto-continue —
   the user needs to manage their Max-plan quota window.

## Judge phase (Batch F, or anytime after recording is complete)

The runner separates recording from grading so all sub-agent runs can
happen first (cheap, parallelizable in theory) and judging happens once
at the end (one Sonnet sub-agent per (cell, criterion) pair).

To run the judge phase:

1. **`tsx bench/runner/cli.ts judge-plan`** → emits a JSON list of pending
   judge work, one entry per (cell, criterion-index) pair. Each entry
   contains `cellId`, `criterionIndex`, `criterion`, `userQuestion`, and
   the recorded `response`.

2. **For each judge work item**, spawn a **Sonnet** sub-agent (not Opus —
   we want to avoid self-enhancement bias). Use `buildJudgePrompt()` from
   `bench/runner/prompt-templates.ts` as the template; it takes
   `(userQuestion, response, criterion)` and returns a prompt that asks
   for a single-line JSON verdict: `{"verdict": "PASS"|"FAIL"|"PARTIAL",
   "reason": "..."}`.

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

- **`--retry`** skips the plan and just re-runs the one specified cell.
  Useful for fixing constraint violations or transient failures without
  re-running an entire batch.

- **`--limit`** is for smoke tests: `--batch A --limit 2` runs just two
  cells of batch A. Used for calibration runs before committing to a
  full batch.

## Honest reminders

- This is a **batched, resumable** runner. Never try to do all 90 cells in
  one Claude Code session — the user's Max-plan quota will exhaust.
- The new methodology captures **real** token consumption from the
  `<usage>` footer, not the bench's older byte-based estimator. The
  estimator still runs when a trajectory is provided but it only
  measures tool-definition + I/O overhead, not actual model context.
- If a cell's sub-agent ignores the MCP-prefix constraint and uses tools
  from the OTHER MCP, the CLI flags it as `invalid` (only catches what's
  in the supplied trajectory — if you skip the trajectory, the check
  doesn't run). Don't try to rationalize the result. The trial is wasted;
  re-run it.
- Sub-agent prompts are **natural user questions**. Do not append
  benchmark framing, output-format demands, or "you're being evaluated"
  instructions — that defeats the methodology. The plan output is
  authoritative; spawn the Agent with the exact prompt string from the
  plan.
