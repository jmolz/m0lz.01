---
paths:
  - "src/core/evaluate/**"
  - "src/cli/evaluate.ts"
---

# Evaluation Conventions

Rules for the three-reviewer adversarial evaluation layer (`src/core/evaluate/**`, `src/cli/evaluate.ts`). Patterns emerged during Phase 5 — they keep the gate deterministic, auditable, and safe against reviewer drift.

## Deterministic work stays in the CLI; judgment stays in the skill

The CLI owns all reproducible work: autocheck lints, fingerprinting, Jaccard similarity, categorization, verdict. The skill owns reviewer-specific judgment via Claude + `codex exec`. This split is load-bearing — it lets a grader re-derive any verdict from stored inputs without re-running an LLM.

- **Never** embed LLM calls in `src/core/evaluate/**` or `src/cli/evaluate.ts`. Those paths must be pure logic + DB + filesystem.
- **Never** make synthesis conditional on model behavior (e.g. "ask Claude to dedupe"). Dedup is a fingerprint + Jaccard operation — full stop.

## Autocheck lints are sorted by (category, id) before return

`runStructuralAutocheck` must produce byte-identical output across repeated invocations on the same draft. Determinism is enforced with a final sort by `(category ASC, id ASC)` and stable IDs via `issueFingerprint('structural', title, description)`.

```typescript
issues.sort((a, b) => {
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
});
```

New lints must tag `source: 'autocheck'` and route their ID through `issueFingerprint` — never hand-roll an ID, or reruns diverge.

## Jaccard threshold is a named, exported constant

`JACCARD_THRESHOLD = 0.6` lives in `src/core/evaluate/synthesize.ts` as an exported constant. Tests reference the constant, not the literal. If the threshold ever needs tuning, it changes in exactly one place and every test inherits the new value.

- **Never** inline `0.6` in call sites.
- When the threshold changes, update `synthesize.ts` only; do not search-and-replace literals elsewhere.

## ReviewerOutput schema is validated before any DB insert

`recordReview` must call `validateReviewerOutput` (via `parseReviewerOutput`) before touching the `evaluations` table. A malformed JSON or schema drift must throw with a descriptive, multi-line error listing every violation. No partial rows, no best-effort parsing.

This protects the synthesis path: `runSynthesis` trusts the stored `issues_json`, so any schema drift at record time becomes a silent synthesis failure later. Catch it at the boundary.

## Synthesis refuses on missing or corrupt reviewers

`runSynthesis` must throw — and write **nothing** to `evaluation_synthesis` or `posts.evaluation_passed` — when:

- Any expected reviewer is missing a row.
- Any stored `issues_json` fails to parse as JSON.
- Any stored `issues_json` parses but is not an array.

Partial synthesis rows are prohibited. The gate is binary.

## Verdict logic

```typescript
fail if (autocheck_issues > 0 || consensus_issues > 0 || majority_issues > 0);
pass otherwise;
```

`autocheck_issues` counts clusters containing at least one issue with `source: 'autocheck'`. Deterministic lints from `structural.lint.json` are authoritative and block the verdict **independently of cross-reviewer clustering** — a broken frontmatter, MDX parse error, unbacked benchmark claim, or missing companion_repo cannot be absorbed into the `single` bucket and silently ship because no human reviewer echoed it.

Severity is carried on each `Issue` but does not influence the verdict in MVP. If severity ever becomes a factor, update this rule and `computeVerdict` together — do not branch at the call site.

## Content-type routing lives in `expectedReviewers`

`analysis-opinion` posts run a two-reviewer panel (`structural`, `adversarial`). All other content types run three (`structural`, `adversarial`, `methodology`). Manifests record the expected list; `runSynthesis` reads from the manifest, not by re-deriving from `content_type`. This makes old evaluations replay correctly even if `content_type` changes semantics later.

When adding a new content type: extend `expectedReviewers` and the test matrix in `tests/evaluate-synthesize.test.ts` + `tests/evaluate-state.test.ts`. Do not branch on `content_type` inside CLI handlers.

## Reject preserves history; cycles isolate the gate

`rejectEvaluation` writes `.rejected_at` into the evaluation workspace, marks the current cycle as `ended_reason='rejected'` in the manifest, and moves the post back to `draft`. It does **not** delete `evaluations` or `evaluation_synthesis` rows. The next `initEvaluation` opens a new cycle (appends to `manifest.cycles`), advances `cycle_started_at`, captures `evaluation_id_floor`/`synthesis_id_floor` from the DB's current MAX(id), and removes the `.rejected_at` marker.

