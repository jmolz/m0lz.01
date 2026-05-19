---
paths:
  - "src/core/publish/**"
  - "src/cli/publish.ts"
---

# Publish Conventions

Rules for the publish layer (`src/core/publish/**`, `src/cli/publish.ts`). These protect the evaluated draft boundary and the public site/cross-post contract.

## Publish verify re-checks evaluated artifacts

`blog publish start` must not trust `posts.evaluation_passed` alone. The `verify` step re-reads the latest passed evaluation manifest, synthesis receipt, and reviewed artifact SHA256 set before any site mutation. If `.blog-agent/drafts/{slug}/index.mdx`, benchmark results, environment metadata, or structural autocheck output changed after `blog evaluate complete`, publish fails before `research-page`/`site-pr` can copy stale bytes. Use `blog publish reopen-draft <slug> --reason "evaluated artifact drift"` only for that pre-site failure, then re-run draft completion and evaluation.

Forensic anchors:
- `src/core/publish/pipeline-registry.ts` calls `assertLatestEvaluationArtifactsCurrent` from the `verify` step.
- `tests/publish-verify-artifacts.test.ts` mutates draft bytes after `completeEvaluation` and asserts `verify` fails before `site-pr`.
- `tests/publish-cli.test.ts` covers the matching `blog publish reopen-draft` recovery path for evaluated artifact drift.

## Site PR validates evaluated drafts; it does not rewrite them

`createSitePR` and `createSiteUpdate` may verify stable assets, but they must not rewrite `.blog-agent/drafts/{slug}/index.mdx` or write draft receipts after the evaluation gate. Platform-image fields and `.platform-images.json` receipts are authored during draft phase with `blog draft platform-images <slug>`.

Forensic anchors:
- `src/core/publish/site.ts` calls `ensurePlatformImages(..., { updateFrontmatter: false, writeReceipt: false })` before branch checkout and asset copy.
- `tests/publish-site.test.ts` asserts `createSitePR` keeps the source draft byte-for-byte unchanged and does not create or refresh `.platform-images.json`.
- `completeDraft` requires `devto_main_image`, `medium_featured_image`, and `substack_preview_image` before evaluation starts.
- `completeDraft` and `createSitePR` reject generator-owned default image paths when the receipt input hash or file hashes are stale after a title/frontmatter edit.
- Missing `devto_main_image`, `medium_featured_image`, or `substack_preview_image` during publish is an actionable draft-phase error, not permission for `site-pr` to serialize new frontmatter. If an old workspace already reached this failed pre-site-pr state, use `blog publish reopen-draft <slug> --reason "missing platform images"` so the post is re-evaluated after `blog draft platform-images`.
  For a post already published with stale PNG bytes, use `blog publish platform-images <slug> --commit-site`.

## Platform image references have distinct modes

Treat `http(s)` platform image values as configured external references. They are already valid paste targets and must not be overwritten by generated local defaults.

Treat `./assets/<filename>` and `assets/<filename>` as local asset references. Validate dimensions when the file exists. A missing custom platform asset is an error. A missing default platform asset can be generated only when the frontmatter already points at the default filename or the caller is in draft-mutation mode.

Forensic anchors:
- `tests/platform-images.test.ts` preserves explicit `https://...` platform image URLs without rewriting frontmatter.
- `tests/platform-images.test.ts` rejects unsafe platform paths before writes, receipts, or frontmatter rewrites.

## Cross-post paste output must stay portable

Medium and Substack paste files are the copy surface. Do not rely on browser preview copy behavior for charts, figures, diagrams, or other visual MDX components.

`mdxToMarkdown` must preserve image-backed visual components as Markdown image links with public hub asset URLs before JSX stripping. A visual component used in cross-posted content must either render as ordinary Markdown, or expose a string image asset reference such as `src="./assets/chart.png"` with usable alt text. Data-only interactive chart components require an exported image asset before publish, otherwise the visual disappears from `medium-paste.md` and `substack-paste.md`.

Markdown pipe tables outside fenced code must be replaced in Medium/Substack paste output with manifest-tracked generated table artifacts. Do not rewrite canonical MDX to satisfy paste portability. The canonical hub MDX stays semantic; Medium/Substack get local upload placeholders plus `medium-upload-checklist.md` / `substack-upload-checklist.md` with local PNG paths, alt text, captions, canonical-source guidance, and public URLs labeled reference-only. Do not make table success depend on arbitrary public `portable-table-*.png` URL embeds. Fenced code, blockquotes, lists, and malformed tables stay textual.

Substack subtitles are platform-specific. Fit a short paste subtitle naturally from `description` instead of copying long frontmatter descriptions verbatim or hard-clipping with ellipses. If no full description, complete first sentence, or title-aware fallback fits the local limit, fail before site checkout/copy/commit.

Forensic anchors:
- `src/core/publish/convert.ts` preserves image-backed JSX components before `removeJsxComponents`.
- `src/core/publish/table-assets.ts` derives and renders portable Markdown table images for paste output and platform-specific table reference policies.
- `src/core/publish/substack.ts` naturally fits long subtitles for Substack paste output and fails when no safe fit exists.
- `tests/publish-convert.test.ts` covers portable image-backed chart conversion.
- `tests/publish-table-assets.test.ts` covers table detection, fenced-table preservation, readable row-card table-image rendering, snake_case preservation, deterministic PNG writes, and stale generated cleanup.
- `tests/publish-crosspost.test.ts` covers Medium/Substack chart copyability, generated table upload/checklist handoff, natural Substack subtitle fitting, and no-safe-fit failure.

