# Phase 7 PostFrontmatter Fixtures

This directory is the **cross-repo contract artifact** between `m0lz.01`
(producer — this repo, the agent) and `m0lz.00` (consumer — the site
repo). Every `.mdx` file here is a canonical shape that the site's
frontmatter parser MUST accept without erroring. If the agent starts
emitting a shape not represented here, the fixture is incomplete — add
a new file and pair it with matching site-side test coverage.

Tests in this repo (`tests/frontmatter-phase7.test.ts`) and in m0lz.00
(the site's frontmatter ingestion tests, once they exist) both read
from this directory. Drift in either parser that breaks a fixture is
the signal to coordinate a schema change.

## Files

- `legacy.mdx` — pre-Phase-7 post. No `unpublished_at`, `updated_at`,
  or `update_count`. Must parse cleanly; those three fields must be
  undefined on the parsed result.
- `initial-published.mdx` — a first-time publish. Has `canonical`,
  `medium_url`, `devto_url` but none of the Phase 7 additions.
- `updated-once.mdx` — post-update-publish. Has `updated_at` and
  `update_count: 1`; `unpublished_at` still undefined.
- `updated-twice.mdx` — post-update-publish (second cycle).
  `update_count: 2`, fresh `updated_at` reflecting the second cycle's
  completion timestamp.
- `unpublished.mdx` — post-`blog unpublish`. `published: false`, plus
  `unpublished_at` set. `updated_at` and `update_count` may or may not
  be present (depends on whether the post was ever updated).
- `updated-then-unpublished.mdx` — the most contentious shape.
  `published: false`, `unpublished_at` set, `updated_at` + `update_count`
  from the prior update cycle preserved.

## Contract

The m0lz.00 site frontmatter parser:

1. Accepts unknown fields gracefully (legacy fields are never removed).
2. Parses `update_count` as a number. Agents may emit either unquoted
   (`update_count: 3`) or quoted (`update_count: "3"`) — both must
   resolve to `3` (Number).
3. Parses `updated_at` and `unpublished_at` as ISO 8601 strings.
4. Does not require the Phase 7 fields; legacy posts parse identically.

## Adding a new fixture

1. Draft the MDX file under this directory.
2. Extend `tests/frontmatter-phase7.test.ts` with a test that imports
   the file via `readFileSync` and asserts the expected parsed shape.
3. Mirror the test in m0lz.00. Both repos' CI should stay green.
