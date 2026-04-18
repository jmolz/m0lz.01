# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-18

### Added

- Foundation: SQLite state database with WAL journaling, `.blogrc.yaml` config loader, Commander.js CLI entry point, and m0lz.00 post import (Phase 1).
- Research pipeline with source tracking, structured research documents, and schema-validated finalization (Phase 2).
- Benchmark test-harness scaffolding, environment capture, and reproducible `METHODOLOGY.md` generation (Phase 3).
- MDX drafting with content-type routing, Excalidraw diagrams, benchmark data tables/charts, and placeholder-token safety (Phase 4).
- Three-reviewer adversarial evaluation panel: Claude structural + Codex GPT-5.4 high adversarial + Codex GPT-5.4 xhigh methodology, with consensus/majority/single synthesis, mandatory artifact-hash provenance, and slug-scoped FS locking (Phase 5).
- 11-step publish pipeline with SQLite step tracking, per-slug filesystem lock, resume-on-failure, origin-URL verification before every repo touch, and probe-then-mutate patterns for external APIs (Phase 6).
- Update + unpublish lifecycle flows sharing one pipeline runner via `publishMode` dispatch; first-class `update_cycles` table with partial unique index; explicit `is_update_review` flag; cycle-keyed notice marker; shared `finalizePipelineUnderLock` helper; metrics audit log for every destructive/cycle action (Phase 7).
- Shared `src/core/paths.ts` helper (`findPackageRoot` + `TEMPLATES_ROOT`) replacing four per-file inline offset-arithmetic template-path resolutions.
- `npm pack` validation script (`scripts/verify-pack.mjs`) enforcing an explicit allowlist of shipped files and denylist of secret-carrying paths.
- GitHub Actions CI workflow running lint, tests, build, and pack verification on Node 20.
- Release runbook (`RELEASING.md`) with a literal v0.1.0 command sequence and a template for subsequent releases.
- `.nvmrc` pinning Node 20 for contributors.

### Fixed

- Template loading now resolves from the installed package directory instead of the current working directory. Previously, `blog publish`, `blog update`, and `blog init` silently failed or emitted unhelpful errors when run from any directory other than the agent's own checkout — `init` in particular would silently skip copying `.blogrc.example.yaml` and `.env.example` when the operator's CWD lacked those files, leaving them with an empty workspace.

[0.1.0]: https://github.com/jmolz/m0lz.01/releases/tag/v0.1.0
