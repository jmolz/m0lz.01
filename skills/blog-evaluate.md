---
name: blog-evaluate
description: Run the three-reviewer adversarial evaluation panel (Claude structural, GPT-5.4 high adversarial, GPT-5.4 xhigh methodology), merge autocheck lints with reviewer judgment, and synthesize verdicts into consensus/majority/single categories with a pass/fail gate.
---

# /blog-evaluate

Coordinates the three-reviewer panel for a draft post. The CLI owns all deterministic work (phase gating, schema validation, autocheck lints, synthesis, verdict). This skill owns reviewer-specific judgment (prose quality, argument gaps, methodology critique) via Claude + two Codex CLI invocations.

## Pre-flight

1. Confirm the post is in `draft` or `evaluate` phase: `blog draft show <slug>` (or `blog evaluate show <slug>` once initialized).
2. Confirm the required artifacts exist:
   - `.blog-agent/drafts/{slug}/index.mdx` — valid frontmatter, no placeholder sections
   - `.blog-agent/research/{slug}.md` — research document
   - `.blog-agent/benchmarks/{slug}/results.json` and `environment.json` — only for `technical-deep-dive` and `project-launch` with benchmarks
3. `codex` CLI must be available on `$PATH`. Fall back to structural-only if Codex is unreachable (see Degraded Mode below).

## Workflow

### Step 1 — Initialize the evaluation workspace

```bash
blog evaluate init <slug>
```

Creates `.blog-agent/evaluations/{slug}/manifest.json` listing the expected reviewers for the post's content type:

- `technical-deep-dive`, `project-launch` -> `['structural', 'adversarial', 'methodology']` (3 reviewers)
- `analysis-opinion` -> `['structural', 'adversarial']` (2 reviewers)

This also promotes the post from `draft` to `evaluate` if needed. Idempotent.

### Step 2 — Run the deterministic structural autocheck

```bash
blog evaluate structural-autocheck <slug>
```

Writes `.blog-agent/evaluations/{slug}/structural.lint.json` with a sorted, reproducible list of mechanical findings (frontmatter schema, placeholder sections, broken internal links, unescaped MDX, unbalanced code fences, unbacked benchmark claims, missing companion_repo). This is the reviewer-neutral input to the Claude structural review in Step 3.

### Step 3 — Claude structural review

Read these files:

- `.blog-agent/drafts/{slug}/index.mdx`
- `.blog-agent/research/{slug}.md`
- `.blog-agent/benchmarks/{slug}/results.json` (when present)
- `.blog-agent/evaluations/{slug}/structural.lint.json`

Tasks:

1. Load `structural.lint.json` and parse the autocheck issues.
2. Load `.claude/rules/voice.md` and scan the draft for voice violations: hedges and filler, tricolon stacks, uniform sentence length, topic-restatement transitions, smarmy openers, undefined jargon, em-dash overuse (more than ~1 per 500 words without the substitution test surviving), colon-as-reveal overuse, emojis anywhere. Emit each as a reviewer-sourced issue with `"category": "voice"` and `"source": "reviewer"`.
3. Add other judgment-based issues that autocheck cannot detect: prose quality, reading level, section cohesion, source sufficiency, thesis clarity. Tag each with `"source": "reviewer"`.
4. Merge autocheck + judgment issues into a single array. Do not modify autocheck-tagged issues.
5. Write `.blog-agent/evaluations/{slug}/structural.md` — a human-readable report.
6. Write `.blog-agent/evaluations/{slug}/structural.json` — a `ReviewerOutput` (schema below).
7. Record:

```bash
blog evaluate record <slug> \
  --reviewer structural \
  --report .blog-agent/evaluations/<slug>/structural.md \
  --issues .blog-agent/evaluations/<slug>/structural.json
```

### Step 4 — Codex adversarial review (GPT-5.4 high, in parallel with Step 5)

Invoke the Codex CLI to challenge the thesis. Write to `adversarial.json` matching the `ReviewerOutput` schema.

