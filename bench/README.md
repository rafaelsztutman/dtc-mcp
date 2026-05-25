# dtc-mcp benchmark

Head-to-head comparison of `dtc-mcp` v1.0.4+ against Klaviyo's official MCP server on Klaviyo-only analytics tasks, organized along the **conversation-length axis**.

> This is a **portfolio benchmark**, not a peer-reviewed one. The methodology is documented honestly and the raw trajectories are committed so anyone can re-run, re-grade, or challenge the numbers.

## The thesis

Most MCP servers are designed around single-shot tool calls — the model picks a tool, sends one request, reads one response. Real LLM usage is conversational: an analyst asks a question, then a follow-up, then drills in, then synthesizes. Each follow-up turn pays for the previous turn's tool-result bytes again, because tool-list MCPs serialize fresh JSON payloads on every call and the agent has to keep the prior data in its conversation context to reference it later.

dtc-mcp takes a different shape: one `execute_code` tool backed by a stateful V8 sandbox per MCP connection. Prior tool calls' data live in `globalThis` and are addressable from later calls — no need to re-serialize them through the conversation. The hypothesis under test: **as conversation length grows, dtc-mcp's per-turn cost stays flat or shrinks while tool-list MCPs scale up**, so the headline gap should compound with turn count.

The benchmark is built to test that specifically.

## What it measures

For each of 9 tasks × 2 MCPs × 2 trials (= 36 cells):