Subsequent `recordReview` calls flag `is_update_review=1` whenever `manifest.cycles.length > 1`. `runSynthesis` and `completeEvaluation` only see rows with `id > cycle floor` — prior-cycle rows are invisible to the gate. This makes the gate strictly cycle-scoped: a stale `pass` from a pre-reject cycle cannot authorize `completeEvaluation`.

Cycle boundaries use monotonic row IDs, not timestamps, so clock-precision (second-level `CURRENT_TIMESTAMP` vs millisecond `toISOString()`) cannot alias cycles. Do not add a timestamp-based filter back — it will break under fast sequential commands.

## `recordReview` validates its input and dedupes within a cycle

`recordReview` calls `validateReviewerOutput(output)` before any DB touch. Programmatic callers that bypass the CLI path cannot insert malformed rows. It also dedupes: if the latest row for `(slug, reviewer)` in the current cycle is byte-identical (same model, passed, issues_json, report_path), it returns that row without inserting. This keeps the advertised retry model true — running `blog evaluate record` twice with the same payload is a no-op.

When the payload differs (reviewer found a new issue on a partial fix), a new row is inserted and the latest wins at synthesis time. Historical rows are preserved for audit.

## Autocheck is authoritative at synthesis — fail-closed

The structural reviewer's stored issues are union'd with `structural.lint.json` findings at synthesis time, keyed by the cross-reviewer fingerprint (SHA-256 of normalized title + description). A reviewer who drops an autocheck finding cannot hide it — `runSynthesis` reinjects it before clustering.

`runSynthesis` **throws** when `structural.lint.json` is missing, unparsable, not an array, or contains any item missing a string `title`/`description`. Silent skip would defeat the "authoritative" invariant — a missing or corrupt sidecar must fail the gate, not bypass it. Run `blog evaluate structural-autocheck <slug>` before `synthesize`.

## Synthesis pins the evaluation id it was built from; complete rejects stale or missing pins within a cycle

`runSynthesis` captures `last_synthesis_eval_id = MAX(evaluations.id) WHERE post_slug = ?` **inside** the same `db.transaction` that reads the reviewer rows and writes the synthesis/posts update. better-sqlite3 holds an immediate reserved lock for the duration, so no concurrent `recordReview` can slip a new row between the reviewer reads and the MAX(id) sample — the pin is race-free coverage of exactly the rows synthesized. The pin is then written to the manifest outside the txn (advisory cache).

`completeEvaluation` **fails closed** in two cases:
- `pin === undefined` — the last synthesis did not finish writing its manifest pin (crash, manual manifest edit, restore skew). We cannot verify coverage, so we refuse to advance. A fresh `blog evaluate synthesize` reattaches the pin and unblocks the gate without side-stepping the coverage check.
- `pin < MAX(evaluations.id)` — a reviewer re-recorded after synthesis. The pass is out of date and must be re-synthesized.

Do **not** "tolerate restart" by treating a missing pin as a passable synthesis — that is exactly the silent-pass hole that the guard is designed to close.

## Synthesis gate flip is atomic and serialized against recordReview

`runSynthesis` wraps all reviewer reads, autocheck union, MAX(id) capture, `evaluation_synthesis` INSERT, and `posts.evaluation_passed` UPDATE in a single `db.transaction(...)`. A failure anywhere inside the txn rolls back every DB write. The reserved write lock also serializes concurrent `recordReview` calls — they block until the synthesis txn commits (or rolls back) and therefore cannot contribute rows that the pin falsely claims to cover. The manifest pin write happens outside the txn; if it fails, `completeEvaluation`'s fail-closed guard (above) catches the missing pin before publish can be authorized.

## Cycle-open is serialized under a DB transaction

`initEvaluation` runs its cycle-open step (read manifest → `MAX(id)` sampling → manifest write) inside `db.transaction(...)`. better-sqlite3 takes an immediate write lock for each txn, so concurrent `initEvaluation` calls on the same slug cannot race to double-open a cycle with conflicting floor IDs.

## Manifest floors are validated on read; skew fails loudly

