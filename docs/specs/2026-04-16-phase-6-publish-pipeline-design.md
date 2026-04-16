# Phase 6: Publish Pipeline with Resume — Design Spec

> Validated design for the publish pipeline phase. Covers all 11 PRD steps,
> cross-posting, social text generation, research page generation, and
> resume-on-failure. This spec was negotiated before implementation planning.

---

## Problem

After a post passes the three-reviewer adversarial evaluation (Phase 5), there
is no automated path from the local `.blog-agent/` artifacts to production on
m0lz.dev and cross-post platforms. Publishing is currently a manual 10+ step
process: copy MDX to the site repo, create a PR, cross-post to Dev.to, generate
paste-ready content for Medium and Substack, push companion repos, update
frontmatter with platform URLs, update project READMEs, generate research pages,
and write social distribution text. This friction reduces publishing frequency.

## Solution

A sequential 11-step publish pipeline tracked by the existing `pipeline_steps`
SQLite table. Each step is idempotent and checkpointed. If the pipeline fails at
step N, `blog publish <slug>` resumes from step N. A manual gate at step 3
(PR merge + preview verification) gives the author control before cross-posting
begins.

---

## User Story

As a content author, I want to run `blog publish <slug>` and have the pipeline
handle everything from creating a site PR through cross-posting and social text
generation, resuming from where it left off if anything fails, so that publishing
is a single command instead of a 10-step manual process.

---

## Architecture

### Pipeline Steps (11 total, sequential)

| # | Step Name | Module | Description | External? | Failure Mode |
|---|-----------|--------|-------------|-----------|--------------|
| 1 | `verify` | state.ts | Confirm evaluation passed + verdict = pass | No | Hard fail |
| 2 | `research-page` | research-page.ts | Generate research page MDX locally | No | Skip for analysis-opinion w/o artifacts |
| 3 | `site-pr` | site.ts | Copy MDX + assets + research page to m0lz.00, create branch + PR via `gh` CLI | Local git + `gh` | Hard fail |
| 4 | `preview-gate` | site.ts | Check PR merge status via `gh pr view`, pause if not merged | `gh` CLI | Manual gate (pause + resume) |
| 5 | `crosspost-devto` | devto.ts | Forem API POST with canonical_url, `published: false` | HTTP (Dev.to) | Skip if no DEVTO_API_KEY |
| 6 | `paste-medium` | medium.ts | Generate paste-ready markdown file | No | None (always succeeds) |
| 7 | `paste-substack` | substack.ts | Generate paste-ready content file | No | None (always succeeds) |
| 8 | `companion-repo` | repo.ts | `gh repo view` probe then `gh repo create --source=. --push` if missing | `gh` CLI | Skip if no companion repo |
| 9 | `update-frontmatter` | frontmatter.ts | Update frontmatter with platform URLs, direct push to main of site repo | Local git | Hard fail |
| 10 | `update-readme` | readme.ts | Add writing link to project README, direct push to main | Local git | Skip if no `project` field |
| 11 | `social-text` | social.ts | Generate LinkedIn + HN text files | No | None (always succeeds) |

**Key ordering decisions:**
- `research-page` (step 2) runs BEFORE `site-pr` so the research page ships in the same PR as the draft. One atomic review.
- `update-frontmatter` (step 9) and `update-readme` (step 10) direct-push to main because they are mechanical, idempotent URL additions to already-reviewed content. This avoids PR noise.

### Step 4: Manual Gate (preview-gate)

Step 4 is a deliberate pause point. The pipeline:
1. Checks PR merge status via `gh pr view --json state`
2. If not merged: prints "PR #{number} is open -- review the Vercel preview, merge when ready, then re-run `blog publish start <slug>`" and marks step as `pending`
3. If merged: marks step as `completed` and continues to step 5
4. On re-run: the resume logic picks up at step 4, checks again

This gives the author full control over what reaches production while keeping the
pipeline resumable.

### Concurrency Safety

Every mutating pipeline operation acquires a filesystem lock at
`.blog-agent/publish/{slug}/.publish.lock` using `O_EXCL | O_CREAT` for atomic
creation, with PID staleness detection. This prevents duplicate Dev.to posts,
git conflicts, or race conditions from concurrent `blog publish start` invocations
on the same slug. Copied from the evaluate phase's `acquireEvaluateLock` pattern.

### Resume Logic

```
blog publish <slug>
  1. Phase gate: post must be in 'publish' phase with evaluation_passed = true
  2. INSERT OR IGNORE all 11 steps as 'pending' into pipeline_steps
  3. Loop through steps in order:
     - Skip steps where status = 'completed' or 'skipped'
     - Find first step where status = 'pending' or 'failed'
     - Mark as 'running', execute, mark as 'completed'/'failed'/'skipped'
  4. On failure: store error_message, print diagnostic, stop
  5. On all complete: advancePhase to 'published', set published_at + URLs
```

### State Transitions

- **Entry**: `evaluate` phase with `evaluation_passed = true`
- **initPublish**: advances to `publish` phase, creates pipeline_steps rows
- **During execution**: remains in `publish` phase
- **completePublish**: advances to `published` phase, sets `published_at`

