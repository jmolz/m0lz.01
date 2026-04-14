---
name: blog-draft
description: Generate an MDX draft incorporating research findings, benchmark data, and auto-generated Excalidraw diagrams. Guides content creation, Excalidraw diagram generation, asset registration, and frontmatter validation.
---

# /blog-draft

Interactive skill for drafting MDX content. Orchestrates the draft phase of the content pipeline.

## Prerequisites

- Post must be in `draft` phase (completed research + benchmark or benchmark skip)
- `.blogrc.yaml` config present
- Research document exists in `.blog-agent/research/{slug}.md`

## Workflow

### 1. Initialize Draft Workspace

```bash
blog draft init <slug>
```

Creates `.blog-agent/drafts/{slug}/index.mdx` with:

- Auto-populated PostFrontmatter (canonical URL, companion repo, project ID)
- Content-type-aware section structure
- Research thesis pre-filled in introduction
- Benchmark data table and methodology reference (if available)

### 2. Write MDX Content

Edit `.blog-agent/drafts/{slug}/index.mdx` section by section:

- **Introduction** -- expand research thesis into engaging opening
- **Architecture / Analysis / What It Does** -- content-type-specific body sections
- **Benchmark Results** -- auto-populated table, add narrative context
- **Methodology** -- auto-populated reference link, expand with details
- **Conclusion** -- summarize key takeaways

Replace all `{/* TODO: Fill this section */}` placeholders.

### 3. Create Excalidraw Diagrams

For each architectural or conceptual diagram:

1. Generate Excalidraw JSON with the excalidraw-diagram skill
2. Export to SVG and save to `.blog-agent/drafts/{slug}/assets/`
3. Register the asset:

```bash
blog draft add-asset <slug> --file <filename> --type excalidraw
```

Valid asset types: `excalidraw`, `chart`, `image`, `benchmark_viz`

### 4. Update Frontmatter

Replace placeholder title and description with final values:

- **title** -- specific, descriptive (not `{{title}}`)
- **description** -- one-sentence summary (not `{{description}}`)
- **tags** -- select from existing site tags for consistency
- **date** -- auto-set to initialization date, update if needed

### 5. Validate Draft

```bash
blog draft validate <slug>
```

Checks:

- Frontmatter schema validity (no placeholders, required fields present)
- All TODO sections filled
- All registered asset files exist on disk

### 6. Complete Draft

```bash
blog draft complete <slug>
```

Validates and advances phase to `evaluate`. Fails if validation does not pass.

## Available Commands

| Command | Description |
| --- | --- |
| `blog draft init <slug>` | Initialize draft workspace with template MDX |
| `blog draft show <slug>` | Show draft state: frontmatter, assets, benchmark data |
| `blog draft validate <slug>` | Validate frontmatter, sections, and assets |
| `blog draft add-asset <slug>` | Register an asset file |
| `blog draft complete <slug>` | Validate and advance to evaluate phase |

## Content Type Templates

| Content Type | Sections |
| --- | --- |
| `technical-deep-dive` | Introduction, Architecture, Benchmark Results, Methodology, Conclusion |
| `project-launch` | Introduction, What It Does, How It Works, Architecture, Conclusion |
| `analysis-opinion` | Introduction, Analysis, Key Takeaways, Conclusion |

## Key Rules

- Never commit placeholder titles or descriptions
- Always register asset files before completing the draft
- Use existing site tags (from m0lz.00) for consistency
- Benchmark data table is auto-populated -- add narrative, do not modify raw data
- Canonical URLs are permanent: `{base_url}/writing/{slug}`
