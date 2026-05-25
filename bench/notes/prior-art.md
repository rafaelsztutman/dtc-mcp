# Prior art and state-of-the-art around our bench findings

**Status:** internal companion to `findings.md`. Captures what's been published on each of our seven lessons so we don't reinvent solutions. Compiled 2026-05-25 via web search.

## TL;DR — the architectural validation

**Our `execute_code` design is now the industry-blessed direction, not an outlier.** Anthropic's own engineering blog (Nov 2025) and Cloudflare's "Code Mode" production launch both reframe MCP as a code target, citing the same problems we measured: per-call tool-definition overhead, context bloat, the fragility of large hand-built tool surfaces. We are early adopters of a pattern that's becoming canonical.

**Concrete numbers from prior work that match our experience:**
- Anthropic (Nov 2025): 150,000 → 2,000 tokens (98.7% reduction) by moving to code execution
- CodeAct paper (Wang et al., ICML 2024): **+20% success rate** for code actions vs JSON tool calls across 17 LLMs
- HuggingFace smolagents: **~30% fewer LLM steps** with `CodeAgent` vs `ToolCallingAgent`; 44.2% on GAIA vs ~7% for GPT-4-Turbo
- Cloudflare "Code Mode": entire Cloudflare API exposed in <1,000 tokens via `search` + `execute`

This is the existence proof for what we built. We should cite these everywhere we defend the architecture.

## What this changes about our seven lessons

| Our lesson | Prior art | What changes |
|---|---|---|
| 1. Per-call payload dominates | Anthropic prompt-caching docs; Solo.io progressive-disclosure benchmarks (85–100× reductions) | Lesson is correct and well-documented. Our single-tool design is uniquely cache-friendly (tool defs essentially never change) — we should measure this advantage explicitly. |
| 2. Cross-turn state has to be *used*, not just *available* | BFCL v3 (multi-turn pass rate ~47% best-in-class); τ²-bench pass@8 < 25% in retail | Lesson confirmed by published evals. The fix isn't "make state available" (already done) — it's "teach the agent to use it." Anthropic's tool-description writeup is the playbook. |
| 3. Code-as-tool has fixed cost below threshold | smolagents docs literally recommend `ToolCallingAgent` for "simple systems that don't require variable handling" | Validated; nobody else has published the crossover point. **Our +61% on task 01 may be the cleanest published instance of this.** |
| 4. Flexibility vs ergonomics tradeoff | Cloudflare's `search` + `execute` pattern; Anthropic's filesystem-of-tools (Skills) | Mainstream pattern. The synthesis exists — opinionated defaults inside a flexible surface. |
| 5. Docs as teaching surface | **Anthropic Agent Skills (Oct 2025)** — filesystem of recipes that load on demand | This is exactly our gap. Skills is the productionized answer. We should adopt the pattern. |
| 6. API revision pinning has efficiency cost | Gorilla / APIBench retriever-aware training; no direct prior art on revision pinning specifically | Mostly novel — the broader question (how do agents handle API drift) has work; the specific MCP-server-pinning angle is open. |
| 7. Conversation shape > turn count | AMA-Bench, Drift-Bench probe long-horizon but don't isolate branching | **Largely unstudied as a workload axis. Strong contribution opportunity if we publish.** |

## Top 5 references — read these first

1. **Anthropic, "Code execution with MCP: Building more efficient agents" (Nov 4, 2025)** — https://www.anthropic.com/engineering/code-execution-with-mcp
   The canonical statement of our architecture's thesis with Anthropic's own numbers. Filesystem-of-tools pattern = direct model for our docs surface.
2. **Cloudflare, "Code Mode" series** — https://blog.cloudflare.com/code-mode/ + https://blog.cloudflare.com/code-mode-mcp/
   Production validation at hyperscale. Two-tool design + V8 isolates = the SaaS version of what we built.
3. **BFCL v3 (Berkeley) + τ²-bench (Sierra)** — https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html + https://github.com/sierra-research/tau2-bench
   The empirical case for our lesson 2. Both benchmarks are runnable — we could literally run dtc-mcp through them.
4. **Anthropic, "Writing effective tools for AI agents"** — https://www.anthropic.com/engineering/writing-tools-for-agents
   Most concrete playbook for lessons 1, 3, 5. Response shaping (206→72 tokens), namespacing effects, description-refinement as a SOTA-mover.
