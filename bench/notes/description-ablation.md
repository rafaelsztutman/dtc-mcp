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

## Methodology notes

This ablation is a model for future tool-design decisions. Pattern:
1. Generate diverse candidates (5+ recommended; cover the design space, not just variations of one philosophy).
2. Probe via Sonnet sub-agents with a scenario that exercises the dimension under test. Use `claude -p --model claude-sonnet-4-6` for cheap parallel runs.
3. Score on behavior dimensions, not introspection.
4. Real-bench validate the top 1-2 candidates.

Cost: ~$0 (Max subscription Sonnet), ~5 min wall-clock per candidate batch. Use this BEFORE committing description changes to dtc-mcp, not after shipping.
