# dtc-mcp v1.0.4 benchmark — internal findings

**Status:** internal working doc, not for public distribution yet. Source of truth for the architecture revisit that this benchmark prompted. Updated alongside `bench/results/<runId>/state.json`; treat the file as the polished interpretation of that raw data.

**Run reference:** `bench/results/2026-05-25_13-57-02/` (36 cells, both MCPs, 2 trials each, fully judged).

---

## The bench in one paragraph

We ran 9 analytics tasks across the conversation-length axis (1 / 2 / 5 / 10 turns), 2 trials per cell, against `dtc-mcp v1.0.4` and Klaviyo's official MCP back-to-back. Every cell was driven by one `claude -p --input-format stream-json` invocation — one MCP transport per cell, so dtc-mcp's per-connection sandbox state persists across all turns. Sonnet judged each response against 4–6 natural-language criteria per task; both MCPs ended at ~99% pass rate (dtc 0.990, klv 0.983), so quality is essentially a wash. The interesting story is in the efficiency dimension. **dtc-mcp wins tokens on 7/9 tasks**; **klv wins wall-clock duration on 6/9 tasks**. The original hypothesis ("MCPs aren't optimized for long conversations, dtc-mcp's stateful sandbox should compound its advantage with turn count") is **wrong as stated** — turn count isn't the binding axis. The real axes are **information-reuse pattern** and **how much aggregation lives on the model's side vs the tool's side**.

---

## Seven lessons about how Opus uses MCPs

Each lesson is grounded in specific cells from the run. Cell IDs are receipts; if a claim doesn't trace to a cell, it doesn't belong here.

### 1. Per-call payload size dominates tool-call count

**Evidence.** Task 08 klv: 25.5 calls / 102,890 tokens. Task 09 klv: 6.5 calls / 78,462 tokens. Call count fell 4×; tokens only fell 24%. Each call carries the tool-definition bytes regardless of how much *useful* response payload comes back.

**Implication.** "Reduce tool calls" is the wrong metric to optimize for. **Tokens per useful insight** is the right metric. An MCP can be "wasteful" while making few calls (verbose tool descriptions, redundant include patterns in responses) or "frugal" while making many (tight tool definitions, scoped includes). The bench's `usage.totalTokens` is the honest number; `usage.toolUses` is a noisy proxy.

### 2. Cross-turn working memory is a primary efficiency lever — but it has to be *used*, not just *available*

**Evidence.** Task 09 klv: front-loaded both campaigns' full details in turn 1, then answered turns 2–10 by citing from context (6.5 calls for 10 turns). Task 08 dtc: kept reaching back to the sandbox for each new question (44.5 calls for 10 turns) — even though dtc-mcp's globalThis was *available* to stash results across turns. The agent didn't leverage it.

**Implication.** State being available isn't enough. The agent has to discover and adopt the "stash once, reference forever" pattern. Right now the `execute_code` tool description doesn't explicitly mention that returned data persists across calls in the same conversation. The agent has to infer it. **The docs and tool descriptions need to teach the pattern.**

### 3. Code-as-tool has a fixed cost that doesn't pay off below a complexity threshold

**Evidence.** Task 01 (plain enumeration of 5 campaigns): dtc 57,319 tokens vs klv 35,671 tokens (**dtc +61%**). No aggregation work for the sandbox to amortize against. TS transpile + sandbox-bridge round-trip + code-as-prose in the assistant turn are all real, fixed costs.

**Implication.** The "one tool to rule them all" thesis is wrong at the simple end. **A pure code-execution MCP wastes tokens on trivial reads.** Two possible directions:
- (a) Reduce the per-call overhead of `execute_code` (faster transpile, leaner output protocol, etc.) so the floor cost is closer to a hand-built tool's floor cost. Preserves the philosophy.
- (b) Expose 2–3 thin hand-built tools (e.g., `klaviyo.campaigns.list`, `klaviyo.flows.list`) alongside `execute_code`. Agent picks the right granularity per query. Partial reversal of the v1.0 philosophy; explicitly trades architectural purity for ergonomics on the high-volume simple-read path.

