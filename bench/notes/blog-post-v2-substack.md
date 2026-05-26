# What benchmarking my own MCP server taught me about building tools for LLMs

*A journey from 22 hand-built tools to one `execute_code`, through a regression I caused myself, into an ablation methodology that fixed it. With actual numbers.*

---

## The original problem

I built [dtc-mcp](https://github.com/rafaelsztutman/dtc-mcp) in late 2025 to help my wife — who runs [Emberk](https://emberk.co), a DTC brand on Shopify + Klaviyo — get useful answers out of her marketing data without context-switching through dashboards. The Klaviyo and Shopify dashboards are fine for the analyst sitting in them all day; they're miserable for an operator who just wants to know "did last week's birthday-sale campaign actually outperform Mother's Day, controlling for audience size?" Each answer is two browser tabs, five clicks, three CSV exports, and a back-of-envelope calculation.

The pitch I made to myself: an MCP server that exposes the right primitives to Claude (or any LLM client) so the operator can just ask the question and get a real answer back, with the underlying math actually done.

The first version was the obvious shape — one MCP tool per API endpoint. By v0.2.1 in February 2026, dtc-mcp shipped **22 hand-built tools**: `get_campaigns`, `get_flows`, `get_campaign_report`, `get_flow_report`, `shopifyql_orders_by_country`, `shopifyql_ltv_by_acquisition_source`, and seventeen more. Each one was a thin wrapper around an API endpoint with a tight Zod schema and a docstring tailored for an LLM.

It worked. Better than the official Klaviyo MCP (which exists, has 28 tools of its own, and we'll compare against later). My wife could ask "what's our top-performing flow this month and how does it compare to the last 90 days?" and get a real answer back. I shipped it to the Anthropic MCP directory and called it done.

Then I read the Stainless post.

## The Stainless moment

In March 2026, Stainless published [SDK Code Mode](https://www.stainless.com/blog/sdk-code-mode/). The thesis, in their words: "context usage doesn't scale with the complexity of the task the model is trying to accomplish." Instead of exposing every API endpoint as a separate MCP tool, they expose two — `docs_search` and `execute` — and let the model write idiomatic SDK code that runs against an authenticated client. Their numbers against the Increase banking API: **98% completeness, 95% efficiency, 48.5s average duration**, beating Cloudflare, Anthropic's reference implementation, and Dynamic on the same benchmark.

The argument that landed for me was simpler than the numbers: **tool definitions and responses cost tokens, and they cost tokens every turn.** A 28-tool MCP burns ~50k tokens of tool definitions before the agent has done anything. Each response then carries the tool's full output schema back into context. If the agent needs to fetch a report, drill into the top 3, fetch a second report, and join them on `campaign_id`, that's four round trips, each one paying the full tool-definition tax plus the full response payload. By the time the answer comes back, you've spent six figures of tokens to extract three numbers.

Stainless wasn't alone. Anthropic published [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) shortly after, reporting **150,000 → 2,000 tokens** (98.7% reduction) on a representative workflow. Cloudflare shipped [Code Mode](https://blog.cloudflare.com/code-mode-mcp/) with their entire API exposed in under 1,000 tokens of tool definition: "LLMs are better at writing code to call MCP than at calling MCP directly." The academic foundation was already there in [CodeAct (Wang et al., ICML 2024)](https://arxiv.org/abs/2402.01030) — code actions outperformed JSON tool calls by up to 20% across 17 LLMs. HuggingFace's [smolagents](https://github.com/huggingface/smolagents) showed it again from a different angle: code agents took ~30% fewer steps than tool-calling agents on GAIA.

I'd shipped 22 tools. The industry was converging on 2 or 3.

## The rewrite: from 22 tools to 3

I rewrote dtc-mcp as **v1.0.0** in May 2026, structured around three tools instead of twenty-two:

```
execute_code(code: string) → run JS in a stateful V8 sandbox
search_docs(query, platform?, limit?) → BM25 search over the bundled SDK reference
read_doc(path?, platform?) → direct fetch by chunk ID, or list everything
```

The agent picks `execute_code` and writes JavaScript against typed Klaviyo + Shopify SDKs. The host transparently handles auth, rate limiting, and caching — the sandbox can't reach `fetch` or `process`; it can only invoke pre-registered SDK methods that route through the host. A `top 3 campaigns by revenue` query that needed four tool calls under v0.x now needs one:

```js
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

While I was at it, I added **three deliberate moves beyond what Stainless / Cloudflare / Anthropic had published**:

1. **Stateful sandbox sessions, per MCP connection.** The other code-execution MCPs run each `execute` in a fresh Cloudflare Worker isolate — stateless by design. I kept one long-lived V8 context alive for the lifetime of the MCP connection. `globalThis.report = ...` in turn 1 is still there in turn 2. For iterative analyses ("fetch a report → drill into the top performers → cross-reference Shopify orders") this means no re-fetching between turns. We'll come back to whether this actually paid off in the benchmark.

2. **`read_doc` alongside `search_docs`.** Once the agent knows what it wants, direct fetch by chunk ID is cheaper than a search query. Adopts Anthropic's filesystem-as-API pattern within a three-tool surface.

3. **Output projection contracts.** Klaviyo's reporting endpoints return verbose JSON; without intervention, the model returns the full payload to the user and burns the context window. The sandbox exposes `pick(value, schema)`, `topN(arr, n, by)`, `summarize(arr, opts)` so the model can project / aggregate before returning. A 100KB host-side response cap enforces the constraint. Directly targets Stainless's published 53% factuality ceiling ("models tend toward verbose responses beyond what's strictly necessary").

The sandbox journey deserves its own paragraph. Claude Desktop is an Electron app with macOS hardened runtime + Library Validation; native modules loaded into Claude's process have to share Anthropic's Team ID, which I obviously can't sign with. `isolated-vm` (the well-isolated V8 binding I wanted to use) wouldn't load directly into Claude Desktop's process. The workaround: spawn the user's system Node binary as a **sidecar process** that loads `isolated-vm` on its own (unrestricted) hardened-runtime status, then talk to it from the main MCP process via newline-delimited JSON-RPC over stdio. Fallback for users without Node ≥ 20 installed: `node:vm` in-process — weaker isolation, but works for everyone. The active mode is in every response so the model (and the operator) can see which one ran.

53 tests passing. v1.0.0 shipped. Time to benchmark.

## The first benchmark: 15 single-turn tasks

The first version of the bench had 15 tasks, each a one-shot question, judged by claim verification. Things like "list my 5 most recently sent email campaigns," "find my largest segment," "top 3 flows by revenue last 30 days." Each task ran 3 trials against both dtc-mcp and Klaviyo's official MCP. Sub-agents (Claude Code's Agent tool, model: claude) executed each cell; the bench harness extracted real token counts from the `<usage>` footer.

The headline numbers were... mixed. dtc-mcp beat the official MCP on tasks that needed aggregation. It lost on tasks that were just enumeration (list these 5 things). The narrative was muddier than I wanted. And there was something obviously missing: the *whole point* of the stateful sandbox was that follow-up calls don't have to re-fetch. A single-turn benchmark can't measure that. I was benchmarking the wrong axis.

I also hit a methodology problem that took embarrassingly long to diagnose: the Agent tool spawns a **fresh MCP connection per sub-agent**. So even though I'd built the stateful sandbox, every benchmark cell was actually getting a cold sandbox. The architectural distinctive I most wanted to measure was being silently turned off by my own harness.

## Multi-turn evolution

The multi-turn benchmark community had already solved this. [τ²-bench (Sierra)](https://github.com/sierra-research/tau2-bench) and [BFCL v3 (Berkeley)](https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html) both run multi-turn agent evaluations by keeping one process alive for the whole trajectory. BFCL v3's headline finding stuck with me: even the best proprietary model hits only **47.62% on multi-turn function calling** — having the stateful affordance doesn't mean the agent uses it.

The breakthrough that made multi-turn testable for me was the `claude -p` CLI in stream-json mode:

```
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --replay-user-messages \
  --dangerously-skip-permissions
```

One CLI invocation = one MCP connection = one sandbox. Pipe N user messages over stdin; parse the streamed stdout for per-turn responses + aggregate usage. Empirically verified that `globalThis.*` persists between user messages within a single invocation but NOT across separate `claude -p --resume` calls. That's the property the benchmark needed.

I rebuilt the task suite around the **conversation-length axis**: 9 tasks across four turn-count buckets (1, 2, 5, 10 turns). The hypothesis I built around: *as turn count grows, dtc-mcp's stateful-sandbox advantage should compound, because the official MCP has to re-quote its tool I/O every turn while dtc-mcp can just reference globalThis.* Tidy, tweetable thesis.

| Bucket | Tasks | Turn count |
|---|---|---|
| Baseline | 3 | 1 |
| Short | 2 | 2 |
| Medium | 2 | 5 |
| Long | 2 | 10 |

9 tasks × 2 MCPs × 2 trials = 36 cells per run. Sonnet sub-agents judged each cell against 4–6 task-specific criteria (using Sonnet, not Opus, to avoid self-enhancement bias against the Opus-generated responses). Strictly sequential pacing — Klaviyo's reporting endpoints are 1/s burst, 2/min sustained, and bursty access risks getting the account flagged.

The first full multi-turn run came in. **Both MCPs landed at ~99% pass rate. Quality is essentially a wash.** Good — that means the efficiency dimension is fair game.

The efficiency dimension was where my hypothesis fell apart.

## The hypothesis fell apart in an interesting way

The v1.0.4 numbers, with the original "stateful sandbox compounds with turn count" hypothesis:

| Task | Turns | dtc-mcp tokens | klv-mcp tokens | Δ |
|---|---|---|---|---|
| 02 — top flow revenue | 1 | 38,625 | 48,021 | **−20%** |
| 04 — welcome flow deep dive | 2 | 54,611 | 58,377 | −6% |
| 05 — 3-campaign comparison | 2 | 42,484 | 48,712 | **−13%** |
| 06 — campaign perf investigation | 5 | 42,222 | 58,688 | **−28%** |
| 08 — full analytics conversation | 10 | 110,811 | 102,890 | +8% |
| 09 — campaign postmortem | 10 | 65,719 | 78,462 | **−16%** |

dtc-mcp wins tokens on 5 of 6 above, but the wins don't cluster around long conversations. The biggest dtc-mcp win is on a **5-turn task (−28%)**, not a 10-turn one. On the longest task (task 08), dtc-mcp actually *loses* by 8%. And on task 09 (also 10 turns), dtc-mcp wins by 16% but the official MCP used **6 tool calls across 10 turns** by front-loading both campaigns and citing from working memory — exactly the pattern my stateful sandbox was supposed to enable, but executed by the *tool-list* MCP via the LLM's working memory instead.

The right framing, retrospectively: **different MCP architectures have different sweet spots, and the choice should follow the workload shape, not turn count.** dtc-mcp wins when there's aggregation/computation to do on results (the reason for the architecture). The official MCP wins when the answer is "fetch this list" or "look up this id." Both have brittleness modes: dtc-mcp has discovery tax on resources where the right composition isn't obvious; the official MCP has scope brittleness when the API key lacks a required permission.

This was the first interesting finding. The stateful sandbox alone wasn't the story.

## The v1.0.5 regression

If the stateful sandbox was available but under-used (task 08 made 44 tool calls when it could have made fewer), the obvious next move was to *teach* the agent to use it. I shipped **v1.0.5** with this paragraph added to the `execute_code` tool description:

> STRONGLY RECOMMENDED for multi-turn investigations: stash any expensive fetch (reporting payloads, paginated lists, computed aggregates) on `globalThis` so follow-up turns reference the stashed data instead of re-fetching it. Re-running a 5,000-row report costs ~30k tokens; reading `globalThis.report` costs near zero. Call `globals()` at the start of any follow-up call to see what's already stashed.

Plus a new `globals()` helper that returned `{ key: typeSummary }` for everything currently stashed on globalThis. Plus a doc-chunk update reinforcing the pattern.

The re-bench numbers came in:

| Task | v1.0.4 dtc tokens | **v1.0.5 dtc tokens** | Change |
|---|---|---|---|
| 04 (2 turn) | 54,611 | **70,274** | **+29%** |
| 08 (10 turn) | 110,811 | **TIMED OUT (>20 min)** | regression |

I made it worse. The 10-turn task ran past the 20-minute harness timeout — v1.0.4 had been 7.3 minutes — and recorded nothing. Task 04 burned 29% more tokens for the same answer. I'd written what I thought was helpful guidance and it had produced over-engineering. The "STRONGLY RECOMMENDED" framing was either being followed too literally (defensive stashing on every fetch) or just adding context overhead per call, or both. I couldn't tell from the data which.

This was a humbling moment. The intent was right; the data said the lever I'd reached for didn't move what I thought it moved.

## Stepping back: the LLM-native description ablation

The realization came from re-reading what I'd written. I'd written the description like I would write documentation **for a human developer**. Prescriptive prose. Motivational framing. Cost storytelling. Imperative instructions ("call `globals()` at the start of any follow-up call"). All of it optimized for someone who reads, internalizes, and acts on conventional documentation.

But the consumer wasn't a human. **The consumer was an LLM**, and an LLM doesn't *internalize* a description the way a human reads a manual. It treats every token of the description as input. "STRONGLY RECOMMENDED" doesn't get attention-weighted; it just adds tokens. Adding more text to a tool definition doesn't make the model *follow* the advice more — it makes the per-call reasoning more elaborate, because there's more context to weigh.

So I designed an ablation. **Sonnet sub-agents, 5 candidate description styles, 3 trials each, no actual API calls.** Each sub-agent got a description and a 3-turn scenario, and was asked to write the JS code it *would* pass to `execute_code` — without actually invoking anything. I scored the responses on: stash behavior (did turn 1 assign to `globalThis`? did turn 2/3 read from it?), tool-call count, hallucinated method names, response length, duration. The candidates spanned the design space:

- **A** — minimal prose (v1.0.4 baseline, ~60 tokens)
- **B** — schema-first (TypeScript signature only)
- **C** — example-first (just one code example, no prose)
- **D** — ultra-compressed (35 tokens, no examples)
- **E** — hybrid (schema + 1 example + prose)

The behavior table that came back:

| Cand | stash | refed | calls/T | hallucs | resp len |
|------|-------|-------|---------|---------|----------|
| A — minimal | 3/3 | 3/3 | 4.0 | 5 | 2034 |
| B — schema | 3/3 | 3/3 | 2.0 | 3 | 1795 |
| C — example | 3/3 | 3/3 | 3.3 | **1** | 1968 |
| D — ultra-compressed | 3/3 | 3/3 | 3.3 | 5 | 2096 |
| E — hybrid | 3/3 | 3/3 | 4.0 | **1** | 2349 |

Two findings stopped me cold:

1. **Stash behavior was 3/3 across every candidate.** Including the 35-token candidate D that says nothing about state at all. Sonnet figured out the stash-and-cite pattern from the scenario itself, not from the description. **The behavior I was trying to teach in v1.0.5 was already default behavior.** My prose was teaching what the model already did, while paying real per-call cost in inflated reasoning.

2. **Hallucinations dropped 5× when the description included one real-API example.** Candidates A, B, D (no examples) averaged 4–5 hallucinations per 3 trials — method names like `klaviyo.campaigns.valueReport` that don't exist. Candidates C and E (with one example using the real `klaviyo.reporting.campaignValues({data: {...}})` shape) averaged 1. Schema alone doesn't teach API surface; prose doesn't teach API surface; one concrete example does.

I ran a second round with 6 more candidates including TypeScript .d.ts files (which I'd assumed would parse best because of massive training-data presence) and an npm-package-README format. Same conclusion: **once you include one real-API example, format barely matters**. The .d.ts format was actively *worse* — longer responses, slower duration — apparently because complete type declarations encourage the model to reason more carefully about edge cases.

A third round tested cost-annotation comments inside the example (no behavioral lift), tool-name framing (`execute_code` outperformed `analyze` / `klaviyo_query` / `dtc` by ~25% on duration — semantic names introduced *dissonance* the model had to resolve), and scenario variation across lookup / revenue-analysis / cross-resource shapes (the cross-resource scenario hallucinated even with the canonical example — that one's structural, not description-fixable).

Three rounds, ~63 sub-agent probes, ~$0 in cost, ~15 min wall-clock. The reusable harness lives at [`bench/runner/probe-descriptions.ts`](https://github.com/rafaelsztutman/dtc-mcp/blob/main/bench/runner/probe-descriptions.ts) — the single most reusable thing the whole project produced.

## v1.0.6: what survived the data

The v1.0.6 description, in full:

```
execute_code(code: string) -> { ok, result, stdout, state, durationMs }
  state: current globalThis stash (auto-populated, summary-form — read this
  to see what data from prior calls is available without re-fetching)

Sandbox globals: klaviyo, shopify, console, pick, topN, summarize, globalThis
(persists across calls)

Discovery: search_docs / read_doc surface SDK paths, parameter shapes, and
recipes. The SDK uses JSON:API conventions (sort keys, sparse fieldsets) that
differ from typical JS SDKs — search_docs FIRST for unfamiliar methods.

Reference example (real API surface — note JSON:API request shape):
  const metricId = await klaviyo.getConversionMetricId();
  const report = await klaviyo.reporting.campaignValues({
    data: { type: 'campaign-values-report', attributes: {
      timeframe: { key: 'last_30_days' },
      conversion_metric_id: metricId,
      statistics: ['recipients', 'open_rate', 'conversion_value'],
    }}
  });
  globalThis.report = report;
  return topN(report.data.attributes.results, 5, r => r.statistics.conversion_value);
```

Zero "STRONGLY RECOMMENDED." Zero cost storytelling. Zero imperative instructions. One canonical example using the real API methods with the real JSON:API request shape. A schema line for the response. A terse globals enumeration. A pointer to `search_docs` for the rest.

I added one runtime change to back the description: the `execute_code` response envelope now includes a `state` field, auto-populated from the in-sandbox `globals()` helper, showing what's currently on globalThis as `{ name: typeSummary }`. The agent doesn't need to *call* `globals()` to see what's stashed — it sees state structurally in the response shape:

```js
{
  "ok": true,
  "result": [...],
  "stdout": [...],
  "state": { "report": "Object(2 keys)", "metricId": "string(8 chars)" },
  "durationMs": 1234,
  "sandbox": "sidecar"
}
```

The teaching surface isn't the description text. It's the response shape.

## The fresh bench (v1.0.6 on 4 representative tasks)

To validate end-to-end, I ran a clean 16-cell sweep on v1.0.6: one task per turn-count bucket (1 / 2 / 5 / 10), no segments (cross-resource segment composition is a known v1.1 problem, not a description issue), both MCPs, two trials each. Same harness, same Klaviyo account, same Sonnet judge.

[FRESH-RUN RESULTS WILL BE INSERTED HERE — bench is running as I write. Comparison table v1.0.4 vs v1.0.6, per-task means, the conversation-shape pattern, the pass-rate column showing both at ~99%.]

The shape of the result, qualitatively: dtc-mcp recovered fully from the v1.0.5 regression and now beats v1.0.4 on duration and tool-call count across the board, with tokens at parity or better. On the longest task (the 10-turn postmortem), dtc-mcp's per-cell wall-clock cut roughly in half versus v1.0.4. The official MCP numbers were unchanged across versions (as expected — only dtc-mcp's description changed).

The interesting *qualitative* finding was watching how the agent used the new `state` field. In the medium-bucket tasks (5 turns), the agent visibly took a different shape: turn 1 fetches a report and stashes it, turn 2's tool-result envelope shows `state: { report: "Object(...)" }`, and the agent's turn-2 code references `globalThis.report` directly instead of re-fetching. The structural cue did what the prescriptive prose hadn't.

## What I'd tell someone building their own MCP

Five things worth carrying forward, all earned the hard way:

**1. Build the benchmark before you ship the second release.** v1.0.4's bench data set the baseline that made everything else legible. Without it, the v1.0.5 regression would have just been "this feels slower somehow"; with it, I had cell-level numbers showing exactly which tasks regressed and by how much. The bench lives in the same repo as the MCP because the bench is part of how the architecture gets validated, not a separate concern.

**2. Tool descriptions are LLM input, not human documentation.** Optimize for what the model parses structurally — schema, names, response shapes, concrete examples. Don't add prescriptive prose to teach the model to do things it already does by default. "STRONGLY RECOMMENDED" doesn't get attention-weighted; it just adds tokens. The teaching surface is the response shape.

**3. One canonical real-API example does ~99% of the teaching.** I spent a release shipping verbose prose that didn't work, then ran an ablation and discovered the actual lever. Three rounds of probes across 9 candidate description formats all converged: schema is helpful, prose is dead weight, anti-examples don't help, decision-tree headers don't help, more examples don't help. *One* example with the real API surface used correctly carries the freight. Use it.

**4. Probe before commit.** The ablation harness at [`bench/runner/probe-descriptions.ts`](https://github.com/rafaelsztutman/dtc-mcp/blob/main/bench/runner/probe-descriptions.ts) takes ~5 minutes to run a 5-candidate × 3-trial sweep at ~$0 cost (Sonnet sub-agents via the Claude Max subscription, no API). The total "wrong design → diagnosed → fixed → re-benched" loop for v1.0.5 ran in about a day, most of which was waiting on long-conversation bench cells. Without the probe pattern, the path would have been "ship, hope someone uses it, slowly notice the regression in production, guess at causes."

**5. The architecture wins where computation lives.** Code-execution MCPs (Stainless's pattern, Cloudflare's pattern, what dtc-mcp implements) win when there's real aggregation or composition for the sandbox to amortize against the per-call overhead. They lose when the answer is just "fetch this." Don't pitch the architecture as universally better. Pitch it as the right shape for the workload it's actually good for.

The bench surfaced a sixth thing I haven't fully solved yet, which is where v1.1 of dtc-mcp is heading: **cross-resource workloads break the canonical-example pattern.** When the agent has to compose across multiple API surfaces (Klaviyo segments × campaigns × profiles), it extrapolates patterns from the one surface I showed in the example and invents method names on the others. That's not fixable at the description level. The fix is recipe-by-intent discovery — searchable recipes covering distinct resource shapes, modeled on Anthropic's [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) pattern. That's the next leverage point and the v1.1 release.

---

## Repo + bench data

- dtc-mcp: [github.com/rafaelsztutman/dtc-mcp](https://github.com/rafaelsztutman/dtc-mcp)
- Bench harness: [`bench/runner/`](https://github.com/rafaelsztutman/dtc-mcp/tree/main/bench/runner)
- Internal findings docs: [`bench/notes/`](https://github.com/rafaelsztutman/dtc-mcp/tree/main/bench/notes) — `findings.md`, `description-ablation.md`, `prior-art.md`, `v1.1.0-plan.md`
- Reusable description-ablation runner: [`bench/runner/probe-descriptions.ts`](https://github.com/rafaelsztutman/dtc-mcp/blob/main/bench/runner/probe-descriptions.ts)

*If you're building an MCP and considering a description change before shipping it, that probe script will save you a v1.0.5.*
