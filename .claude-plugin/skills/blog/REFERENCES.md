# References

## `blog agent` CLI surface (v0.2.0)

| Subcommand | Purpose | Key flags |
|---|---|---|
| `blog agent preflight [--json]` | Report workspace root, config validity, schema + CLI version | `--json` (envelope) |
| `blog agent plan <slug>` | Write a plan skeleton (unapproved) | `--intent`, `--content-type`, `--depth`, `--venues`, `--steps-inline <json>` (preferred for skill), `--steps-json <path>`, `--output <path>` |
| `blog agent approve <plan-path>` | Atomically set `approved_at` + `payload_hash` | — |
| `blog agent verify <plan-path>` | Dry-run validate a plan | Exit 2 with `[AGENT_ERROR]` on failure |
| `blog agent apply <plan-path>` | Validate + execute step-by-step | `--restart` (re-run from step 1) |

## `--json` surfaces (versioned envelope)

Every `--json` output is wrapped as:

```json
{
  "schema_version": "1",
  "kind": "<Kind>",
  "generated_at": "<ISO 8601>",
  "data": { ... }
}
```

| Command | `kind` | Data highlights |
|---|---|---|
| `blog status --json` | `WorkspaceStatus` | `workspace_root`, `posts[]`, `totals{total,published,in_progress}` |
| `blog agent preflight --json` | `AgentPreflight` | `workspace_root`, `workspace_detected`, `config_valid`, `config_errors[]`, `schema_version`, `cli_version` |
| `blog publish show <slug> --json` | `PublishPipeline` | `slug`, `phase`, `steps[]`, `paused_step` |
| `blog update show <slug> --json` | `UpdatePipeline` | `slug`, `open_cycle_id`, `cycles[]` |
| `blog unpublish show <slug> --json` | `UnpublishPipeline` | `slug`, `steps[]`, `completed_at` |
| `blog evaluate show <slug> --json` | `EvaluationState` | `slug`, `cycle_id`, `reviewers[]`, `verdict` |

## Research phase authoring — two-gate finalize contract

`blog research finalize <slug>` enforces BOTH gates, independently:

1. **DB sources** — `countSources(slug) >= config.evaluation.min_sources` (default 3). Populate via `blog research add-source <slug> --url <...> --title <...> --excerpt <...>`.
2. **Document sections** — all 7 template sections non-empty in the rendered markdown. Populate via `blog research set-section <slug> --section <key> --content <text>` (or `--from-file <path>` for large content). Sections keyed by:
   - `thesis` → "Thesis"
   - `findings` → "Key Findings"
   - `sources_list` → "Sources"
   - `data_points` → "Data Points"
   - `open_questions` → "Open Questions"
   - `benchmark_targets` → "Benchmark Targets"
   - `repo_scope` → "Suggested Companion Repo Scope"

The two gates are INDEPENDENT — DB sources do NOT auto-populate the `Sources` markdown block, and `set-section` does NOT add DB source rows. A complete research phase requires both. Plan steps carry `set-section` content through the hash gate so section prose is immutable between `approve` and `apply`.

## Phase state machine

```
 research -> benchmark -> draft -> evaluate -> publish -> published
                                                             |
                                                    (update cycle)
                                                             |
                                                          published
                                                             |
                                                         unpublished
```

- `research`, `benchmark`, `draft`, `evaluate`, `publish` — in-progress states.
- `published` — canonical state; target of initial publish; source state for updates + unpublish.
- `unpublished` — terminal; slug is reserved forever (canonical-URL permanence).

Phase-boundary guards in the CLI reject a subcommand that doesn't match the post's current phase. Update commands (`blog update benchmark/draft/evaluate/publish`) bypass these guards via an explicit `isUpdateReview`/`isUpdate` flag because the post stays in `published` throughout the update cycle.

## Plan file schema (v2)

```json
{
  "schema_version": "2",
  "plan_id": "<generated ULID-like>",
  "slug": "<slug>",
  "workspace_root": "<absolute path>",
  "created_at": "<ISO 8601>",
  "approved_at": null,
  "payload_hash": null,
  "intent": "<one-line user intent>",
  "content_type": "project-launch | technical-deep-dive | analysis-opinion",
  "depth": "park | fast-path | full",
  "venues": ["hub", "devto", "hn"],
  "expected_start_phase": "research",
  "steps": [
    {
      "command": "blog <subcommand>",
      "args": ["<slug>", "--flag", "value"],
      "checkpoint_message": "Human-readable prompt before this step",
      "preconditions": { "phase": "research" }
    }
  ]
}
```

### Hash derivation

1. Clone plan, drop `approved_at` + `payload_hash`.
2. Serialize with stable-stringify: object keys sorted recursively, arrays preserve order.
3. `payload_hash = sha256(canonical).hex()`.

Approval sets `approved_at = <now>` and `payload_hash = sha256(...)`. Any subsequent mutation of any other field invalidates the hash — `verify` and `apply` both recompute and reject on mismatch.

## Receipt file

Written to `.blog-agent/plans/<slug>.receipt.json` after `blog agent apply`. Shape:

```json
{
  "plan_id": "<plan_id>",
  "plan_payload_hash": "<sha256 hex of the plan that wrote this receipt>",
  "slug": "<slug>",
  "workspace_root": "<absolute>",
  "applied_at": "<first-start ISO 8601>",
  "completed_at": "<last-success ISO 8601 | null>",
  "overall_exit": 0,
  "steps": [
    {
      "step_number": 1,
      "command": "blog research finalize",
      "args": ["<slug>"],
      "status": "completed | failed | skipped",
      "exit_code": 0,
      "stdout_tail": "<last ~2KB>",
      "stderr_tail": "<last ~2KB>",
      "started_at": "<ISO 8601>",
      "completed_at": "<ISO 8601>",
      "duration_ms": 1234
    }
  ]
}
```

The receipt is the mutable execution record; the plan file is the immutable review artifact. Resuming `apply` reads the receipt and skips steps marked `completed` — but only when both `plan_id` AND `plan_payload_hash` match the current plan. A mismatch on either (different plan, re-approval, or a hand-edit to the receipt) surfaces as `RECEIPT_CONFLICT` or `RECEIPT_HASH_MISMATCH` and requires `--restart` to proceed. This closes the "receipt edit silently suppresses approved steps" vector.

## Legacy `skills/blog-*.md` reference material

The repo ships eight phase-specific reference files under `skills/`:

- `skills/blog-research.md`
- `skills/blog-benchmark.md`
- `skills/blog-draft.md`
- `skills/blog-evaluate.md`
- `skills/blog-pipeline.md`
- `skills/blog-update.md`

These remain in-repo as prose references; `/blog` links out to them for phase-specific judgment material. They are surveyed by `tests/skills-crossref.test.ts` and `src/cli/status.ts` output.
