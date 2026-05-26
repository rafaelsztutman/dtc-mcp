# Building dtc-mcp: what a real benchmark taught me about MCP design

> **Status:** draft. Not yet published anywhere. The numbers and findings are real (from `bench/results/2026-05-25_13-57-02/`); the prose is a rough first pass to be polished before posting.

Most MCP servers look the same: a vendor publishes one tool per API endpoint, and the LLM picks from a list of dozens. It works for simple lookups. It falls apart when the agent has to *compose* — pull a report, aggregate it, drill in, compare across resources. The agent ends up streaming every row of every response into context just to sort and filter them in working memory, paying for the same data three or four times across a conversation.

`dtc-mcp` started as a hypothesis that code-execution MCPs scale better through this exact gap: one `execute_code` tool, a typed SDK exposed inside a stateful V8 sandbox, and the model writes a few lines of JS that does the aggregation in-sandbox and returns just the answer. Anthropic published [almost the same thesis](https://www.anthropic.com/engineering/code-execution-with-mcp) six months after I started building, with their own numbers (150,000 → 2,000 tokens on a representative workflow; ~60% latency reduction). Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode-mcp/) shipped the production version at hyperscale around the same time, exposing their entire API in under 1,000 tokens of tool definition. The thesis is now mainstream. What I had — and they didn't publish — was a head-to-head comparison against an actual vendor MCP (Klaviyo's official) on a real account, judged by LLM-as-judge, with all the messy reality intact.

This post is what that benchmark taught me. Not a marketing piece for `dtc-mcp` — most of the lessons are about MCP design generally, and three of the seven were things I had wrong when I started.

## The benchmark, briefly

Nine analytics tasks. Each one a natural-language question a Klaviyo analyst would actually ask ("which of my live flows generated the most attributed revenue in the last 30 days?", "compare these three campaigns and tell me which performed best and why"). Conversations spanned 1, 2, 5, and 10 turns — explicitly designed to test whether the gap between architectures widens with conversation length (the original hypothesis I built around). Two MCPs head-to-head: `dtc-mcp` (the code-execution one) and Klaviyo's official MCP (28 hand-built tools). Two trials per cell, run sequentially against a live Klaviyo account with strict pacing to keep below the 2/min reporting throttle. Sonnet sub-agents graded each response against 4–6 task-specific criteria. The grader judged the *response*, not the implementation — so an MCP that got to the right answer with a contorted approach still passed.

Both MCPs landed at ~99% pass rate. Quality is essentially a wash. The interesting story is in the efficiency dimension.

## Lesson 1: the original hypothesis was wrong

The bench was designed around "as conversation length grows, dtc-mcp's stateful sandbox should compound its advantage." This is a clean, tweetable thesis. **The data doesn't support it.** The actual axes that drive the gap are *information-reuse pattern* and *how much aggregation lives on the model's side vs the tool's side*.

The shape: dtc-mcp wins tokens on 7 of 9 tasks. But the wins cluster around tasks where the agent has to compute something from a fetched result (campaigns-by-revenue, flow comparisons, campaign postmortems), not specifically around long conversations. The single biggest win came on a 5-turn campaign-performance task (−28% tokens vs the official MCP) — bigger than either of the 10-turn tasks. And on a focused 10-turn postmortem, the official MCP used **6 tool calls across 10 turns** by fetching both campaigns once and citing from working memory across all 9 follow-ups; `dtc-mcp` used 21 calls because the agent kept reaching back to the sandbox for each new question. dtc still won that one on tokens (−16%) — but klv won on wall-clock by 34%, and the call-count gap suggests the *strategy difference* mattered more than the architecture difference. Same model, same conversation length, dramatically different costs depending on whether the question chain was "linear with context" or "branching with new data."

The better framing isn't "MCPs aren't optimized for long conversations." It's: **different MCP architectures have different sweet spots; the choice should follow the workload shape, not vendor preference.** Tool-list MCPs win on simple enumeration and front-loadable conversations. Code-execution MCPs win on aggregation and compute-bound work. Both have specific brittleness modes — code MCPs depend on docs to surface useful workarounds; tool MCPs depend on the underlying API being scope-accessible to the user's key.

This is a less marketable thesis than the original. It's also the one the data actually supports.

## Lesson 2: the agent already knows things you might think you need to teach it

I shipped a v1.0.5 release with this paragraph in the `execute_code` tool description:

> STRONGLY RECOMMENDED for multi-turn investigations: stash any expensive fetch (reporting payloads, paginated lists, computed aggregates) on globalThis so follow-up turns reference the stashed data instead of re-fetching it. Re-running a 5,000-row report costs ~30k tokens; reading globalThis.report costs near zero. Call `globals()` at the start of any follow-up call to see what's already stashed.

This was supposed to teach the model the stash-and-cite pattern that the v1.0.4 bench showed it under-using. The v1.0.5 re-bench numbers came in: tokens on a 2-turn welcome-flow task went from 49k to 93k. A 10-turn analytics conversation timed out at 20+ minutes (vs 7.3 min on v1.0.4). The regression was real and significant.

I ran a Sonnet sub-agent ablation to diagnose. Five candidate description styles — verbose prescriptive prose, minimal English, schema-first TypeScript signature, ultra-compressed (35 tokens), a hybrid with examples and prose — given the same 3-turn revenue-analysis scenario, no real API access. Each candidate got 3 sub-agent trials. **All five candidates scored 3/3 on stashing in turn 1 AND 3/3 on referencing the stash in turns 2/3.** Including the 35-token ultra-compressed one that says nothing about state. The model figures out the pattern from the *scenario*, not the description. My prescriptive prose was teaching default behavior; the bytes just inflated per-call reasoning overhead.

This was a humbling result. The intent was right — the gap on multi-turn tasks was real — but the lever I reached for didn't move what I thought it moved. v1.0.6 stripped the prescriptive paragraph entirely and added a `state` field to the response envelope instead (auto-populated from the sandbox, so the agent sees the current stash structurally without being told to look). The re-bench: the regression resolved. Tokens recovered to v1.0.4 levels, wall-clock got *better* than v1.0.4 by ~50% on the 2-turn task. The structural cue worked; the prose didn't.

The transferable lesson, and one I think generalizes well beyond `dtc-mcp`: **tool descriptions are LLM input, not human documentation.** Optimize for what the model can parse structurally — schema, names, response shapes, concrete examples — not for what a human reader finds helpful (prescriptive guidance, motivational framing, cost storytelling). "STRONGLY RECOMMENDED" doesn't get specially weighted by attention; it just adds tokens. The teaching surface isn't the description text. It's the response shape.

## Lesson 3: one canonical example does ~99% of the teaching

After v1.0.5 backfired, I designed a second-round ablation. Six candidate description formats including the v1.0.6 design plus four radically different ones: a TypeScript `.d.ts` file (which has astronomical training-data presence — I assumed the model would parse it most efficiently), an npm package README (the most familiar packaging format on the planet), a four-example variant (more coverage), an anti-example variant ("DON'T write `klaviyo.campaigns.report({...})`; DO write `klaviyo.reporting.campaignValues({data: {type, attributes}})`"). Plus a third round that varied the scenario, added inline cost annotations, and tested whether renaming the tool itself changed agent behavior.

The pattern that emerged across ~63 sub-agent probes: **once you include one concrete example using the real API methods with the right request shape, hallucinations drop 5× and the call pattern stabilizes.** Format past that is marginal. The schema-first TypeScript signature, the npm README, the multi-example variant, and the v1.0.6 control all produced essentially equivalent agent behavior — same call counts, same hallucination rates, same correctness. Two findings I genuinely didn't expect:

- **More examples didn't help.** A version with four examples covering different workloads performed equivalently to one with a single canonical example. The first example does the teaching; the second through fourth pay tokens for no measurable lift. There's a diminishing-returns curve and it flattens hard at one.
- **Full TypeScript type declarations were *worse* than minimal descriptions.** The `.d.ts` candidate had the longest responses, slowest duration (~25% slower than the npm README), and more tool calls. Complete type systems seem to encourage the model to reason more carefully about edge cases, which costs tokens. The right level of abstraction for an LLM tool description is "here's one example showing the real API" — not "here's the precise type system."

The corollary, also surprising: **renaming `execute_code` to something more semantically loaded (`analyze`, `klaviyo_query`, `dtc`) made the agent slower.** The literal name `execute_code` is what the agent expects given it's writing and executing JavaScript; alternative names introduce dissonance that requires extra reasoning to resolve. Semantic priming exists, but in this case it cuts against you.

## Lesson 4: cross-resource composition is intrinsically harder than the description can fix

The probes also surfaced where description-level optimization stops working. On a cross-resource scenario ("what's my largest active segment, and how many recent campaigns targeted it most?"), every candidate description — including the v1.0.6 one with the canonical example — produced 2–4 hallucinations across 3 trials. The agent invented method names like `klaviyo.getCampaigns` and `klaviyo.getSegments`, flat-namespace patterns that don't exist in the SDK. These hallucinations are *generalized* from the canonical example: the description shows one API surface (the reporting endpoints), and the agent extrapolates the patterns to other surfaces (campaigns, segments) and sometimes gets them wrong.

This isn't fixable at the description layer. The fix is making the *right composition* discoverable per-intent — recipes searchable by what the agent wants to do, not by keyword match against API names. That's what Anthropic Agent Skills [productionizes](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills): a filesystem of recipes loaded on demand. It's the v1.1.0 direction for `dtc-mcp` and probably the right pattern for any code-execution MCP exposing more than ~5 resource types.

The bigger architectural take: **for a code-execution MCP, the discovery mechanism IS the product.** The agent has the language model and the sandbox; what it doesn't have is knowledge of which composition to reach for. Tool descriptions can carry one canonical example. Recipes carry the rest. The right surface for both is structural, not prescriptive — schemas with intents and concrete examples, not paragraphs explaining when to use what.

## A few process notes

The ablation methodology — Sonnet sub-agents probing candidate descriptions against a fixed scenario, ~5 minutes wall-clock per round, zero API cost — paid for itself fifteen times over. v1.0.5 shipped without it; I assumed my read of the prior art was enough to design a good description. The bench caught the regression in 8 cells; the ablation diagnosed it in 15 sub-agent calls; v1.0.6 was implementation. The total "wrong design → diagnosed → fixed → re-benched" loop ran in about a day, most of which was waiting on long-conversation bench cells. Without the probe pattern, the path would have been "ship v1.0.5, hope someone uses it, slowly notice the regression in production, guess at causes." The reusable harness lives in `bench/runner/probe-descriptions.ts` and is the single most reusable thing the project produced.

The other process note: **build the bench before you ship the second release.** The v1.0.4 bench data set the baseline that made everything else legible. Without it, the v1.0.5 regression would have just been "this feels slower somehow"; with it, I had cell-level numbers showing exactly which tasks regressed and by how much. Both `dtc-mcp` and its bench live in the same repo precisely because the bench is part of how the architecture gets validated, not a separate concern.

## What the bench told me, in one sentence

If you take one thing from this: **the architecture wins where computation lives; the description loses where prescription lives; the discovery surface is where the next leverage point lives.** Code-execution MCPs are the right shape for compute-bound work, but the model already knows how to compose with state — what it needs is reliable knowledge of *which* API surface to reach for, and that knowledge belongs in structured, intent-indexed recipes, not in tool-description prose.

I'll know if v1.1.0's recipes actually deliver on this when the next bench round runs. The bench itself is the only thing I've published that doesn't have a hypothesis attached.

---

*The full bench data, findings, and methodology are in [`bench/notes/`](https://github.com/rafaelsztutman/dtc-mcp/tree/main/bench/notes). The reusable description-ablation runner is at `bench/runner/probe-descriptions.ts`. If you're building an MCP and want to ablate a description change before shipping it, that script will save you a v1.0.5.*
