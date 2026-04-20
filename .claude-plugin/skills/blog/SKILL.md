---
name: blog
description: Orchestrate m0lz.01 content lifecycle. Describe your intent in natural language; I'll propose a plan, get your approval, and hand off to the CLI for structural-safety-gated execution.
argument-hint: [what you want to do]
allowed-tools: Bash(blog:*) Read Grep Glob
---

# `/blog` — propose → approve → apply

You are the coordination layer for the m0lz.01 content pipeline. Every **destructive or network-touching** action flows through `blog agent apply`, never directly from this skill. The CLI validates a SHA256-bound plan file before it runs anything; tampering after approval is rejected structurally.

## 1. Preflight

State snapshot:

!`blog agent preflight --json`

Parse the `AgentPreflight` envelope. If `data.workspace_detected` is `false`, respond: "No m0lz.01 workspace detected here. `cd` into an existing workspace or run `blog init`." and STOP. If `data.config_valid` is `false`, list `data.config_errors` and ask the user to fix before proceeding.

## 2. Classify intent

Ask the user exactly enough to fill four dimensions. Infer what you can from the prompt; ask only about what's ambiguous.

| Dimension | Options | Notes |
|---|---|---|
| **slug** | new, existing in-workspace, or existing GitHub project | Read `blog status --json` to detect collisions. Canonical URL is permanent — an existing slug's phase dictates next steps. |
| **content_type** | `project-launch`, `technical-deep-dive`, `analysis-opinion` | Enum is schema-locked. Do not invent values like `park-research`. |
| **depth** | `park`, `fast-path`, `full` | `park` = capture and leave; `fast-path` = skip benchmark; `full` = research → benchmark → draft → evaluate → publish. |
| **venues** | comma-separated subset of `hub`, `devto`, `hn`, `linkedin`, `medium`, `substack` | `hub` (the canonical site from `.blogrc.yaml#site.base_url`) is always included on a publish path. |

### Slug collision

Before proposing a plan for a new slug, parse `blog status --json` and grep `data.posts[].slug`. If the proposed slug exists, report its current `phase` and ask the user whether to resume, pick a new slug, or abort. Never rename a slug after publishing — the canonical URL `<site.base_url>/writing/<slug>` is permanent.

## 3. Propose the plan

Summarize the classification and render the proposed step sequence as a markdown table. Each row MUST name a concrete `blog <subcommand>` — no abstract actions like "run the panel" or "init-and-draft".

**Research phase — two-gate finalize:** When the post is in `research` and the doc has empty `{{placeholder}}` sections OR fewer than `config.evaluation.min_sources` (default 3) DB-tracked sources, finalize will fail. The plan must include either (a) `blog research set-section` steps to populate the 7 sections AND `blog research add-source` steps to meet the source floor, OR (b) a clear "pause here, operator authors interactively then resumes" checkpoint before finalize. Option (a) is the skill-driven path and is preferred for project-launch posts where the source material is the repo/artifact itself; option (b) fits deep-dive research where the operator wants interactive drafting. `REFERENCES.md § Research phase authoring` documents the two-gate contract.

Example step sequence for `fast-path` + `project-launch` starting from `research` (with research authoring inline):

| Step | Command | Purpose |
|---|---|---|
| 1a..1g | `blog research set-section <slug> --section <key> --content "<prose>"` | One step per section key (thesis, findings, sources_list, data_points, open_questions, benchmark_targets, repo_scope). Skill composes prose from in-conversation approval before emitting. |
| 1h..1j+ | `blog research add-source <slug> --url "<...>" --title "<...>" --excerpt "<...>"` | At least 3; omit if operator has added sources interactively. |
| 2 | `blog research finalize <slug>` | Validate both gates (sections + source count) |
| 3 | `blog draft init <slug>` | Scaffold the MDX draft |
| 4 | `blog draft complete <slug>` | Advance to evaluate |
| 5 | `blog evaluate init <slug>` | Open the evaluation cycle |
| 6 | `blog evaluate record <slug> --reviewer structural --report <path> --issues <path>` | Record the structural reviewer |
| 7 | `blog evaluate synthesize <slug>` | Compute verdict |
| 8 | `blog evaluate complete <slug>` | Gate pass → publish-ready |
| 9 | `blog publish start <slug>` | Run the 11-step publish pipeline |

Every destructive step (`draft init`, `evaluate complete`, `publish start`, any `update`/`unpublish` command) MUST appear only inside a `blog agent apply` handoff — never as a direct invocation from this skill. Research-authoring steps (`set-section`, `add-source`) are destructive in the same sense — they live inside the plan, not in the skill's direct exec scope.

## 4. Write the plan file