## Complete publication bundle is reviewed before preview

`site-pr` and `site-update` must copy the whole publication bundle into `content/posts/{slug}/` before preview: evaluated MDX, draft assets, public-only LinkedIn/Hacker News copy, Medium/Substack paste files, Medium/Substack upload checklists, manifest provenance, the default deterministic LinkedIn local-card image, and generated portable table assets. `linkedin-image-prompt.md` is an operator artifact only for `prompt-only`, `generate`, and `required` image modes. Post-preview paste steps are read/verify-only and must load manifest-tracked artifacts instead of regenerating from preview content.

Bundle persistence is fail-closed. `persistDistributionKitToSite` must reject path escapes, hash mismatches, conflicting reviewed site artifacts, unrelated dirty state, and unexpected ahead commits before staging.

Stale owned-artifact cleanup is branch-dependent. `site-pr` and `site-update` may precompute an allowed cleanup set for the dirty guard, but tracked stale deletion paths must be recomputed after checking out or reusing the target branch before staging. Generated `assets/linkedin-feed.png` is an owned image artifact like generated portable tables: when the current manifest omits it, tracked stale copies must be deleted, staged, and included in crash-replay expected paths instead of being left in the reviewed bundle.

Forensic anchors:
- `src/core/publish/site.ts` generates and copies the bundle before site checkout/mutation completes.
- `src/core/publish/site.ts` recomputes cleanup stage paths after branch checkout/reuse so existing PR/update branches cannot hide stale tracked bundle files.
- `src/core/publish/site-artifacts.ts` copies manifest-derived text/table/image artifacts and refuses conflicting reviewed bytes.
- `src/core/publish/site-artifacts.ts` treats omitted `assets/linkedin-feed.png` as a generator-owned cleanup candidate.
- `src/core/publish/pipeline-registry.ts` loads verified Medium/Substack manifest artifacts in paste steps.
- `tests/publish-site.test.ts`, `tests/update-publish-pipeline.test.ts`, and `tests/publish-distribution-kit.test.ts` cover pre-preview bundle copy, branch-relative cleanup, stale image deletion, crash replay, and strict persistence.

## Image generation must be deterministic and config-derived

The default LinkedIn feed image mode is `local-card`: publish writes `assets/linkedin-feed.png` with local Sharp rendering and does not call OpenAI. `prompt-only` is explicit compatibility mode and writes a prompt file without an image. `generate` and `required` are OpenAI-backed and fail before site checkout/copy/commit when credentials or generation are unavailable.

Publish must not call remote image APIs, browser automation, or platform upload APIs to create deterministic local assets. Local Sharp transforms and fallback SVG rendering are acceptable because they run offline and produce stable filenames.

The fallback SVG may display site/author labels, but those labels must come from `config.site.base_url`, `config.author.github`, or draft frontmatter such as `project`. Do not hardcode `m0lz.01`, `m0lz.dev`, or a GitHub owner in publish helpers.

Forensic anchors:
- `tests/platform-images.test.ts` verifies fallback labels are config-derived.
- `tests/distribution-kit.test.ts` verifies local-card output, prompt-only compatibility, prompt quality guards, and nonblank bounded LinkedIn card rendering.
- `src/core/publish/platform-images.ts` renders Dev.to, Medium, Substack, and LinkedIn local-card images from the same fallback SVG article-card framework and local SVG-to-PNG paths with config-derived labels.

## Direct-push helpers inspect ahead state before mutation

Any publish helper that commits directly to `main` must check the target repo's ahead state before it mutates files. The order is: origin guard, checkout `main`, `git pull --ff-only`, staged-index guard, compute the exact expected subject and paths, inspect `origin/main..HEAD`, then copy/stage files only after unexpected ahead commits are ruled out.

Crash replay support is narrow. A direct-push helper may push exactly one ahead commit only when the subject and touched paths match the helper-owned expected shape. If that exact replay exists but current local artifacts would introduce a new staged diff, abort instead of stacking a second commit on top of the unpushed one.

Forensic anchors:
- `src/core/publish/site-artifacts.ts` computes expected distribution paths and inspects `origin/main..HEAD` before copying artifacts.
- `tests/publish-distribution-kit.test.ts` rejects unexpected ahead commits before staging new distribution changes and proves exact crash replay remains allowed.

## Persist-only artifact loaders verify manifest bytes

Persist-only publish steps must not trust manifest presence alone. If a step loads existing local artifacts for site persistence or paste handoff, it must validate fixed manifest paths and recalculate every recorded SHA256 before copy, commit, push, or output. Existence checks without hash verification can commit tampered bytes beside stale provenance.

Forensic anchors:
- `src/core/publish/distribution-kit.ts` validates `linkedin.md`, `hackernews.md`, `medium-paste.md`, `medium-upload-checklist.md`, `substack-paste.md`, `substack-upload-checklist.md`, `linkedin-image-prompt.md`, `assets/linkedin-feed.png`, and `assets/portable-table-*.png` against `manifest.json` before returning a reusable kit.
- `tests/distribution-kit.test.ts` proves `loadDistributionKit` refuses tampered text, image, and table artifacts whose bytes no longer match the manifest.
