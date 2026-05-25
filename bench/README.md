# dtc-mcp benchmark

Head-to-head comparison of `dtc-mcp` v1.0.2 against Klaviyo's official MCP server on Klaviyo-only analytics tasks.

> This is a **portfolio benchmark**, not a peer-reviewed one. The methodology is documented honestly and the raw trajectories are committed so anyone can re-run, re-grade, or challenge the numbers.

## What it measures

For each of 15 tasks × 2 MCPs × 3 trials (= 90 cells):

- **Estimated tokens** — sum of tool-definition bytes (× turns), tool I/O payload bytes, and final response bytes, divided by a calibrated tariff (default 4 bytes/token). Honest assumption: NO prompt cache.
- **Tool calls** — count of MCP tool invocations the sub-agent made.
- **Wall-clock duration** — time from sub-agent spawn to final response.
- **Pass rate** — fraction of task-level claims satisfied by the final answer (claims-based grading + LLM-as-judge for fuzzy claims).

## Constraints driving the design

- **No Anthropic API access** — we use Claude Max sub-agents instead. Token counts are estimated, not measured from `usage.input_tokens`.
- **Max 5-hour quota window** — the run is split into 6 batches (A–F) that the user authorizes one at a time.
- **Live Klaviyo account** — run all trials within a tight time window so reporting data doesn't shift between MCPs.

## Quick start

### Prerequisites

1. **Both MCPs installed in Claude Code.** The user's `~/.claude.json` (or per-project `.claude.json`) needs both:
   ```json
   "mcpServers": {
     "dtc-mcp": { "command": "npx", "args": ["-y", "dtc-mcp"], "env": { "KLAVIYO_API_KEY": "pk_..." } },
     "klaviyo":  { "command": "klaviyo-mcp-server", "env": { "PRIVATE_API_KEY": "pk_..." } }
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
#   /bench --batch A     # 15 cells, ~15 min
#   /bench --batch B
#   /bench --batch C
#   /bench --batch D
#   /bench --batch E
#   /bench --batch F     # finalizes + writes report.md

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
      { "name": "mcp__klaviyo__get_campaigns", "description": "..." },
      { "name": "mcp__klaviyo__get_campaign", "description": "..." },
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
├── tasks/               ← 15 task definitions (JSON, one per file)
├── runner/
│   ├── cli.ts           ← deterministic bookkeeping (init/state/plan/record/grade/report)
│   ├── types.ts         ← Task, Trial, RunState, etc.
│   ├── state.ts         ← state.json read/write + batch planning
│   ├── prompt-templates.ts ← sub-agent prompt builder + judge prompt
│   ├── estimator.ts     ← byte → token estimator
│   ├── grader.ts        ← claims-based grading
│   └── report.ts        ← markdown report generator
└── results/<runId>/
    ├── state.json       ← single source of truth, resumable
    ├── tmp/             ← per-cell sub-agent outputs (intermediate)
    ├── raw.jsonl        ← every trajectory recorded
    └── report.md        ← the publishable summary
```

## Methodology details

### Why batches (A–F)

Sub-agents consume Max-plan quota. A full run is ~90 cells × ~40s each ≈ 60 min of sub-agent time at strictly sequential pacing (see below); even one batch is meaningful in isolation. The 6-batch split lets the user:
- Pause between batches as quota allows
- Inspect intermediate state and abort if early results look bogus
- Resume cleanly from `state.json` after restart

### Strictly sequential, deliberately slow

The benchmark hits a live Klaviyo account. Bursty access could trip rate-limit detection and (worse) flag the account. To stay below the radar:

- **`concurrency: 1`** by default — one sub-agent at a time. Never parallel.
- **`baseDelayMs: 3000`** — minimum 3-second gap between any two cells.
- **`reportingDelayMs: 8000`** — extra 8-second gap before any cell that hits Klaviyo's `campaign-values-reports` or `flow-values-reports` endpoints (those tiers are throttled at 1/s burst, 2/min sustained).
- **`mcpSwitchDelayMs: 10000`** — extra 10-second gap when switching between dtc-mcp and klaviyo-mcp cells, since both share the same per-account budget.

Per-cell pacing is computed by `bench/runner/cli.ts plan` and surfaced to the sub-agent runner. Total estimated wall-clock per batch is in the plan JSON's `totalEstSeconds` field. Pacing settings live in `state.json` under `pacing` so they can be tweaked per-run.

### Why claims-based grading

Live Klaviyo data shifts (campaigns get sent, reports update). Exact-match grading isn't viable for most tasks. Each task defines a list of **verifiable claims** (e.g. "list contains exactly 5 items", "all items have field `name`", "ordered by `revenue` descending"). The grader checks each claim against the final answer. Tasks where claims are inherently fuzzy ("explain WHY campaign X performed best") get an LLM-as-judge claim, deferred to batch F.

### Why estimated tokens

The Anthropic API exposes `usage.input_tokens` directly, but Max-plan sub-agents don't surface that to the parent agent. We work around this by recording every tool-call payload's byte size and using a calibrated bytes/token tariff (default 4, refined in Phase 2 against the published Anthropic tokenizer on sample payloads). The estimate is intentionally **conservative against prompt caching** — we assume tool definitions are re-loaded every turn. Real-world cache hits would only widen the gap that the benchmark reports, not narrow it.

### Constraint enforcement

Sub-agents in Claude Code see ALL configured MCPs. The prompt template explicitly instructs each sub-agent to use only one MCP's prefix. After every cell is recorded, `cli.ts record` scans the captured trajectory; any tool call outside the allowed prefix marks the trial as `invalid`, and it's re-run. Sub-agent self-reported `tool_calls` are ignored in favor of the trajectory-based ground truth.

### What's NOT in the benchmark

- **Cross-platform tasks** — dtc-mcp supports Shopify; Klaviyo's MCP doesn't. Out of scope for apples-to-apples comparison. See the capability matrix in the final report for qualitative differences.
- **Write operations** — both MCPs support some writes (e.g. `create_profile`), but live-account write tests would muddy results across trials. Read-only analytics only.
- **Multi-model comparison** — Opus 4.7 only for v1. Adding Sonnet / Haiku tiers is deferred.

## Honest tradeoffs

| Decision | Tradeoff |
|---|---|
| Sub-agents, not direct API | $0 cost, but token counts are estimated |
| Live API data | Realistic numbers, but reruns won't reproduce exactly |
| 3 trials per cell | Variance signal without huge cost; not pass@k |
| Claude Opus 4.7 only | Comparable to Stainless's published numbers; misses model-tier scaling |
| Klaviyo-only tasks | Fair comparison; doesn't showcase dtc-mcp's Shopify advantage |

## License

MIT (same as the parent repo).