```bash
codex exec --effort high \
  "Adversarial peer review of draft at .blog-agent/drafts/<slug>/index.mdx.

   Your job: challenge the thesis. Find argument gaps. Surface unstated
   assumptions. Identify bias in framing or evidence selection.

   Read: the draft, .blog-agent/research/<slug>.md, and any
   .blog-agent/benchmarks/<slug>/results.json that exists.

   Output exactly one JSON file at .blog-agent/evaluations/<slug>/adversarial.json
   conforming to this schema:

   {
     \"reviewer\": \"adversarial\",
     \"model\": \"gpt-5.4-high\",
     \"passed\": <boolean>,
     \"issues\": [
       {
         \"id\": <12-char sha256>,
         \"category\": \"thesis\" | \"evidence\" | \"framing\" | \"bias\" | ...,
         \"severity\": \"low\" | \"medium\" | \"high\",
         \"title\": <one line>,
         \"description\": <full explanation>
       }
     ],
     \"report_path\": \".blog-agent/evaluations/<slug>/adversarial.md\",
     \"artifact_hashes\": {
       \"draft/index.mdx\": \"<sha256 of current file>\",
       \"benchmark/results.json\": \"<sha256 or '<absent>'>\",
       \"benchmark/environment.json\": \"<sha256 or '<absent>'>\",
       \"evaluation/structural.lint.json\": \"<sha256 of current file>\"
     }
   }

   Also write a human-readable adversarial.md alongside the JSON."
```

After Codex returns:

```bash
blog evaluate record <slug> \
  --reviewer adversarial \
  --report .blog-agent/evaluations/<slug>/adversarial.md \
  --issues .blog-agent/evaluations/<slug>/adversarial.json
```

### Step 5 — Codex methodology review (GPT-5.4 xhigh; skip for analysis-opinion)

```bash
codex exec --effort xhigh \
  "Methodology review of benchmark at .blog-agent/benchmarks/<slug>/.

   Your job: assess benchmark validity. Check sample size, confounds,
   environmental drift, statistical significance, reproducibility of
   METHODOLOGY.md, and whether the test harness measures what the draft claims.

   Output .blog-agent/evaluations/<slug>/methodology.json matching ReviewerOutput
   schema (including artifact_hashes with SHA-256 of every reviewed file — use
   '<absent>' for files that do not exist) and methodology.md with the reasoning."
```

Then:

```bash
blog evaluate record <slug> \
  --reviewer methodology \
  --report .blog-agent/evaluations/<slug>/methodology.md \
  --issues .blog-agent/evaluations/<slug>/methodology.json
```

Skip this entire step when `manifest.json.expected_reviewers` does not include `methodology` (analysis-opinion).

### Step 6 — Synthesize

```bash
blog evaluate synthesize <slug>
```

The CLI performs two-tier issue matching:

- Tier 1: SHA-256 fingerprint of normalized (title, description) — exact matches across reviewers collapse into one cluster.
- Tier 2: Jaccard token overlap >= `JACCARD_THRESHOLD` (0.6) — paraphrased issues still cluster.

Categorization:

- **Consensus:** cluster touched by all expected reviewers (3/3, or 2/2 for analysis-opinion) -> must fix.
- **Majority:** cluster touched by a strict majority (2/3; N/A for 2-reviewer mode) -> should fix.
- **Single:** cluster touched by exactly one reviewer -> advisory.

Verdict: `fail` when consensus > 0 OR majority > 0. Otherwise `pass`.

`blog evaluate synthesize` writes `.blog-agent/evaluations/{slug}/synthesis.md`, inserts an `evaluation_synthesis` row, and updates `posts.evaluation_passed`.

### Step 7 — Review and decide

```bash
blog evaluate show <slug>
```

Read `synthesis.md`. On `pass`:

```bash
blog evaluate complete <slug>   # advances to publish phase
```

On `fail`:

- If the author accepts the findings: `blog evaluate reject <slug>`, edit the draft, then run through the workflow again from Step 1 (or Step 3 if the autocheck output is still valid).
- If the author disputes single-reviewer advisory issues: those never block the verdict. Only consensus and majority issues determine pass/fail.

## ReviewerOutput schema (shared by all three reviewers)

