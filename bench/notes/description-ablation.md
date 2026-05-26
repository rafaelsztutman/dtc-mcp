# Tool description ablation — what an LLM probe taught us

**Status:** internal finding. Drove the v1.0.6 revert and reshaped the v1.1.0 plan.

**Method:** for each of 5 candidate `execute_code` tool descriptions, spawned 3 fresh `claude -p --model claude-sonnet-4-6` calls with the SAME 3-turn analyst scenario ("top 3 campaigns by revenue last 30 days → vs prior 30 days → biggest drop"). The agent was told NOT to actually call tools, just to write the code it would compose. Behavior dimensions measured:

- **stash**: did turn-1 code assign to `globalThis`?
- **referenced**: did turn-2/3 code read from `globalThis` without re-fetching?
- **call count**: total `klaviyo.*` / `shopify.*` invocations across all 3 turns
- **hallucinations**: method names not in `bridge.ts` registry
- **length**: response chars (proxy for elaboration cost)

15 sub-agent runs, ~5 min wall-clock, no Klaviyo API hit. Pure description-effects ablation.

Runner: `bench/runner/probe-descriptions.ts`. Transcripts: `bench/notes/probe-results/`.

## Results

| Cand | Style | stash | refed | calls/T | hallc | len |
|------|-------|-------|-------|---------|-------|-----|
| A | Minimal (v1.0.4 baseline) | 3/3 | 3/3 | 4.0 | 5 | 2034 |
| B | Schema-first (TS signature) | 3/3 | 3/3 | 2.0 | 3 | 1795 |
| C | Example-first (code only) | 3/3 | 3/3 | 3.3 | **1** | 1968 |
| D | Ultra-compressed | 3/3 | 3/3 | 3.3 | 5 | 2096 |
| E | Hybrid (schema + 1 example) | 3/3 | 3/3 | 4.0 | **1** | 2349 |

## The three big findings

### 1. Stash behavior is description-independent

**Every candidate scored 3/3 on stashing AND 3/3 on referencing from stash in later turns.** Even the ultra-compressed candidate D (35 tokens, no mention of when to stash) and the minimal candidate A (60 tokens, no prescriptive guidance) had the agent reliably using `globalThis` across all 3 turns.

**Sonnet figures out the stash-and-cite pattern from the scenario itself, not from the tool description.** Our v1.0.5 prescriptive paragraph ("STRONGLY RECOMMENDED for multi-turn investigations…") was teaching behavior the model already had as default. The bloat added cost with zero behavioral benefit — and the v1.0.5 bench data is consistent with this: token counts went UP, not down, because the bloat added per-call reasoning overhead without changing what the agent did.

### 2. Concrete examples are the only effective API-surface teaching

| | Hallucinations | Description had real example? |
|---|---|---|
| A (minimal) | 5 | No |
| B (schema-first) | 3 | No |
| D (ultra-compressed) | 5 | No |
| C (example-first) | **1** | Yes |
| E (hybrid) | **1** | Yes |

C and E both had a single real-API example in the description (`klaviyo.reporting.flowValues({ data: { ... } })`). The agent generalized from that example to `klaviyo.reporting.campaignValues` with the correct JSON:API nested shape — even though that exact method wasn't shown.

Candidates without examples (A, B, D) had the agent inventing plausible-looking method names: `klaviyo.campaigns.report`, `klaviyo.campaigns.valueReport`, `klaviyo.campaigns.getValuesReport`. Schema-only (B) didn't help — knowing the return type doesn't tell the agent what to call.

**Conclusion: prose teaches nothing useful; schema teaches structure but not method names; ONE concrete example teaches the API surface dramatically.** One real example > five hand-written paragraphs.

### 3. Schema-first wins on call count but partly via "easier hallucinations"

