# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/blog` Claude Code plugin — single orchestration skill that classifies intent, proposes a plan, gets user approval, and hands off to the CLI. Ships in the npm tarball at `.claude-plugin/`. Three install paths documented in `docs/plugin-install.md`.
- `blog agent` CLI subcommand family: `preflight`, `plan`, `approve`, `verify`, `apply`. Plan files are SHA256-bound — `approved_at` + `payload_hash` are set atomically by `approve`; any post-approval edit is rejected at `verify`/`apply` with `[AGENT_ERROR] HASH_MISMATCH`. `apply` is resumable by default via DB-authoritative per-step state (see below) plus a `.blog-agent/plans/<slug>.receipt.json` audit mirror; `--restart` re-runs from step 1. Error taxonomy: `SCHEMA_INVALID`, `NO_APPROVAL`, `HASH_MISMATCH`, `WORKSPACE_MISMATCH`, `UNKNOWN_COMMAND`, `STEP_FAILED`, `RECEIPT_CONFLICT`, `RECEIPT_HASH_MISMATCH`.
- **DB-authoritative agent-plan execution state (schema v4):** `agent_plan_runs` and `agent_plan_steps` tables store the authoritative per-step completion record. The receipt JSON is now an audit mirror derived from the DB on every write — tampering the receipt is a no-op (neither skip-state nor `RECEIPT_CONFLICT` is consulted from the file). Closes the Phase-8 Codex adversarial finding (High #1: "receipt hash binding does not authenticate completed-step list") plus the Phase-9 Medium ("receipt tampering still forces RECEIPT_CONFLICT").
- **Slug-scoped exclusive apply lock:** `src/core/plan-file/apply-lock.ts` serializes concurrent `blog agent apply` runs on the same `slug` (not `plan_id`) via O_CREAT|O_EXCL lockfile with a JSON stamp (PID + acquired-at). Two different plans for the same slug serialize. Stale-reclaim policy is explicitly PID-liveness-only: PID alive → held; PID dead (ESRCH) → reclaim; PID reuse is a known edge case requiring manual lockfile deletion (documented in the module header). Closes Codex Phase-9 High #3.
- **`plan.slug` validated at the shared-schema layer:** `validatePlanSchema` now calls `validateSlug()` on `plan.slug` so a hand-authored plan with `slug: "../../outside"` is rejected at `blog agent verify`/`apply`, not just at `blog agent plan`. Before the fix, a malicious plan could bypass the CLI's upstream clamp and reach `defaultReceiptPath` / `defaultLockPath`, which interpolate the raw slug into filesystem paths. Closes Codex Phase-9 Pass-2 Critical.
- **`--restart` clears all open runs for the slug:** not just the current `plan_id`. A crashed prior plan no longer leaves a stale `agent_plan_runs` row that permanently triggers `RECEIPT_CONFLICT` on every future plan for the same slug. `blog agent apply --restart` is now the documented recovery path from arbitrary stuck state. Closes Codex Phase-9 Pass-2 High.
- **Step-slug binding: `args[0]` must equal `plan.slug` for slug-bearing commands:** every `blog X Y <slug>` subcommand is enumerated in `SLUG_BEARING_STEP_COMMANDS` and rejected at schema validation if the step's first positional disagrees with `plan.slug`. Before the bind, a plan declaring `slug: alpha` could execute `blog research finalize beta`, mutating a different post while the apply lock + `agent_plan_runs.slug` audit trail recorded `alpha`. Closes Codex Pass-3 High.
- **Canonical leaf-command allowlist for plan steps:** Pass-3's slug binding was bypassable two ways — (a) whitespace variants (`"blog  research  finalize"`) that split differently in `stepToArgv` than in `.includes()`, (b) namespace-only commands (`{command: "blog research", args: ["finalize", "beta"]}`) that smuggled the real subcommand through `args`. The validator now requires `step.command` to be single-space canonical AND an exact member of `KNOWN_LEAF_COMMANDS`. `KNOWN_LEAF_COMMANDS` contains ONLY true leaves — commands without further Commander subcommands beneath them (`blog status`, `blog metrics`) plus every slug-bearing subcommand. Commands with subcommand children (even with Commander default-action patterns like `blog ideas`) are excluded because args like `["start", "1"]` would still dispatch to the mutating subcommand. Workspace-global mutators (`blog init`, `blog ideas add/start/remove`) remain operator-only. Closes Codex Pass-4 High, Claude Pass-4 High, Codex Pass-5 High, Codex Pass-6 High, and Claude Pass-6 Critical.
- **`blog agent apply` pins spawned children to `plan.workspace_root`:** apply prepends `--workspace <plan.workspace_root>` to every spawned child's argv AND scrubs `BLOG_WORKSPACE` from child env. Before the fix, a parent invocation that passed workspace validation could still spawn children that re-resolved workspace from inherited `BLOG_WORKSPACE`, executing the approved plan's steps against a different workspace than its hash bound to. Closes Codex Pass-6 High.
- **Startup shim rejects empty `--workspace` operand:** `--workspace=` and trailing `--workspace` with no operand now exit with an explicit diagnostic before any subcommand runs. Pre-fix, an empty value silently fell back to `BLOG_WORKSPACE`/ancestor walk — a typo'd operator command could run against an ambient workspace unintentionally. Closes Codex Pass-6 Medium.
- **Crash-recovery sentinel for interrupted `blog agent apply`:** apply writes a pre-spawn sentinel (`.<plan_id>.attempt-<step>`) BEFORE spawning each step and deletes it AFTER the DB completion record commits. If a sentinel survives without a completed DB row at resume time, the parent crashed between child exit and recordStep — the child may have succeeded against non-idempotent domain state. Resume refuses with `CRASH_RECOVERY_REQUIRED`; `--restart` clears sentinels + stale open runs. Closes Codex Pass-7 High #2.

### Known residual risk (v0.2 → v0.3)

- **Plan hash does not bind `.blogrc.yaml` state.** The approval gate covers `{intent, content_type, depth, venues, steps[]}` but NOT the resolved `.blogrc.yaml` the apply pipeline reads at runtime. An operator who edits `.blogrc.yaml` (e.g. toggles `publish.devto`) between `approve` and `apply` can alter the pipeline's destinations without changing the plan hash. Workaround for v0.2: re-approve any plan whose `.blogrc.yaml` has been edited since original approval. Full config-hash binding (plan carries `config_hash`, verify/apply recompute and refuse on mismatch) is deferred to v0.3 (Codex Pass-7 High #1, accepted residual risk per release.md's convergence guidance).
- **Startup shim --workspace parsing hardened:** (a) recognizes both `--workspace <path>` and `--workspace=<path>` (compact form) so CLI semantics match Commander's parser. (b) The shim's positional walk now excludes the workspace operand slots, so `blog --workspace /abs agent preflight` correctly classifies `agent` as the first positional instead of the workspace path. Closes Codex Pass-5 Medium.
- **`blog agent preflight` honors the already-resolved `--workspace` override:** previously preflight re-resolved workspace from `_BLOG_ORIGINAL_CWD` (pre-chdir cwd) and reported `workspace_detected=false` for users running `blog --workspace /abs/path agent preflight` from outside `/abs/path`. Now trusts `process.cwd()` (which the startup shim has already chdir'd to the override) and omits `envVar` from the resolver call so `--workspace` wins over `BLOG_WORKSPACE` per the documented precedence. Closes Codex Pass-3 Medium + Codex Pass-4 Medium.

### Removed

- `--dry-run` flag on `blog publish start` — only `crosspost-devto` honored it while `createSitePR` and `pushCompanionRepo` still produced real Git/GitHub side effects, making the flag a rollback hazard. Removed entirely until v0.3 threads dry-run through every side-effecting publish step. Closes Codex Pass-3 High.
- **Workspace-root requirement extended to `agent plan/approve/verify/apply`:** previously the entire `agent` family bypassed workspace detection, letting `agent plan` stamp an arbitrary cwd as trust root. Now only `agent preflight` (plus `init`, help, version) is workspace-free. Closes Codex finding High #3.
- **`--output` + default-path clamp on `blog agent plan`:** both the explicit `--output` branch AND the default `<slug>.plan.json` branch now apply the same containment check, run `validateSlug()` before any path is built (so `slug = '../../outside'` is rejected early), and `lstat` the final path to refuse pre-existing symlinks. Before this, a raw slug in the default branch restored the write-anywhere primitive even with the `--output` guard. Closes Codex Phase-9 Critical.
- **Banned global flags in plan-step `args`:** `--workspace`, `--workspace=…`, `--help`, `-h`, `--version`, `-V` now fail schema validation when embedded inside step args. The CLI startup shim hoists `--workspace` from anywhere in argv, so without this guard an approved step could execute against a workspace other than the one the plan's hash binds to. Closes Codex Phase-9 High #2.
- **Validator rejects flag-like tokens embedded inside `PlanStep.command`:** `"blog status --unsafe-flag"` is now a schema violation; flags must live in `args` where the hash gate covers them individually.
- `--json` envelope surface across six commands: `blog status`, `blog agent preflight`, `blog publish show`, `blog update show`, `blog unpublish show`, `blog evaluate show`. Versioned envelope `{schema_version: "1", kind, generated_at, data}` with typed `kind` per command. Human table remains the default.
- Workspace-root detection CLI-wide via `src/core/workspace/root.ts#findWorkspaceRoot`. Ancestor-walks from cwd to `.blog-agent/state.db`; respects `--workspace <path>` flag and `BLOG_WORKSPACE` env var. CLI startup chdirs to the detected root so all module-level `resolve('.blog-agent/...')` constants work from any subdirectory.
- Plan schema v2: `{schema_version, plan_id, slug, workspace_root, created_at, approved_at, payload_hash, intent, content_type, depth, venues, expected_start_phase, steps[]}`. Content type locked to the 3-value enum; depth ∈ `park | fast-path | full`. Every step is a concrete `{command, args}` pair — abstract action strings rejected.
- Scoped rules file `.claude/rules/skills.md` auto-loads when editing `.claude-plugin/skills/**`.
- `tests/skill-smoke.test.ts` now scans `JOURNEYS.md` and `CHECKPOINTS.md` for the same discipline as `SKILL.md` (no bare destructive exec fences, no hardcoded identity values, no Write/Edit/Bash(gh:*) scope references). Previously only `SKILL.md` was checked and sibling docs drifted.

### Changed

- README Quick Start is skill-first: leads with `/blog` and the plugin install path; the CLI walkthrough moves below as "Using the CLI underneath."
- README CLI Reference now documents the `blog agent` family (`preflight`, `plan`, `approve`, `verify`, `apply`) that the `/blog` skill drives.
- JOURNEYS.md uses `<your-user>`/`<your-domain>` placeholders instead of hardcoded identity values, and presents plan steps as JSON data (not shell invocations) to make the "skill proposes; CLI executes under hash gate" boundary unambiguous.
- `docs/plugin-install.md` troubleshooting section reflects the tightened `allowed-tools: Bash(blog:*) Read Grep Glob` scope (no Write, no Edit, no Bash(gh:*)).

### Fixed

- CLAUDE.md `src/skills/` reference was stale — the agent's skill definitions live under `.claude-plugin/skills/blog/` now. Updated Project Structure table and Key Rules accordingly.
- CWD-bound workspace resolution — running any `blog` subcommand from a subdirectory below the workspace root would previously fail with "No state database found" because `resolve('.blog-agent/state.db')` used the cwd. The new startup shim chdirs to the detected workspace root before any module imports, so existing relative-resolve constants resolve correctly.
- **`/blog` skill exec fences with literal `<placeholder>` tokens would fail shell parse.** `SKILL.md` and `JOURNEYS.md` contained `!`blog agent verify <plan-path>`` style templates. Claude Code executes `!`…`` verbatim in bash, so `<plan-path>` parsed as stdin redirection and the command failed with `parse error near `>`` on the first live dogfood invocation. Fixed by replacing every `<…>` token inside `!`…`` fences with explicit `"$VAR"` bash-variable form, making the substitution responsibility visible to Claude before shell-exec. New `tests/skill-smoke.test.ts` check (3 tests — one per `.md` sibling) rejects any exec fence containing an unsubstituted `<…>` token, so future drift surfaces as a failing test.

## [0.1.0] — 2026-04-18

### Added

- Foundation: SQLite state database with WAL journaling, `.blogrc.yaml` config loader, Commander.js CLI entry point, and m0lz.00 post import (Phase 1).
- Research pipeline with source tracking, structured research documents, and schema-validated finalization (Phase 2).
- Benchmark test-harness scaffolding, environment capture, and reproducible `METHODOLOGY.md` generation (Phase 3).
- MDX drafting with content-type routing, Excalidraw diagrams, benchmark data tables/charts, and placeholder-token safety (Phase 4).
- Three-reviewer adversarial evaluation panel: Claude structural + Codex GPT-5.4 high adversarial + Codex GPT-5.4 xhigh methodology, with consensus/majority/single synthesis, mandatory artifact-hash provenance, and slug-scoped FS locking (Phase 5).
- 11-step publish pipeline with SQLite step tracking, per-slug filesystem lock, resume-on-failure, origin-URL verification before every repo touch, and probe-then-mutate patterns for external APIs (Phase 6).
- Update + unpublish lifecycle flows sharing one pipeline runner via `publishMode` dispatch; first-class `update_cycles` table with partial unique index; explicit `is_update_review` flag; cycle-keyed notice marker; shared `finalizePipelineUnderLock` helper; metrics audit log for every destructive/cycle action (Phase 7).
- Shared `src/core/paths.ts` helper (`findPackageRoot` + `TEMPLATES_ROOT`) replacing four per-file inline offset-arithmetic template-path resolutions.
- `npm pack` validation script (`scripts/verify-pack.mjs`) enforcing an explicit allowlist of shipped files and denylist of secret-carrying paths.
- GitHub Actions CI workflow running lint, tests, build, and pack verification on Node 20.
- Release runbook (`RELEASING.md`) with a literal v0.1.0 command sequence and a template for subsequent releases.
- `.nvmrc` pinning Node 20 for contributors.

### Fixed

- Template loading now resolves from the installed package directory instead of the current working directory. Previously, `blog publish`, `blog update`, and `blog init` silently failed or emitted unhelpful errors when run from any directory other than the agent's own checkout — `init` in particular would silently skip copying `.blogrc.example.yaml` and `.env.example` when the operator's CWD lacked those files, leaving them with an empty workspace.

[0.1.0]: https://github.com/jmolz/m0lz.01/releases/tag/v0.1.0
