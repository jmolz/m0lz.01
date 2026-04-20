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
3. Skill classifies: `slug=<slug>` (new), `content_type=project-launch`, `depth=fast-path`, `venues=hub,devto,hn`.
4. `!`blog agent plan <slug> --intent "..." --content-type project-launch --depth fast-path --venues "hub,devto,hn" --steps-inline '<json>'`` — CLI writes the plan file and prints its absolute path. The `<json>` is the array of plan-step objects below. The skill never hand-edits plan JSON; every byte originates from the CLI.
5. Human checkpoint: "Approve this exact plan?" (render the step list as a markdown table, not raw JSON).
6. On `yes`: `!`blog agent approve <plan-path>`` → `!`blog agent verify <plan-path>`` → `!`blog agent apply <plan-path>``.

### Plan-step payload (inline JSON array passed to `--steps-inline`)

| # | `command` | `args` | `checkpoint_message` |
|---|---|---|---|
| 1 | `blog research finalize` | `[<slug>]` | Finalize research sources? |
| 2 | `blog draft init` | `[<slug>]` | Scaffold MDX draft? |
| 3 | `blog draft complete` | `[<slug>]` | Advance to evaluate? |
| 4 | `blog evaluate init` | `[<slug>]` | Open evaluation cycle? |
| 5 | `blog evaluate structural-autocheck` | `[<slug>]` | Run deterministic lints? |
| 6 | `blog evaluate record` | `[<slug>, --reviewer, structural, --report, <path>, --issues, <path>]` | Record structural reviewer output? |
| 7 | `blog evaluate synthesize` | `[<slug>]` | Compute verdict? |
| 8 | `blog evaluate complete` | `[<slug>]` | Gate pass → publish-ready? |
| 9 | `blog publish start` | `[<slug>]` | Run the 11-step publish pipeline? |

None of these rows is a direct shell invocation. Each is a JSON object inside the inline payload; they execute only via `blog agent apply` after hash-verified approval.

Live dogfood transcript will be captured in `docs/journeys/launch.md` once a real end-to-end run is recorded.

## Journey B — Technical deep-dive with benchmark (full depth)

**Intent**: "Write a deep-dive on a benchmark topic; include reproducible methodology."

### CLI handoffs

1. `!`blog agent preflight --json``.
2. Skill classifies: `content_type=technical-deep-dive`, `depth=full`, `venues=hub,devto`.
3. `!`blog agent plan <slug> --content-type technical-deep-dive --depth full --venues "hub,devto" --steps-inline '<json>'``.
4. Human checkpoints between each phase: research done? benchmark results sane? draft complete? evaluation passed?
5. `!`blog agent approve`` → `!`blog agent verify`` → `!`blog agent apply``. Pauses at `preview-gate` for PR merge.

### Plan-step payload

`full` depth inserts benchmark steps *before* the draft phase and runs the full three-reviewer panel before synthesize:

- `blog research finalize [<slug>]`
- `blog benchmark init [<slug>]`
- `blog benchmark run [<slug>, --results, <path>]`
- `blog benchmark complete [<slug>]`
- `blog draft init [<slug>]`
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
3. `!`blog agent plan <slug> --intent "..." --content-type ... --depth full --venues "..." --steps-inline '<json>'``.
4. Human checkpoint before `apply`: "Ready to push the updated post live?"
5. `!`blog agent approve`` → `!`blog agent verify`` → `!`blog agent apply``.

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
3. `!`blog agent plan <slug> --intent "..." --content-type ... --depth park --venues "..." --steps-inline '<json>'`` — where `<json>` is the one-element plan-step array described below.
4. On approval: `!`blog agent approve <plan-path>`` → `!`blog agent verify <plan-path>`` → `!`blog agent apply <plan-path>``.
5. The `apply` step pauses at the site-revert-PR gate until the operator merges the PR on GitHub, then resumes the 7-step unpublish pipeline (site revert PR, Dev.to PUT `published:false`, project README link removal, etc.).

### Plan-step payload

Single step, passed as the `--steps-inline` JSON array:

| # | `command` | `args` | `checkpoint_message` |
|---|---|---|---|
| 1 | `blog unpublish start` | `[<slug>, --confirm]` | Irreversible. Proceed? |
