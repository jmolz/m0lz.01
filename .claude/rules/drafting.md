---
paths:
  - "src/core/draft/**"
  - "src/cli/draft.ts"
  - "templates/draft/**"
---

# Drafting Conventions

Rules for the MDX drafting layer (`src/core/draft/**`, `src/cli/draft.ts`). Patterns emerged during Phase 4 — they protect the m0lz.00 content contract and prevent silent MDX corruption.

## PostFrontmatter is a hard contract

`PostFrontmatter` in `src/core/draft/frontmatter.ts` has exactly these fields: `title`, `description`, `date`, `tags`, `published`, and optional `canonical`, `companion_repo`, `project`, `medium_url`, `devto_url`. These mirror the schema that m0lz.00 consumes.

- **Never add, remove, or rename a field without a coordinated change in m0lz.00.** Drift silently breaks published posts.
- **Validation is strict at completion time.** `date` must match `YYYY-MM-DD`; `tags` must be a non-empty array; `published` must be a literal boolean. No string coercion (`Boolean("false")` → `true` is a bug).
- **Placeholder detection rejects un-filled drafts.** `title`/`description` equal to `{{title}}`/`{{description}}` are placeholders, not valid content.

## MDX frontmatter parsing

Always use an **anchored** regex that matches only the first two `---` delimiters:

```typescript
// Good — anchored, only matches frontmatter at the top of the file
const match = mdxContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

// Bad — unanchored split corrupts parsing when the body contains a thematic break (---)
const parts = mdxContent.split(/^---$/m);
```

A thematic break in the MDX body renders as `---` on its own line. Unanchored regexes treat it as a frontmatter delimiter and silently mangle content.

## Config values are threaded, not hardcoded

Library functions in `src/core/draft/**` must **never** hardcode values that belong in `.blogrc.yaml`:

```typescript
// Good — github user flows in via options, sourced from config.author.github
export function formatMethodologyRef(
  env: EnvironmentSnapshot,
  slug: string,
  opts: { githubUser: string },
): string { ... }

// Bad — hardcoded user will break the moment another author uses the agent
return `...https://github.com/jmolz/${slug}/blob/main/METHODOLOGY.md...`;
```

Applies to: `author.github`, `site.base_url`, `site.content_dir`, any URL component that depends on the owner.

## Placeholder tokens live in one place

The MDX template emits `{/* TODO: Fill this section */}` markers. Validators (`completeDraft`, `runDraftValidate`) must read the **same** token. Use the shared `PLACEHOLDER_PATTERN` constant in `src/core/draft/state.ts`:

```typescript
// Good — emitter and validators share one source of truth
import { PLACEHOLDER_PATTERN } from '../core/draft/state.js';
const count = (content.match(PLACEHOLDER_PATTERN) || []).length;

// Bad — inline regex drifts from the template, silently passes validation
const count = (content.match(/\{\/\* TODO: Fill this section \*\/\}/g) || []).length;
```

The pattern is permissive (`\{\/\*\s*TODO[:\s].*?\*\/\}`) so new TODO variants still trip validation.

## Best-effort tag taxonomy

`readExistingTags()` reads m0lz.00's frontmatter to surface previously-used tags for consistency. It **must** return `[]` gracefully if the site repo is missing or has no posts — the agent can still draft without it. Never throw from `readExistingTags`; let callers decide whether to surface the degraded state.

## Asset filenames are plain names

`runDraftAddAsset` and `registerAsset` accept filenames only — no path separators, no `..`. Enforce at the CLI boundary:

```typescript
if (opts.file !== basename(opts.file) || opts.file.includes('..')) {
  console.error(`Invalid asset filename...`);
  process.exitCode = 1;
  return;
}
```

Assets live at `.blog-agent/drafts/{slug}/assets/{filename}`. Anything else is a path-traversal attempt.

## Idempotency on re-init

`initDraft` must return the existing draft unchanged if `index.mdx` is already present. Only overwrite when the caller explicitly requests it. This protects author-edited content from being clobbered by accidental re-runs.

## Content-type routing

Template and draft behavior branches on `post.content_type`:

| Content type | Benchmark sections | Architecture section | Notes |
| ------------ | ------------------ | -------------------- | ----- |
| `technical-deep-dive` | Required | Required | Includes Methodology ref |
| `project-launch` | Optional — include when `benchmarkTable` is present | Required | Preserve benchmarks when run |
| `analysis-opinion` | Omit | Omit | Analysis + Key Takeaways only |

Test all three paths whenever modifying `renderDraftTemplate` or `initDraft`.
