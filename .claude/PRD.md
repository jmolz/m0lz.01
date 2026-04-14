# Product Requirements Document: m0lz.01

## Executive Summary

m0lz.01 is a local idea-to-distribution pipeline that orchestrates the full lifecycle of technical content: research, benchmark, draft, evaluate, publish, and distribute. It goes beyond blog generation — a single prompt can trigger deep research on a topic, build and run original test suites, architect a companion project, write about the findings with original data, and distribute the result across platforms.

The tool publishes all content to [m0lz.dev](https://m0lz.dev) (m0lz.00) as the canonical hub, with cross-post platforms, project repos, and social channels as spokes. It runs on the author's machine using existing AI subscriptions (Claude Max 20x for primary work, OpenAI Codex CLI for adversarial review). No server, no SaaS. Open-source, MIT licensed.

The agent operates in two modes inferred from prompt specificity: **directed mode** (detailed prompt, full automation) and **exploratory mode** (vague topic, collaborative back-and-forth). Both modes use the same pipeline — they differ only in how much human input is required at each stage.

A core differentiator: every benchmark claim is backed by original test data from a companion repo that readers can clone and run themselves. The agent doesn't aggregate other people's benchmarks — it builds test harnesses, runs them, and presents primary-source data.

**MVP Goal:** A working pipeline where a single prompt produces a published, cross-posted blog post backed by original benchmark data, auto-generated Excalidraw diagrams, adversarial evaluation, and platform-optimized social distribution text.

---

## Target Users

### Primary Persona: Jacob (Author)

- **Who:** Solo technical writer and developer building in public across a catalog of projects (m0lz.00 through m0lz.0n)
- **Technical Level:** Developer — comfortable with CLI tools, Git workflows, and AI-assisted development
- **Key Need:** Spend time thinking and directing, not writing and designing. The agent handles execution; the author handles strategy.
- **Pain Point:** Manual blog publishing is a 10-step process across multiple platforms. Each post requires research, writing, diagram creation, cross-posting, social promotion, and companion repo management. This friction reduces publishing frequency.

---

## MVP Scope

### In Scope

Core Functionality
- [ ] Dual-mode pipeline: fully automated (directed) and interactive (exploratory)
- [ ] Deep research with web search and structured source gathering
- [ ] Original benchmarking: scaffold test harnesses, run tests, collect primary-source data
- [ ] Companion repo as research artifact (test suites, benchmarks, reproducible methodology)
- [ ] MDX draft generation incorporating original benchmark data with PostFrontmatter schema compliance
- [ ] Auto-generated Excalidraw SVG diagrams and benchmark data visualizations
- [ ] Three-reviewer evaluation panel: Claude (structural), GPT-5.4 high (adversarial), GPT-5.4 xhigh (methodology)
- [ ] Hub publish: PR to m0lz.00 with local preview and CI/CD gate
- [ ] Cross-post to Dev.to with canonical URL
- [ ] Medium and Substack fallback (paste-ready markdown on API failure)
- [ ] Platform-optimized social text: LinkedIn (professional) and Hacker News (Show HN format)
- [ ] Content type handling: project launch, technical deep-dive, analysis/opinion (each with appropriate pipeline behavior)
- [ ] Pipeline status and metrics tracking via SQLite
- [ ] Pipeline resume on failure (idempotent sub-steps, resume from last checkpoint)
- [ ] Existing content migration (import m0lz.00's published posts into state DB)
- [ ] Content updates: re-run benchmarks, regenerate sections, republish
- [ ] Content unpublish/rollback: set published: false, handle cross-post removal
- [ ] Editorial backlog: lightweight topic idea tracking
- [ ] Research page auto-generation for m0lz.00 from research artifacts

Technical
- [ ] Claude Code skill layer for interactive AI operations (uses subscription)
- [ ] Standalone Commander.js CLI for mechanical operations (publish, status, metrics, update)
- [ ] SQLite state database with sub-step tracking for pipeline resume
- [ ] `.blogrc.yaml` config + `.env` secrets separation
- [ ] Agent-driven tag taxonomy based on site knowledge
- [ ] Data provenance: METHODOLOGY.md, environment capture, raw data storage

Deployment
- [ ] Installable via `npx` for others to use
- [ ] Full test coverage and CI on the agent repo itself

### Out of Scope

- GUI or web interface (Claude Code IS the interface for interactive work)
- Automated social posting via LinkedIn/HN APIs (generate-only, post manually)
- X/Twitter integration (not a target platform)
- Multi-author support (single author tool)
- Analytics dashboards (metrics are CLI-only)
- Image generation beyond Excalidraw (no DALL-E, no Midjourney)
- Video or podcast content
- Paid API usage for primary AI work (uses Claude Max subscription via Claude Code)
- Real-time analytics or engagement tracking from cross-post platforms

---

## User Stories

1. As an author, I want to give a detailed research brief (e.g., "Deep research MinIO's decline, map the S3 landscape, propose m0lz.0a architecture") and have the agent execute the full pipeline autonomously, so that I can focus on the idea rather than the execution.
2. As an author, I want to give a vague topic (e.g., "write about agentic harnesses") and have the agent research, surface interesting projects, and collaborate with me to shape the direction, so that I can explore ideas interactively.
3. As an author, I want the agent to build and run original test suites for benchmark claims, so that every data point in my posts is primary-source research I own, not aggregated from other articles.
4. As an author, I want every draft adversarially evaluated by a different AI model (Codex), so that I have checks and balances on factual accuracy, logical coherence, and argument quality.
5. As an author, I want auto-generated Excalidraw SVG diagrams and benchmark data visualizations in every post, so that content is visually compelling without manual design work.
6. As an author, I want cross-posts to Dev.to with canonical URLs pointing to m0lz.dev, so that my hub site maintains SEO authority while reaching broader audiences.
7. As an author, I want platform-optimized social text (LinkedIn professional summary, Hacker News "Show HN:" with char limits), so that distribution is maximally effective on each platform.
8. As an author, I want the agent to scaffold companion repos with test harnesses before drafting, so that the repo feeds data into the post rather than being an afterthought.
9. As an author, I want to see pipeline status and publishing metrics across all posts, so that I can track what's in progress, what's published, and how the system performs.
10. As an author, I want a local preview and CI/CD gate before anything deploys to production, so that broken MDX or bad content never reaches m0lz.dev.
11. As an author, I want research pages auto-generated from my research artifacts, so that the research section of m0lz.dev demonstrates depth and becomes a citable resource for readers.
12. As an author, I want to update a published post when new data is available (new software versions, re-run benchmarks), so that content stays accurate over time and readers trust the data.
13. As an author, I want the pipeline to resume from where it failed if something breaks mid-publish, so that I never have to re-run the entire pipeline for a transient failure.
14. As an author, I want my 5 existing m0lz.00 posts imported into the agent's state on init, so that status and metrics reflect my full publishing history from day one.

---

## Tech Stack

| Technology | Purpose | Rationale |
|------------|---------|-----------|
| TypeScript / Node.js | Runtime | AI SDKs are JS-first, matches m0lz.00 ecosystem |
| Commander.js | CLI framework | Lightweight, well-documented for standalone commands |
| Claude Code Skills | Interactive AI layer + structural review | Uses existing Claude Max 20x subscription, no API billing |
| Codex CLI (GPT-5.4 high) | Adversarial evaluation | Uses existing OpenAI subscription, challenges thesis and argument structure |
| Codex CLI (GPT-5.4 xhigh) | Methodology evaluation | Uses existing OpenAI subscription, deep review of benchmark validity and statistical rigor |
| SQLite (better-sqlite3) | State management | Query flexibility, supports growth to many posts over time |
| Octokit | GitHub API | Companion repo creation, PR management |
| Forem API | Dev.to cross-posting | Stable API with canonical_url support |
| Excalidraw | Diagram generation | Auto-generated SVGs via Claude Code skill |
| YAML (js-yaml) | Config parsing | `.blogrc.yaml` for non-secret configuration |

---

## Architecture

### Dual-Layer Design

```
Claude Code Skills (interactive layer — uses subscription)
  /blog-research    Research workflow, web search, source gathering
  /blog-benchmark   Scaffold test harness, run benchmarks, collect data
  /blog-draft       MDX generation, Excalidraw diagrams, frontmatter
  /blog-evaluate    Three-reviewer panel (Claude + GPT-5.4 high + GPT-5.4 xhigh)
  /blog-pipeline    Orchestrates full research-to-publish in one shot
  /blog-update      Re-run benchmarks, regenerate sections, republish

Standalone CLI (mechanical layer — no AI subscription needed)
  blog init         Config scaffolding, directory setup, existing post import
  blog publish      Cross-post pipeline (Dev.to, Medium fallback, etc.)
  blog unpublish    Rollback: set published: false, handle cross-post removal
  blog status       SQLite pipeline view
  blog metrics      Aggregate stats
  blog ideas        Editorial backlog management

Shared Infrastructure
  .blog-agent/      Working directory (research, drafts, benchmarks, social, repos)
  .blog-agent/state.db   SQLite state database (with sub-step tracking for resume)
  .blog-agent/ideas.yaml Editorial backlog
  .blogrc.yaml      Non-secret configuration
  .env              API keys and secrets
```

### Directory Structure

```
m0lz.01/
  src/
    cli/                 Commander.js command definitions
      init.ts            Config setup + existing post import
      publish.ts         Cross-post pipeline with resume support
      unpublish.ts       Rollback: unpublish and handle cross-post removal
      status.ts          Pipeline state viewer
      metrics.ts         Aggregate stats
      ideas.ts           Editorial backlog management
    skills/              Claude Code skill definitions
      research.ts        Research workflow
      benchmark.ts       Test harness scaffolding + execution
      draft.ts           MDX generation with benchmark data
      evaluate.ts        Three-reviewer panel orchestration
      pipeline.ts        Full pipeline orchestrator
      update.ts          Content update workflow
    core/                Shared business logic
      research/          Research orchestration + web search
      benchmark/         Test harness scaffolding + data collection
        scaffold.ts      Generate test suite from research findings
        runner.ts        Execute benchmarks and collect results
        environment.ts   Capture test environment metadata
        methodology.ts   Generate METHODOLOGY.md
      draft/             MDX generation + frontmatter compliance
        content-types.ts Content type detection and pipeline behavior routing
      evaluate/          Three-reviewer evaluation panel
        structural.ts    Claude: content quality, schema, MDX, sources
        adversarial.ts   GPT-5.4 high: thesis challenge, bias, argument gaps
        methodology.ts   GPT-5.4 xhigh: benchmark validity, statistics, reproducibility
        synthesizer.ts   Merge three reviews into consensus/majority/single report
      publish/           Cross-posting pipeline (idempotent sub-steps)
        site.ts          PR to m0lz.00
        devto.ts         Dev.to cross-post
        medium.ts        Medium cross-post with fallback
        substack.ts      Substack cross-post with fallback
        readme-updater.ts   Project repo README link insertion
        resume.ts        Pipeline checkpoint and resume logic
        unpublish.ts     Rollback: set published: false, remove cross-posts
      visuals/           Excalidraw diagram + benchmark chart generation
      social/            Platform-optimized text generation
        linkedin.ts      Professional format with hashtags
        hackernews.ts    Show HN format with char limits
      repo/              Companion repo scaffolding
      research-page/     Auto-generate m0lz.00 research pages
      update/            Content update pipeline
      ideas/             Editorial backlog (ideas.yaml management)
      db/                SQLite state management (with sub-step tracking)
      config/            Config loading + validation
      migrate/           Import existing m0lz.00 posts into state DB
  templates/
    repo/                Companion repo templates (README, CI, LICENSE)
    methodology/         METHODOLOGY.md template for benchmark repos
    social/              Social post templates per platform
    research-page/       Research page MDX template
  tests/
  .claude/
    skills/              Claude Code skill frontmatter files
  package.json
  tsconfig.json
  .blogrc.example.yaml
  .env.example
  README.md
  branch-mark.svg
  LICENSE
```

### Data Flow

**Directed mode** (detailed prompt):

```
Prompt -> Parse intent + detect content type
  -> Research (automated, web search, source gathering)
  -> Benchmark (scaffold test harness, run tests, collect data) [skip if analysis/opinion type]
  -> Draft (automated, incorporates original benchmark data)
  -> Excalidraw + data visualization generation
  -> Evaluate (three-reviewer panel, run in parallel):
     Claude: structural  |  GPT-5.4 high: adversarial  |  GPT-5.4 xhigh: methodology
  -> Synthesize: consensus / majority / single-reviewer issues
  -> [Pass?] -> Publish PR to m0lz.00 -> Local preview -> CI/CD
  -> Cross-post Dev.to -> Medium/Substack fallback
  -> Social text generation (LinkedIn + HN)
  -> Companion repo push (if new) -> README updates
  -> Research page generation -> Done
```

**Exploratory mode** (vague topic):

```
Prompt -> Parse intent + detect content type
  -> Research (collaborative, surfaces findings for discussion)
  -> Author shapes direction, identifies benchmark targets
  -> Benchmark (scaffold test harness, author reviews, run tests) [skip if analysis/opinion type]
  -> Draft (iterative, author gives feedback on structure and argument)
  -> Excalidraw + data visualization generation
  -> Evaluate (three-reviewer panel, same as directed)
  -> Author reviews synthesized evaluation
  -> [Same publish pipeline from here]
```

**Update mode** (revising published content):

```
blog update <slug>
  -> Load original research + benchmark config
  -> Re-run benchmarks against current versions
  -> Compare results with original data
  -> Regenerate affected sections with updated data
  -> Append update notice with date to post
  -> Re-evaluate updated content (three-reviewer panel)
  -> Publish update (PR to m0lz.00, update cross-posts where API supports)
```

**Content type detection:** Inferred from prompt and research findings. Determines which pipeline phases are required:

| Content Type | Benchmark phase | Companion repo | Social strategy | Methodology review |
|-------------|----------------|----------------|-----------------|-------------------|
| **Project launch** | Optional (existing repo) | Existing repo linked | Show HN | If benchmarks present |
| **Technical deep-dive** | Required | New test suite | Standard HN + LinkedIn | Required |
| **Analysis/opinion** | Skip | Optional | Standard HN + LinkedIn | Skip |

**Mode detection:** Inferred from prompt specificity. A prompt that names specific research targets, architecture decisions, and companion repo specs triggers directed mode. A prompt like "write about X" triggers exploratory mode with collaboration checkpoints.

**Pipeline resume:** Every sub-step in the publish pipeline is idempotent and tracked in SQLite. If the pipeline fails at step 6 of 10, `blog publish <slug>` resumes from step 7. Each completed sub-step is recorded with a timestamp. The resume logic checks which steps have completed and skips them.

### Key Design Decisions

- **Claude Code as interface, not a custom REPL:** The interactive AI work (research, benchmarking, drafting, evaluation) happens in Claude Code sessions using the author's existing subscription. No need to build a separate chat UI or terminal REPL. The standalone CLI handles only mechanical, non-AI operations.
- **Primary-source research, not aggregation:** The agent builds and runs original test suites. Every benchmark claim in a published post is backed by data the author generated, stored in a companion repo readers can clone and verify. This is the core differentiator from other technical blogs.
- **Benchmark before draft, not after:** The companion repo and test harness are created during the benchmark phase, before drafting begins. The draft incorporates real data from test runs. This inverts the typical "write post, add code sample" workflow.
- **Three-reviewer panel, not a single adversary:** Claude handles structural review (schema, syntax, sources). GPT-5.4 high challenges the thesis and argument. GPT-5.4 xhigh deep-reviews benchmark methodology and statistical rigor. All three run in parallel. The synthesizer categorizes issues by consensus (all three agree), majority (2 of 3), or single-reviewer (1 of 3 — investigate, author decides). Disagreements between reviewers are themselves informative signal.
- **Content types drive pipeline behavior:** Not all posts are the same. Project launches, technical deep-dives, and analysis/opinion pieces each have different benchmark requirements, companion repo needs, and social strategies. Content type is detected from the prompt and research, not from a flag.
- **PR-based publishing, not direct push:** Content goes to m0lz.00 via pull request with local preview and CI/CD verification. This catches MDX rendering issues before production.
- **Excalidraw-first visuals:** Every post gets auto-generated architecture diagrams and benchmark data visualizations. Visuals are not optional — they're part of the quality contract.
- **Companion repos are bidirectional:** A post might document an existing project (link to it) OR the agent might scaffold a new project repo as part of the post pipeline (the MinIO example). The state machine handles both directions.
- **Fallback is structural:** Medium and Substack APIs are unreliable. The pipeline never blocks on them — it generates paste-ready markdown and continues. Dev.to is the only required cross-post target.
- **Idempotent pipeline with resume:** Every publish sub-step is idempotent and checkpointed. A failure at step 6 of 10 doesn't require re-running steps 1-5. This is critical for a pipeline that touches multiple external APIs.
- **Day-one accuracy:** Existing m0lz.00 posts are imported on `blog init` so that status and metrics reflect the full publishing history, not just agent-created posts.
- **Content ages; data doesn't have to:** The update workflow re-runs benchmarks against current versions, regenerates affected sections, and republishes. Posts stay accurate over time.

---

## Core Features

### Feature 1: Research Pipeline

Deep research with web search, source gathering, and structured output. In directed mode, executes a specific research brief autonomously. In exploratory mode, surfaces findings and collaborates with the author to shape direction.

**Inputs:** Topic string or detailed research brief
**Outputs:** Structured research document at `.blog-agent/research/{slug}.md` containing: thesis, key findings, sources with URLs, data points, open questions, benchmark targets (what should be tested), and suggested companion repo scope
**AI model:** Claude Code (via subscription) with web search enabled
**State transition:** `research` phase in SQLite

**Key behaviors:**
- Sources are tracked in the `sources` table with URLs and access timestamps
- Research documents follow a consistent structure for downstream consumption by the benchmark and draft phases
- In exploratory mode, the agent highlights interesting projects or angles the author might want to pursue
- Research identifies specific claims that can be verified through original benchmarking
- Minimum 3 sources required (configurable in `.blogrc.yaml`)
- Research output includes a "Benchmark Targets" section: specific claims, comparisons, or hypotheses that should be tested with original data

### Feature 2: Benchmark and Test Harness

Original research through code. The agent scaffolds a test harness or benchmark suite based on research findings, runs it, and collects primary-source data that feeds into the draft.

**Inputs:** Research document with benchmark targets identified
**Outputs:**
- Companion repo at `.blog-agent/repos/{slug}/` containing: test suite source code, benchmark scripts, raw results data, CI config, LICENSE
- `METHODOLOGY.md` documenting: test environment (hardware, OS, dependency versions, date), methodology (what was tested, how, why), reproducibility instructions (how to re-run)
- Structured benchmark results at `.blog-agent/benchmarks/{slug}/results.json`
- Environment snapshot at `.blog-agent/benchmarks/{slug}/environment.json`

**AI model:** Claude Code (via subscription) for test harness generation
**State transition:** `benchmark` phase in SQLite

**Key behaviors:**
- The companion repo is created HERE, not during publish. It's a research artifact, not a marketing artifact.
- Test harness is language-appropriate to the subject (Rust benchmarks for Rust projects, Node.js for JS, etc.)
- Raw data is always preserved — never discard results, even if they contradict the thesis
- Environment metadata is captured automatically: `uname -a`, language versions, dependency versions, hardware specs, timestamp
- `METHODOLOGY.md` follows a consistent template so readers know exactly how to reproduce
- For posts about existing projects (e.g., writing about m0lz.02), benchmarks run against the existing repo rather than scaffolding a new one
- In exploratory mode, the agent proposes benchmark approaches and the author selects which to run
- Results that contradict the research thesis are flagged — the draft should address them honestly, not hide them

**METHODOLOGY.md template:**
```markdown
# Methodology

## Environment
- **Hardware:** {CPU, RAM, disk type}
- **OS:** {name and version}
- **Runtime:** {language version}
- **Dependencies:** {key dependency versions}
- **Date:** {YYYY-MM-DD}

## What Was Tested
{Description of what was measured and why}

## How to Reproduce
{Step-by-step instructions to re-run these benchmarks}

## Raw Data
Results are in `results/` directory. Each run is timestamped.

## Limitations
{Known limitations of this benchmark approach}
```

### Feature 3: MDX Drafting with Excalidraw

Interactive or automated MDX generation with strict PostFrontmatter schema compliance, original benchmark data integration, and auto-generated Excalidraw SVG diagrams.

**Inputs:** Research document + benchmark results from Features 1-2
**Outputs:** Complete MDX file at `.blog-agent/drafts/{slug}.mdx` with frontmatter, prose, code blocks, benchmark data tables/charts, and Excalidraw SVG assets at `.blog-agent/drafts/{slug}/assets/`
**AI model:** Claude Code (via subscription) + Excalidraw skill for diagrams

**PostFrontmatter contract (must match m0lz.00 exactly):**
```typescript
interface PostFrontmatter {
  title: string           // "{catalogId} -- Description" for catalog projects
  description: string     // One-line for SEO and post cards
  date: string            // "YYYY-MM-DD"
  tags: string[]          // Agent-driven taxonomy
  published: boolean      // true to appear on site
  canonical?: string      // "https://m0lz.dev/writing/{slug}"
  companion_repo?: string // "https://github.com/jmolz/{repo}"
  project?: string        // "m0lz.02" -- links to catalog project
  medium_url?: string     // Populated after cross-post
  devto_url?: string      // Populated after cross-post
}
```

**Content conventions:**
- No emojis (design constraint)
- No bare `<` characters (MDX interprets as JSX)
- Code blocks must specify language for syntax highlighting
- Slugs are kebab-case, permanent after publishing
- Agent-driven tag taxonomy informed by existing site tags and content

**Benchmark data integration:**
- Original benchmark data is presented as tables and visualized as charts — never just prose claims
- Every benchmark claim links to the companion repo where readers can verify
- Data that contradicts the thesis is acknowledged, not hidden
- Methodology is referenced: "Tested on {environment} — see METHODOLOGY.md for reproduction steps"
- Comparative benchmarks use consistent formatting across posts for a recognizable style

### Feature 4: Adversarial Evaluation

Three-reviewer evaluation panel. Each reviewer has a distinct role and runs independently in parallel. Results are synthesized into a single report with consensus-based severity.

**Inputs:** Draft MDX + benchmark results + research document
**Outputs:** Synthesized evaluation report at `.blog-agent/evaluations/{slug}.md` containing individual reviewer findings and consensus analysis. Individual reviews stored at `.blog-agent/evaluations/{slug}/structural.md`, `adversarial.md`, `methodology.md`

**Reviewer 1: Structural (Claude Code)**
Role: Content quality, technical correctness, schema compliance
- Factual claims have sources (external sources OR original benchmark data)
- Code blocks are syntactically valid
- Frontmatter is complete and schema-compliant
- No broken links
- MDX renders without errors
- Reading level appropriate
- Benchmark claims match the actual data in results.json
- METHODOLOGY.md is complete and reproducibility instructions are clear

**Reviewer 2: Adversarial (GPT-5.4 high via Codex CLI)**
Role: Challenge the thesis, find argument weaknesses
- Challenges the thesis — are there counterarguments not addressed?
- Identifies logical gaps or unsupported leaps
- Flags claims that need stronger evidence
- Checks for bias or one-sided framing
- Evaluates whether the post delivers on its title's promise
- Checks if contradictory data was acknowledged or suppressed
- Assesses whether the conclusion follows from the evidence presented

**Reviewer 3: Methodology (GPT-5.4 xhigh via Codex CLI)**
Role: Deep review of benchmark design and statistical validity
- Are there confounding variables that weren't controlled for?
- Is the sample size sufficient for the claims being made?
- Are the comparisons fair (same hardware, same config, same workload)?
- Could the results be explained by something other than what the author claims?
- Are statistical methods appropriate (if used)?
- Would the benchmark design survive peer review?
- Are limitations honestly stated?
- Skipped for analysis/opinion content type (no benchmarks to review)

**Synthesis:**
All three reviews are merged into a single report with issue categorization:
- **Consensus issues** (all 3 reviewers flagged): Must fix before publish
- **Majority issues** (2 of 3 flagged): Should fix — high confidence problems
- **Single-reviewer issues** (1 of 3 flagged): Investigate — author decides
- **Reviewer disagreements**: Highlighted as valuable signal (e.g., methodology reviewer says sample size is too small, but adversarial reviewer didn't notice — real concern but not obvious to general readers)

**Gate:** All consensus and majority issues must be resolved before `blog publish` will execute. Single-reviewer issues are advisory. The evaluation report includes a clear pass/fail verdict with reasoning.

### Feature 5: Publish Pipeline

Sequential publish process with idempotent sub-steps and resume-on-failure support. PR to m0lz.00, local preview, CI/CD verification, cross-posting, companion repo, and frontmatter updates.

**Steps (each is idempotent and checkpointed in SQLite):**
1. **Verify** — Confirm evaluation passed. Abort if not.
2. **PR to site** — Copy MDX + assets to site repo `content/posts/{slug}/`. Create PR (not direct push to main).
3. **Local preview** — Author can preview the post locally before merging.
4. **CI/CD gate** — Vercel preview deployment verifies rendering. Author merges when satisfied.
5. **Cross-post Dev.to** — Forem API with `canonical_url` set to `https://m0lz.dev/writing/{slug}`.
6. **Cross-post Medium** — Attempt API. On failure, generate paste-ready markdown to `.blog-agent/social/{slug}/medium-paste.md`. Never block pipeline.
7. **Cross-post Substack** — Attempt API. On failure, generate paste-ready content. Never block pipeline.
8. **Companion repo push** — If companion repo exists in `.blog-agent/repos/{slug}/`: push to GitHub via Octokit, set description and URL pointing to blog post. If post references an existing project repo, skip creation.
9. **Update frontmatter** — Commit updated frontmatter (with platform URLs) back to site repo.
10. **Update project README** — If post has `project` field, update the project repo README with a link under "## Writing" section. Idempotent.
11. **Generate research page** — If post has research artifacts, generate/update the corresponding research page in m0lz.00 `content/research/`.
12. **Social text generation** — Generate platform-optimized text for LinkedIn and Hacker News.

**Resume behavior:** If the pipeline fails at any step, `blog publish <slug>` resumes from the first incomplete step. Each completed step is recorded in the `pipeline_steps` table with a timestamp. Steps that produce external side effects (API calls, git pushes) are designed to be safe to re-run — they check for existing state before acting.

### Feature 6: Social Distribution

Generate platform-optimized text for manual posting on LinkedIn and Hacker News. Output includes posting timing recommendations.

**LinkedIn output** (`.blog-agent/social/{slug}/linkedin.md`):
- Professional summary format
- Key takeaway highlighted (from benchmark data when applicable)
- Link to canonical URL
- Appropriate hashtags
- Posting recommendation: best days/times for technical content engagement

**Hacker News output** (`.blog-agent/social/{slug}/hackernews.md`):
- Title formatted for HN (80 character limit)
- "Show HN:" prefix for new project posts, standard title for analysis/opinion posts
- URL to canonical post
- Suggested first-comment text (as is HN convention: provide context, summarize key findings, link to companion repo)
- Posting recommendation: Tuesday-Thursday, 9-11am ET for peak visibility

### Feature 7: Content Updates

Re-run benchmarks against current software versions, regenerate affected sections, and republish. Keeps content accurate over time.

**Triggers:**
- Manual: `/blog-update <slug>` or `blog update <slug>`
- Future: could be triggered by dependency version watches (out of scope for MVP)

**Process:**
1. Load original research document and benchmark configuration
2. Re-run benchmarks against current versions of tested software
3. Compare new results with original data — flag significant changes
4. Regenerate affected sections of the draft with updated data
5. Add an update notice to the post with the date and summary of changes
6. Preserve original data alongside updated data (readers can see what changed)
7. Re-evaluate updated content through adversarial review
8. Publish update via the same PR + CI/CD pipeline
9. Update cross-posts where the platform API supports editing (Dev.to supports PUT)

**Update notice format (appended to post):**
```markdown
---

**Updated {YYYY-MM-DD}:** Re-ran benchmarks against {software} {version}. {Summary of what changed.} Original benchmark data is preserved in the companion repo's `results/` directory.
```

### Feature 8: Research Page Generation

Auto-generate research pages for m0lz.00 from the structured research artifacts produced during the research and benchmark phases. These become the `/research/{slug}` pages on the site.

**Inputs:** Research document + benchmark results + sources
**Outputs:** Research page MDX at `.blog-agent/research-pages/{slug}/index.mdx`

**Content includes:**
- Thesis and key findings from research
- Source bibliography with annotations
- Benchmark methodology summary (links to full METHODOLOGY.md in companion repo)
- Key data visualizations from benchmark results
- Open questions and areas for further research
- Links to the associated blog post and companion repo

**Best-in-class approach:** Research pages serve a different audience than blog posts. Posts are narratives; research pages are reference material. A reader who finds the blog post interesting should be able to go deeper via the research page. A researcher who finds the research page should be able to read the accessible version via the blog post. They cross-link but serve different purposes.

### Feature 9: Pipeline Status, Metrics, and Existing Post Import

CLI commands for tracking post progress, aggregate publishing stats, and importing existing content.

**`blog init --import`** — Scans m0lz.00 `content/posts/` directory and imports existing posts into the state DB:
- Reads frontmatter from each post's `index.mdx`
- Creates `published` phase entries with known URLs (canonical, devto_url, medium_url from frontmatter)
- Sets `mode` to `imported` for pre-agent posts
- Provides accurate baseline for status and metrics from day one

**`blog status`** — Shows all posts (imported + agent-created) and their current pipeline phase:
```
slug                    phase        status          mode
hey-im-jacob            published    imported        imported
pice-framework          published    imported        imported
mcp-guard               published    imported        imported
case-pilot              published    imported        imported
investor-matchmaker     published    imported        imported
post-minio-s3           benchmark    running tests   directed
agentic-harnesses       research     3 sources       exploratory
```

**`blog metrics`** — Aggregate stats:
- Total posts published (imported + agent-created, distinguished)
- Platform distribution (site, Dev.to, Medium, Substack)
- Companion repos created with benchmark data
- Average research-to-publish time (agent-created posts only)
- Evaluation pass/fail rates
- Posts updated since original publication

### Feature 10: Content Unpublish / Rollback

Remove a published post from production and handle cross-post cleanup. Rare but important when it happens.

**`blog unpublish <slug>`:**
1. Set `published: false` in m0lz.00 frontmatter, commit and push (post disappears from site)
2. Attempt to delete/unpublish Dev.to cross-post via API (if supported)
3. Generate manual removal instructions for Medium and Substack
4. Update SQLite state: phase reverts to `draft`, unpublish event logged in metrics
5. Companion repo is NOT deleted (code artifacts may have independent value)
6. Research page is NOT deleted (research has independent value)
7. Social posts are already manual — no action needed

**Safety:** Requires explicit confirmation. Canonical URL remains permanently reserved (never reuse a slug). The post can be re-published later with `blog publish`.

### Feature 11: Editorial Backlog

Lightweight topic idea tracking so ideas can be captured without starting the full pipeline.

**`blog ideas`** — Manage a YAML-based editorial backlog at `.blog-agent/ideas.yaml`:

```yaml
ideas:
  - topic: "Post-MinIO S3 server landscape"
    content_type: "technical-deep-dive"
    project: "m0lz.0a"
    notes: "Benchmark all alternatives on $20 VPS. Companion test suite."
    added: "2026-04-14"
    priority: high

  - topic: "Full agentic harnesses compared"
    content_type: "analysis"
    notes: "Surface interesting projects, could become a series"
    added: "2026-04-14"
    priority: medium
```

**Commands:**
- `blog ideas` — List all ideas, sorted by priority
- `blog ideas add "topic"` — Add a new idea (interactive prompts for content type, notes, priority)
- `blog ideas start <index>` — Move an idea into the pipeline (creates research phase entry, removes from backlog)
- `blog ideas remove <index>` — Remove an idea from the backlog

**Integration:** When `/blog-pipeline` or `/blog-research` is run without a topic, the agent can suggest ideas from the backlog.

---

## Hub-Spoke Content Architecture

m0lz.dev owns all content and SEO authority. Every other surface links back.

```
                    m0lz.dev (m0lz.00)
                    Canonical hub
                    /writing/{slug}
                          |
        +-----------------+-----------------+
        |                 |                 |
   Cross-post        Project repos     Social media
   platforms          (README links)   (link to hub)
                                       
   Dev.to (primary)   m0lz.02          LinkedIn
   Medium (fallback)  m0lz.03          Hacker News
   Substack (fallback) m0lz.04
```

### Rules

1. **Single publish target** — the agent always commits MDX to `m0lz.00/content/posts/{slug}/`. No content in spoke repos.
2. **Canonical URL is king** — every cross-post, every README link, every social share points to `m0lz.dev/writing/{slug}`.
3. **`project` field = catalog glue** — frontmatter `project` field uses catalog IDs to link content to projects. The Research page uses this for grouping.
4. **Fallback is structural** — the pipeline never blocks on Medium or Substack API failures.
5. **README updates are additive and idempotent** — the agent appends links to README sections, never duplicating.

---

## Security & Configuration

### Authentication

No user-facing auth. The agent runs locally with API keys stored in environment variables. Git operations use the author's local Git credentials. GitHub API uses a personal access token.

### Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `ANTHROPIC_API_KEY` | Claude API (fallback if not using Claude Code subscription) | No |
| `DEVTO_API_KEY` | Dev.to cross-posting via Forem API | Yes (for cross-posting) |
| `MEDIUM_TOKEN` | Medium integration token (deprecated API) | No |
| `SUBSTACK_API_KEY` | Substack API access | No |
| `GITHUB_TOKEN` | Companion repo creation and PR management via Octokit | Yes |
| `VERCEL_TOKEN` | Deploy status polling (optional, for automated preview checks) | No |

### Configuration (`.blogrc.yaml`)

```yaml
site:
  repo_path: "../m0lz.00"
  base_url: "https://m0lz.dev"
  content_dir: "content/posts"

author:
  name: "Jacob Molz"
  github: "jmolz"
  devto: "jmolz"
  medium: "@jmolz"
  substack: "jmolz"
  linkedin: "jacobmolz"

ai:
  primary: "claude-code"          # Uses Claude Code subscription for research, drafting, structural review
  reviewers:                      # Three-reviewer evaluation panel
    structural: "claude-code"     # Content quality, schema, MDX, sources
    adversarial: "codex-cli"      # GPT-5.4 high — thesis challenge, bias, argument gaps
    methodology: "codex-cli"      # GPT-5.4 xhigh — benchmark validity, statistics, reproducibility
  codex:
    adversarial_effort: "high"    # Reasoning effort for adversarial review
    methodology_effort: "xhigh"   # Reasoning effort for methodology review

content_types:                    # Pipeline behavior per content type
  project-launch:
    benchmark: optional           # Existing project may already have benchmarks
    companion_repo: existing      # Link to existing repo, don't scaffold new one
    social_prefix: "Show HN:"    # HN submission prefix
  technical-deep-dive:
    benchmark: required           # Must have original test data
    companion_repo: new           # Scaffold test suite as companion repo
    social_prefix: ""             # Standard HN title
  analysis-opinion:
    benchmark: skip               # No test data needed
    companion_repo: optional      # Only if code examples warrant it
    social_prefix: ""             # Standard HN title

benchmark:
  capture_environment: true       # Auto-capture hardware/OS/versions
  methodology_template: true      # Generate METHODOLOGY.md from template
  preserve_raw_data: true         # Never discard results, even contradictory
  multiple_runs: 3                # Number of benchmark runs for statistical validity

publish:
  devto: true
  medium: true                    # Fallback to paste-ready on failure
  substack: true                  # Fallback to paste-ready on failure
  github_repos: true
  social_drafts: true
  research_pages: true            # Auto-generate research pages for m0lz.00

social:
  platforms:
    - linkedin
    - hackernews
  timing_recommendations: true    # Include best posting times in output

evaluation:
  require_pass: true
  min_sources: 3
  max_reading_level: 12
  three_reviewer_panel: true      # Run all three reviewers in parallel
  consensus_must_fix: true        # All-3-agree issues block publish
  majority_should_fix: true       # 2-of-3 issues block publish
  single_advisory: true           # 1-of-3 issues are advisory only
  verify_benchmark_claims: true   # Check prose claims against results.json
  methodology_completeness: true  # Verify METHODOLOGY.md is reproducible

updates:
  preserve_original_data: true    # Keep original benchmark data alongside updates
  update_notice: true             # Append update notice with date and summary
  update_crosspost: true          # Attempt to update Dev.to cross-posts
```

### Deployment

The agent itself is not deployed — it runs locally. The content it produces deploys to:
- **m0lz.dev** via Vercel (auto-deploys on merge to main of m0lz.00)
- **Dev.to** via Forem API
- **GitHub** via Octokit (companion repos)

---

## State Management

SQLite database at `.blog-agent/state.db`:

```sql
-- Core post tracking
CREATE TABLE posts (
  slug TEXT PRIMARY KEY,
  title TEXT,
  topic TEXT,
  content_type TEXT CHECK(content_type IN ('project-launch', 'technical-deep-dive', 'analysis-opinion')),
  phase TEXT CHECK(phase IN ('idea', 'research', 'benchmark', 'draft', 'evaluate', 'publish', 'published', 'unpublished')),
  mode TEXT CHECK(mode IN ('directed', 'exploratory', 'imported')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME,
  unpublished_at DATETIME,            -- When content was unpublished (Feature 10)
  last_updated_at DATETIME,           -- When content was last updated (Feature 7)
  site_url TEXT,
  devto_url TEXT,
  medium_url TEXT,
  substack_url TEXT,
  repo_url TEXT,
  project_id TEXT,
  evaluation_passed BOOLEAN,
  evaluation_score REAL,
  has_benchmarks BOOLEAN DEFAULT FALSE,
  update_count INTEGER DEFAULT 0      -- Number of times content has been updated
);

-- Research source tracking
CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  url TEXT NOT NULL,
  title TEXT,
  excerpt TEXT,
  source_type TEXT CHECK(source_type IN ('external', 'benchmark', 'primary')) DEFAULT 'external',
  accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Benchmark run tracking
CREATE TABLE benchmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  run_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  environment_json TEXT NOT NULL,      -- Full environment snapshot (hardware, OS, versions)
  results_path TEXT NOT NULL,          -- Path to results.json
  is_update BOOLEAN DEFAULT FALSE,     -- TRUE if this is a re-run for content update
  previous_run_id INTEGER REFERENCES benchmarks(id),  -- Links update runs to originals
  status TEXT CHECK(status IN ('pending', 'running', 'completed', 'failed')) DEFAULT 'pending'
);

-- Pipeline sub-step tracking for resume-on-failure
CREATE TABLE pipeline_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  step_number INTEGER NOT NULL,
  step_name TEXT NOT NULL,             -- 'verify', 'pr_to_site', 'crosspost_devto', etc.
  status TEXT CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped')) DEFAULT 'pending',
  started_at DATETIME,
  completed_at DATETIME,
  error_message TEXT,                  -- Stored on failure for diagnostic
  UNIQUE(post_slug, step_name)         -- Only one record per step per post
);

-- Generated assets (diagrams, charts, images)
CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  type TEXT CHECK(type IN ('excalidraw', 'chart', 'image', 'benchmark_viz')),
  filename TEXT NOT NULL,
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Three-reviewer evaluation panel results
CREATE TABLE evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  reviewer TEXT CHECK(reviewer IN ('structural', 'adversarial', 'methodology')) NOT NULL,
  model TEXT NOT NULL,                 -- 'claude-code', 'gpt-5.4-high', 'gpt-5.4-xhigh'
  passed BOOLEAN,
  issues_json TEXT,                    -- JSON array of issues found
  report_path TEXT NOT NULL,           -- Path to full review markdown
  run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_update_review BOOLEAN DEFAULT FALSE  -- TRUE if reviewing updated content
);

-- Synthesized evaluation verdicts
CREATE TABLE evaluation_synthesis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  consensus_issues INTEGER DEFAULT 0,  -- Issues all 3 flagged (must fix)
  majority_issues INTEGER DEFAULT 0,   -- Issues 2 of 3 flagged (should fix)
  single_issues INTEGER DEFAULT 0,     -- Issues 1 of 3 flagged (advisory)
  verdict TEXT CHECK(verdict IN ('pass', 'fail')) NOT NULL,
  report_path TEXT NOT NULL,           -- Path to synthesized report
  synthesized_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- General event log for metrics
CREATE TABLE metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  event TEXT NOT NULL,
  value TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Schema design notes:**
- `posts.content_type` drives pipeline behavior (which phases are required/optional/skipped)
- `posts.phase = 'idea'` represents backlog items promoted from `ideas.yaml` via `blog ideas start`
- `posts.phase = 'unpublished'` tracks rollback state for Feature 10
- `pipeline_steps` enables resume: query for the first step where `status != 'completed'` and resume from there
- `benchmarks` tracks multiple runs per post, linking updates to originals so you can see how data changed over time
- `evaluations` stores individual reviewer results; `evaluation_synthesis` stores the merged verdict
- `sources.source_type` distinguishes external citations from primary benchmark data
- `posts.mode = 'imported'` identifies pre-agent posts imported from m0lz.00 on init
- All timestamps use UTC for consistency

---

## Current Catalog (from m0lz.00 `data/projects.ts`)

| ID | Description | Status |
|----|-------------|--------|
| `m0lz.00` | Monochrome developer blog and portfolio | Shipped |
| `m0lz.01` | Idea-to-distribution pipeline (this project) | Building |
| `m0lz.02` | Structured AI coding workflow orchestrator | Shipped |
| `m0lz.03` | MCP security proxy daemon | Shipped |
| `m0lz.04` | AI legal case management | Shipped |
| Investor Matchmaker | Investor-founder meeting scheduler | Shipped |
| Bloom | AI-powered revenue discovery | Active |
| Alpaka | Value chain intelligence for real estate | Active |
| Ready Text | Waitlist texting platform | Active |

---

## Implementation Phases

### Phase 1: Foundation

**Goal:** Working project scaffold with config, state management, CLI skeleton, and existing post import. Everything builds on this.

- [ ] TypeScript project setup (package.json, tsconfig.json, build config)
- [ ] Commander.js CLI with `blog init`, `blog status`, `blog metrics` command stubs
- [ ] Full SQLite schema creation (all tables including `benchmarks`, `pipeline_steps`, `evaluations`, `evaluation_synthesis`)
- [ ] Schema migration system for future changes
- [ ] Config loader (`.blogrc.yaml` parsing and validation)
- [ ] `.env.example` with all environment variables documented
- [ ] `.blogrc.example.yaml` with annotated defaults
- [ ] Claude Code skill file scaffolding (frontmatter definitions for all skills)
- [ ] `.blog-agent/` directory structure creation (research, benchmarks, drafts, repos, social, evaluations, research-pages)
- [ ] `blog ideas` command with add/list/start/remove subcommands (reads/writes `.blog-agent/ideas.yaml`)
- [ ] Existing post import: `blog init --import` scans m0lz.00 and populates state DB with published posts
- [ ] Content type detection utility (used by research and pipeline phases)

**Validation:** `blog init` creates config and DB. `blog init --import` with m0lz.00 path populates 5 existing posts as `imported`. `blog status` shows all 5 imported posts. `blog ideas add "test topic"` creates ideas.yaml entry. Project builds and lints cleanly.

### Phase 2: Research Pipeline

**Goal:** Given a topic or brief, the agent can research it and produce a structured research document with sources and benchmark targets.

- [ ] Research orchestration module (handles both directed and exploratory modes)
- [ ] Web search integration (via Claude Code's web search capability)
- [ ] Source tracking (saves to SQLite `sources` table with `source_type`)
- [ ] Structured research document output format with "Benchmark Targets" section
- [ ] `/blog-research` Claude Code skill definition
- [ ] State transitions: creates `research` phase entry in DB
- [ ] Research document template

**Validation:** Run `/blog-research "MinIO timeline and S3 alternatives"` — produces a structured document with 3+ sources, benchmark targets identified, all tracked in DB. Run `/blog-research "agentic harnesses"` — enters collaborative mode, surfaces findings, suggests what could be benchmarked.

### Phase 3: Benchmark and Test Harness

**Goal:** Given research with benchmark targets, the agent scaffolds a test suite, runs it, and produces primary-source data with full reproducibility documentation.

- [ ] Test harness scaffolding from research findings (language-appropriate to subject)
- [ ] Benchmark runner that executes tests and collects structured results
- [ ] Environment capture: automatic snapshot of hardware, OS, runtime versions, dependency versions, date
- [ ] `METHODOLOGY.md` generation from template
- [ ] Raw results storage at `.blog-agent/benchmarks/{slug}/results.json`
- [ ] Environment snapshot at `.blog-agent/benchmarks/{slug}/environment.json`
- [ ] Companion repo structure at `.blog-agent/repos/{slug}/` (source, tests, results, CI, LICENSE, METHODOLOGY.md)
- [ ] `/blog-benchmark` Claude Code skill definition
- [ ] Benchmark run tracking in SQLite `benchmarks` table
- [ ] State transitions: updates to `benchmark` phase in DB
- [ ] Handle "no benchmarks needed" case: some posts are opinion/analysis pieces without testable claims — skip gracefully

**Validation:** Run `/blog-benchmark` on MinIO research — scaffolds an S3 compatibility test suite, captures environment, runs tests (or provides runnable commands), stores results. `METHODOLOGY.md` is complete and a reader could reproduce the test. Results that contradict research thesis are flagged, not hidden.

### Phase 4: Drafting and Visuals

**Goal:** Given research + benchmark data, the agent produces a complete MDX post with original data integration, Excalidraw diagrams, and benchmark visualizations.

- [ ] MDX generation module with PostFrontmatter schema enforcement
- [ ] Content-type-aware drafting (project launches link existing repos, deep-dives cite benchmark data, opinion pieces need no benchmarks)
- [ ] Benchmark data integration: tables, charts, and citations to companion repo
- [ ] Excalidraw SVG auto-generation integration (architecture diagrams)
- [ ] Benchmark data visualization (comparison charts, performance graphs)
- [ ] Agent-driven tag taxonomy (reads existing site tags for consistency)
- [ ] `/blog-draft` Claude Code skill definition
- [ ] Frontmatter field auto-population (canonical URL, project link, companion repo)
- [ ] State transitions: updates to `draft` phase in DB
- [ ] Asset management (SVGs and charts stored alongside draft)
- [ ] Methodology reference in prose: "Tested on {env} — see METHODOLOGY.md"

**Validation:** Run `/blog-draft` on completed research + benchmarks — produces valid MDX with correct frontmatter, at least one Excalidraw SVG, benchmark data tables/charts that match results.json, and tags consistent with existing site taxonomy. MDX renders without errors in m0lz.00 locally. Benchmark claims in prose match actual data.

### Phase 5: Three-Reviewer Evaluation Panel

**Goal:** Automated quality check with three independent reviewers running in parallel: Claude (structural), GPT-5.4 high (adversarial), GPT-5.4 xhigh (methodology). Synthesized into a consensus-based report.

- [ ] Structural reviewer (Claude): sources, syntax, frontmatter, links, MDX rendering, benchmark-data-matches-prose check
- [ ] Adversarial reviewer (GPT-5.4 high via Codex CLI): thesis challenge, bias detection, argument gap analysis
- [ ] Methodology reviewer (GPT-5.4 xhigh via Codex CLI): benchmark validity, statistical rigor, reproducibility, confounding variables
- [ ] Parallel execution: all three reviewers run simultaneously
- [ ] Synthesizer: merge three independent reviews into consensus/majority/single-reviewer report
- [ ] Individual review storage in SQLite `evaluations` table
- [ ] Synthesized verdict storage in `evaluation_synthesis` table
- [ ] Content-type-aware review: methodology reviewer is skipped for analysis/opinion posts (no benchmarks)
- [ ] `/blog-evaluate` Claude Code skill definition
- [ ] Pass/fail gate: consensus + majority issues must be resolved; single-reviewer issues are advisory
- [ ] State transitions: updates to `evaluate` phase in DB

**Validation:** Run `/blog-evaluate` on a draft — produces three independent reviews plus synthesized report. Intentionally introduce: (1) a broken link (structural catches), (2) a logical gap in argument (adversarial catches), (3) an unfair benchmark comparison (methodology catches). Verify that each reviewer independently identifies their domain's issue. Synthesized report correctly categorizes by consensus/majority/single.

### Phase 6: Publish Pipeline with Resume

**Goal:** One command takes a passing draft from local files to live on m0lz.dev and cross-posted to Dev.to. Resumable on failure.

- [ ] Pipeline step tracking in SQLite `pipeline_steps` table
- [ ] Resume logic: query for first incomplete step, resume from there
- [ ] Step 1: Verify evaluation passed
- [ ] Step 2: Copy MDX + assets to m0lz.00 repo, create PR
- [ ] Step 3: Vercel preview deploy detection (poll or webhook)
- [ ] Step 4: Cross-post to Dev.to via Forem API with canonical_url
- [ ] Step 5: Cross-post to Medium with fallback to paste-ready markdown
- [ ] Step 6: Cross-post to Substack with fallback to paste-ready content
- [ ] Step 7: Push companion repo to GitHub via Octokit (if new, skip if existing)
- [ ] Step 8: Update frontmatter with platform URLs, commit to site repo
- [ ] Step 9: Update project README with link under "## Writing" section (idempotent)
- [ ] Step 10: Generate/update research page in m0lz.00 `content/research/`
- [ ] Step 11: Generate social text (LinkedIn + Hacker News)
- [ ] `blog publish` CLI command with resume support
- [ ] State transitions: updates to `published` phase in DB with all URLs

**Validation:** Run `blog publish` on a passing evaluation — creates PR on m0lz.00, cross-posts to Dev.to with correct canonical URL, generates paste files for Medium/Substack, pushes companion repo, updates frontmatter. Kill the process mid-pipeline, re-run `blog publish` — resumes from last incomplete step without duplicating completed steps.

### Phase 7: Distribution, Updates, and Operations

**Goal:** Platform-optimized social text, content update workflow, unpublish/rollback, full pipeline orchestrator, and operational visibility.

- [ ] LinkedIn post generation (professional format, key takeaway from benchmarks, hashtags, timing recommendation)
- [ ] Hacker News submission generation (Show HN for projects, standard for analysis; 80-char title, first-comment text, timing recommendation)
- [ ] Content-type-aware social strategy (Show HN prefix only for project-launch type)
- [ ] `blog status` implementation (reads from SQLite, formatted table with phase, mode, and content type)
- [ ] `blog metrics` implementation (aggregate stats, imported vs. agent-created distinguished, evaluation panel breakdown)
- [ ] `blog unpublish <slug>` — rollback: set published: false, attempt cross-post removal, log event, require confirmation
- [ ] `/blog-pipeline` orchestrator skill (chains research -> benchmark -> draft -> evaluate -> publish, content-type-aware)
- [ ] `/blog-update` skill (re-run benchmarks, regenerate sections, re-evaluate with panel, republish with update notice)
- [ ] `blog update` CLI command for the mechanical parts of content updates
- [ ] Research page auto-generation for m0lz.00 from research + benchmark artifacts
- [ ] Update notice formatting (date, summary of changes, preservation of original data)

**Validation:** Run full pipeline end-to-end with `/blog-pipeline` and a detailed prompt — runs research through publish without human intervention. Social outputs are platform-appropriate (HN title under 80 chars, Show HN prefix for project-launch type only). Status and metrics reflect accurate pipeline state including imported posts and content types. Run `/blog-update` on a published post — re-runs benchmarks, regenerates affected sections, appends update notice, re-evaluates with three-reviewer panel, and republishes. Run `blog unpublish` — sets published: false, handles cross-post cleanup, requires confirmation.

---

## Success Criteria

- [ ] A detailed prompt (like the MinIO example) runs research-to-publish without human intervention, including original benchmark data
- [ ] An exploratory prompt ("write about agentic harnesses") enters collaborative mode with meaningful research surfacing and benchmark target identification
- [ ] Every benchmark claim in a published post is backed by original test data from a companion repo readers can clone and run
- [ ] Every companion repo includes a complete METHODOLOGY.md with environment details and reproduction steps
- [ ] Every published post has at least one Excalidraw SVG diagram and benchmark data visualization
- [ ] Three-reviewer panel catches issues across all domains: structural (Claude), adversarial (GPT-5.4 high), methodology (GPT-5.4 xhigh)
- [ ] Consensus/majority/single-reviewer categorization produces actionable, prioritized feedback
- [ ] Cross-posts to Dev.to include correct canonical URL to m0lz.dev
- [ ] No content reaches production without resolving all consensus and majority issues from the evaluation panel
- [ ] Content type detection correctly routes pipeline behavior (project-launch vs. technical-deep-dive vs. analysis-opinion)
- [ ] Pipeline resumes from last checkpoint on failure without duplicating completed steps
- [ ] `blog status` shows all posts (imported + agent-created) with accurate phase tracking
- [ ] Social distribution text is platform-appropriate (LinkedIn professional, HN Show HN with 80-char titles)
- [ ] Content updates re-run benchmarks, preserve original data alongside new data, and append update notices
- [ ] Research pages are auto-generated and cross-linked with blog posts
- [ ] Editorial backlog captures ideas without starting the full pipeline
- [ ] Unpublish/rollback cleanly removes content from production and handles cross-post cleanup
- [ ] Agent repo has full test coverage and CI
- [ ] Installable via `npx` by others

---

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Medium API fully deprecated / non-functional | Low | High | Fallback to paste-ready markdown is built into the pipeline. Never blocks. |
| Substack API unavailable or undocumented | Low | High | Same fallback strategy as Medium. Paste-ready content generated. |
| Codex CLI interface changes or breaks | Medium | Medium | Each reviewer is an isolated module. Panel degrades gracefully: if Codex is unavailable, Claude runs structural review alone. If one Codex effort level fails, the other still runs. Minimum viable evaluation: Claude structural review only. |
| Three reviewers produce conflicting or noisy feedback | Low | Medium | Synthesizer categorizes by consensus weight. Single-reviewer issues are advisory only, reducing noise. Author sees the categorization and decides. Over time, tuning reviewer prompts reduces false positives. |
| MDX rendering issues in m0lz.00 | Medium | Medium | PR-based publish with local preview and CI/CD catches issues before production. |
| Excalidraw generation produces low-quality diagrams | Low | Medium | Agent generates first pass; author can refine. Quality improves with better prompting over time. |
| Benchmark tests fail or produce inconsistent results | Medium | Medium | Store raw data regardless. Flag inconsistencies in evaluation. Author decides whether to address or acknowledge in post. Multiple runs with statistical analysis where appropriate. |
| Benchmark environment not reproducible by readers | Medium | Medium | METHODOLOGY.md captures full environment. Companion repo includes Docker/nix config where practical. CI runs benchmarks to verify reproducibility. |
| Dev.to API rate limiting | Low | Low | Single-post publishing cadence is well within limits. |
| Cross-post formatting differences | Medium | Medium | Platform-specific transformers strip/convert incompatible MDX syntax. Benchmark tables/charts converted to platform-compatible formats. |
| SQLite state corruption | Medium | Low | WAL mode, regular backups, state is reconstructable from file system artifacts. |
| Pipeline fails mid-way on external API | Medium | Medium | Idempotent sub-steps with checkpointing. Resume from last completed step. Each step checks for existing state before acting. |
| Benchmark data contradicts thesis | Low | Medium | This is a feature, not a bug. The evaluation flags it, the draft addresses it honestly. Contradictory data that's acknowledged builds more credibility than data that's hidden. |
| Content updates break existing cross-post links | Low | Low | Dev.to supports PUT for updates. Medium/Substack updates are paste-ready. Canonical URLs never change. |
| Imported posts have incomplete metadata | Low | Medium | Import reads available frontmatter. Missing fields (devto_url, medium_url) are left null. Author can manually populate via `blog status --edit`. |

---

## Assumptions

These assumptions were made during PRD creation and should be validated:

1. **Claude Code skills can shell out to Codex CLI** — The adversarial evaluation depends on being able to invoke `codex` from within a Claude Code skill. Needs verification.
2. **Dev.to Forem API supports canonical_url on creation** — Believed true based on documentation, but should be tested with a real API key.
3. **Codex CLI is installed and configured** — The author has confirmed Codex CLI is used on other projects, but setup in this project context needs verification.
4. **m0lz.00 accepts PRs** — The publish pipeline creates PRs rather than direct pushes. The m0lz.00 repo must have branch protection or at minimum support PR workflow.
5. **Excalidraw skill produces SVGs suitable for MDX embedding** — The existing excalidraw-diagram skill generates Excalidraw JSON. The pipeline needs to convert this to SVG for embedding in posts.
6. **Substack has no usable write API** — Treating as fallback-only. If a functional API is discovered, it can be promoted to primary.
7. **Benchmark test harnesses can be scaffolded and run locally** — Some benchmarks may require external services (cloud APIs, specific hardware). The agent should detect when a benchmark can't run locally and provide instructions for manual execution.
8. **Environment capture is sufficient for reproducibility** — `uname -a` + language versions + dependency lockfile covers most cases. Some benchmarks may need more (BIOS settings, kernel tuning). METHODOLOGY.md has a "Limitations" section for this.
9. **Dev.to API supports PUT for content updates** — Needed for Feature 7 (content updates). If not, updated cross-posts fall back to paste-ready markdown.