### 4. Flexibility wins on edge cases; ergonomics wins on common cases

**Evidence.** Pre-API-scope-fix on task 03: klv-mcp's `get_segments` unconditionally requested the `tags` relationship → failed entirely without `tags:read` scope on the key. dtc's `execute_code` constructed exactly the request needed and answered correctly. **But** dtc had to *rediscover* the segment-`profile_count` workaround (additional-fields query param) each run, burning 200–500s of wall-clock and ~50k tokens of exploration (tasks 03, 07, 08). klv's hand-built `get_segment` returns `profile_count` natively — when scopes are present, klv just works.

**Implication.** Raw flexibility has a discovery tax. **The MCP needs to make the common-case path obvious AND keep the escape hatch open.** Possible directions:
- Method aliases for common compositions (`klaviyo.segments.listWithCounts({...})` that bakes in the additional-fields workaround).
- Intent-indexed docs (recipes searchable by "list largest segments" rather than keyword match against API names).
- Both — they're complementary, not alternatives.

### 5. Docs are the primary teaching surface for flexible MCPs

**Evidence.** The segments-`profile_count` workaround **exists in our docs** (was added in v1.0.4 as part of the top-flows recipe). The agent still didn't surface it reliably in tasks 03, 07, 08 — it had to rediscover by trial and error. Indicates the discovery mechanism isn't matching agent intent to recipes effectively.

**Implication.** API-reference style docs aren't enough for a code-execution MCP. **We need recipe-by-intent discovery**, plus probably an inline nudge in `execute_code`'s response when a recipe matches the request's keywords. The current `search_docs` requires the agent to know what to search for; the gap is "agent doesn't know what it doesn't know."

### 6. API revision pinning is an architecture decision with efficiency consequences

**Evidence.** dtc-mcp pins Klaviyo revision `2026-01-15`, which doesn't expose `profile_count` directly on the segments resource — that's why the additional-fields workaround is needed. klaviyo-mcp pins a different (later?) revision that returns `profile_count` natively. Task 08 dtc trial-1 explicitly hit this: *"The MCP's pinned Klaviyo revision (2026-01-15) doesn't return the profile_count field."*

**Implication.** Revision choice is a real architectural decision with measurable cost downstream. **Two requirements:**
- (a) Document the pinned revision explicitly, including what it does and doesn't expose, so callers can plan around it.
- (b) Allow per-call override (`apiRevision` option on the SDK call) so the agent can opt into newer revisions when an older pin is the bottleneck. This keeps the default stable while leaving an escape hatch.

### 7. Conversation shape matters more than turn count

**Evidence.** Both task 08 and task 09 are 10-turn long-conversation tasks. Costs diverged sharply:

| | Task 08 (branching analytics) | Task 09 (focused postmortem) |
|---|---|---|
| dtc tokens | 110,811 | 65,719 |
| klv tokens | 102,890 | 78,462 |

Task 09 has a linear arc — two campaigns picked early, all follow-ups reference them. Task 08 branches across resources (campaigns → flows → segments → overlap) with new lookups per turn. **Same turn count, ~2× cost difference.**

**Implication.** The dichotomy isn't "short vs long" — it's "linear-with-context" vs "branching-with-new-data". An MCP should support both well:
- **Linear:** stash early data, cite from context. dtc's sandbox is ideal *if the agent uses it*; otherwise klv's working-memory pattern wins.
- **Branching:** new data per turn is unavoidable; the efficient path is to make each new fetch as cheap as possible (small tool definitions, scoped includes).

The agent should *choose* which pattern to use based on the question shape. Right now the choice is implicit and inconsistent.

---

## Principles for MCP design (generalizable, not Klaviyo-specific)

Distilled from the seven lessons. These should hold for any future dtc-mcp expansion (Shopify, others) and inform any MCP we build downstream.

**P1. Optimize for tokens per insight, not tool-call count.** Per-call payload is the dominant factor. Trim tool definitions ruthlessly; scope response includes; don't echo what the agent already has.

