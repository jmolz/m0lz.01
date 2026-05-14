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
- Missing `devto_main_image`, `medium_featured_image`, or `substack_preview_image` during publish is an actionable draft-phase error, not permission for `site-pr` to serialize new frontmatter.

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
- `src/core/publish/platform-images.ts` renders Dev.to, Medium, and Substack from the same fallback SVG article-card framework with platform-specific dimensions.

## Direct-push helpers inspect ahead state before mutation

Any publish helper that commits directly to `main` must check the target repo's ahead state before it mutates files. The order is: origin guard, checkout `main`, `git pull --ff-only`, staged-index guard, compute the exact expected subject and paths, inspect `origin/main..HEAD`, then copy/stage files only after unexpected ahead commits are ruled out.

Crash replay support is narrow. A direct-push helper may push exactly one ahead commit only when the subject and touched paths match the helper-owned expected shape. If that exact replay exists but current local artifacts would introduce a new staged diff, abort instead of stacking a second commit on top of the unpushed one.

Forensic anchors:
- `src/core/publish/site-artifacts.ts` computes expected distribution paths and inspects `origin/main..HEAD` before copying artifacts.
- `tests/publish-distribution-kit.test.ts` rejects unexpected ahead commits before staging new distribution changes and proves exact crash replay remains allowed.

## Persist-only artifact loaders verify manifest bytes

Persist-only publish steps must not trust manifest presence alone. If a step loads existing local artifacts for site persistence, it must validate fixed manifest paths and recalculate every recorded SHA256 before copy, commit, or push. Existence checks without hash verification can commit tampered bytes beside stale provenance.

Forensic anchors:
- `src/core/publish/distribution-kit.ts` validates `linkedin.md`, `hackernews.md`, `linkedin-image-prompt.md`, and `assets/linkedin-feed.png` against `manifest.json` before returning a reusable kit.
- `tests/distribution-kit.test.ts` proves `loadDistributionKit` refuses tampered text and image artifacts whose bytes no longer match the manifest.