---

## Cross-Posting

### Dev.to (Forem API)

- **Endpoint**: `POST https://dev.to/api/articles`
- **Auth**: `DEVTO_API_KEY` header (`api-key`)
- **Created as draft**: `published: false` (author reviews before publishing)
- **Canonical URL**: `https://m0lz.dev/writing/{slug}`
- **Tags**: Map m0lz.00 tags to Dev.to tags (max 4). Unmapped tags dropped.
- **Content**: MDX converted to Markdown (strip JSX, resolve asset URLs)

### Medium (Paste-Ready)

- **API status**: Deprecated, archived March 2023. No API integration.
- **Output**: `.blog-agent/social/{slug}/medium-paste.md`
- **Content**: Clean Markdown with public asset URLs from m0lz.dev
- **Manual action**: Author pastes into Medium editor

### Substack (Paste-Ready)

- **API status**: No official publishing API exists.
- **Output**: `.blog-agent/social/{slug}/substack-paste.md`
- **Content**: Clean Markdown formatted for Substack's editor
- **Manual action**: Author pastes into Substack editor

---

## MDX to Markdown Conversion

Cross-posts and paste-ready files need clean Markdown, not MDX. The converter:

1. Strips JSX component imports (`import { X } from '...'`)
2. Replaces JSX component usage with Markdown equivalents or removes
3. Resolves relative asset paths to public URLs (`https://m0lz.dev/writing/{slug}/assets/...`)
4. Preserves code blocks, tables, and standard Markdown
5. Strips frontmatter (platforms have their own metadata)
6. Handles Excalidraw SVG embeds (convert to image references with public URLs)

---

## Social Text Generation

### LinkedIn

- **Output**: `.blog-agent/social/{slug}/linkedin.md`
- **Format**: Professional summary, key takeaway (benchmark data when applicable), canonical URL, hashtags
- **Timing**: Include posting recommendation (Tuesday-Thursday, morning)
- **No emojis** (m0lz.00 design constraint)

### Hacker News

- **Output**: `.blog-agent/social/{slug}/hackernews.md`
- **Title**: 80 character limit; "Show HN:" prefix for `project-launch` type only
- **URL**: Canonical URL
- **First comment**: Context summary, key findings, companion repo link
- **Timing**: Include posting recommendation (Tuesday-Thursday, 9-11am ET)

---

## Research Page Generation

- **Output**: `.blog-agent/research-pages/{slug}/index.mdx`
- **Content**: Thesis, key findings, source bibliography, benchmark methodology summary, data visualizations, open questions, cross-links to blog post and companion repo
- **Skip condition**: `analysis-opinion` content type with no research artifacts
- **Destination**: Committed to m0lz.00 `content/research/` alongside the site PR

---

## Content-Type Routing

| Step | project-launch | technical-deep-dive | analysis-opinion |
|------|---------------|--------------------|--------------------|
| research-page (2) | Generate | Generate | Skip (no research artifacts) |
| companion-repo (8) | Skip (link existing) | Create via `gh repo create` + push | Skip |
| update-readme (10) | Update existing README | Update newly-created README | Skip (no project) |
| social prefix | "Show HN:" | Standard | Standard |
| Dev.to tags | Include project tag | Include benchmark tags | Standard tags |

---

## File Structure

```
src/core/publish/
  state.ts            Phase boundary, initPublish, completePublish, resume
  pipeline.ts         Step definitions, step runner, resume orchestrator
  site.ts             Steps 2-3: Copy to site repo, create PR, preview gate
  devto.ts            Step 4: Forem API cross-post
  medium.ts           Step 5: Generate paste-ready markdown
  substack.ts         Step 6: Generate paste-ready content
  repo.ts             Step 7: Push companion repo
  frontmatter.ts      Step 8: Update frontmatter with platform URLs
  readme.ts           Step 9: Update project README
  research-page.ts    Step 10: Generate research page MDX
  social.ts           Step 11: LinkedIn + HN text generation
  convert.ts          MDX to Markdown converter

src/cli/publish.ts    CLI commands (blog publish, blog publish show)

templates/
  social/
    linkedin.md       LinkedIn post template
    hackernews.md     HN submission template
  research-page/
    template.mdx      Research page MDX template

skills/
  blog-publish.md     Skill documentation

tests/
  publish-state.test.ts
  publish-pipeline.test.ts
  publish-site.test.ts
  publish-crosspost.test.ts
  publish-social.test.ts
  publish-research-page.test.ts
  publish-convert.test.ts
  publish-cli.test.ts
```

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DEVTO_API_KEY` | For Dev.to cross-post | Forem API authentication |
| `ANTHROPIC_API_KEY` | Optional | Claude API fallback (not needed with Claude Code subscription) |

GitHub and Vercel operations use `gh` CLI (existing auth) and `git` (existing
credentials). No tokens needed.

---

## Dependencies

**No new npm dependencies.** The pipeline uses:
- Node 20+ built-in `fetch()` for Dev.to HTTP calls
- `child_process.execFileSync` for `gh` CLI and `git` commands (safe from shell injection)
- Existing `better-sqlite3` for state management
- Existing `js-yaml` and `dotenv` for config

---

## Config Usage

Existing `PublishConfig` and `SocialConfig` types (already defined in
`src/core/config/types.ts`):

```typescript
interface PublishConfig {
  devto: boolean;         // Cross-post to Dev.to
  medium: boolean;        // Generate paste-ready (API is dead)
  substack: boolean;      // Generate paste-ready (no publishing API)
  github_repos: boolean;  // Push companion repos
  social_drafts: boolean; // Generate social text
  research_pages: boolean; // Generate research pages
}