5. **CodeAct (Wang et al., ICML 2024)** — https://arxiv.org/abs/2402.01030
   The academic foundation. +20% across 17 LLMs is the published version of what smolagents claims anecdotally.

## Relevant technologies / projects to study

- **Anthropic Agent Skills** (https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — the productionized "recipes that load on demand" pattern. The MCP-builder skill in `anthropics/skills` is itself a recipe for building MCP servers — study it as a reference implementation.
- **MCP SEP #1888** — https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1888 — active spec proposal for progressive disclosure as a first-class MCP capability. Our design may need to align.
- **MCP gateway/aggregator pattern** (MetaMCP, Composio, Smithery) — relevant if dtc-mcp ever gets composed with other servers; our single-tool design plays nicely with aggregators.
- **DTDR — Dynamic Tool Dependency Retrieval (Dec 2025)** — https://arxiv.org/pdf/2512.17052 — 23–104% improvements over static retrieval. Directly applicable to our "rediscovery on each run" problem.
- **Toolshed / RAG-Tool Fusion** — https://www.themoonlight.io/en/review/toolshed-scale-tool-equipped-agents-with-advanced-rag-tool-fusion-and-tool-knowledge-bases — 3× invocation accuracy + halved prompt length via tool RAG.

## Gaps we could fill if we publish

1. **The crossover threshold is unstudied.** Everyone reports "code is better when workflows are complex" but nobody publishes the token-per-task curve where code overhead breaks even. Our bench has this data — task-shape × token-cost across both architectures. Our +61% on enumeration is the cleanest published instance of the cost-on-simple-tasks side.
2. **Conversation-shape taxonomy** ("linear-with-context" vs "branching-with-new-data") is novel as a workload classifier. Worth coining and measuring.
3. **State usage vs state availability ablation.** BFCL v3 confirms agents fail at state but doesn't isolate "the state was there, the agent didn't use it" from "the state wasn't representable." Our harness already permits the ablation (toggle whether the sandbox resets per call).
4. **Per-call payload decomposition.** No published clean breakdown of tool-def-bytes vs argument-bytes vs result-bytes per turn. We have the raw stream-json data to produce one.
5. **Neutral head-to-head on real third-party APIs.** All prior work is either synthetic (BFCL, API-Bank) or self-reported by the code-as-tool vendor (Cloudflare). A neutral comparison on a vendor MCP we don't own (Klaviyo's) would be uniquely credible.

## Implications for the architecture backlog in findings.md

Re-prioritized given the prior art:

- **#1 (stash guidance in `execute_code` description)** — strongly validated by Anthropic's "Writing effective tools" post. Highest leverage, smallest effort. **Ship first.**
- **#3 (recipe-by-intent discovery)** — Anthropic Skills + DTDR show this is a solved-pattern direction. Should adopt the Skills filesystem-of-recipes structure rather than inventing our own. Medium effort, high leverage.
- **#5 (cookbook recipes)** — fits naturally into the Skills-style structure from #3. Do these together.
- **#4 (revision override)** — still small effort, but lower priority given the prior art on API drift isn't deep enough to dictate a specific design.
- **#6 (audit `execute_code` per-call overhead)** — Anthropic and Solo.io reports make this concrete: target <100 tokens per tool listing, prompt-cache-friendly tool definitions. Worth a measurement pass.
- **#7 (philosophy decision)** — Cloudflare's two-tool design (`search` + `execute`) is the closest analog to "stay pure with better defaults." Tilts the decision against adding hand-built tools.

## What this means for the blog post

The prior-art landscape changes the framing options:

1. **"We validated the code-execution-MCP thesis on real APIs"** — frames us as contributing data to a well-defined debate. Strongest if we can quantify the crossover point clearly.
2. **"Seven things we learned that the MCP community is still figuring out"** — frames the bench as a probe, references CodeAct / Cloudflare / Anthropic posts, identifies the open gaps. Closer to how the community actually publishes.
3. **"Conversation shape, not turn count, is the right MCP-efficiency axis"** — leads with the novel finding (#7) and uses everything else as support. Riskier but most original.

(1) and (2) are safer; (3) is the most differentiated and matches what no one else has published.