**P2. State must be discoverable, not just available.** A stateful surface only pays off if the agent knows to use it. The first place to teach: the tool's own description. Second place: docs surfaced reactively when the pattern would help.

**P3. Common cases need ergonomic defaults; edge cases need escape hatches.** A flexible API surface with no opinionated defaults pays a discovery tax on every common path. Hand-built tools optimize the common case but fail entirely on edges (scope variance, API revision drift). The synthesis: opinionated defaults *with* a parameterized escape hatch.

**P4. Docs are not reference; they are teaching infrastructure.** For code-execution MCPs especially, the docs *are* the surface the agent reasons over. Recipe-by-intent beats API-name-by-keyword for discovery. Inline nudges (from `execute_code` responses) probably matter more than static docs the agent might or might not search.

**P5. Architectural decisions like API revision pinning have measurable cost — document the tradeoff and provide overrides.** Implicit choices made for stability become invisible taxes on agent performance. Make them explicit and overridable.

**P6. Optimize for conversation shape, not conversation length.** Build for both linear-with-context (front-load + cite) and branching-with-new-data (cheap per-turn fetches) patterns. Don't assume one is the default.

**P7. The model's "I'll figure it out" loop is expensive.** When the agent has to rediscover a workaround on each run (segments-`profile_count` is the canonical example here), the MCP is failing. Every exploration loop is a docs / ergonomics bug, not an agent bug.

---

## What this means for dtc-mcp (prioritized backlog)

Ordered by leverage × effort. Each item maps to one or more of P1–P7 above.