```typescript
interface Issue {
  id: string;                                            // 12-char hex; stable per (reviewer, normalized title, normalized description)
  category: string;                                      // 'thesis', 'bias', 'sample-size', 'frontmatter-schema', etc.
  severity: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  source?: 'autocheck' | 'reviewer';                     // structural only — tags how the issue was found
}

interface ReviewerOutput {
  reviewer: 'structural' | 'adversarial' | 'methodology';
  model: string;                                         // 'claude-code', 'gpt-5.4-high', 'gpt-5.4-xhigh'
  passed: boolean;                                       // reviewer's own pass/fail verdict (advisory; CLI computes the hard verdict)
  issues: Issue[];
  report_path?: string;                                  // optional pointer to the human-readable markdown report
}
```

`blog evaluate record` validates this schema before inserting into the `evaluations` table. Malformed JSON or schema drift fails the record call with a descriptive error and leaves the DB unchanged.

## Degraded mode — Codex unavailable

If `codex exec` fails or is not installed:

1. Run Step 3 only (Claude structural review).
2. Do NOT run `blog evaluate synthesize` — it will refuse because adversarial/methodology are missing.
3. Surface the degraded state explicitly to the author: "Only structural review ran. Adversarial and methodology skipped because Codex CLI is unavailable. Set `codex` on $PATH or pass a manually-authored adversarial.json through `blog evaluate record`."
4. Do not advance the post — manual `blog evaluate complete` will fail because there is no synthesis row.

This is by design. The three-reviewer contract is load-bearing.

## Transparency principle

All CLI work — autocheck lints, fingerprint matching, Jaccard similarity, categorization, verdict — is deterministic and reproducible. The same inputs always produce the same `synthesis.md`. The reviewer JSON files are the only non-deterministic inputs, and they are validated against the `ReviewerOutput` schema before insert. This makes the gate auditable: you can hand-verify any verdict by re-running `blog evaluate synthesize` and re-reading the report.

## Parallel invocation pattern

Step 4 and Step 5 are independent. Invoke both Codex commands in parallel (background jobs, or a single shell running `( codex ... ) & ( codex ... ) & wait`). The `record` calls afterwards are idempotent per `(post_slug, reviewer)` and order-insensitive. The CLI does not synthesize until all three recorded reviewers are present.

## Rework after reject

When `blog evaluate reject` moves a post back to `draft`, the current evaluation cycle is marked `ended_reason='rejected'` in `manifest.json` and prior `evaluations` rows are preserved. The next `blog evaluate init` opens a **new cycle** and the gate becomes strictly cycle-scoped:

- Reviewer rows from the prior cycle do not satisfy `synthesize` — all expected reviewers must be re-recorded in the new cycle.
- A `pass` verdict from a prior cycle does **not** authorize `complete`. The CLI refuses to advance until a new `pass` is produced in the current cycle.
- The first record per reviewer in a cycle after a reject is tagged `is_update_review=1` (audit trail).
- **Reviewer artifacts on disk are purged.** Rolling a new cycle deletes the prior `structural.json` / `adversarial.json` / `methodology.json` / `{reviewer}.md` / `structural.lint.json` / `synthesis.md`. This prevents accidental replay — the skill must produce a fresh review for the changed draft, since the stale filenames are gone.
- **`blog evaluate show` is cycle-scoped.** Immediately after re-init, every reviewer reads `pending` and the verdict line reads "not synthesized in current cycle" even though prior-cycle rows remain in the DB. Prior cycles appear as a short historical summary (`prior cycles: N passed, M rejected (historical, not part of gate)`).

`blog evaluate record` is idempotent within a cycle: running it twice with the same reviewer JSON produces a single row. Passing a payload that differs from the last stored row (a reviewer found a new issue on a partial fix) appends a new row; the latest wins at synthesis time.

## Autocheck is authoritative — required at synthesis

The structural reviewer may add judgment-based findings, but cannot drop autocheck lints. `blog evaluate synthesize` re-unions `structural.lint.json` into the structural reviewer's issues (by normalized title + description fingerprint) before clustering. This keeps the deterministic CLI work load-bearing instead of prompt-trust-dependent.

**`blog evaluate synthesize` fails closed** when `structural.lint.json` is missing, unparsable, or not an array. Always run Step 2 (`blog evaluate structural-autocheck <slug>`) before synthesize — not optional.

## Re-recording after synthesis invalidates the pass