B (schema-first, 2 calls/T average) looked best on call efficiency. But on inspection: B's lower call count came partly from the agent inventing a simpler API (`klaviyo.campaigns.report({start, end})`) that didn't need the metric-ID lookup step. Real production calls would fail and trigger retries. So B's "efficiency" is an artifact of its hallucination style, not real efficiency.

A and E (which made real or near-real calls) had the agent correctly fetching the conversion metric ID first — adding 1 call per turn but landing on the real API.

**Take:** call count is a noisy metric when hallucinations differ. Hallucination count is the harder signal.

## Recommended v1.0.6 description

Refined from C + E's strengths, no prescriptive prose:

```
execute_code(code: string) -> { ok, result, stdout, state, durationMs }
  state: current globalThis stash (auto-populated, summary-form)

Sandbox globals: klaviyo, shopify, console, pick, topN, summarize, globalThis (persists across calls)

// Reference example (note the JSON:API request shape):
const metricId = await klaviyo.getConversionMetricId();
const report = await klaviyo.reporting.campaignValues({
  data: { type: 'campaign-values-report', attributes: {
    timeframe: { key: 'last_30_days' },
    conversion_metric_id: metricId,
    statistics: ['recipients', 'open_rate', 'conversion_value'],
  }}
});
globalThis.report = report;
return topN(report.data.attributes.results, 3, r => r.statistics.conversion_value);
```

Why this shape:
- **Schema line** gives the response structure (and exposes `state` field as an LLM-readable cue, not as prose).
- **Globals enumeration** is terse, no editorializing.
- **One canonical example** uses the real `klaviyo.reporting.campaignValues` with the correct JSON:API shape — this is the single biggest teaching lever per the ablation.
- **No prescriptive language** about WHEN to stash — the example demonstrates the pattern; the scenario will trigger the behavior the model already has.

Estimated cost: ~100 tokens (vs v1.0.5's ~180, vs v1.0.4's ~80). Spends the extra 20 tokens vs v1.0.4 on one concrete example, which the probe shows cuts hallucinations 5×.

## Where this leaves the v1.1.0 plan

Two pieces of the v1.1.0 plan get reframed by these findings:

1. **Recipes are about teaching API surface, not teaching patterns.** The original v1.1.0 plan framed recipes as "teach the agent the right composition." The ablation shows the agent figures out composition naturally — but doesn't know the API surface. Recipes should be heavy on real-API examples and light on prose.

2. **Intent-driven recipe surfacing matters more than we thought.** With hallucinations the dominant accuracy problem AND universal across description styles, the discovery mechanism (recipe-by-intent) becomes the single biggest leverage point. If the agent reaches for an existing recipe instead of guessing, hallucinations drop near zero.

The v1.1.0 plan's structure (intents metadata + recipe boost in search ranking) is unchanged; the *priority* of recipe-authoring goes UP because we now know examples are the only thing that teaches API surface effectively.

## Round 3 — scenario variation + cost annotations + tool-name framing

Run via `bench/runner/probe-round3.ts`. Three experiments, 30 sub-agent cells.

### 3A: scenario variation (the methodology check)

Tested F (v1.0.6 control) vs O (npm README) across 3 distinct scenarios that mirror the real bench's task categories:

| Scenario | Cand | Hallc | Calls/T | Len | Dur |
|---|---|---|---|---|---|
| lookup (1 turn) | F | 1 | 1.0 | 422 | 18.9s |
| lookup (1 turn) | O | **0** | 1.0 | **374** | **15.5s** |
| revenue (3 turn) | F | 0 | 3.0 | **1990** | **38.3s** |
| revenue (3 turn) | O | 0 | 3.0 | 2177 | 40.8s |
| cross (3 turn) | F | **4** | 4.0 | 1771 | 43.2s |
| cross (3 turn) | O | 2 | 4.0 | 2116 | 58.1s |

**Findings:**