`readManifest` throws on non-numeric `evaluation_id_floor`, `synthesis_id_floor`, or `last_synthesis_eval_id`. `initEvaluation` additionally verifies every cycle's floors are `<= MAX(id)` in the DB; if the workspace was restored from a backup without the DB (or vice versa), init refuses to proceed. Silent coercion to `0` would either hide all rows or re-expose pre-reject rows depending on drift direction — neither is safe.

## Record idempotency uses canonical comparison

`recordReview` dedupes against the latest in-cycle row via (a) canonicalized issues JSON (keys sorted alphabetically per issue, issues array sorted by id) and (b) `path.resolve()`d report_path. This keeps dedupe robust against key-order or array-order variance in reviewer tooling and against relative-vs-absolute path variants.

## Jaccard matching is representative-anchored, NOT category-guarded

`matchIssues` clusters greedily against each cluster's first-seen representative. A candidate joins only when `jaccard(candidate.tokens, representative.tokens) >= JACCARD_THRESHOLD`. No transitive chaining — every candidate is compared to the representative alone, never to the latest member. This prevents transitive-closure drift (A~B, B~C, A!~C) where unrelated issues could merge via shared boilerplate.

Category is **not** a guard for Tier 2 (Jaccard) matches. Two reviewers describing the same real defect under different category labels (e.g., `"thesis"` vs `"argument-gap"`, `"benchmark-claim-unbacked"` vs `"methodology"`) still cluster as long as the token overlap exceeds the threshold. A category guard would silently degrade the gate's sensitivity whenever reviewer taxonomies don't align exactly — that is a contract-breaking silent-pass vector, not hardening.

Tier 1 (exact cross-reviewer fingerprint of normalized title+description) already collapses identical issues regardless of category; identical normalized text is authoritative.

## Cycle rollover purges reviewer artifacts

When `initEvaluation` rolls a new cycle (after a closed prior cycle), it deletes the on-disk reviewer artifacts — `structural.json`, `adversarial.json`, `methodology.json`, `structural.md`, `adversarial.md`, `methodology.md`, `structural.lint.json`, `synthesis.md`, `synthesis.receipt.json` — from the workspace. DB rows are preserved for audit behind the monotonic id floors; only the replayable on-disk files rotate.

This closes a concrete gate bypass: after `blog evaluate reject`, the prior cycle's reviewer JSON files sit in the workspace with stable filenames. Without purge, `blog evaluate record` could re-record them verbatim — satisfying `runSynthesis`'s completeness check with stale judgments about a draft that has since changed. The purge forces every new cycle to receive a real, fresh review.

The `manifest.json` and any `.rejected_at` marker are cycle-aware metadata and survive; only reviewer artifacts rotate.

## `blog evaluate show` is cycle-scoped

`runEvaluateShow` reads reviewer status and verdict through `listRecordedReviewersInCycle(evaluation_id_floor)` and `latestSynthesisInCycle(synthesis_id_floor)` so prior-cycle rows (audited in the DB) do not render as if they were current. After reject+re-init, every reviewer must report `pending` and the verdict line must read "not synthesized in current cycle" — otherwise the CLI lies about gate state exactly when operators are recovering. Prior cycles are summarized as historical metadata ("2 passed, 1 rejected") and labeled as not part of the gate.

## Synthesis pins reviewed artifact hashes; complete detects drift

At synthesis time, `runSynthesis` computes SHA-256 over every reviewed input — `drafts/{slug}/index.mdx`, `benchmarks/{slug}/results.json`, `benchmarks/{slug}/environment.json`, `evaluations/{slug}/structural.lint.json` — and writes the hash table into the current cycle's `reviewed_artifact_hashes`. Missing files are recorded with the literal sentinel `ARTIFACT_ABSENT = '<absent>'` so later materialization is detected as drift, not silently allowed.

`completeEvaluation` recomputes these hashes and refuses to advance if any changed — including a pinned-absent artifact that now exists, or a pinned-present artifact that was deleted. A missing `reviewed_artifact_hashes` on the current cycle is also fail-closed (treated the same as a missing pin): the last synthesis did not complete cleanly and must be re-run. This prevents the "edit draft between synthesize and complete" bypass: operators cannot ship content reviewers never saw.

## `recordReview` and `completeEvaluation` refuse closed cycles

Both functions check `currentCycle(manifest).ended_reason === undefined` and throw when set. This closes the reject-crash-recovery window where the manifest is closed but the post is still in `evaluate` — in that partial state, neither a record nor a complete can operate on the closed cycle's floors. The only valid next step is `initEvaluation` (which rolls a fresh cycle).