Invoke `blog agent plan` with the proposed steps passed inline — the CLI generates the `plan_id`, detects `workspace_root`, validates schema on write, and refuses to start if anything is malformed. The skill **never hand-edits plan JSON**; the tool scope does not grant `Write` or `Edit`, and that is intentional — every byte of the plan file originates from the CLI so the hash gate stays enforceable.

Compose the invocation by substituting every `<…>` token with the classified value, then emit the final line to the shell:

```
!blog agent plan "$SLUG" --intent "$INTENT" --content-type "$TYPE" --depth "$DEPTH" --venues "$VENUES" --steps-inline "$JSON"
```

Never emit a literal `<slug>` or `<json>` token to the shell — `<` parses as stdin redirection and the command fails.

`--steps-inline` is a JSON array of `{ "command": "blog <subcmd>", "args": [...], "checkpoint_message": "..." }` objects. The validator rejects abstract action strings, unknown subcommands, and nested `blog agent *` delegation (a plan cannot call another `agent apply`). The CLI prints the plan path; `Read` it back to render the approval table.

## 5. Approval gate

Show the final plan (rendered as a table, not the raw JSON) and ask:

> **Approve this exact plan?** (`yes` / `edit <n>` / `abort`)

- **`yes`** — capture the plan path printed by `blog agent plan` into a shell variable, then run approve → verify → apply with that variable (each on its own `!` line):

  ```
  !PLAN="/absolute/path/from/blog-agent-plan-stdout.plan.json"
  !blog agent approve "$PLAN"
  !blog agent verify "$PLAN"
  !blog agent apply "$PLAN"
  ```

  Substitute `$PLAN` with the real path before emitting each `!` line — never emit a literal `<plan-path>` token to the shell (the `<` parses as stdin redirection and the command fails).

  The `apply` command spawns each `blog <subcmd>` in sequence and writes a receipt at `.blog-agent/plans/<slug>.receipt.json` with per-step exit codes, stdout tails, and durations. The receipt is **bound to the plan's `payload_hash`** — a receipt edit or a plan re-approval forces `--restart`, so skip authority cannot be silently suppressed. Resume is the default; use `--restart` only when the CLI explicitly asks for it.

- **`edit <n>`** — ask which field of step `<n>` to change, then **re-invoke `blog agent plan`** with an updated `--steps-inline` payload. The CLI overwrites the plan file, resets `approved_at` + `payload_hash` to `null`, and assigns a fresh `plan_id`. Loop back to step 5.

- **`abort`** — tell the user the plan file at `<plan-path>` can be deleted manually with `rm` (the skill cannot touch the filesystem directly). Stop.

## 6. Resume

If the user runs `/blog` with no argument, detect in-flight work:

- Parse `blog status --json` for `data.posts[]` with `phase !== 'published' && phase !== 'unpublished'`.
- Glob `.blog-agent/plans/*.plan.json` for existing plans.
- Cross-reference with `.blog-agent/plans/*.receipt.json` to see what ran.

Present the candidates and ask which to resume. Re-enter step 3 with the existing plan; if the plan's `payload_hash` is set, skip to step 5.

## 7. Error taxonomy

`blog agent apply` emits `[AGENT_ERROR] <CODE>: <msg>` on stderr with these codes:

| Code | Exit | Meaning |
|---|---|---|
| `SCHEMA_INVALID` | 2 | Plan JSON failed schema validation — fix the plan shape |
| `NO_APPROVAL` | 2 | `approved_at` is null — run `blog agent approve` |
| `HASH_MISMATCH` | 2 | Plan was modified after approval — re-approve |
| `WORKSPACE_MISMATCH` | 2 | `plan.workspace_root` ≠ detected root — re-run from the correct workspace |
| `UNKNOWN_COMMAND` | 2 | A step's `command` is not a registered `blog` subcommand |
| `STEP_FAILED` | 1 | A step's exit code ≠ 0 — check the receipt for stderr tail |
| `RECEIPT_CONFLICT` | 2 | Existing receipt belongs to a different `plan_id` — use `--restart` |
| `RECEIPT_HASH_MISMATCH` | 2 | Receipt's bound `plan_payload_hash` differs from the plan's current hash (re-approval or tamper) — use `--restart` |

On any `[AGENT_ERROR]`, surface the full message to the user and stop — do NOT attempt recovery from the skill. The CLI is the single source of truth for gate state.

## References

- [REFERENCES.md](./REFERENCES.md) — CLI surface, phase state machine, plan schema
- [JOURNEYS.md](./JOURNEYS.md) — worked examples
- [CHECKPOINTS.md](./CHECKPOINTS.md) — every human-in-the-loop moment
