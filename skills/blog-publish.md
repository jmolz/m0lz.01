---
name: blog-publish
description: Run or resume the 11-step publish pipeline that copies MDX + research page to the site repo PR, cross-posts to Dev.to, generates paste-ready Medium/Substack markdown, creates and pushes the companion repo, updates frontmatter and project README with platform URLs, and generates social text. Use when a post has passed evaluation and is ready to ship.
---

# /blog-publish

Coordinates the distribution fan-out for a post that has already cleared the three-reviewer evaluation gate. The CLI owns every mechanical operation — file copies, `gh pr create`, Dev.to API, direct pushes to main, social-text generation — so this skill is mostly a thin observer/operator of the pipeline and a decision-maker at the preview gate.

## Preflight

Before running `blog publish start`, confirm:

- The post is in `evaluate` phase with `evaluation_passed = 1`. `/blog-evaluate` must have run `blog evaluate synthesize` + `blog evaluate complete` successfully. `blog evaluate show <slug>` should report `verdict: pass`.
- `.blogrc.yaml` is present and loadable. Required fields used by the pipeline: `author.github`, `site.repo_path`, `site.base_url`, `site.content_dir`, `site.research_dir`.
- `gh auth status` returns authenticated. The `site-pr` (step 3) and `companion-repo` (step 8) steps shell out to the `gh` CLI directly — install with `brew install gh` and `gh auth login` if not.
- `DEVTO_API_KEY` is set in `.env` or `.env.local` (auto-loaded via `dotenv/config` at CLI entry). **Optional**: a missing key causes step 5 to fail — set `publish.devto: false` in `.blogrc.yaml` to pre-skip that step, or accept the step failure and fix + resume.
- If the post has `project_id` set and `config.projects[project_id]` resolves, the project repo at the resolved path must be a git repo with an `origin` remote pointing at GitHub (step 10 pushes directly to main).

## Workflow

1. **Check readiness.** `blog evaluate show <slug>` — the `verdict` line must read `pass`. If not, stop; evaluation has to complete and pass before any publish step is safe.
2. **Start the pipeline.** `blog publish start <slug>` promotes the post from `evaluate` to `publish`, seeds the 11 `pipeline_steps` rows (with content-type- and config-driven skips pre-applied), then runs steps in order under a slug-scoped FS lock.
3. **Observe progress.** Each step prints `[N/11] step-name: <message>` on stdout as it completes (or `SKIPPED`, `PAUSED`, `FAILED` prefixes). The runner stops at the first failure or pause.
4. **Act on the preview gate (step 4).** After `site-pr` opens the PR, `preview-gate` pauses the pipeline and prints guidance. Review the Vercel preview, merge the PR when the rendered output looks right, then re-run `blog publish start <slug>` — the gate re-checks the merge state and advances.
5. **Inspect state anytime.** `blog publish show <slug>` prints post metadata plus a step-by-step table with statuses and timestamps. Safe to run at any point; informational only.
6. **Resume after failure.** Any failing step leaves the pipeline paused at that step with `status = 'failed'` and the error message in `pipeline_steps.error_message`. Fix the underlying cause (auth error, missing file, conflicting branch) and re-run `blog publish start <slug>`; `getNextPendingStep` picks up failed rows too, so no manual intervention in the DB is needed.

## The 11 Steps