If a reviewer records a new payload AFTER `blog evaluate synthesize` has run (e.g., they noticed a new issue on a second pass), the synthesis becomes stale. `blog evaluate complete` refuses to advance until `blog evaluate synthesize` has been re-run to include the newer reviewer row. This prevents a stale-pass verdict from authorizing publication of a different draft revision.

Additionally, `blog evaluate complete` fails closed when the manifest's synthesis pin is missing — e.g., the prior synthesize was killed between DB commit and the manifest write, or the manifest was edited manually. Re-run `blog evaluate synthesize` to reattach the pin. Do not "rescue" a missing pin by editing the manifest by hand; the guard exists precisely because we can't verify coverage without a real re-synthesize.

## Autocheck findings block the verdict independently (fingerprint-authoritative)

Synthesis counts `autocheck` clusters separately from `consensus`/`majority`/`single`. Authority derives from the fingerprints in `structural.lint.json` directly — NOT from a `source: 'autocheck'` tag in any reviewer JSON. A reviewer copying a lint into their `issues[]` as `source: 'reviewer'` cannot absorb or neutralize the block; `computeVerdict` checks the cluster's normalized title+description against the lint's fingerprint set and returns `fail` on any hit.

Deterministic lints (broken frontmatter, MDX parse errors, unbacked benchmark claims, missing companion_repo) are therefore unignorable — a reviewer "agreeing" with an autocheck lint does not reduce its weight, and a reviewer "missing" it does not let the post ship.

To pass the gate, the draft must have zero outstanding autocheck lints at synthesis time. If autocheck surfaces issues, fix them in the draft first, then `blog evaluate structural-autocheck <slug>` again, then `blog evaluate synthesize <slug>`.

## Reviewer provenance: emit `artifact_hashes` in ReviewerOutput (REQUIRED)

Every `structural.json` / `adversarial.json` / `methodology.json` MUST include the `artifact_hashes` field with all four required keys (`draft/index.mdx`, `benchmark/results.json`, `benchmark/environment.json`, `evaluation/structural.lint.json`). Use SHA-256 of each file's current bytes; use the literal `"<absent>"` sentinel for files that legitimately don't exist (e.g., benchmarks on an analysis-opinion post). `blog evaluate record` rejects any output missing the field or any required key — closing the "generate reviewer JSON against D0, omit artifact_hashes, record stale JSON against D1" bypass.

```json
{
  "reviewer": "structural",
  "model": "claude-code",
  "passed": false,
  "issues": [ ... ],
  "report_path": ".blog-agent/evaluations/<slug>/structural.md",
  "artifact_hashes": {
    "draft/index.mdx": "<sha256>",
    "benchmark/results.json": "<sha256>",
    "benchmark/environment.json": "<sha256>",
    "evaluation/structural.lint.json": "<sha256>"
  }
}
```

Use `<absent>` as the literal value for any file that legitimately doesn't exist (e.g., `results.json` on an analysis-opinion post).

## Artifact hashes are pinned at record AND synthesis, and re-checked at complete

Two layers of artifact binding:

- **Per-reviewer (record)**: each `blog evaluate record` pins SHA-256 of `drafts/<slug>/index.mdx`, `benchmarks/<slug>/results.json`, `benchmarks/<slug>/environment.json`, `evaluations/<slug>/structural.lint.json` to `manifest.cycles[current].reviewer_artifact_hashes[<reviewer>]`. Reviewers therefore commit to the exact file set they judged.
- **Cycle-wide (synthesis)**: `blog evaluate synthesize` asserts every expected reviewer's pinned hashes agree AND match current disk, then pins the hash set to `reviewed_artifact_hashes`. `blog evaluate complete` recomputes and fails on drift — inside the same DB transaction as the phase flip, closing the TOCTOU window.

Net effect: if the draft, benchmark results/environment, or autocheck sidecar change between record and complete — or between reviewers — the gate blocks. Re-record any reviewer whose judgment was against a stale file, then re-synthesize. Do NOT edit manifest hashes by hand; every gate function cross-validates the manifest against live DB state and will reject tampering.

`fileHash` rejects symlinks (`lstatSync` first) so pinned paths cannot be redirected between synth and complete.
