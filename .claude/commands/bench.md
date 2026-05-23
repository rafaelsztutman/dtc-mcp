---
description: Run a benchmark batch — dtc-mcp vs Klaviyo official MCP. Takes optional --batch <A-F> and --retry <cellId>.
---

# /bench — head-to-head MCP benchmark driver

You are about to execute one batch of the dtc-mcp vs Klaviyo-MCP benchmark.
The benchmark is run via Claude Code sub-agents (no Anthropic API access);
this command coordinates them and the deterministic bookkeeping CLI.

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

3. **If the run's `mcpMetadata` for either MCP has `toolCount: 0`**, ask
   the user to dump `tools/list` for each MCP into a JSON file like
   `bench/tools-list-dump.json`:
   ```
   {
     "dtc-mcp": { "toolList": [<paste from /mcp tools/list>] },
     "klaviyo-mcp": { "toolList": [<paste>] }
   }
   ```
   Then run `tsx bench/runner/cli.ts probe bench/tools-list-dump.json`
   to populate metadata. Then proceed.

4. **Run `tsx bench/runner/cli.ts plan --batch <batch>`** to get the JSON
   plan. Parse it — it's an array of pending cells, each with a fully-built
   sub-agent prompt.

5. **For each cell in the plan — STRICTLY SEQUENTIAL**, one at a time.
   Klaviyo's API will flag bursty access; the harness intentionally paces
   itself. The plan JSON includes a `delayBeforeMs` field on every cell:
   wait that many milliseconds BEFORE spawning the cell's sub-agent. Do
   NOT run sub-agents in parallel for this benchmark — even though the
   `Agent` tool supports it.

   a. **Wait `delayBeforeMs` milliseconds** (skip on the first cell of
      a batch — there's nothing to space from).
   b. Capture `startedAt = new Date().toISOString()`.
   c. Spawn a sub-agent via the `Agent` tool. Use `subagent_type: claude`,
      `description` from the plan, `prompt` from the plan. The sub-agent
      will run autonomously and return a single JSON object as its message.
   d. Capture `finishedAt`.
   e. Parse the sub-agent's return message. It MUST conform to:
      ```
      { "final_answer": <string>, "claims": [<strings>],
        "tool_calls": <int>, "succeeded": <bool>, "errors": [<strings>] }
      ```
   f. **Capture the full trajectory.** The sub-agent's actual MCP tool
      calls are visible in its returned transcript. Parse them into a
      `Trajectory` with each tool's `name`, `input`, `output`. Don't worry
      about exact byte counts — the CLI fills those in on record.
   g. Write the result to a temp file under `bench/results/<runId>/tmp/<cellId>.json`:
      ```
      { "trajectory": { "toolCalls": [...], "rawResponse": "...", "durationMs": <number> },
        "report": { "final_answer": ..., "claims": [...], "tool_calls": ..., "succeeded": ..., "errors": [...] },
        "startedAt": "...", "finishedAt": "..." }
      ```
   h. Run `tsx bench/runner/cli.ts record --cell <cellId> <tmpfile>` to
      persist + estimate tokens + check constraint violations.

6. **After all cells in the batch are recorded**, run
   `tsx bench/runner/cli.ts grade` to score everything that's recorded
   (skips fuzzy/judge claims until batch F).

7. **Run `tsx bench/runner/cli.ts state`** and print the summary to the
   user. Tell them which batch is next and stop. Do NOT auto-continue —
   the user needs to manage their Max-plan quota window.

## Special cases

- **Batch F** also runs LLM-as-judge over all collected fuzzy claims (the
  ones marked `type: "judge"`). For each, spawn a Sonnet sub-agent (use
  the judge prompt template at `bench/runner/prompt-templates.ts`).
  Then re-grade all cells (the judge outputs feed `gradeCell`) and write
  the final `report.md` with `tsx bench/runner/cli.ts report`.

- **`--retry`** skips the plan and just re-runs the one specified cell.
  Useful for fixing constraint violations or transient failures without
  re-running an entire batch.

- **`--limit`** is for smoke tests: `--batch A --limit 2` runs just two
  cells of batch A. Used for the Phase 2 smoke + calibration.

## Honest reminders

- This is a **batched, resumable** runner. Never try to do all 90 cells in
  one Claude Code session — the user's Max-plan quota will exhaust.
- Token counts are **estimated**, not measured (no API access). Document
  this in the report so claims based on the numbers are defensible.
- If a cell's sub-agent ignores the MCP-prefix constraint and uses tools
  from the OTHER MCP, the CLI flags it as `invalid` — don't try to
  rationalize the result. The trial is wasted; re-run it.
