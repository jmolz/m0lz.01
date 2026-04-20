---
paths:
  - "src/core/plan-file/**"
  - "src/cli/agent.ts"
  - "src/cli/index.ts"
  - "src/core/workspace/**"
  - "src/core/json-envelope.ts"
---

# Plan-File Safety Boundary Conventions

Rules that auto-load when editing the `/blog agent` CLI family, the plan-file
schema/validator/apply runner, the startup shim, or the workspace-root
resolver. Every invariant below was forged across seven adversarial review
passes (1 Claude evaluator + 6 Codex GPT-5.4 high) on the Tier-2
`blog-skill-plugin` contract before the feature shipped. **Do NOT revert any
of them without re-running adversarial review** — the attack vector each
closes is documented inline.

## The validator's view must EXACTLY match the executor's view

`stepToArgv` in `src/core/plan-file/apply.ts` splits `step.command` on
`/\s+/` and concatenates with `step.args`. Every check `validateStep` makes
on `command` must operate on the SAME split. Divergence between these two
views is the root cause of every Pass-4 and Pass-5 bypass.

**Canonical form is mandatory.** After splitting into `commandWords`, the
validator requires `step.command === 'blog ' + commandWords.join(' ')` —
rejecting double-space (`"blog  research  finalize"`), trailing whitespace,
tab/newline variants, and leading space. Without this, `.includes(KNOWN_LEAF_COMMANDS)`
silently missed the allowlist match while `stepToArgv` normalized and spawned
the real subcommand.

## `KNOWN_LEAF_COMMANDS` admits TRUE leaves only

A "true leaf" is a Commander command path with NO registered subcommands
beneath it. `blog status` and `blog metrics` qualify. `blog ideas` does
NOT — it has `add/start/remove` children via Commander's default-action
pattern, and a step like `{command: "blog ideas", args: ["start", "1"]}`
would dispatch to the mutating subcommand while validation saw only the
namespace parent.

Workspace-global mutators (`blog init`, `blog ideas add/start/remove`)
remain deliberately excluded. Their effects are not bound to `plan.slug`
and their targets can shift between approval and apply (e.g.,
`ideas start 1` resolves the current backlog INDEX, which is mutable).
If a future plan needs workspace-global mutation, it requires a separate
workspace-global plan type with its own lock and immutable target binding
— NOT re-adding a subcommand-bearing root to this allowlist.

## Slug binding: `args[0]` must equal `plan.slug`

Every command listed in `SLUG_BEARING_STEP_COMMANDS` takes the target
post's slug as its first positional argument. The validator's second pass
requires `args[0] === plan.slug` for those commands. Without this, a
plan declaring `slug: alpha` could execute `blog research finalize beta`,
mutating a different post while the apply lock + `agent_plan_runs.slug`
record `alpha` — the slug-scoped audit trail would lie.

Every new Commander `<slug>` entry point lands in BOTH
`SLUG_BEARING_STEP_COMMANDS` AND `KNOWN_LEAF_COMMANDS` in the same commit
as the CLI registration.

## `validateSlug` at BOTH layers — CLI boundary AND shared schema

`blog agent plan <slug>` calls `validateSlug(slug)` in the CLI handler
BEFORE building any path. But `validatePlanSchema` also calls
`validateSlug(plan.slug)` — because a hand-authored or hand-edited plan
with `slug: "../../outside"` otherwise sails through verify/approve/apply
and reaches `defaultReceiptPath` / `defaultLockPath`, which build
filesystem paths from the raw slug. Both layers are required; removing
either reopens the traversal vector.

## `--output` clamp: realpath parent + `lstat` leaf

`runAgentPlan`'s `clampOutputPath` helper enforces:

1. Output path is inside `<workspace>/.blog-agent/plans/`.
2. Parent directory is realpath'd before the containment check (macOS
   `/var → /private/var` symlink canonicalization).