- **F doesn't dominate across scenarios.** O is marginally better on lookup; F is marginally better on revenue; both struggle on cross-resource.
- **Cross-resource breaks the canonical-example pattern.** Both F and O hallucinated on cross — the hallucinations (`klaviyo.getCampaigns`, `klaviyo.getSegments`) are flat-namespace patterns extrapolated from the example. The canonical example only shows ONE API surface (reporting); when the agent composes across resources, it makes up plausible-looking but wrong methods.
- **This validates the v1.1.0 priority on recipes covering distinct resource shapes** — not more variants of the same shape.
- **The lookup advantage of O over F is real but tiny** (~50 chars, ~3s). Doesn't justify additional churn.

### 3B: cost annotations (inline metadata vs prescriptive prose)

Tested F vs F_cost (F plus inline `// cost: X` comments in the canonical example):

| Cand | Hallc | Calls/T | Len | Dur |
|---|---|---|---|---|
| F | 0 | 3.0 | 1990 | 38.3s |
| F_cost | 0 | 3.0 | 1899 | 41.6s |

**Wash.** Inline cost annotations produced 5% shorter responses but 9% slower duration. No accuracy change. **Hypothesis dead** — agents don't visibly weigh inline cost metadata, at least not in the comment-style format tested. This rules out the "maybe the cost-framing prose was right but in the wrong place" hypothesis from v1.0.6 design.

### 3C: tool-name framing (does renaming change behavior?)

Tested F's description under 4 alternative tool names:

| Name | Hallc | Dur |
|---|---|---|
| execute_code | 0 | **38.3s** |
| analyze | 0 | 51.2s |
| klaviyo_query | 0 | 47.5s |
| dtc | 0 | 52.4s |

**`execute_code` is meaningfully fastest** — alternative names slow the agent down ~25%. Counter to my hypothesis (semantic-loaded names would help routing). Likely explanation: `execute_code` literally describes what the agent is doing (writing and executing JS), so there's no dissonance to resolve; renaming forces extra reasoning about whether the tool is appropriate.

**Don't rename.** This rules out the "maybe a better name would prime better behavior" hypothesis.

## Convergence across 3 rounds

After 9 candidates across 3 rounds (~63 sub-agent probes), the description-design space has converged:

1. **Stash behavior is description-independent** — Sonnet uses globalThis by default for multi-turn scenarios.
2. **One canonical example with the real API surface does 99% of the teaching.**
3. **Past that example, format is marginal** — schema, npm README, multi-example, anti-example, intent-routing, .d.ts all produce essentially equivalent behavior.
4. **Cross-resource workloads break the canonical example.** The agent extrapolates patterns from one surface to others and invents methods. **Description-only can't fix this.**
5. **Cost annotations don't help.** Inline cost metadata is neither absorbed nor weighed.
6. **Tool names matter** — but counterintuitively. The literal `execute_code` outperforms semantic names by ~25% wall-clock.

## What this means architecturally

**The next leverage point is NOT description tweaks. It's runtime architecture.** Specifically:

1. **Recipes covering distinct resource shapes** (v1.1.0 plan, priority confirmed).
2. **Response-side teaching** that surfaces relevant recipes based on what the agent just ran.
3. **Reactive tool surfaces** — tool descriptions that adapt to the prior call sequence.
4. **Speculative result inclusion** — tool responses that carry likely follow-up data.

None of these are description-level. The probe has earned its keep by showing us that the description has converged.

## Methodology notes

This ablation is a model for future tool-design decisions. Pattern:
1. Generate diverse candidates (5+ recommended; cover the design space, not just variations of one philosophy).
2. Probe via Sonnet sub-agents with a scenario that exercises the dimension under test. Use `claude -p --model claude-sonnet-4-6` for cheap parallel runs.
3. Score on behavior dimensions, not introspection.
4. Real-bench validate the top 1-2 candidates.

Cost: ~$0 (Max subscription Sonnet), ~5 min wall-clock per candidate batch. Use this BEFORE committing description changes to dtc-mcp, not after shipping.
