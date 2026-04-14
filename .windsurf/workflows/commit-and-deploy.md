---
description: Build, test, commit by feature, and deploy — adapts to any project's toolchain
---

# Commit and Deploy Workflow

## Phase 1: Pre-Commit Validation

Run these checks in order. Fix failures before proceeding to the next level.

### 1. Discover Project Tools

```bash
# Identify package manager and scripts
cat package.json 2>/dev/null | grep -A 50 '"scripts"' | head -60
cat pyproject.toml 2>/dev/null | head -40
cat Makefile 2>/dev/null | grep '^[a-z]' | head -20

# Check for project-specific validation scripts
ls scripts/validate* scripts/check* 2>/dev/null
ls .github/workflows/ 2>/dev/null
```

### 2. Build

Run the project's build command:

```bash
# Use whatever this project has:
# npm run build / pnpm build / yarn build
# cargo build / go build ./...
# uv run python -m py_compile main.py
```

### 3. Project-Specific Checks

Run any project-specific validation scripts discovered in Step 1:

```bash
# Examples — use whatever this project has:
# ./scripts/validate-*.sh
# docker build -f {service}/Dockerfile .
```

### 4. Tests

Run tests in order of speed — fast feedback first:

```bash
# Regression / smoke tests (if they exist separately)
# {test-runner} {regression-test-directory}

# Full test suite
# npm test / pnpm test / pytest / cargo test
```

If the project has multiple test targets (e.g., a Python service alongside a JS frontend), run each:

```bash
# Examples:
# cd {service-dir} && python3 -m pytest -v
# npm test
```

### 5. Lint / Type Check (if not covered by build)

```bash
# Examples:
# npm run lint / npx tsc --noEmit
# ruff check . / mypy .
# cargo clippy
```

## Phase 2: Documentation Updates

Before committing, check if any project docs need updating based on what changed:

```bash
# Find documentation files in the project
ls README.md TASK.md CHANGELOG.md docs/ 2>/dev/null
ls -d */README.md 2>/dev/null
```

For each doc that exists:

- **README.md**: Update if commands, env vars, architecture, or setup changed
- **Task tracking files** (TASK.md, TODO.md, etc.): Mark completed work, add discovered issues
- **Subproject READMEs**: Update if that subsystem's endpoints, models, config, or architecture changed
- **User-facing docs** (help pages, knowledge base): Review for accuracy if product behavior changed

## Phase 3: Determine Context (Worktree or Main)

```bash
git branch --show-current
git worktree list
```

Determine if you're in a **worktree** (feature branch) or on **main**. The remaining phases adapt based on this.

## Phase 4: Commit by Feature (CRITICAL)

**Do NOT create one giant commit.** Group changes by logical feature/purpose.

```bash
# Review everything
git status
git diff --stat HEAD

# Stage and commit by logical group — examples:
git add {frontend-files}
git commit -m "feat(ui): description of UI change"

git add {api-files}
git commit -m "feat(api): description of API change"

git add {schema/migration-files}
git commit -m "feat(db): description of schema change"

# Docs last, separately
git add README.md {other-docs}
git commit -m "docs: update documentation"
```

**Commit tags:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`

**Include scope:** `feat(ui)`, `fix(api)`, `refactor(db)`, etc.

If any AI layer files changed (CLAUDE.md, .claude/rules/, .claude/commands/, .windsurf/), add a `Context:` section to the commit body explaining what changed and why.

## Phase 5: Merge to Main (Worktree Only)

**Skip this phase if already on main.**

If you committed on a feature branch in a worktree, merge it into main:

```bash
# Capture the current branch and worktree path
FEATURE_BRANCH=$(git branch --show-current)
WORKTREE_PATH=$(pwd)

# Navigate to the main repo
MAIN_REPO=$(git worktree list | head -1 | awk '{print $1}')
cd "$MAIN_REPO"

# Ensure main is up to date
git checkout main
git pull origin main

# Merge the feature branch
git merge "$FEATURE_BRANCH"
```

If the merge has conflicts:

1. Resolve conflicts — favor the feature branch for new code, preserve main for unrelated changes
2. Run the full validation suite (Phase 1) again after resolving
3. Commit the merge resolution

## Phase 6: Deploy

```bash
# Push from the main repo directory (not the worktree)
git push origin main
```

After pushing, note what deploy mechanisms exist:

```bash
# Check for deploy automation
ls .github/workflows/ 2>/dev/null
cat vercel.json 2>/dev/null | head -5
cat netlify.toml 2>/dev/null | head -5
cat fly.toml 2>/dev/null | head -5
cat render.yaml 2>/dev/null | head -5
```

## Phase 7: Clean Up Worktree (Worktree Only)

**Skip this phase if you were already on main.**

After a successful merge and push, remove the worktree and feature branch:

```bash
# From the main repo directory
git worktree remove "$WORKTREE_PATH"
git branch -d "$FEATURE_BRANCH"
```

Verify cleanup:

```bash
git worktree list
# Expected: only the main worktree remains (plus any other active feature worktrees)

git branch
# Expected: feature branch is gone

git status
# Expected: "nothing to commit, working tree clean"
```

If `git branch -d` refuses (branch not fully merged), investigate — this usually means the merge in Phase 5 didn't complete. Do NOT force-delete with `-D` without understanding why.

## Phase 8: Final Verification

```bash
git log --oneline -5
git status
# Expected: on main, clean tree, feature commits visible in log
```

If deployment fails: check CI/CD logs (GitHub Actions, platform dashboard), verify builds locally, check platform console for errors.