3. Final path component is `lstat`'d (not `stat`'d) — a pre-existing
   symbolic link at the leaf is REJECTED, not followed. Without this,
   an attacker who plants a symlink inside `plans/` before the CLI runs
   could redirect the plan write to any path the process can reach.
4. Extension must end in `.plan.json`.
5. The default-path branch (no `--output` given) runs the SAME clamp
   against the derived `<slug>.plan.json` — slug validation upstream
   guarantees the interpolation is safe, but the symlink check still
   applies.

Adding a new path-producing branch to `runAgentPlan` without routing
through `clampOutputPath` reopens the write-anywhere primitive.

## Apply lock is slug-scoped, not plan-id-scoped

`src/core/plan-file/apply-lock.ts` serializes concurrent `blog agent apply`
runs for the same `slug` — including DIFFERENT `plan_id`s for that slug.
The lockfile is `.<slug>.apply.lock`. Slug scope (not plan-id scope) is
load-bearing: two approved plans for the same slug mutate the same
underlying post state; the apply runner handles research/draft phases
that have no downstream slug-lock protection, so concurrent applies must
serialize there.

The lock format is a structured JSON stamp (`pid` + `acquiredAt`). Legacy
bare-PID format is tolerated during rollovers. Reclaim policy is
**honest PID-liveness only** — cross-platform Node has no portable way to
read another process's start time without a subprocess, so PID reuse by
an unrelated process is a known edge case requiring manual lockfile
deletion (`rm .blog-agent/plans/.<slug>.apply.lock`). Do NOT add
false PID-reuse hardening claims to the module header.

## DB is authoritative; receipt is audit mirror

Schema v4 adds `agent_plan_runs` + `agent_plan_steps` tables. Step-skip
authority at resume derives EXCLUSIVELY from `agent_plan_steps` (status
= 'completed'). `RECEIPT_CONFLICT` derives EXCLUSIVELY from
`agent_plan_runs` (open runs for the same slug with a different plan_id).
The JSON receipt file is rewritten from the DB on every step via
`buildReceiptFromDb` → `writeReceiptAtomic`. Tampering the receipt JSON
is a no-op.

Before Pass-2 this was not the case — the receipt file was both the
mutable progress state and the trust boundary. Forging a `status: "completed"`
row could suppress step execution. If a future refactor reads the receipt
FILE to decide anything about skip or conflict state, it has re-opened
the forged-receipt attack. The receipt file is audit output ONLY.

## `--restart` clears ALL open runs for the slug

Not just the current `plan_id`. A crashed prior plan leaves a stale open
row in `agent_plan_runs`; if `--restart` only cleared the current plan's
row, the stale one would keep tripping `RECEIPT_CONFLICT` forever. `--restart`
is the documented recovery path from arbitrary stuck state, so it must
DELETE every `agent_plan_runs` row where `slug = plan.slug AND completed_at IS NULL`
inside the reconcile transaction. Also wipes pre-spawn crash-recovery
sentinels so the next non-restart run is clean.

## Pre-spawn crash-recovery sentinel

`applyPlan` writes `.<plan_id>.attempt-<step>` BEFORE spawning each step
and deletes it AFTER `recordStep` commits. If a sentinel survives
without a completed DB row at resume time, the parent crashed between
child exit and recordStep — the child may have succeeded against
non-idempotent domain state (`blog update start`, `blog publish start`,
`blog benchmark run` all either hard-fail or create duplicate rows on
blind re-run). Resume refuses with `CRASH_RECOVERY_REQUIRED`; the operator
must use `--restart` and consciously discard the prior run.

## Banned global flags in step args

`BANNED_ARG_FLAGS` in `schema.ts` blocks `--workspace`, `--help`, `-h`,
`--version`, `-V` (and `--workspace=...` compact form) inside any step's
`args`. The CLI startup shim hoists `--workspace` from ANY position in
argv BEFORE Commander dispatches, so a plan step with
`args: ["--workspace", "/tmp/attacker"]` would execute against a
workspace the plan's hash does NOT bind to. Adding a new CLI-global
flag of any kind requires a matching entry in `BANNED_ARG_FLAGS`.