1. **verify** — Inline check that `posts.evaluation_passed = 1`. Fails closed. Guards against a manually-manipulated phase flip that bypassed the evaluation gate.
2. **research-page** — Generates MDX at `.blog-agent/research-pages/{slug}/index.mdx` from the research doc, optional benchmark summary, and the extracted bibliography. Skipped automatically for `analysis-opinion` posts that have no research artifacts.
3. **site-pr** — Copies draft MDX + assets + research page into `{repo_path}/{content_dir}/{slug}/` and `{repo_path}/{research_dir}/{slug}/`. Creates branch `post/{slug}`, commits, pushes, opens a PR via `gh pr create`. Idempotent: reuses an existing branch and PR when re-run.
4. **preview-gate** — Polls PR merge state via `gh pr view`. Returns `paused` until the PR merges. This is the intentional manual checkpoint — do not try to automate around it.
5. **crosspost-devto** — POSTs to `https://dev.to/api/articles` with `published: false`, `canonical_url` set to `{base_url}/writing/{slug}`, and tags mapped to Dev.to's `[a-z0-9-]` format capped at 4. Fails if `DEVTO_API_KEY` is missing or the API is down.
6. **paste-medium** — Writes `.blog-agent/social/{slug}/medium-paste.md`. Medium has no publishing API, so this is always a paste-ready artifact, never a direct post.
7. **paste-substack** — Writes the Substack equivalent with H1/H2 layout tuned for the Substack editor.
8. **companion-repo** — `technical-deep-dive` only: probes `gh repo view {author.github}/{slug}`; creates via `gh repo create --source=. --push` if missing; pushes the current contents if it exists. Skipped for `analysis-opinion` and `project-launch`.
9. **update-frontmatter** — Direct push to main of the site repo: adds `published: true`, `canonical`, `devto_url`, `companion_repo` to the post's MDX frontmatter. Idempotent — re-running leaves the same content.
10. **update-readme** — For posts with `project_id` set and a matching `config.projects[project_id]` entry: direct-pushes to main of the resolved project repo, adding `- [{title}]({canonical_url})` under the `## Writing` heading. Skipped if either condition is missing.
11. **social-text** — Generates `.blog-agent/social/{slug}/linkedin.md` and `hackernews.md` from templates in `templates/social/`. Project-launch HN titles get the `Show HN:` prefix. Throws if any generated text contains emoji characters (design constraint).

## CLI Commands

```bash
blog publish start <slug>    # Initialize or resume the pipeline
blog publish show <slug>     # Display the step table
```

The pipeline takes no flags — every knob lives in `.blogrc.yaml` (pre-skip booleans for each destination) or is derived from the post's content type.

## Troubleshooting

**`Evaluation not passed` at step 1** — the post was advanced to `publish` without a passing synthesis. Run `/blog-evaluate` end-to-end (init, structural-autocheck, three reviewer records, synthesize, complete). `blog evaluate show <slug>` must report `verdict: pass` before publish will succeed.

**`gh: command not found` or `gh auth status` fails** — install the GitHub CLI (`brew install gh`) and run `gh auth login`. `site-pr` (step 3), `preview-gate` (step 4), and `companion-repo` (step 8) all shell out to `gh`.

**`DEVTO_API_KEY not set`** — add the key to `.env` or `.env.local`. If you intentionally don't want to cross-post to Dev.to, set `publish.devto: false` in `.blogrc.yaml`; re-running will seed step 5 as `skipped` from the start.

**PR is open but preview-gate keeps pausing** — merge the PR first (the manual gate is intentional). After the merge, re-run `blog publish start <slug>` and the gate advances on the next check.

**`Could not acquire publish lock`** — another `blog publish` process is already running for this slug, or a crashed process left a stale lock file at `.blog-agent/publish/{slug}/.publish.lock`. Check with `ps` / `lsof`; if the holding process is gone, delete the lock file manually.

**`gh repo create failed — already exists`** — race condition; the step falls back to pushing into the existing repo. If that also fails, confirm `gh auth status` has the `repo` scope.

**Branch conflict on `post/{slug}`** — someone else (or a prior run on a different machine) pushed to the same branch. Resolve the conflict manually (`git rebase` or reset), then re-run `blog publish start`.

## Degraded Mode

When an external dependency is unavailable the pipeline fails loud at the affected step, not silently:

- **Dev.to API down** — step 5 throws; pipeline halts at step 5. Wait for the API or set `publish.devto: false` and re-run.
- **gh auth expired** — steps 3, 4, 8 fail. `gh auth login` and re-run `blog publish start`.
- **Site repo push rejected (branch conflict)** — step 3 fails. Resolve the conflict in the local site repo checkout, then re-run.

In every case, `blog publish show <slug>` tells you exactly which step stalled and what its error message was. The pipeline never silently advances past a broken boundary.

## Relationship to /blog-evaluate

- `/blog-evaluate` gates: synthesizes reviewer verdicts, flips `posts.evaluation_passed = 1` on pass, advances the post to `evaluate` phase (with `ended_reason` closed on the current cycle).
- `/blog-publish` consumes that gate: step 1 (`verify`) refuses to run unless `evaluation_passed = 1`. On full success, the post advances to `published` and URLs from every completed step are written to the `posts` row.
- Never run `/blog-publish` before `/blog-evaluate` passes. Step 1 fails closed, the pipeline halts immediately, and nothing is published. This is by design.
