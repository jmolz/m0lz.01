---
paths:
  - ".claude-plugin/skills/**"
---

# `/blog` Skill Conventions

Rules that auto-load when editing files under `.claude-plugin/skills/**`. These
protect the structural safety boundary between the `/blog` skill (propose,
review, approve) and the CLI (validate hash, execute steps).

## Safety boundary is CLI-native, not prose-gated

**The skill never invokes destructive commands directly.** Every one of
these commands appears in a SKILL.md code fence ONLY inside a
`blog agent apply <path>` handoff:

- `blog research init`, `blog research finalize`
- `blog benchmark init/run/complete`
- `blog draft init/complete`
- `blog evaluate init/complete/reject`
- `blog publish start`
- `blog update start/benchmark/draft/evaluate/publish/abort`
- `blog unpublish start`

The skill may READ state via `blog status --json`, `blog <flow> show --json`,
and `blog agent preflight --json`. Grep-verifiable via `tests/skill-smoke.test.ts`.

## `!`…`` exec fences must use `"$VAR"`, never literal `<placeholder>` tokens

Claude Code executes `!`…`` fences verbatim in bash. A token like `<plan-path>`
inside such a fence parses as stdin redirection (`<` reads from file `plan-path`)
and fails with `parse error near `>`` when followed by nothing, or silently
reads from a nonexistent file otherwise. Every `!`…`` fence in SKILL.md,
JOURNEYS.md, CHECKPOINTS.md MUST substitute real values first — either via
bash-variable form `!blog agent verify "$PLAN"` or by inline-composing the
full command before emission. The surrounding prose states "substitute `$PLAN`
with the real path" so Claude knows to compose before executing.

Descriptive (non-`!`) inline-code spans documenting CLI argument conventions
(`blog agent verify <plan-path>` without a leading `!`) are fine — they are
reference documentation for humans, not shell-exec instructions for Claude.
Grep-verifiable: `tests/skill-smoke.test.ts` fails if any `!`…`` fence in any
of the three skill docs contains a `<…>` token.

## Preflight uses the CLI envelope, never `node -e` or `cat`

The skill's first action on every invocation is `!`blog agent preflight --json``.
Never spawn `node -e`, `cat <.blogrc.yaml>`, or `head` to inspect workspace
state — the `allowed-tools: Bash(blog:*)` scope covers only the blog binary,
and adding `Bash(node:*)` or `Bash(cat:*)` would widen the blast radius for
no benefit.

## All state reads use `--json`

Every `blog status`, `blog publish show`, `blog update show`, `blog unpublish show`,
`blog evaluate show`, `blog agent preflight` call in SKILL.md MUST be
followed by `--json`. Parse the envelope's `data` field. Never parse the
human-facing table — its format is not a stable contract and will drift.
Enforced by body regex in `tests/skill-smoke.test.ts`.

## Plan steps are concrete CLI invocations

Every entry in a plan's `steps` array is `{ command: "blog <subcmd>", args: [...] }`.
Abstract strings like `"run-panel"`, `"init-and-draft"`, `"ship-it"` are rejected
by the validator. The `command` field's first token after `"blog "` must be a
registered top-level subcommand — see `KNOWN_SUBCOMMANDS` in
`src/core/plan-file/schema.ts`.

## SHA256 binding is the structural gate

- `blog agent plan` writes `approved_at: null`, `payload_hash: null`.
- `blog agent approve` atomically sets both in a single `writeFileSync`.
- `blog agent verify` and `blog agent apply` recompute the hash from canonical
  JSON (keys sorted, `approved_at` + `payload_hash` dropped) and reject on
  mismatch with exit 2 `[AGENT_ERROR] HASH_MISMATCH`.

Never hand-edit `approved_at` or `payload_hash` from the skill — the atomic
helper is the only correct approval path.

## Canonical-URL permanence is skill-cited, CLI-unenforced

The skill MUST cite canonical-URL permanence in:

- Slug collision prompts (when a proposed slug exists).
- Any `blog unpublish` approval prompt.

`https://m0lz.dev/writing/<slug>` is the canonical URL forever. The slug is
reserved even after unpublish. This rule lives in the skill prose, not in
the CLI (the CLI can't tell "rename intent" from "deliberate slug reuse"),
so omitting the warning is a silent-failure vector.

## Identity values flow from config, never hardcoded

Do not paste `jmolz`, `m0lz.dev`, or any `DEVTO_API_KEY=...` literal into
SKILL.md, REFERENCES.md, JOURNEYS.md, or CHECKPOINTS.md. Identity values
come from `.blogrc.yaml` (read via `blog agent preflight --json` or `blog
status --json`). Grep-verifiable.

## Checkpoints before apply; per-step output after

The skill owns pre-apply checkpoints (intent classification, slug collision,
plan approval). Post-apply checkpoints are NOT skill-owned — `blog agent
apply` emits per-step output that the operator reads in their terminal, and
the operator re-invokes `apply` to resume. Do not try to make the skill
polling `show --json` after each step; the CLI is the single source of truth.
