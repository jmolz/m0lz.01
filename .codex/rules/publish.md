---
paths:
  - "src/core/publish/**"
  - "src/cli/publish.ts"
---

# Publish Conventions

Rules for the publish layer (`src/core/publish/**`, `src/cli/publish.ts`). These protect the evaluated draft boundary and the public site/cross-post contract.

## Site PR validates evaluated drafts; it does not rewrite them

`createSitePR` and `createSiteUpdate` may verify or generate missing stable assets, but they must not rewrite `.blog-agent/drafts/{slug}/index.mdx` or write draft receipts after the evaluation gate. Platform-image fields are authored during draft phase with `blog draft platform-images <slug>`.

Forensic anchors:
- `src/core/publish/site.ts` calls `ensurePlatformImages(..., { updateFrontmatter: false, writeReceipt: false })` before branch checkout and asset copy.
- `tests/publish-site.test.ts` asserts `createSitePR` keeps the source draft byte-for-byte unchanged and does not write `.platform-images.json`.
- Missing `medium_featured_image` or `substack_header_image` during publish is an actionable draft-phase error, not permission for `site-pr` to serialize new frontmatter.

## Platform image references have distinct modes

Treat `http(s)` platform image values as configured external references. They are already valid paste targets and must not be overwritten by generated local defaults.

Treat `./assets/<filename>` and `assets/<filename>` as local asset references. Validate dimensions when the file exists. A missing custom platform asset is an error. A missing default platform asset can be generated only when the frontmatter already points at the default filename or the caller is in draft-mutation mode.

Forensic anchors:
- `tests/platform-images.test.ts` preserves explicit `https://...` platform image URLs without rewriting frontmatter.
- `tests/platform-images.test.ts` rejects unsafe platform paths before writes, receipts, or frontmatter rewrites.

## Image generation must be deterministic and config-derived

Publish must not call remote image APIs, browser automation, or platform upload APIs to create assets. Local Sharp transforms and fallback SVG rendering are acceptable because they run offline and produce stable filenames.

The fallback SVG may display site/author labels, but those labels must come from `config.site.base_url`, `config.author.github`, or draft frontmatter such as `project`. Do not hardcode `m0lz.01`, `m0lz.dev`, or a GitHub owner in publish helpers.

Forensic anchors:
- `tests/platform-images.test.ts` verifies fallback labels are config-derived.
- `src/core/publish/platform-images.ts` writes same-path source/output transforms through a temp file before `renameSync`; direct Sharp same-file writes fail.