- **Real tokens** — pulled from the `<result>` event's `usage` block in `claude -p --output-format stream-json`: `input + cache_creation + output` (cache reads excluded, matches `<usage>` footer convention).
- **Tool calls** — count of MCP tool invocations parsed from the assistant events.
- **Wall-clock duration** — total time the `claude -p` invocation took, end-to-end.
- **Per-turn breakdown** — turn-by-turn responses and approximate per-turn token allocation (aggregate `÷` turn count, since stream-json doesn't expose per-turn usage natively).
- **Pass rate** — fraction of judge_criteria evaluated `PASS` by a Sonnet sub-agent (PARTIAL = 0.5).

## Task structure

Nine tasks across four turn-count buckets:

| Bucket | Turns | Tasks | Examples |
|---|---|---|---|
| Baseline | 1 | 3 | "Show me my 5 most recently sent campaigns" |
| Short | 2 | 2 | Welcome-flow deep dive; 3-campaign comparison |
| Medium | 5 | 2 | Campaign-performance investigation; segment-engagement deep dive |
| Long | 10 | 2 | Full analyst standup; campaign postmortem + strategy |

Each task is **a natural user question** — no JSON-format mandates, no "you're being benchmarked" framing. The harness adds a single minimal MCP-routing hint to the first turn (`Use the \`mcp__<server>__*\` tools to answer this question`) so the agent picks the assigned MCP, and that's the whole instrumentation envelope.

The 9 tasks live in `bench/tasks/*.json`. See each file for the prompt + judge criteria.

## Constraints driving the design

- **No Anthropic API access** — we use the user's Claude Max subscription via the `claude -p` CLI. One `claude -p` invocation = one MCP transport, so dtc-mcp's per-connection sandbox state survives across all turns of a multi-turn cell.
- **Max-plan quota window** — the run is split into 4 batches (A–D) that the user authorizes one at a time. Long-bucket cells (10 turns each) can take 4–8 minutes per cell, so quota planning matters.
- **Live Klaviyo account** — strictly sequential pacing, with extra buffer around reporting-endpoint cells, to keep below the 2/min sustained throttle on reporting endpoints.

## Quick start

### Prerequisites

1. **Both MCPs installed at the user level** in `~/.claude.json`. The `claude -p` child process won't see project-level `.mcp.json` configs unless they're explicitly trusted.
   ```json
   "mcpServers": {
     "dtc-mcp": { "command": "npx", "args": ["-y", "dtc-mcp"], "env": { "KLAVIYO_API_KEY": "pk_..." } },
     "klaviyo": { "command": "klaviyo-mcp-server", "env": { "PRIVATE_API_KEY": "pk_..." } }
   }
   ```
   Install Klaviyo's official MCP with `pip install klaviyo-mcp-server` (or `pipx install klaviyo-mcp-server`).

2. **Bench harness deps.**
   ```bash
   cd bench
   npm install
   ```

### Run

```bash
# One-time per run: initialize state.json.
tsx runner/cli.ts init

# After both MCPs are configured in Claude Code, dump their tool lists
# into bench/tools-list-dump.json (see below) and run probe:
tsx runner/cli.ts probe tools-list-dump.json

# Run one batch at a time via the Claude Code slash command:
#   /bench --batch A     # 12 cells, baseline (1 turn)
#   /bench --batch B     #  8 cells, short (2 turns)
#   /bench --batch C     #  8 cells, medium (5 turns)
#   /bench --batch D     #  8 cells, long (10 turns)
# Or run a single cell directly:
#   tsx runner/cli.ts multiturn --cell 06-medium-campaign-performance-investigation::dtc-mcp::trial-1

# Or query progress any time:
tsx runner/cli.ts state
```

### Tools-list dump format

The `probe` command needs the actual `tools/list` payload from each MCP. Capture once with MCP Inspector or by asking Claude Code to dump `mcp__dtc-mcp__*` and `mcp__klaviyo__*` tool names:

```json
{
  "dtc-mcp": {
    "toolList": [
      { "name": "mcp__dtc-mcp__execute_code", "description": "..." },
      { "name": "mcp__dtc-mcp__search_docs", "description": "..." },
      { "name": "mcp__dtc-mcp__read_doc", "description": "..." }
    ]
  },
  "klaviyo-mcp": {
    "toolList": [
      { "name": "mcp__klaviyo__klaviyo_get_campaigns", "description": "..." },
      ...
    ]
  }
}
```

## Layout

```
bench/
├── README.md            ← this file
├── package.json         ← tsx, vitest
├── tsconfig.json
├── tasks/               ← 9 task definitions (JSON, one per file)
├── runner/
│   ├── cli.ts           ← deterministic bookkeeping (init/state/plan/multiturn/record/grade/report)
│   ├── multiturn.ts     ← spawns `claude -p` and parses stream-json
│   ├── types.ts         ← Task, CellResult, RunState, etc.
│   ├── state.ts         ← state.json read/write + batch planning
│   ├── prompt-templates.ts ← MCP routing hint + judge prompt builder
│   ├── estimator.ts     ← byte → token estimator (legacy; real tokens come from claude stream)
│   ├── grader.ts        ← aggregate judge verdicts → score
│   └── report.ts        ← markdown report generator
└── results/<runId>/     ← gitignored
    ├── state.json       ← single source of truth, resumable
    ├── tmp/             ← per-cell intermediate dumps
    └── report.md        ← the publishable summary
```

## Methodology details

### Why `claude -p` with stream-json

The breakthrough that made the multi-turn axis testable: one `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages` invocation keeps ONE CLI process alive, which means ONE MCP transport for the whole trajectory. dtc-mcp's per-connection sandbox state — verified empirically to survive across turns within a single invocation but NOT across separate `claude -p --resume` calls — is the property the long-bucket tasks are designed to exercise.

This is the τ²-bench (Sierra) / BFCL v3 multi-turn pattern: one script holds the chat history list AND the tool transport open for the whole trajectory. We adopted it after confirming that Claude Code's `Agent` tool spawns a FRESH MCP connection per sub-agent, which would defeat the cross-turn stateful-sandbox signal.

### Why batches (A–D)

A full run is 36 cells. Batch D alone (long-conversation, 10 turns × 8 cells) can take ~50 minutes of `claude -p` time. The 4-batch split lets the user:
- Pause between batches as Max-plan quota allows
- Inspect intermediate state and abort if early results look bogus
- Resume cleanly from `state.json` after restart

### Strictly sequential, deliberately slow

The benchmark hits a live Klaviyo account. Bursty access could trip rate-limit detection and (worse) flag the account. To stay below the radar:

- **`concurrency: 1`** by default — one cell at a time. Never parallel.
- **`baseDelayMs: 3000`** — minimum 3-second gap between any two cells.
- **`reportingDelayMs: 8000`** — extra 8-second gap before any cell that hits Klaviyo's `campaign-values-reports` or `flow-values-reports` endpoints (1/s burst, 2/min sustained, 225/day).
- **`mcpSwitchDelayMs: 10000`** — extra 10-second gap when switching MCPs.

Per-cell pacing is computed by `cli.ts plan` and surfaced in the plan JSON's `delayBeforeMs` field. Pacing settings live in `state.json` under `pacing` so they can be tweaked per-run.

### Why claims-based grading (LLM-as-judge)

Live Klaviyo data shifts (campaigns get sent, reports update). Exact-match grading isn't viable. Each task defines a list of natural-language `judge_criteria` (e.g. "the answer identifies 5 email campaigns", "no fabricated subject lines appear"). A Sonnet sub-agent grades each criterion against the cell's final-turn response (PASS / PARTIAL / FAIL). We deliberately use Sonnet, not Opus, to avoid self-enhancement bias when judging Opus-generated responses.

### Constraint enforcement

The harness prepends a one-line MCP routing hint to the first turn of every cell — "Use the `mcp__<server>__*` tools to answer this question." After the cell runs, `cli.ts multiturn` scans the parsed trajectory; any `mcp__*`-prefixed tool call outside the allowed server marks the cell `invalid` and it can be re-run with `--retry`. Claude Code's own infrastructure tools (Bash, Read, ToolSearch, etc.) are orthogonal and not flagged.

### What's NOT in the benchmark

- **Cross-platform tasks** — dtc-mcp supports Shopify; Klaviyo's MCP doesn't. Out of scope for apples-to-apples comparison. See the capability matrix in the final report for qualitative differences.
- **Write operations** — both MCPs support some writes (e.g. `create_profile`), but live-account write tests would muddy results across trials. Read-only analytics only.
- **Multi-model comparison** — Opus 4.7 only for v1. Adding Sonnet / Haiku tiers is deferred.

## Honest tradeoffs

| Decision | Tradeoff |
|---|---|
| `claude -p` CLI + Claude Max | $0 marginal cost, but consumes Max-plan quota |
| Live API data | Realistic numbers, but reruns won't reproduce exactly |
| 2 trials per cell | Variance signal at half the cost of 3; a 3rd trial can be added per cell if needed |
| Claude Opus 4.7 only | Comparable to Stainless's published numbers; misses model-tier scaling |
| Klaviyo-only tasks | Fair comparison; doesn't showcase dtc-mcp's Shopify advantage |
| Per-turn token split is uniform | Stream-json reports only aggregate usage; per-turn cost is `aggregate ÷ turns` (rough — first turn carries tool-definition load and is typically heaviest) |

## License

MIT (same as the parent repo).
