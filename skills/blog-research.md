---
name: blog-research
description: Research a topic with web search and structured source gathering. Produces a research document with benchmark targets.
---

# /blog-research

Orchestrate the research phase: detect mode and content type, gather sources with WebSearch, and produce a structured research document that the benchmark, draft, and evaluate phases consume.

The CLI (`blog research init/add-source/show/finalize`) owns persistence. This skill owns the AI-heavy work: mode detection, source gathering, thesis drafting, and the two exploratory checkpoints.

---

## Mode Detection

Decide between **directed** and **exploratory** from the incoming prompt:

- **Directed** -- user named two or more specific research targets, the prompt includes "benchmark", "test", "compare", or references a concrete project ID (e.g., `m0lz.02`). Run without intermediate checkpoints.
- **Exploratory** -- vague prompt, broad topic, no explicit targets. Use two checkpoints (scope confirm, pre-finalize) before gating.

If unclear, default to **exploratory**. Better to confirm with the user once than to drift in directed mode.

---

## Content Type Detection

Pass `--content-type` explicitly when the mode makes it obvious; otherwise let the CLI auto-detect via `detectContentType()`:

| Prompt signals | Content type |
|----------------|--------------|
| Catalog ID (e.g., `m0lz.02`) | `project-launch` |
| "benchmark", "compare", "measure", "latency" | `technical-deep-dive` |
| Otherwise | `analysis-opinion` |

---

## Directed Mode Workflow

1. **Init the entry**:

   ```
   blog research init <slug> --topic "..." --mode directed --content-type <type>
   ```

   This creates the post row (phase = `research`) and writes `.blog-agent/research/<slug>.md` from the template.

2. **Gather sources with WebSearch**. Minimum from config `evaluation.min_sources` (default 3). For each source:

   ```
   blog research add-source <slug> --url <u> --title "..." --excerpt "<why it matters>"
   ```

   The `--excerpt` is the UX lever: it must state *why* the source matters (claim supported, datum provided) -- not just summarize the page. Downstream evaluators read these excerpts to judge source quality.

3. **Fill the research doc** at `.blog-agent/research/<slug>.md`. Replace every `{{placeholder}}` with real content:
   - **Thesis** -- one paragraph stating the core claim
   - **Key Findings** -- 3 to 5 bullet points
   - **Sources** -- markdown bullet list (structured copies live in the SQLite `sources` table)
   - **Data Points** -- specific numbers, measurements, or verifiable facts
   - **Open Questions** -- what remains unknown
   - **Benchmark Targets** -- see guidance below
   - **Suggested Companion Repo Scope** -- what a companion repo would contain

4. **Finalize**:

   ```
   blog research finalize <slug>
   ```

   If it fails (insufficient sources or missing/empty sections), fix the gaps and retry. Finalize is a read-only gate -- it does NOT transition the phase. Phase 3 (benchmark) owns that transition.

---

## Exploratory Mode Workflow

Same CLI surface, two additional checkpoints:

1. **Initial sweep**. Run `blog research init` and gather 3 to 5 sources via WebSearch.

2. **Checkpoint 1 -- Scope confirm**. Present to the user:
   - The sources gathered so far (titles + one-line excerpts)
   - 2 to 3 candidate angles or thesis directions
   - A specific question: "Which direction should the research go deeper on?"

   Wait for direction before continuing. Do not proceed to deep research without this confirmation.

3. **Deep research**. Gather the remaining sources. Fill in the doc's sections based on the user's chosen direction.

4. **Checkpoint 2 -- Pre-finalize**. Present to the user:
   - The final thesis
   - The benchmark targets list
   - A specific question: "Ready to finalize?"

   Wait for approval before running `finalize`.

5. **Finalize**. Same as directed mode.

Both checkpoints are minimal by design -- enough friction to catch divergence from author intent, not enough to feel like an interview.

---

## Benchmark Targets Guidance

The "Benchmark Targets" section feeds Phase 3 mechanically. List each target as:

```
- {specific claim}: {how it would be tested}
```

Examples:

```
- Claim: JIT compilation adds 15-25ms to cold start: measure cold vs warm start latency across 100 runs
- Claim: vector search beats keyword search above 1M rows: index both, query the same corpus at 1M/10M/100M rows
```

Every target must be concrete enough that Phase 3 can scaffold a test without further input from the author. If a target can't be stated in this format, it belongs in "Open Questions" instead.

For `analysis-opinion` content type, this section can be short ("no benchmarks -- position piece") but still must exist and be filled in.

---

## Source Excerpt Guidance

Every `add-source --excerpt` call must state *why* the source matters. The excerpt format:

```
<claim this source supports> (<format>: <datum>)
```

Examples:

- "Demonstrates 40% latency improvement with prefetching (benchmark: 250ms -> 150ms p95)"
- "Baseline for the cold start problem (blog post: 500ms p99 before optimization)"
- "Authoritative source on RFC 7234 cache semantics (spec)"

Excerpts surface signal for downstream consumers. Skipping them or writing generic summaries ("article about X") breaks the evaluation pipeline.

---

## Output Contract

What downstream phases read from the research output:

| Consumer | Reads from |
|----------|-----------|
| Benchmark (Phase 3) | `Benchmark Targets` section; `sources` table rows with `source_type = 'benchmark'` |
| Draft (Phase 4) | `Thesis` (post opening); `Key Findings` (body structure); `Data Points` (evidence) |
| Evaluate (Phase 5) -- structural reviewer | All sections + `sources` table (source count, excerpt quality) |
| Evaluate -- adversarial reviewer | `Thesis`, `Open Questions`, `Sources` (argument gaps) |

If any section is skipped, those downstream consumers degrade silently. `blog research finalize` exists to catch this before the phase transitions.

---

## Quick Reference

```
blog research init <slug> --topic "..." [--mode directed|exploratory] [--content-type <t>] [--force]
blog research add-source <slug> --url <u> [--title "..."] [--excerpt "..."] [--type external|benchmark|primary]
blog research show <slug>
blog research finalize <slug>
```