## `recordReview` dedup check + INSERT is transactional

The "is-this-payload-already-recorded" SELECT and the subsequent INSERT are wrapped in `db.transaction(...)`. Under better-sqlite3's reserved-lock semantics, a concurrent identical `recordReview` cannot race past the dedupe branch on both connections and double-insert. Idempotency is atomic with the write.

## `rejectEvaluation` is transactional

Marker write + `closeCurrentCycle` (manifest write) + `advancePhase` (DB UPDATE) execute inside a single `db.transaction`. A crash during reject either commits every effect or none. Without this, a crash between cycle-close and phase-flip would leave the post in `evaluate` with a closed-rejected cycle — recoverable via `initEvaluation`, but the intermediate state is briefly inconsistent and any concurrent command sees a skewed gate.

## Manifest floor monotonicity is enforced on read

`readManifest` rejects any manifest where a later cycle's `evaluation_id_floor` or `synthesis_id_floor` is below the previous cycle's. `MAX(id)` of a non-deleting audit table only grows, so a lowered floor is evidence of tampering (or backup/restore skew). Additionally, a new cycle's `evaluation_id_floor` must be `>= prior_cycle.last_synthesis_eval_id` when that pin is set — otherwise a tamper could re-expose a pre-reject pass synthesis via the new cycle's `latestSynthesisInCycle(synthesis_id_floor)` lookup. Both checks fail loudly; no silent coercion.

## Manifest trust is DB-cross-validated at every gate function

`validateManifestAgainstDb(db, slug, manifest, post)` is called by `recordReview`, `runSynthesis`, `completeEvaluation`, and `rejectEvaluation` (and `initEvaluation` on an existing manifest). It enforces three invariants:

1. `manifest.expected_reviewers` **must equal** `expectedReviewers(post.content_type)` — same length, same order, same values. Rejects manifest tamper that shrinks the gate (e.g. `['structural']`), duplicates a reviewer (e.g. `['structural','structural','structural']` satisfying completeness from one review), or reorders entries. The DB's `content_type` is authoritative; the manifest is cached metadata that must match.
2. Every cycle's `evaluation_id_floor` and `synthesis_id_floor` must be `<= MAX(id)` of their respective tables — covers restore skew in either direction.
3. Every cycle's `last_synthesis_eval_id` (if set) must be `<= MAX(evaluations.id)` for the slug. Closes the pin-tamper-upward bypass where an operator raises the pin beyond live rows so `currentMaxEval > pin` can never trip.

Do not add new gate functions that read the manifest without calling this validator.

## Autocheck blocking is fingerprint-authoritative, NOT reviewer-tag-authoritative

`synthesize` accepts an `autocheckFingerprints: Set<string>` parameter — the SHA-256 (normalized title + description) of every issue in `structural.lint.json`. `counts.autocheck` counts clusters that intersect this set. **Do not** count autocheck by scanning `issue.source === 'autocheck'`: that tag is mutable reviewer input, and a reviewer mirroring a lint finding as `source: 'reviewer'` would then absorb the cluster and strip the block. Authority derives from the lint file's content, not from any field a reviewer can set.

`unionAutocheckIntoStructural` also upgrades any reviewer-authored issue whose fingerprint matches a lint to `source: 'autocheck'` — this is cosmetic (keeps the rendered report honest) and does not change the verdict computation. The block comes from the fingerprint set, not the upgraded tag.

## Per-reviewer artifact binding

Every `recordReview` call pins `computeReviewedArtifactHashes(...)` into `manifest.cycles[current].reviewer_artifact_hashes[reviewer]`. `runSynthesis` asserts that every expected reviewer's pin exists AND that every pin matches current disk byte-for-byte across all four reviewed-artifact keys. This closes two bypasses:

1. "Record all reviewers on D0, edit draft to D1, synthesize" — reviewers pinned D0, disk is D1, drift detected.
2. "Reviewer A records on D0, someone edits to D1, reviewer B records on D1" — two reviewers disagree on the file set, drift detected even before disk compare.

The per-reviewer pin complements `reviewed_artifact_hashes` (set by synthesis): the former proves reviewers saw the same files; the latter proves the gate advances on the same files reviewers judged.

## Artifact hashing rejects symlinks

`fileHash` calls `lstatSync` first and throws if the path is not a regular file. A symlink swap between synthesis and complete would otherwise serve different content through a pinned path. `readFileSync` follows symlinks by default; lstat-first is the only way to refuse the indirection outright.