## Child workspace pinning

When `applyPlan` spawns each step, it prepends `--workspace <plan.workspace_root>`
to the child argv AND scrubs `BLOG_WORKSPACE` from the child env. Without
this, a parent invocation where parent validation passed could still spawn
children that re-resolve workspace from inherited `BLOG_WORKSPACE` and
chdir somewhere else. Both mechanisms are required — argv prepend is the
primary binding; env scrub is belt-and-suspenders in case the shim's
--workspace precedence regresses.

## Startup shim: `--workspace` parsing

`src/cli/index.ts` handles both `--workspace <path>` (split) and
`--workspace=<path>` (compact). The shim records the argv slots that
belong to `--workspace` (flag + operand) in `skippedIndices` and excludes
them from the `positionals = argv.filter(...)` walk — so
`blog --workspace /abs agent preflight` correctly identifies `agent` as
`firstPositional` (not `/abs`).

Empty or whitespace-only override (`--workspace=`, `--workspace ''`,
trailing `--workspace` with no operand) is rejected explicitly with exit
1 BEFORE any subcommand runs. Silent fallback to env/ancestor-walk would
let a typo'd operator command run against an ambient workspace.

## Preflight trusts post-chdir cwd

`runPreflight` in `src/cli/agent.ts` calls `findWorkspaceRoot(process.cwd())`
WITHOUT passing `envVar: process.env.BLOG_WORKSPACE`. By the time preflight
runs, the startup shim has already applied the full precedence
`--workspace > BLOG_WORKSPACE > ancestor-walk` and `chdir`'d. Passing
`envVar` a second time re-runs the lookup with env winning over cwd,
breaking the documented precedence.

## `agent` is the gate — never a plan step

`DENY_STEP_SUBCOMMANDS = ['agent']` rejects any step that invokes
`blog agent approve/apply/verify <other-plan>`. The outer plan's hash
covers only the literal step string; it does NOT cover the nested plan's
content. Allowing nested agent delegation would let one hash-verified
plan run a different, unverified plan underneath. Keep `agent` in the
deny list forever.

## Known residual risk (v0.2 → v0.3)

**Config-hash binding is deferred to v0.3** (Codex Pass-7 High #1,
accepted residual risk per `release.md`'s convergence guidance). The
approval gate covers `{intent, content_type, depth, venues, steps[]}`
but NOT the resolved `.blogrc.yaml` the apply pipeline reads at runtime.
An operator who edits `.blogrc.yaml` (e.g., toggles `publish.devto`)
between `approve` and `apply` can alter the pipeline's destinations
without changing the plan hash.

Workaround: re-approve any plan whose `.blogrc.yaml` has been edited
since original approval. When v0.3 lands config-hash binding, the plan
will carry a `config_hash` field set at approve time and verified at
verify/apply with a `CONFIG_MISMATCH` error on divergence.

## Adversarial evaluation convergence

The `blog-skill-plugin` feature ran seven passes before Codex returned
clean/approve on the remaining findings (with v0.3 items documented as
accepted residual risk). Expected cadence per `release.md`:

- Pass 1–2: Critical/High findings (structural gate bypasses,
  workspace-global mutators, receipt-as-trust).
- Pass 3–4: High findings (config-driven behavior, crash recovery,
  whitespace + namespace bypasses).
- Pass 5–6: Medium findings (shim parsing edge cases, lock reclaim
  honesty).
- Pass 7+: Convergence. Critical/High items closed with code; remaining
  v0.3 items documented as residual risk in `CHANGELOG.md`.

Every future change to this surface MUST re-run adversarial review. The
bypasses Codex found in Passes 2–7 were not obvious from code reading
alone — each required probing the boundary between validator view and
executor view, between parent shim and spawned child, between receipt
file and DB.
