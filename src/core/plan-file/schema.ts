// Plan file v2 — the canonical contract between `/blog` skill proposals and
// `blog agent apply` execution. Hash-bound: every field contributes to the
// SHA256 payload hash except `approved_at` + `payload_hash` themselves.
//
// See `.claude/plans/blog-skill-plugin.md` and `.claude-plugin/skills/blog/REFERENCES.md`.

export type PlanContentType = 'project-launch' | 'technical-deep-dive' | 'analysis-opinion';
export const PLAN_CONTENT_TYPES: readonly PlanContentType[] = [
  'project-launch',
  'technical-deep-dive',
  'analysis-opinion',
] as const;

export type PlanDepth = 'park' | 'fast-path' | 'full';
export const PLAN_DEPTHS: readonly PlanDepth[] = ['park', 'fast-path', 'full'] as const;

// Every concrete CLI invocation is recorded as { command, args }. The
// `apply` runner spawns `blog` with args directly — no prose interpretation.
export interface PlanStep {
  command: string;
  args: string[];
  checkpoint_message?: string;
  preconditions?: Record<string, unknown>;
}

export interface PlanFile {
  schema_version: '2';
  plan_id: string;
  slug: string;
  workspace_root: string;
  created_at: string;
  approved_at: string | null;
  payload_hash: string | null;
  intent: string;
  content_type: PlanContentType;
  depth: PlanDepth;
  venues: string[];
  expected_start_phase: string;
  steps: PlanStep[];
}

// Registered top-level `blog` subcommands. Used by the validator to reject
// steps pointing at invented commands (criterion #3: no abstract actions).
export const KNOWN_SUBCOMMANDS: readonly string[] = [
  'init',
  'status',
  'metrics',
  'ideas',
  'research',
  'benchmark',
  'draft',
  'evaluate',
  'publish',
  'update',
  'unpublish',
  'agent',
] as const;

// Subcommands that the CLI registers but that MUST NOT appear as plan steps.
// `agent` is the gate itself — nesting `blog agent approve/apply <other-plan>`
// inside an approved plan would let one hash-verified plan run a different,
// unverified plan underneath. The outer hash covers only the literal step
// string, not the nested plan's content. Banning `agent` from plan steps
// closes this delegation vector (Codex Phase-8 adversarial review, High #2).
export const DENY_STEP_SUBCOMMANDS: readonly string[] = ['agent'] as const;

// Flags that MUST NOT appear inside any plan-step `args` array. Each of these
// is parsed by the CLI startup shim (`src/cli/index.ts`) BEFORE Commander
// dispatches to the subcommand — they are global-behavior knobs. --workspace
// is the high-severity case: a step with `args: ["--workspace", "/tmp/x"]`
// would run against a workspace the plan's hash does NOT bind to, breaking
// the approval gate. --help / --version short-circuit the subcommand, which
// has no legitimate use inside an approved step.
export const BANNED_ARG_FLAGS: readonly string[] = [
  '--workspace',
  '--help',
  '-h',
  '--version',
  '-V',
] as const;

// Commands whose FIRST POSITIONAL ARG is a slug. The validator enforces that
// `args[0]` equals `plan.slug` for every step using one of these commands —
// preventing a plan that declares `slug: alpha` from mutating post `beta`
// via `blog research finalize beta`, which would escape the slug-scoped
// apply lock and record the wrong slug in `agent_plan_runs.slug` (Codex
// Pass-3 High). Enumerated from Commander `<slug>` declarations across
// `src/cli/*.ts`; any new CLI surface that takes a slug as first positional
// must be added here AND to `KNOWN_LEAF_COMMANDS` below in the same commit.
export const SLUG_BEARING_STEP_COMMANDS: readonly string[] = [
  'blog research init',
  'blog research add-source',
  'blog research set-section',
  'blog research show',
  'blog research finalize',
  'blog benchmark init',
  'blog benchmark env',
  'blog benchmark run',
  'blog benchmark show',
  'blog benchmark skip',
  'blog benchmark complete',
  'blog draft init',
  'blog draft show',
  'blog draft validate',
  'blog draft add-asset',
  'blog draft complete',
  'blog evaluate init',
  'blog evaluate structural-autocheck',
  'blog evaluate record',
  'blog evaluate show',
  'blog evaluate synthesize',
  'blog evaluate complete',
  'blog evaluate reject',
  'blog publish start',
  'blog publish show',
  'blog update start',
  'blog update benchmark',
  'blog update draft',
  'blog update evaluate',
  'blog update publish',
  'blog update abort',
  'blog update show',
  'blog unpublish start',
  'blog unpublish show',
] as const;

// Exhaustive allowlist of leaf commands permitted as plan steps. A "leaf" is
// the FULL executable command path (`blog <top>` or `blog <top> <sub>`) —
// NOT a namespace parent like `blog research`. This closes two bypasses of
// the slug-binding check found in Codex Pass 4:
//
//   Whitespace variants: pre-fix, `{ command: "blog  research  finalize" }`
//   passed the `.includes(SLUG_BEARING_STEP_COMMANDS)` lookup because the
//   allowlist entries are single-space canonical, but `stepToArgv` splits
//   on `/\s+/`. Canonicalizing the command to single-space form and
//   matching against this allowlist closes that gap.
//
//   Namespace smuggling: pre-fix, `{ command: "blog research", args:
//   ["finalize", "beta"] }` passed — `research` is a known top-level
//   subcommand, `commandWords.length` was only 1, and `step.command` was
//   not in `SLUG_BEARING_STEP_COMMANDS`. But `stepToArgv` concatenated
//   commandWords + args, so the spawned process ran `blog research
//   finalize beta` against `beta`, not `plan.slug`. Requiring the full
//   leaf path in `command` closes this gap.
//
// Non-slug-bearing entries must be TRUE LEAVES — commands with NO further
// Commander subcommand dispatch. Workspace-global MUTATORS (`blog init`,
// `blog ideas add/start/remove`) were removed in Pass-5; the NAMESPACE
// PARENT `blog ideas` was removed in Pass-6 because Commander's
// default-action pattern still dispatched `args: ["start", "1"]` to the
// mutating `start` subcommand, re-opening the Pass-5 attack through an
// args-smuggling vector.
//
// The only safe slug-free leaves are ones whose root command has NO
// registered subcommands under it — `blog status` and `blog metrics`
// qualify, `blog ideas` does not (it has add/start/remove children via
// Commander).
//
// If a future plan genuinely needs backlog-edit or workspace-init
// behavior, the correct path is a separate workspace-global plan type
// with its own lock and immutable target binding — NOT re-adding a
// subcommand-bearing root to this allowlist.
//
// Any new CLI entry point must land here in the same commit as its
// Commander registration — otherwise the skill cannot call it.
export const KNOWN_LEAF_COMMANDS: readonly string[] = [
  // Slug-free, read-only LEAVES with NO Commander subcommands beneath.
  // Do NOT add subcommand-bearing roots here: their default action is
  // bypassed when args contain a registered subcommand name.
  'blog status',
  'blog metrics',
  // All slug-bearing leaves (see SLUG_BEARING_STEP_COMMANDS).
  ...SLUG_BEARING_STEP_COMMANDS,
] as const;