## runSynthesis guards against concurrent manifest mutation

`runSynthesis` stamps `sha256(manifest.json bytes)` before the synthesis DB transaction and re-stamps immediately before the post-commit manifest write. If the stamp diverged, the function throws and refuses to persist the pin — a concurrent `rejectEvaluation` or `initEvaluation` ran while synthesis was in flight, and last-writer-wins would erase their changes. The DB synthesis row is already committed and remains the latest, but `completeEvaluation` will fail-closed on the missing pin until synthesis is re-run.

## rejectEvaluation commits DB first, then FS writes

`rejectEvaluation` runs `advancePhase(db, slug, 'draft')` inside a `db.transaction` BEFORE writing the marker file or the closed-cycle manifest. If `advancePhase` throws, no FS side effect is observable. If the DB commits but a subsequent FS write fails, the post is already in `draft` — the closed-cycle guards on `record`/`complete` plus the phase change keep the gate safe, and `initEvaluation` on the next attempt will roll a fresh cycle regardless of the marker/manifest state. The comment in code intentionally acknowledges the non-atomic FS tail; do not try to wrap FS writes in the db.transaction — better-sqlite3 cannot rewind them.

## completeEvaluation recomputes drift INSIDE the txn

The artifact-drift recomputation runs inside the same `db.transaction` as `closeCurrentCycle` + `advancePhase`. The reserved write lock held for the transaction duration blocks concurrent `recordReview` / `runSynthesis` from mutating state between hash recompute and phase flip — closes the TOCTOU window where an operator could edit the draft in the microseconds between drift-check and phase-advance.

## runSynthesis uses an immutable artifact snapshot

`runSynthesis` calls `captureSynthesisSnapshot` once at entry and every downstream consumer — autocheck union, autocheck fingerprint set, reviewed-artifact-hash pin — reads from the same in-memory `SynthesisSnapshot`. Do NOT re-read `structural.lint.json` or artifact files after the snapshot is captured. A concurrent swap of the lint file to `[]` between the union-read and the fingerprint-read would otherwise drop `counts.autocheck` to 0 silently; reading from the frozen snapshot closes that race.

## Reviewer provenance: artifact_hashes is MANDATORY (supersedes pre-R8 optional rule)

See the "ReviewerOutput.artifact_hashes is MANDATORY with the full required key set" section below. The field was originally optional for back-compat; R8 made it required after Codex xhigh proved the stale-JSON-omit bypass. `recordReview` unconditionally verifies every declared hash matches the current workspace and throws with a mismatch list on divergence.

## Per-reviewer hash write is inside the recordReview transaction

The manifest update that persists `reviewer_artifact_hashes[<reviewer>]` runs INSIDE the `db.transaction` that does the dedup check + INSERT. Two concurrent records for different reviewers on the same slug serialize on the reserved write lock and cannot RMW-race on the manifest. The hash write also happens on the dedup path (not just on insert) so a manifest corruption recovery completes without requiring a payload-change.

## rejectEvaluation writes the sentinel BEFORE the DB commit

Order is `writeFileSync(.rejected_at) → db.transaction(advancePhase → draft) → closeCurrentCycle(manifest close)`. Writing the sentinel first means: if the DB commits, the sentinel is already on disk; if the DB fails, the sentinel exists without a phase flip and the retry is idempotent. `initEvaluation` treats a present sentinel + open cycle as an implicit close (reject crashed mid-tail) and rolls a fresh cycle — prevents the "reject partial + init reuses cycle + complete ships rejected post" bypass.

## Synthesis receipt anchors manifest against pin tampering

`runSynthesis` writes `synthesis.receipt.json` containing a canonical SHA-256 over `{pin, verdict, reviewed_artifact_hashes, reviewer_artifact_hashes, synthesis_row_id}`. `completeEvaluation` recomputes and verifies both the receipt's self-hash AND that the receipt body matches the manifest's current cycle state. Raising `last_synthesis_eval_id` in the manifest without regenerating the receipt is rejected. Not cryptographically unforgeable (no keys), but raises the tamper bar from "edit one JSON field" to "coordinate two files + recompute SHA-256".

## Empty-normalized issues are rejected at validateReviewerOutput