interface SocialConfig {
  platforms: string[];    // ['linkedin', 'hackernews']
  timing_recommendations: boolean;
}
```

### New config extensions (Phase 6)

Two additions to `SiteConfig` and `BlogConfig`:

```typescript
interface SiteConfig {
  repo_path: string;      // existing
  base_url: string;       // existing
  content_dir: string;    // existing -- e.g., "content/posts"
  research_dir: string;   // NEW -- e.g., "content/research"
}

interface BlogConfig {
  // ... existing fields
  projects?: Record<string, string>;  // NEW -- id -> repo path, e.g., { "m0lz.02": "../m0lz.02" }
}
```

`research_dir` defaults to `"content/research"`. `projects` is optional;
step 10 (update-readme) skips if the post's `project_id` has no entry in
`projects`.

Config flags control which steps execute vs. skip. Disabled steps are marked
`skipped` in `pipeline_steps`.

---

## Testing Strategy

Target: ~80-100 tests across 8 suites.

| Suite | Focus | Approximate Tests |
|-------|-------|-------------------|
| publish-state | Phase boundary, initPublish, completePublish, resume queries | 15-20 |
| publish-pipeline | Step runner, resume logic, skip conditions, config routing | 15-20 |
| publish-site | PR creation, branch naming, file copying, preview gate | 10-12 |
| publish-crosspost | Dev.to API call shape, tag mapping, error handling, paste-ready generation | 10-12 |
| publish-social | LinkedIn format, HN format, char limits, content-type prefixes, timing | 8-10 |
| publish-research-page | Template rendering, skip conditions, cross-links | 6-8 |
| publish-convert | MDX to Markdown: JSX stripping, URL resolution, code block preservation | 10-12 |
| publish-cli | Handler shape, path injection, error formatting, exit codes | 8-10 |

Testing patterns follow established conventions:
- In-memory SQLite for state tests
- Temp directories for file artifact tests
- Direct function calls (no CLI simulation)
- `captureLogs()` + `process.exitCode` pattern for CLI tests
- Idempotency tests for every mutating function
- Phase boundary enforcement tests for every command

---

## Design Decisions

1. **No manifest/cycle pattern.** The publish pipeline is sequential, not
   parallel. The `pipeline_steps` table provides resume tracking. Adding manifest
   complexity would be overengineering for a linear workflow.

2. **`gh` CLI over Octokit.** Avoids adding a dependency. Uses existing auth.
   PR creation, status checks, and merge detection all work via `gh`.

3. **Dev.to posts created as drafts.** `published: false` gives the author a
   review step. Consistent with the manual-gate philosophy at step 3.

4. **Medium and Substack are generate-only.** Both APIs are unusable (Medium
   deprecated March 2023, Substack has no publishing API). Steps 5-6 produce
   paste-ready files with no HTTP calls.

5. **MDX-to-Markdown is a separate module.** Conversion logic is shared by
   Dev.to, Medium paste, and Substack paste. Centralizing in `convert.ts`
   avoids duplication and makes it independently testable.

6. **Step 3 is a manual gate, not automation.** The author must merge the PR and
   re-run `blog publish`. No content reaches production without explicit author
   approval.

7. **Content-type routing via config + step logic.** Each step checks the post's
   content type and the relevant config flag to decide execute vs. skip. Skipped
   steps are recorded in `pipeline_steps` for transparency.

8. **`execFileSync` over `exec`.** All subprocess calls use `execFileSync` to
   prevent shell injection. Arguments are passed as arrays, not interpolated
   into shell strings.

---

## Scope Boundary

**In scope (Phase 6):**
- All 11 publish pipeline steps
- `blog publish <slug>` and `blog publish show <slug>` CLI commands
- Resume-on-failure with pipeline_steps tracking
- MDX to Markdown conversion
- Dev.to cross-post (Forem API)
- Medium + Substack paste-ready generation
- Companion repo push
- Frontmatter update with platform URLs
- Project README update
- Research page generation
- Social text generation (LinkedIn + HN)
- `skills/blog-publish.md` documentation
- Phase transition: evaluate -> publish -> published

**Out of scope (Phase 7+):**
- `blog unpublish <slug>` (rollback)
- `/blog-pipeline` full orchestrator skill
- `/blog-update` content update workflow
- `blog update` CLI command
- Automated social posting (LinkedIn/HN APIs)
