# Journeys

Four worked examples of the `/blog` flow. Each shows the concrete CLI handoffs the skill emits, the plan-step *payload* it hands to `--steps-inline`, and the human checkpoint that gates execution.

Terminology:

- **CLI handoff** — the literal `!`blog …`` shell invocation the skill makes (the skill only has `Bash(blog:*)` scope, so these are the only shell operations available).
- **Plan step** — a `{ command, args }` JSON object embedded in the `--steps-inline` payload. Plan steps are *data* fed to `blog agent plan`; they do NOT execute until the approved plan is passed to `blog agent apply`. The skill never shells out to a plan step directly — that is the whole point of the hash gate.

All identity values (`<your-user>`, `<your-domain>`, etc.) come from `.blogrc.yaml` via `blog agent preflight --json` / `blog status --json`. Never hardcode.

## Journey A — New project launch (fast-path, Show HN)

**Intent**: "Launch post for new npm package `<your-user>/<your-package>`; publish to `<your-domain>` hub, Dev.to crosspost, Show HN."

### CLI handoffs

1. `!`blog agent preflight --json`` — confirm `workspace_detected=true` + `config_valid=true`.
2. `!`blog status --json`` — parse `data.posts[].slug` for slug collision against the proposed `<slug>`.
3. Skill classifies: `slug=<slug>` (new), `content_type=project-launch`, `depth=fast-path`, `venues=hub,devto,hn`. `hub` and `devto` are API-automated; `hn` is paste-ready (step 11 writes `hacker-news.txt` the operator submits to Show HN manually).
4. Substitute `$SLUG` and `$JSON` with the real values, then run `!blog agent plan "$SLUG" --intent "..." --content-type project-launch --depth fast-path --venues "hub,devto,hn" --steps-inline "$JSON"` — CLI writes the plan file and prints its absolute path. `$JSON` is the array of plan-step objects below. The skill never hand-edits plan JSON; every byte originates from the CLI.
5. Human checkpoint: "Approve this exact plan?" (render the step list as a markdown table, not raw JSON).
6. On `yes`: capture the plan path from step 4's stdout into `$PLAN`, then `!blog agent approve "$PLAN"` → `!blog agent verify "$PLAN"` → `!blog agent apply "$PLAN"`. Never emit a literal `<plan-path>` token — `<` parses as stdin redirection in the shell.

### Plan-step payload (inline JSON array passed to `--steps-inline`)

| # | `command` | `args` | `checkpoint_message` |
|---|---|---|---|
| 1a..1g | `blog research set-section` | `[<slug>, --section, thesis\|findings\|sources_list\|data_points\|open_questions\|benchmark_targets\|repo_scope, --content, "<section prose>"]` | Approve this section prose? (one step per section; plan author composes prose from the in-conversation draft before emitting) |
| 1h..1j+ | `blog research add-source` | `[<slug>, --url, "<...>", --title, "<...>", --excerpt, "<why it matters>"]` | Approve this source citation? (at least `config.evaluation.min_sources` = 3; omit entirely if the operator has already added sources interactively) |
| 2 | `blog research finalize` | `[<slug>]` | Finalize research (both gates: sections + source count)? |
| 3 | `blog draft init` | `[<slug>]` | Scaffold MDX draft? |
| 4 | `blog draft platform-images` | `[<slug>]` | Generate Medium/Substack platform images? |
| 5 | `blog draft complete` | `[<slug>]` | Advance to evaluate? |
| 6 | `blog evaluate init` | `[<slug>]` | Open evaluation cycle? |
| 7 | `blog evaluate structural-autocheck` | `[<slug>]` | Run deterministic lints? |
| 8 | `blog evaluate record` | `[<slug>, --reviewer, structural, --report, <path>, --issues, <path>]` | Record structural reviewer output? |
| 9 | `blog evaluate synthesize` | `[<slug>]` | Compute verdict? |
| 10 | `blog evaluate complete` | `[<slug>]` | Gate pass → publish-ready? |
| 11 | `blog publish start` | `[<slug>]` | Run the 11-step publish pipeline? |

None of these rows is a direct shell invocation. Each is a JSON object inside the inline payload; they execute only via `blog agent apply` after hash-verified approval.

Live dogfood transcript will be captured in `docs/journeys/launch.md` once a real end-to-end run is recorded.

## Journey B — Technical deep-dive with benchmark (full depth)

**Intent**: "Write a deep-dive on a benchmark topic; include reproducible methodology."

### CLI handoffs

1. `!`blog agent preflight --json``.
2. Skill classifies: `content_type=technical-deep-dive`, `depth=full`, `venues=hub,devto`.
3. Substitute `$SLUG`/`$JSON` first, then `!blog agent plan "$SLUG" --content-type technical-deep-dive --depth full --venues "hub,devto" --steps-inline "$JSON"`.
4. Human checkpoints between each phase: research done? benchmark results sane? draft complete? evaluation passed?
5. Capture the plan path from step 3 into `$PLAN`, then `!blog agent approve "$PLAN"` → `!blog agent verify "$PLAN"` → `!blog agent apply "$PLAN"`. Pauses at `preview-gate` for PR merge.

### Plan-step payload