`validateIssue` throws when `normalizeText(title)` or `normalizeText(description)` yields an empty string. Without this, `title: "."` and `description: "."` would fingerprint-collide with any other all-punctuation issue, producing false clusters. The length check on raw strings is not sufficient — normalization strips everything non-alnum.

## ReviewerOutput.artifact_hashes is MANDATORY with the full required key set

`validateReviewerOutput` rejects any payload missing `artifact_hashes` or missing any of `REQUIRED_ARTIFACT_HASH_KEYS` (`draft/index.mdx`, `benchmark/results.json`, `benchmark/environment.json`, `evaluation/structural.lint.json`). Missing files are declared via the `<absent>` sentinel — the key itself is never omitted. An optional field would let a stale reviewer JSON (generated against D0) be recorded after the workspace drifted to D1 by simply not declaring hashes; mandating the field forces every reviewer to commit to the exact file set it judged. `recordReview` then cross-checks every declared hash against the current workspace and rejects divergence.

## completeEvaluation re-derives synthesis from the DB; the pin is NOT the trust root

`completeEvaluation` re-runs `synthesize()` on the current latest-per-reviewer rows in cycle + the captured artifact snapshot's lint fingerprints, and compares BOTH (a) verdict + `consensus/majority/single` counts AND (b) per-bucket cluster representative fingerprint sets (`cluster_identity`) against the stored `evaluation_synthesis` row + synthesis receipt. Mismatch fails the gate. The DB state is authoritative: an attacker who raises `manifest.last_synthesis_eval_id` to pass the pin guard AND forges a consistent receipt still loses — re-derivation sees different reviewer rows and produces different cluster fingerprints.

**Counts alone are not sufficient.** A coincidence bypass exists where the attacker re-records with DIFFERENT issues that happen to yield the same bucket distribution (e.g. synthesis had single=3, attacker swaps in three new singletons → still single=3). `synthesize()` now emits a `cluster_identity: { consensus, majority, single }` field — each a sorted list of `crossReviewerFingerprint(title, description)` for that bucket's cluster representatives. `runSynthesis` pins the set in `synthesis.receipt.json`; `completeEvaluation` reads it via `loadAndVerifySynthesisReceipt` and compares against the re-derived identity set. Different issues produce different fingerprints, so a count-preserving re-record is caught.

## `readManifest` validates every top-level field

`readManifest` is the single choke point for manifest trust. It validates:

- `slug` is a non-empty string
- `content_type` is one of `project-launch`, `technical-deep-dive`, `analysis-opinion`
- `initialized_at` is a non-empty string
- `expected_reviewers` is a non-empty array of valid reviewer enum values
- All cycle floor / pin / hash fields per prior rules

Without these top-level validators, a tampered manifest with `"expected_reviewers": "string"` passes the `readManifest` cast and crashes a downstream `.join(', ')` with a raw TypeError. Every consumer (`runEvaluateShow`, `validateManifestAgainstDb`, `recordReview`/synth/complete/reject) trusts these fields as typed — the check has to live in `readManifest` itself.

## Slug-scoped FS lock serializes CLI operations

`acquireEvaluateLock` creates an exclusive `.evaluate.lock` file (O_CREAT|O_EXCL) under the evaluation workspace, holds it through the operation, and unlinks on release. `recordReview`, `runSynthesis`, `completeEvaluation`, `rejectEvaluation` all acquire it. Two concurrent `blog evaluate` processes on the same slug serialize on the lock — closing the cooperative-CLI TOCTOU between the `computeReviewedArtifactHashes` call and the DB phase-flip commit. The lock records the holder PID so a crashed process's stale lock can be reclaimed. This is cooperative (not a kernel flock) — external processes (text editors, scripts that don't use this helper) are not blocked, which is an acknowledged threat-model limitation.

## Informational `show` tolerates tampered manifests

`runEvaluateShow` wraps `readManifest` in try/catch. A tampered or malformed manifest degrades the output to `manifest: (unreadable: <message>)` plus the DB-side historical view, rather than leaking a raw Node stack trace. Informational commands must never hard-fail on peripheral state — that rule applies to manifests as much as to `.blogrc.yaml`.

## Phase boundary is strict

Evaluate commands reject posts in any phase other than `evaluate`, with one exception: `initEvaluation` accepts `draft` (and promotes) or `evaluate` (idempotent). Library functions throw with a message that includes the current phase; CLI handlers catch and set `process.exitCode = 1`.

Never let a phase-boundary error surface as a raw stack trace.
