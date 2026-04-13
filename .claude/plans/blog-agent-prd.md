# PRD — m0lz.01: Blog Publishing Agent

## Overview

m0lz.01 is a local CLI tool that orchestrates the full lifecycle of a technical blog post: research, draft, evaluate, publish, and cross-post. It publishes all content to [m0lz.dev](https://m0lz.dev) (m0lz.00) as the canonical hub, with cross-post platforms and project repos as spokes.

The agent runs on the author's machine using their own API keys. No server, no SaaS, no ongoing cost beyond API usage. Open-source, MIT licensed.

**Repo:** [github.com/jmolz/m0lz.01](https://github.com/jmolz/m0lz.01) (placeholder — under development)

---

## Hub-Spoke Content Architecture

m0lz.dev owns all content and SEO authority. Every other surface links back.

```
                    ┌─────────────────────────┐
                    │  m0lz.dev (m0lz.00)     │
                    │  Canonical hub           │
                    │  /writing/{slug}         │
                    └──────────┬──────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                     │
    ┌─────┴──────┐    ┌───────┴────────┐   ┌───────┴───────┐
    │ Cross-post │    │ Project repos  │   │ Social media  │
    │ platforms  │    │ (spoke READMEs │   │ (link to hub) │
    │            │    │  link to hub)  │   │               │
    │ • Dev.to   │    │ • m0lz.02      │   │ • LinkedIn    │
    │ • Medium   │    │ • m0lz.03      │   │ • X/Twitter   │
    │ • Substack │    │ • m0lz.04      │   │               │
    └────────────┘    └────────────────┘   └───────────────┘

    canonical_url →    "## Writing" →       link →
    m0lz.dev/writing/  m0lz.dev/writing/    m0lz.dev/writing/
```

### Rules

1. **Single publish target** — the agent always commits MDX to `m0lz.00/content/posts/{slug}/`. No content in spoke repos.
2. **Canonical URL is king** — every cross-post, every README link, every social share points to `m0lz.dev/writing/{slug}`.
3. **`project` field = catalog glue** — the frontmatter `project` field uses catalog IDs (`m0lz.02`, `m0lz.03`, `m0lz.04`) to link content to projects. The Research page uses this for grouping.
4. **Medium fallback is structural** — the pipeline never blocks on Medium's deprecated API.
5. **README updates are additive** — the agent appends links to README sections. Idempotent.

---

## Current State of the Hub (m0lz.00)

m0lz.00 is shipped and deployed at [m0lz.dev](https://m0lz.dev). The agent must produce content that conforms to the site's existing architecture.

### Site Architecture

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, `output: 'export'`, Turbopack) |
| Styling | Tailwind CSS 4, 4 monochrome color tokens |
| Content | MDX via `@mdx-js/mdx`, `rehype-pretty-code` (Shiki `min-dark`/`min-light`) |
| Fonts | Geist Sans + Geist Mono (400, 500 weights only) |
| Testing | Vitest — 153 regression tests across 5 files |
| Deploy | Vercel (static export, auto-deploys on push to main) |

### Site Structure

```
/                    → Landing page (hero + latest 5 posts + catalog project cards)
/writing             → All posts, reverse chronological
/writing/[slug]      → Individual post (MDX rendering, prev/next nav, project info card)
/projects            → Project cards (public + private sections)
/research            → Research index (per-project research pages)
/research/[slug]     → Research page (slide-out panel with TOC)
/about               → Bio, experience, contact, catalog listing
/feed.xml            → RSS 2.0 feed
```

### PostFrontmatter Schema (the contract between agent and site)

```typescript
// lib/posts.ts — the agent MUST produce this exact schema
export interface PostFrontmatter {
  title: string           // "m0lz.02 — Structured AI Coding Workflows"
  description: string     // One-line for SEO and post cards
  date: string            // "YYYY-MM-DD"
  tags: string[]          // ["ai", "developer-tools"]
  published: boolean      // true to appear on site
  canonical?: string      // "https://m0lz.dev/writing/{slug}"
  companion_repo?: string // "https://github.com/jmolz/m0lz.02"
  project?: string        // "m0lz.02" — links to catalog project
  medium_url?: string     // Populated after cross-post
  devto_url?: string      // Populated after cross-post
}
```

### Content Conventions

- **Catalog project post titles**: `{catalogId} — Description` (e.g., "m0lz.02 — Structured AI Coding Workflows")
- **No old brand names**: Use catalog IDs (m0lz.02, m0lz.03, m0lz.04), never PICE, MCP-Guard, or Case Pilot
- **CLI commands preserved**: `pice plan`, `mcp-guard init` are actual command names — keep as-is
- **No emojis** in any content (design constraint)
- **No bare `<` characters** in prose — MDX interprets them as JSX
- **Code blocks** must specify a language for syntax highlighting
- **Post slugs**: `kebab-case` matching the `content/posts/` directory name
- **URL slugs are permanent**: Never rename a post directory after publishing (breaks bookmarks and SEO)

### MDX Constraints

```yaml
# What the agent must produce:
---
title: "m0lz.02 — Structured AI Coding Workflows"
description: "Plan, Implement, Contract-Evaluate — a structured AI coding methodology."
date: "2026-04-06"
tags: ["ai", "developer-tools", "methodology"]
canonical: "https://m0lz.dev/writing/pice-framework"
companion_repo: "https://github.com/jmolz/m0lz.02"
project: "m0lz.02"
published: true
---

Content here. Standard markdown + fenced code blocks.
No bare < characters. No emojis. Tables use pipes.
```

### Current Catalog (from `data/projects.ts`)

| ID | Description | Tech | Public | Status |
|----|-------------|------|--------|--------|
| `m0lz.00` | Monochrome developer blog & portfolio | Next.js / TypeScript | Yes | Shipped |
| `m0lz.01` | Automated content publishing agent | TypeScript | Yes | Building |
| `m0lz.02` | Structured AI coding workflow orchestrator | Rust / TypeScript | Yes | Shipped |
| `m0lz.03` | MCP security proxy daemon | TypeScript | Yes | Shipped |
| `m0lz.04` | AI legal case management | JavaScript / Claude API | Yes | Shipped |
| Investor Matchmaker | Investor-founder meeting scheduler | Python | Yes | Shipped |
| Bloom | AI-powered revenue discovery | TypeScript/Next.js | No | Active |
| Alpaka | Value chain intelligence for real estate | Python ML + TypeScript | No | Active |
| Ready Text | Waitlist texting platform | Laravel/PHP | No | Active |

---

## Blog Agent (m0lz.01)

### Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node.js / TypeScript | AI SDKs are JS-first, matches site ecosystem |
| CLI framework | Commander.js | Lightweight, well-documented |
| AI provider | Anthropic SDK (Claude) | Primary model for research and writing |
| Web search | Anthropic tool use (web search) or Tavily API | Source gathering during research |
| Publishing APIs | Dev.to (Forem) API, Medium API (deprecated), Substack API, GitHub Octokit | Cross-posting and companion repo creation |
| Config | `.blogrc.yaml` in project root | API keys, site repo path, defaults |
| State | Local SQLite (`.blog-agent/state.db`) | Track post status, publish history, metrics |

### CLI Commands

#### `blog init`

Scaffold the blog-agent config in the current directory.

- Creates `.blogrc.yaml` with placeholder API keys and site repo path
- Creates `.blog-agent/` directory for state and drafts
- Validates that the site repo exists at the configured path and has `content/posts/` and `lib/posts.ts`

#### `blog research <topic>`

Deep research phase. Interactive.

- Takes a topic string or a topic brief file
- Calls Claude with web search enabled to gather sources, data, prior art
- Enters an interactive back-and-forth session to refine the research direction
- Outputs a structured research document to `.blog-agent/research/<slug>.md`
- Research doc includes: thesis, key findings, sources with URLs, data points, open questions

#### `blog draft [slug]`

Writing phase. Interactive.

- Loads the research document for the given slug (or most recent)
- Collaborates with you to write the post in MDX format
- Iterates: generates draft, you give feedback, revises, repeat
- Handles MDX component usage (code blocks, tables)
- Outputs final MDX to `.blog-agent/drafts/<slug>.mdx`
- Generates frontmatter matching PostFrontmatter schema:
  - `project` field: prompt user for catalog project link or none
  - `canonical` field: auto-generate as `https://m0lz.dev/writing/{slug}`
  - `companion_repo` field: auto-link if repo exists
  - Title format: `{catalogId} — Description` for catalog projects

#### `blog repo <slug>`

Companion repository generation. Optional.

- Reads the draft to identify code artifacts, demos, benchmarks, or test suites referenced in the post
- Scaffolds a GitHub repository with: README, source code, tests, CI config, LICENSE
- Does NOT push — creates locally for review
- Outputs to `.blog-agent/repos/<slug>/`

#### `blog evaluate <slug>`

Quality check before publishing. Automated.

- Checks: factual claims have sources, code blocks are syntactically valid, frontmatter is complete, no broken links, MDX renders without errors
- Adversarial review: challenges the thesis, checks for logical gaps, identifies claims that need stronger evidence
- Outputs pass/fail with detailed feedback
- Must pass before `blog publish` will execute

#### `blog publish <slug>`

The full hub-spoke publish pipeline. Sequential.

1. **Verify** — Confirm evaluation passed. Abort if not.
2. **Site deploy** — Copy MDX + assets to site repo `content/posts/<slug>/`. Commit. Push to main. Vercel auto-deploys.
3. **Wait for deploy** — Poll Vercel deployment API until the post URL is live. This is the canonical URL.
4. **Cross-post to Dev.to** — Use Forem API to create article with `canonical_url` set to site URL. Store Dev.to URL in frontmatter.
5. **Cross-post to Medium** — Use Medium API to create post with `canonicalUrl` set to site URL. On failure, generate pasteable markdown to `.blog-agent/social/<slug>/medium-paste.md`. Log warning but do not block pipeline.
6. **Cross-post to Substack** — Use Substack API to create post with canonical link. On failure, generate pasteable content.
7. **Companion repo** — If `.blog-agent/repos/<slug>/` exists: create GitHub repo via Octokit, push code, set description and URL pointing to the blog post.
8. **Update frontmatter** — Commit updated frontmatter (with platform URLs) back to site repo.
9. **Update project README** — If post has `project` field, update the project repo README with a link to the new post under a "## Writing" section. Idempotent.
10. **Promote** — Generate social post variants:
    - LinkedIn: professional summary with key takeaway + link
    - X/Twitter: thread-style summary (3-5 tweets) with link
    - Output to `.blog-agent/social/<slug>/` for review before posting

#### `blog status`

Show state of all posts in the pipeline.

```
$ blog status

  slug                        phase        status
  dual-model-evaluation       published    live on 4 platforms
  mcp-security-layer          drafted      awaiting evaluation
  seam-analysis               researching  3 sources gathered
```

#### `blog metrics`

Aggregate publish metrics across all posts.

- Posts published count
- Platform distribution (site, Dev.to, Medium, Substack)
- Companion repos created
- Average research-to-publish time
- Evaluation pass/fail rates

### Configuration (`.blogrc.yaml`)

```yaml
site:
  repo_path: "../m0lz.00"
  base_url: "https://m0lz.dev"
  content_dir: "content/posts"

author:
  name: "Jacob Molz"
  github: "jmolz"
  medium: "@jmolz"
  devto: "jmolz"
  substack: "jmolz"

ai:
  provider: "anthropic"
  model: "claude-sonnet-4-6"
  research_model: "claude-opus-4-6"

publish:
  medium: true
  devto: true
  substack: true
  github_repos: true
  social_drafts: true

evaluation:
  require_pass: true
  min_sources: 3
  max_reading_level: 12
```

### Cross-Post Platform Strategy

| Platform | API Status | Canonical Support | Fallback |
|----------|-----------|-------------------|----------|
| Dev.to | Stable, actively maintained | `canonical_url` field | None needed |
| Medium | Deprecated (March 2023), still functional | `canonicalUrl` field | Generate paste-ready markdown |
| Substack | API available | Canonical link in body | Generate paste-ready content |

**Priority order:** Dev.to (most reliable) → Substack → Medium (least reliable).

**Medium API fallback:**

1. Attempt API publish first — `POST /v1/users/{userId}/posts` with `canonicalUrl`
2. On failure, generate Medium-compatible markdown to `.blog-agent/social/<slug>/medium-paste.md`
3. Log warning, optionally open Medium new story URL in browser with `--open` flag
4. Never block the pipeline on Medium failure

### State Management

SQLite database at `.blog-agent/state.db`:

```sql
posts (
  slug TEXT PRIMARY KEY,
  title TEXT,
  topic TEXT,
  phase TEXT,           -- research | draft | evaluate | publish | published
  created_at DATETIME,
  updated_at DATETIME,
  published_at DATETIME,
  site_url TEXT,
  medium_url TEXT,
  devto_url TEXT,
  substack_url TEXT,
  repo_url TEXT,
  evaluation_score REAL,
  evaluation_passed BOOLEAN
)

sources (
  id INTEGER PRIMARY KEY,
  post_slug TEXT REFERENCES posts(slug),
  url TEXT,
  title TEXT,
  excerpt TEXT,
  accessed_at DATETIME
)

metrics (
  id INTEGER PRIMARY KEY,
  post_slug TEXT REFERENCES posts(slug),
  event TEXT,
  value TEXT,
  timestamp DATETIME
)
```

### Environment Variables

```
ANTHROPIC_API_KEY=     # Required — Claude for research + writing
MEDIUM_TOKEN=          # Required if Medium publishing enabled
DEVTO_API_KEY=         # Required if Dev.to publishing enabled
SUBSTACK_API_KEY=      # Required if Substack publishing enabled
GITHUB_TOKEN=          # Required if companion repos enabled
VERCEL_TOKEN=          # Optional — for deploy status polling
```

---

## Repo Structure

### m0lz.01 (blog agent)

```
m0lz.01/
├── src/
│   ├── cli/              # Command definitions (init, research, draft, etc.)
│   ├── research/         # Research orchestration
│   ├── draft/            # MDX generation + collaboration
│   ├── repo/             # Companion repo scaffolding
│   ├── publish/          # Cross-posting pipeline
│   │   ├── site.ts       # Git commit to m0lz.00
│   │   ├── devto.ts      # Dev.to cross-post
│   │   ├── medium.ts     # Medium cross-post with fallback
│   │   ├── substack.ts   # Substack cross-post
│   │   └── readme-updater.ts  # Project repo README link insertion
│   ├── evaluate/         # Quality evaluation
│   ├── social/           # Social post generation
│   ├── providers/        # AI provider abstraction
│   └── db/               # SQLite state management
├── templates/
│   ├── repo/             # Companion repo templates (README, CI, etc.)
│   └── social/           # Social post templates per platform
├── tests/
├── package.json
├── tsconfig.json
├── .blogrc.example.yaml
├── README.md
├── branch-mark.svg       # blog-agent variant
└── LICENSE
```

### m0lz.00 (site — the hub, already shipped)

```
m0lz.00/
├── app/                    # Next.js App Router pages
│   ├── layout.tsx          # Root layout, fonts, theme
│   ├── page.tsx            # Landing page (hero + latest + projects)
│   ├── writing/            # Blog posts (index + [slug])
│   ├── projects/           # Project cards (public/private sections)
│   ├── research/           # Research index + [slug] detail pages
│   ├── about/              # Bio, experience, catalog listing
│   ├── feed.xml/           # RSS 2.0 feed
│   └── opengraph-image.tsx # Auto-generated OG images
├── components/             # branch-mark, nav, footer, post-card, project-card,
│                           # code-block, mdx-components, table-of-contents,
│                           # research-panel, theme-toggle, theme-provider
├── content/
│   ├── posts/              # MDX blog posts (agent commits here)
│   │   ├── hey-im-jacob/
│   │   ├── pice-framework/
│   │   ├── mcp-guard/
│   │   ├── case-pilot/
│   │   └── investor-matchmaker/
│   └── research/           # Research pages (per-project)
│       ├── pice/
│       └── mcp-guard/
├── data/projects.ts        # Canonical project data
├── lib/                    # mdx.ts, posts.ts, research.ts, og.tsx
├── __tests__/regression/   # 153 tests across 5 files
└── public/                 # favicon.svg, branch-mark.svg
```

---

## Cost Estimates

| Item | Cost | Notes |
|------|------|-------|
| Dev.to API | Free | Publish via API key |
| Medium API | Free | Integration token, deprecated but functional |
| Substack API | Free | API access |
| GitHub API | Free | Public repos via personal access token |
| Vercel hosting | Free | Free tier covers a static blog |
| Domain (m0lz.dev) | ~$12/year | .dev domain |
| Anthropic API (Claude) | ~$10-20/month | Research + writing, varies by post volume |
| **Total** | **~$11-21/month** | Almost entirely Claude API usage |

---

## Implementation Phases

### Phase 1: Agent Core

1. Scaffold m0lz.01 with TypeScript + Commander.js + SQLite
2. Implement `blog init` (config validation, directory setup)
3. Implement `blog research` (Claude with web search, structured output)
4. Implement `blog draft` (interactive MDX generation, frontmatter schema compliance)
5. Implement `blog evaluate` (quality checks, adversarial review)

### Phase 2: Publish Pipeline

6. Implement `blog publish` — site deploy (git commit to m0lz.00, Vercel polling)
7. Cross-post to Dev.to (canonical_url)
8. Cross-post to Medium (with fallback)
9. Cross-post to Substack
10. Companion repo creation (Octokit)
11. README link updater (project repo spoke updates)
12. Social post generation

### Phase 3: Status & Metrics

13. Implement `blog status` (SQLite pipeline view)
14. Implement `blog metrics` (aggregate stats)

---

## Success Metrics

- First 5 posts published within 30 days of agent completion
- Each post live on 4 platforms (site + Dev.to + Medium + Substack) within 1 hour of `blog publish`
- Blog agent installable via `npx` by others
- At least 1 companion repo per technical post
- Agent repo has full test coverage and CI
- All published posts pass the evaluation contract before publishing

---

## First Post

Title: "I built a blog agent using my own AI coding framework — here's what happened"

This post documents the process of building the blog agent with m0lz.02 (Plan, Implement, Contract-Evaluate), includes the architecture diagram, benchmarks research-to-publish time, and links to both repos. It's the proof that the system works, written by the system itself.

---

## Open Questions

1. **Asset management** — Should the agent handle images and diagrams? The post structure supports `content/posts/{slug}/assets/` but no posts currently use embedded images.
2. **Tagging taxonomy** — Currently freeform strings. Should the agent enforce a controlled vocabulary?
3. **Substack API specifics** — Need to investigate exact API surface for programmatic posting with canonical support.
4. **Research page integration** — Should published research posts automatically generate or update the corresponding research page in `content/research/`? Currently research pages are manually authored.