`full` depth inserts benchmark steps *before* the draft phase and runs the full three-reviewer panel before synthesize:

- `blog research finalize [<slug>]`
- `blog benchmark init [<slug>]`
- `blog benchmark run [<slug>, --results-file, <path>]`
- `blog benchmark complete [<slug>]`
- `blog draft init [<slug>]`
- `blog draft platform-images [<slug>]`
- `blog draft complete [<slug>]`
- `blog evaluate init [<slug>]`
- `blog evaluate record [<slug>, --reviewer, structural, ...]`
- `blog evaluate record [<slug>, --reviewer, adversarial, ...]`
- `blog evaluate record [<slug>, --reviewer, methodology, ...]`
- `blog evaluate synthesize [<slug>]`
- `blog evaluate complete [<slug>]`
- `blog publish start [<slug>]`

## Journey C — Update an existing post

**Intent**: "Update the `<slug>` post — new benchmark results, same methodology."

### CLI handoffs

1. `!`blog status --json`` — detect existing published post.
2. Skill classifies: this is an **update**, not a new publish. Plan uses the `blog update *` family.
3. Substitute `$SLUG`/`$JSON` first, then `!blog agent plan "$SLUG" --intent "..." --content-type ... --depth full --venues "..." --steps-inline "$JSON"`.
4. Human checkpoint before `apply`: "Ready to push the updated post live?"
5. Capture the plan path from step 3 into `$PLAN`, then `!blog agent approve "$PLAN"` → `!blog agent verify "$PLAN"` → `!blog agent apply "$PLAN"`.

Phase stays `published` throughout; update state lives in `update_cycles` (one open row at a time per slug, enforced by partial unique index).

### Plan-step payload

- `blog update start [<slug>, --summary, "what changed"]`
- `blog update benchmark [<slug>, --results, <path>]`
- `blog update draft [<slug>]`
- `blog update evaluate [<slug>, --reviewer, ...]`
- `blog update publish [<slug>]`

## Journey D — Unpublish a post

**Intent**: "Roll back the `<slug>` post — restructuring."

### CLI handoffs

1. Skill classifies: destructive terminal action. Depth inapplicable.
2. Human checkpoint cites canonical-URL permanence: "This is irreversible. The slug `<slug>` is reserved forever at `<your-domain>/writing/<slug>`. Continue?"
3. Substitute `$SLUG`/`$JSON` first, then `!blog agent plan "$SLUG" --intent "..." --content-type ... --depth park --venues "..." --steps-inline "$JSON"` — `$JSON` is the one-element plan-step array described below.
4. On approval: capture the plan path from step 3 into `$PLAN`, then `!blog agent approve "$PLAN"` → `!blog agent verify "$PLAN"` → `!blog agent apply "$PLAN"`. Never emit a literal `<plan-path>` token to the shell.
5. The `apply` step pauses at the site-revert-PR gate until the operator merges the PR on GitHub, then resumes the 7-step unpublish pipeline (site revert PR, Dev.to PUT `published:false`, project README link removal, etc.).

### Plan-step payload

Single step, passed as the `--steps-inline` JSON array:

| # | `command` | `args` | `checkpoint_message` |
|---|---|---|---|
| 1 | `blog unpublish start` | `[<slug>, --confirm]` | Irreversible. Proceed? |

## Journey E — Fix frontmatter after publish ran

**Intent**: "Regenerate the frontmatter on `<slug>` — companion_repo was missing / project_id changed / canonical URL is wrong."

### CLI handoffs

1. Skill classifies: recovery command. Only legal when `post.phase` is `draft`, `evaluate`, or `publish` — **not** `published`. Check via `!blog publish show "$SLUG" --json` or `!blog status --json`.
2. If the post is `project-launch` and `project_id` is missing or wrong, include `--project <id>` in the plan step. This patches the row before frontmatter is regenerated; do not tell the operator to use SQL.
3. Human checkpoint explains scope: "This rewrites `.blog-agent/drafts/<slug>/index.mdx` from the current post row + config. The site-repo copy (if already committed on a PR branch) is NOT touched — update it manually on that branch. Continue?"
4. Substitute `$SLUG`/`$JSON` first, then `!blog agent plan "$SLUG" --intent "regenerate frontmatter for <slug>" --content-type ... --depth park --venues "hub" --steps-inline "$JSON"`.
5. On approval: capture the plan path from step 4 into `$PLAN`, then `!blog agent approve "$PLAN"` → `!blog agent verify "$PLAN"` → `!blog agent apply "$PLAN"`. Never emit a literal `<plan-path>` token to the shell.
6. The `apply` step runs the single `blog draft regenerate-frontmatter` invocation, which writes a receipt to `.blog-agent/drafts/<slug>/.frontmatter-regenerated.json` alongside the rewritten MDX.

### Plan-step payload

Single step, passed as the `--steps-inline` JSON array:

| # | `command` | `args` | `checkpoint_message` |
|---|---|---|---|
| 1 | `blog draft regenerate-frontmatter` | `[<slug>]` or `[<slug>, --project, <id>]` | Rewrites the local draft frontmatter in place. Site-repo copy unchanged. Proceed? |
