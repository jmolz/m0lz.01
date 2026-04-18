# Releasing

## First release — v0.1.0 (literal)

Because `package.json` already shipped with `"version": "0.1.0"` during
development (Phase 1), `npm version 0.1.0` is a no-op and will fail. The
first release tags the existing version directly instead of bumping it.

Preflight: on `main`, working tree clean, CI green. The `main`-branch
guard is load-bearing for the same reason as the subsequent-release
flow — `git push --atomic origin main refs/tags/v0.1.0` from a topic
branch pushes only the new tag (the `main` ref-spec is a no-op because
local `main` hasn't advanced), shipping unmerged code. Fail fast if
not on `main`:

    test "$(git branch --show-current)" = main || { echo "Release must run from main"; exit 1; }
    test -z "$(git status --porcelain)" || { echo "Working tree not clean"; exit 1; }

The order of operations here matters. `npm publish` is the only step in
this sequence that can fail for reasons outside your working tree (npm
auth, 2FA prompt, registry outage, `prepublishOnly` hook rejection).
Everything reversible happens locally first; the irreversible public
push to GitHub happens LAST, only after the registry has accepted the
tarball. That way a failed publish never leaves an orphaned tag on
GitHub advertising a release that doesn't exist on npm.

1. **Date the CHANGELOG.** Replace `## [0.1.0] — Unreleased` with today's date:

       sed -i.bak "s/## \[0\.1\.0\] — Unreleased/## [0.1.0] — $(date +%Y-%m-%d)/" CHANGELOG.md && rm CHANGELOG.md.bak
       git add CHANGELOG.md
       git commit -m "docs(changelog): date v0.1.0 release"

2. **Create the local tag.** No push yet — the tag stays local until
   `npm publish` succeeds.

       git tag -a v0.1.0 -m "Release v0.1.0"

3. **Verify the push will work BEFORE publishing.** `npm publish` is
   the first irreversible remote write; the push that follows must not
   be the step that discovers a problem. `--dry-run` validates auth,
   branch-protection rules, and remote advancement without touching
   refs. `--atomic` ensures the branch update and the tag update
   succeed or fail together — without it, a server-side ref partial
   accept can leave `main` advanced without the tag or vice versa,
   which the release step later attaches metadata to the wrong commit.
   Abort the release if this fails — fix the push problem first, then
   start over from step 1.

       git fetch origin main
       git push --atomic --dry-run origin main refs/tags/v0.1.0

4. **Publish to npm.** `prepublishOnly` runs lint + build + test +
   verify-pack; publish aborts if any fails. See "Recovery" below
   for what to do when this step exits non-zero, or when the next
   step fails after this one succeeds.

       npm publish

5. **Push the commit + tag atomically.** Only after the registry has
   accepted the tarball.

       git push --atomic origin main refs/tags/v0.1.0

6. **Create the GitHub release** with the changelog section as the body.
   `--verify-tag` makes `gh` fail if the tag isn't already on the remote
   — without it, a missing tag (e.g., if step 5 silently lost the tag
   ref) would cause `gh release create` to auto-create a NEW tag from
   the current default-branch HEAD, producing a release that points at
   a different commit than the tarball on npm. The awk pattern starts
   at the `## [0.1.0]` heading, prints every line until the next
   top-level heading, and stops before it — the naive
   `awk '/^## \[0.1.0\]/,/^## \[/'` range stops on its own start line
   and emits only the heading, so it is NOT safe to use here.

       gh release create v0.1.0 --verify-tag --title "v0.1.0" --notes-file <(awk '/^## \[0\.1\.0\]/{flag=1;print;next} /^## \[/{flag=0} flag' CHANGELOG.md)

### Recovery

`npm publish` is the only step in this runbook with indeterminate
failure modes: a network timeout or CLI crash AFTER the tarball
uploads can exit non-zero while the version IS already live on the
registry. Never retry or reset without verifying registry state first.

**Registry-state check** — run this first, always, whether step 4 or
step 5 failed:

    npm view m0lz-01@0.1.0 version

There are three possible outcomes, each with a different recovery path:

**A. `npm view` prints `0.1.0`** — the version is live on the registry.
Do NOT re-publish. Proceed to step 5 (push) and step 6 (gh release).
If step 5 previously failed (auth, branch protection, remote advanced),
resolve the git-side issue and push again. If `origin/main` advanced
while you were publishing, rebase AND re-point the tag:

    git fetch origin main
    # Only if origin/main advanced (git status says "behind"):
    git rebase origin/main
    # Rebase rewrites HEAD; the v0.1.0 tag still points at the OLD commit
    # that no longer exists on origin. Move it to the rebased HEAD:
    git tag -f -a v0.1.0 -m "Release v0.1.0"
    # Then atomically push the rebased branch + moved tag:
    git push --atomic origin main refs/tags/v0.1.0

Then continue to step 6 (`gh release create ... --verify-tag`).

**B. `npm view` errors with `E404`** — nothing published. Safe to
retry. Fix the underlying cause (re-auth with `npm login`, retry the
`prepublishOnly` hook failure, wait out a registry outage) and re-run
`npm publish`.

**C. You want to abandon the release entirely** — only valid under
case B (nothing published). A published version cannot be re-published
under the same version string; you must bump to 0.1.1 instead.

To abandon from case B, inspect what you're about to remove first:

    git log --oneline -2          # confirm only the CHANGELOG-dating commit is present
    git status                    # confirm no uncommitted changes (--hard would discard them)
    git tag -d v0.1.0
    git reset --mixed HEAD~1      # keeps CHANGELOG changes in your worktree

`--mixed` preserves the CHANGELOG edits so you don't lose them;
`--hard` would discard any worktree changes that accumulated while
you were debugging. If you intentionally want the reset to discard
everything, use `--hard` only after confirming `git status` is clean.

Then start over from step 1.

## Subsequent releases (template)

For future releases, substitute the target version for `X.Y.Z`. Because
the next version is strictly greater than `package.json`'s current value,
`npm version` works normally — no `--allow-same-version` flag needed.

Preflight: on `main`, working tree clean, CI green. The `main`-branch
guard is load-bearing — `npm version` tags HEAD and `git push --atomic
origin main refs/tags/vX.Y.Z` will push the tag alone if HEAD is ahead
of origin/main on a topic branch (the `main` ref-spec is a no-op
because local `main` hasn't advanced), producing a published npm
package and GitHub release that point at unmerged code. Fail fast if
not on `main`:

    test "$(git branch --show-current)" = main || { echo "Release must run from main"; exit 1; }
    test -z "$(git status --porcelain)" || { echo "Working tree not clean"; exit 1; }

Same ordering rationale as the v0.1.0 flow: `npm publish` runs BEFORE
any remote push, so a failed publish never leaves an orphaned tag on
GitHub.

1. Add a new `## [X.Y.Z] — YYYY-MM-DD` section at the top of `CHANGELOG.md`
   summarizing changes since the last release, and update the reference
   link footer (`[X.Y.Z]: https://github.com/jmolz/m0lz.01/releases/tag/vX.Y.Z`).
   Commit it.

2. Bump the version locally. `npm version` creates a `vX.Y.Z` tag AND
   a version-bump commit but does NOT push — both stay local until
   step 4 succeeds. Note: this flow has **two local commits** (the
   CHANGELOG commit from step 1 + the version-bump commit from step 2);
   recovery below handles both.

       npm version X.Y.Z -m "release: v%s"

3. Verify the push will work BEFORE publishing (same rationale as
   v0.1.0 step 3 — `--atomic` is required so both refs advance
   together):

       git fetch origin main
       git push --atomic --dry-run origin main refs/tags/vX.Y.Z

4. Publish to npm. `prepublishOnly` runs lint + build + test +
   verify-pack; publish aborts if any fails.

       npm publish

5. Atomically push the commits + tag, then create the GitHub release
   with `--verify-tag` (see v0.1.0 step 6 for why):

       git push --atomic origin main refs/tags/vX.Y.Z
       gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --notes-file <(awk "/^## \\[X\\.Y\\.Z\\]/{flag=1;print;next} /^## \\[/{flag=0} flag" CHANGELOG.md)

### Recovery (subsequent release)

Same registry-state check as v0.1.0 — run BEFORE retrying or rolling
back anything:

    npm view m0lz-01@X.Y.Z version

**A. Version IS on the registry** — do NOT re-publish. Resolve the
git-side issue and push atomically. If `origin/main` advanced while
you were publishing, rebase BOTH local release commits (CHANGELOG +
`npm version` bump) and re-point the tag before pushing:

    git fetch origin main
    # Only if origin/main advanced (git status says "behind"):
    git rebase origin/main
    # Rebase rewrote HEAD and HEAD~1; the vX.Y.Z tag still points at the
    # ORIGINAL version-bump commit that no longer exists on origin.
    # Move it to the rebased version-bump commit (the new HEAD — npm
    # version put the bump commit at the tip, so after rebase the tip
    # is still the version-bump commit):
    git tag -f -a vX.Y.Z -m "release: vX.Y.Z"
    # Verify the tag points at the version-bump commit, not the CHANGELOG
    # commit (the commit message should say `release: vX.Y.Z`):
    git log -1 --format='%s' vX.Y.Z
    # Then atomically push the rebased branch + moved tag:
    git push --atomic origin main refs/tags/vX.Y.Z

Then continue with `gh release create vX.Y.Z --verify-tag ...`.

**B. Version is NOT on the registry** — safe to retry `npm publish`
after fixing the cause.

**C. Abandon the release** — only under case B. Subsequent-release
flow has TWO local commits (CHANGELOG + `npm version`); use `HEAD~2`,
not `HEAD~1`:

    git log --oneline -3          # confirm both commits are present and nothing else
    git status                    # confirm no uncommitted changes
    git tag -d vX.Y.Z
    git reset --mixed HEAD~2

Then start over from step 1.

## First-time repo metadata update

After v0.1.0 ships, update the GitHub repo description, homepage, and
topics so the repo card tells newcomers what this is in ten seconds:

    gh repo edit jmolz/m0lz.01 \
      --description "Idea-to-distribution pipeline for technical content — research, benchmark, draft, adversarially evaluate, publish, distribute. Backed by SQLite state, resumable pipelines, and a three-reviewer eval panel." \
      --homepage "https://m0lz.dev" \
      --add-topic claude-code \
      --add-topic cli \
      --add-topic content-pipeline \
      --add-topic mdx \
      --add-topic ai-agents \
      --add-topic codex \
      --add-topic adversarial-evaluation \
      --add-topic benchmarking \
      --add-topic static-site-generator \
      --add-topic typescript

Verify with:

    gh repo view --json description,homepageUrl,repositoryTopics