| # | Direction | Maps to | Effort | Leverage |
|---|---|---|---|---|
| 1 | Add inline "stash across turns" guidance to `execute_code` tool description; add a `globals()` helper that lists stashed keys+types | P2, P7 | Small | High — likely flips task 08 / similar branching cases |
| 2 | Audit `execute_code` tool description for verbosity; trim docs index entries for the 3 exposed tools | P1 | Small | Medium — chips at the +61% gap on task 01 |
| 3 | Build recipe-by-intent discovery (verb-first index, surface inline when keywords match request) | P4, P5, P7 | Medium | High — addresses the discovery tax on segments, would generalize to Shopify |
| 4 | Document the pinned Klaviyo API revision + add per-call `apiRevision` override | P5 | Small | Medium — specific to Klaviyo today, but the *pattern* is the generalizable thing |
| 5 | Add 8–12 high-quality recipes covering the patterns the bench surfaced as expensive (segments aggregation, multi-resource synthesis, front-load-and-cite pattern) | P4 | Medium | High — direct mitigation of #5 / #7 |
| 6 | Investigate per-call overhead of `execute_code` (TS transpile cost, sandbox bridge round-trip, output protocol size) | P1, P3 | Medium | Medium — could narrow the task 01 gap structurally |
| 7 | Decide on the "one tool" philosophy: keep pure (and rely on #1+#3 above) OR expose 2–3 thin enumeration tools alongside `execute_code` | P3 | Large (philosophy + impl + docs) | Conditional — only if #1+#3 don't close the simple-read gap |

**Order I'd recommend:** 1 → 4 → 3 → 5, then re-bench and decide 6 and 7 based on the delta.

---

## What we deliberately won't do

Things that look like fixes but would over-tune dtc-mcp for the bench and bake in fragility.

- **❌ Adding `getLargestSegment` as a dedicated method.** Solves task 03 specifically; doesn't generalize. The right fix is recipe-by-intent (#3) and aliases that compose cleanly (`segments.listWithCounts` is one of many possible aliases, not a one-off).
- **❌ Hardcoding the "always include profile_count" behavior.** That would over-spec the resource for all callers, costing tokens on queries that don't need counts.
- **❌ Replacing Klaviyo's pinned revision wholesale.** The pin exists for stability reasons; the right answer is overridability (#4), not unilateral upgrade.
- **❌ Spawning a sub-agent per `execute_code` call to "pre-plan" the query.** Tempting fix for the discovery tax but doubles inference cost on every call. The model is already the planning agent; we should teach it better, not add a second one.
- **❌ Optimizing for a single benchmark task family (Klaviyo analytics).** The bench is a probe of architectural fitness, not a target. If a "fix" only helps Klaviyo-specific cells, it's the wrong fix.

---

## v1.0.6 reset (added 2026-05-25 post-publish)

**v1.0.5 was reverted. v1.0.6 replaces it.** Sequence of events:

1. v1.0.5 shipped with a "STRONGLY RECOMMENDED" prescriptive paragraph in the `execute_code` tool description. Predicted to reduce dtc-mcp tokens on multi-turn tasks by teaching the stash-and-cite pattern.
2. v1.0.5 re-bench started. **Task 04 dtc trial-1 jumped from 49k tokens (v1.0.4) to 93k (v1.0.5).** Task 08 timed out at 20 min wall-clock (vs 7.3 min on v1.0.4).
3. Suspected the prescriptive description was inducing over-engineering. User insight: "you're an LLM consuming this; we keep articulating tools that are easier for humans to understand, but the LLM has different needs."
4. **Ran an ablation experiment** (`bench/notes/description-ablation.md`): 5 candidate description styles × 3 Sonnet sub-agent trials each, scenario chosen to exercise stash behavior, NO Klaviyo API calls. Pure description-effects measurement.
5. **Three findings shifted the architecture:**
   - **Stash behavior is description-independent.** Every candidate scored 3/3 on both stashing in turn 1 AND referencing from stash in turn 2/3, including the ultra-compressed 35-token candidate. Sonnet figures out the pattern from the scenario, not the description. v1.0.5's prose was teaching behavior the model already had.
   - **One concrete real-API example is the single most effective teaching surface.** Candidates with an example hallucinated 1/3 trials; candidates without examples hallucinated 5/3. 5× difference from one example.
   - **Prescriptive language has zero behavioral lift and real token cost.** Adding "STRONGLY RECOMMENDED" doesn't change attention weighting — it just adds context.
6. **Designed candidate F** (schema + one canonical real-API example + globals listing, no prose). Re-ran the ablation including F. **F scored 0 hallucinations across 3 trials, 3/3 on stash behavior, 2113 chars response length.** Best-of-class.
7. v1.0.6 ships F as the new `execute_code` description, adds a `state` field to the response envelope (auto-populated from `globals()`, so the agent can see what's stashed without an explicit call), reverts v1.0.5's prose additions completely.

**Specific changes — see commit `<TBD>`:**

- `src/tools/execute_code.ts` — description fully replaced with the F shape. No "STRONGLY RECOMMENDED", no cost framing in prose, no imperative instructions. One canonical example using the real `klaviyo.reporting.campaignValues` API surface and the real `klaviyo.getConversionMetricId()` method — those two corrections in the example were where most v1.0.5 hallucinations came from.
- `src/sandbox/runner.ts` + `vm-runner.ts` + `sidecar-runner.ts` + `sidecar/index.ts` + `protocol.ts` — `state: Record<string, string>` flows from the sandbox through the runner to the tool response. The wrapper script calls `globals()` post-execution and includes the result alongside `result`/`stdout`.
- `bench/notes/description-ablation.md` — full writeup of the experiment, including the runner (`bench/runner/probe-descriptions.ts`) so future tool-design decisions can use the same probe methodology.
- `bench/notes/v1.0.4-baseline-04-08.json` — preserved.

**The cross-cutting lesson** (Lesson 8 — adding to the list above):
> **Tool descriptions are LLM input, not human documentation.** Optimize for what the model parses structurally (schema, names, response shapes, concrete examples), not for what a human reader finds helpful (prescriptive guidance, motivational framing, cost storytelling). Validate description changes via sub-agent ablation BEFORE shipping — the cost is ~5 min and prevents a v1.0.5-style regression.

**Re-bench scope (unchanged from v1.0.5 plan):** same 8 cells from tasks 04 + 08. Already reset in `state.json`. v1.0.4 baseline still in `bench/notes/v1.0.4-baseline-04-08.json`. Run after Claude Max quota refreshes.

**Falsification criteria for v1.0.6:**
- If task 04 dtc tokens come in BELOW v1.0.5 (which was 70k mean): v1.0.6 fixed the regression.
- If task 08 dtc completes within 10 min wall-clock and tokens drop toward klv parity (~103k): v1.0.6 delivered the original v1.0.5 goal.
- If task 04 dtc tokens AT v1.0.4 levels (~55k) and task 08 dtc at ~110k: v1.0.6 = parity recovery. Defensible: we removed a regression and learned a transferable lesson.
- If task 08 STILL exceeds 10 min: the description isn't the bottleneck; problem is somewhere else (sandbox per-call overhead, Klaviyo throttling at scale).

---

## v1.0.5 status (added 2026-05-25 post-publish)

**Shipped.** v1.0.5 published to npm on 2026-05-25, addresses backlog item #1 (stash-and-cite ergonomics).

Specific changes — see commit `e3f3551`:

- New `globals()` helper in the sandbox returns `{ name: summary }` for everything stashed on `globalThis` (filters out built-ins via a baseline captured at module-load in an IIFE closure).
- `execute_code` tool description strengthened: explicit STRONGLY RECOMMENDED paragraph on stashing expensive fetches, concrete cost framing ("re-fetching a 5k-row report costs ~30k tokens; reading globalThis costs nearly nothing"), `globals()` listed in the available-globals enumeration.
- `guide.stateful-sessions` doc chunk gets a new "Discovering what's stashed: use globals()" section so search hits surface the introspection pattern alongside the basics.
- 3 new tests in `tests/output-discipline.test.ts`, all 62 pass.

**Re-bench scope.** 8 cells from tasks 04 + 08 (the two tasks where v1.0.4 dtc lost or held the same on tokens despite the conversation favoring sandbox state). Tasks 03 + 07 are deliberately excluded — they're segment-discovery-bound, a separate v1.1.0 fix; a v1.0.5 re-run wouldn't isolate the stash-and-cite delta cleanly.

**v1.0.4 baseline preserved** at `bench/notes/v1.0.4-baseline-04-08.json` so we can compare directly. The 8 cells in the live `state.json` are reset to pending; re-run + re-judge after Claude Max quota refreshes.

**What we expect to see if v1.0.5 worked:**
- Task 08 dtc tokens: from 110,811 mean → some reduction (target: parity or better with klv's 102,890). Mechanism: agent stashes account-health snapshot in turn 1, references it across the segment-overlap and revenue-comparison turns instead of re-querying.
- Task 04 dtc trial variance: from (49k, 60k) → tighter. Mechanism: stash the welcome-flow report in turn 1, reuse for the comparison in turn 2 instead of recomputing.
- klv numbers: should be ~unchanged. v1.0.5 only affects dtc-mcp's tool description and sandbox helpers.

**What would falsify the v1.0.5 fix:**
- Dtc tokens stay flat or rise. Means the description nudge wasn't enough; need stronger interventions (response-side hints, agent-side fine-tuning prompts in the bench preamble, etc.).
- Tool-call counts stay flat. Means agent isn't reaching for `globals()`; the helper isn't being discovered even with the description mention.

**v1.1.0 plan drafted at `v1.1.0-plan.md`** — recipe-by-intent discovery (bundles backlog #3 + #5). Move to that after v1.0.5 delta is in hand and we know how much of the remaining gap is attributable to discovery vs other factors.

---

## Open questions for planning

1. **#1 (stash guidance) is cheap and high-leverage** — should we ship it as v1.0.5 by itself to validate the lift before tackling the rest?
2. **#7 (philosophy decision)** — when do we trigger this decision? Probably after #1, #3, #5 are in and we re-bench. If task 01 still shows +30% or more gap, it's time. If it closes to within 10%, the pure-code philosophy is defensible.
3. **How much of this should become external content?** The seven lessons could be a blog post directly. The architectural backlog should stay internal until shipped. The bench results themselves are committable once we agree on the redaction (campaign names appear in some responses).
