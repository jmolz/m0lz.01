# Checkpoints

Every human-in-the-loop moment in the `/blog` flow. Checkpoints inside the skill are **all pre-apply** (intent classification, plan proposal, approval). Post-apply checkpoints come from `blog agent apply`'s per-step stdout — the operator watches their terminal and re-runs `apply` to resume when needed.

## Pre-apply (skill-owned)

### CP1 — Intent classification ambiguity
- Trigger: user's natural-language prompt leaves a dimension (slug, content_type, depth, venues) ambiguous.
- Action: ask the minimum question to disambiguate. Do not invent values.

### CP2 — Slug collision
- Trigger: `blog status --json` shows the proposed slug already exists.
- Action: report the existing slug's phase. Ask: resume, rename (if not yet published), or abort. Cite canonical-URL permanence.

### CP3 — Expand steps to concrete commands
- Trigger: the skill has classified intent and is ready to write the plan.
- Action: call `blog agent plan <slug> ... --steps-inline '<json-array>'` with concrete `{command, args}` rows. The skill never hand-edits plan JSON — tool scope excludes `Write`/`Edit` by design so every byte of the plan originates from the CLI. Reject abstract strings and `blog agent *` nesting — the validator rejects both.

### CP4 — Plan approval
- Trigger: proposed plan ready for execution.
- Action: show the final plan as a table. Ask: `yes` / `edit <n>` / `abort`. On `yes`, invoke `blog agent approve` then `blog agent verify` then `blog agent apply`.

### CP5 — Destructive-action confirmation
- Trigger: plan contains any of `blog publish start`, `blog update publish`, `blog unpublish start`, `blog evaluate complete`, `blog evaluate reject`.
- Action: name the destructive step explicitly in the approval prompt. For `unpublish start`, cite canonical-URL permanence verbatim.

### CP6 — Plan edit loop
- Trigger: user responds `edit <n>` at CP4.
- Action: ask which field of step `<n>` to change. Re-invoke `blog agent plan` with an updated `--steps-inline` payload — the CLI overwrites the plan file, resets `approved_at` + `payload_hash` to null, and assigns a fresh `plan_id`. Loop back to CP4.

### CP7 — Resume ambiguity
- Trigger: `/blog` invoked with no argument; multiple in-flight posts or plans exist.
- Action: list candidates with their `phase` + plan/receipt state. Ask which to resume.

## Post-apply (CLI-owned via stdout/stderr)

These are NOT skill checkpoints — `blog agent apply` emits them to stdout as it runs, and the operator reads them directly. If the operator wants to resume after a pause, they invoke `blog agent apply <path>` again (skipping completed steps via the receipt).

### P1 — `preview-gate` pause (publish + update flows)
- Trigger: a site PR is open but unmerged.
- Operator action: review and merge the PR on GitHub, then re-run `blog agent apply`.

### P2 — `site-revert-pr` pause (unpublish flow)
- Trigger: revert PR is open but unmerged.
- Operator action: review and merge the revert PR, then re-run `blog agent apply`.

### P3 — `STEP_FAILED` error
- Trigger: a step's `blog <subcmd>` exited non-zero.
- CLI action: emits `[AGENT_ERROR] STEP_FAILED` + receipt path. Receipt's `stderr_tail` has the failure reason.
- Operator action: fix the underlying issue, re-run `blog agent apply` (resumes from the failed step) or `--restart` to re-run from step 1.

### P4 — `HASH_MISMATCH` error
- Trigger: plan was edited after approval.
- CLI action: emits `[AGENT_ERROR] HASH_MISMATCH` + expected vs recomputed hash.
- Operator action: `blog agent approve` to re-sign, or revert the unwanted edit.

### P5 — `RECEIPT_CONFLICT` error
- Trigger: a receipt from a prior `plan_id` exists at the destination path.
- CLI action: emits `[AGENT_ERROR] RECEIPT_CONFLICT`.
- Operator action: `blog agent apply --restart` to start fresh, or remove the stale receipt manually.

### P6 — `RECEIPT_HASH_MISMATCH` error
- Trigger: the receipt exists for the same `plan_id` but its bound `plan_payload_hash` differs from the plan's current hash — either the plan was re-approved, or the receipt was hand-edited to suppress skip authority.
- CLI action: emits `[AGENT_ERROR] RECEIPT_HASH_MISMATCH` with both hashes in the message.
- Operator action: `blog agent apply --restart` to rewrite the receipt from scratch. Investigate before restarting if a re-approval was not intended.

## What never happens inside the skill

- **The skill never invokes** any of: `blog research init/finalize`, `blog benchmark init/run/complete`, `blog draft init/complete`, `blog evaluate complete/reject`, `blog publish start`, `blog update publish`, `blog unpublish start`, `blog update start`, `blog update abort`.
- All of those live inside `blog agent apply`, behind hash-verified approval.
- The skill is allowed to READ state via `blog status --json`, `blog <flow> show <slug> --json`, and `blog agent preflight --json`.
