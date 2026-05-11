import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

import { BlogConfig } from '../config/types.js';

// Shared trust-boundary helpers for repo-touching steps. Two APIs with
// different semantics for different call sites:
//
//   getOriginState()       — tolerant; returns 'absent'|'matches'. Throws
//                            only when origin is CONFIGURED but points at
//                            the wrong GitHub target. Used by the publish
//                            scaffold flow where origin may be added after
//                            the fact (pushCompanionRepo in repo.ts).
//
//   requireOriginMatch()   — strict; requires origin to be configured AND
//                            point at the expected target. Throws on
//                            absence, parse failure, or mismatch. Used by
//                            unpublish and update flows where the remote
//                            must already exist — asking them to silently
//                            recover from "no origin" by adding one would
//                            be a trust violation.
//
// Both helpers narrow their catch of `git remote get-url origin` failures
// to the specific "No such remote" error. Any other subprocess failure
// (missing git binary, not a git repo, permission error) is re-thrown so
// the caller cannot mistake an environment problem for an intentional
// scaffold state.

// Parse a GitHub remote URL (SSH or HTTPS, with or without .git suffix)
// and return the owner/name components. Returns null for non-GitHub or
// unparseable URLs.
export function parseGitHubRemoteUrl(
  url: string,
): { owner: string; name: string } | null {
  const trimmed = url.trim();
  // SSH: git@github.com:owner/name[.git]
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], name: sshMatch[2] };
  }
  // HTTPS: https://github.com/owner/name[.git] (also tolerate http and trailing slash)
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], name: httpsMatch[2] };
  }
  return null;
}

export type OriginState = 'absent' | 'matches';

// Read the origin remote's URL and either return it as a string or
// signal "no remote configured" via `null`. Re-throws every other
// subprocess failure (bad repo, missing git binary, permission error).
//
// Forces `LC_ALL=C` / `LANG=C` so git emits its C-locale messages
// regardless of the operator's environment (Codex Pass 3 Minor #1). The
// stderr marker check below depends on the English "No such remote"
// wording — without the locale pin, a French/German/Japanese git would
// emit a translated message and the guard would mis-classify
// "origin not configured yet" as an environment failure.
export function readOriginUrl(repoPath: string): string | null {
  try {
    return String(
      execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      }),
    );
  } catch (e) {
    const err = e as Error & { stderr?: Buffer | string; status?: number };
    const stderr = String(err.stderr ?? '').toLowerCase();
    // git returns exit 128 with "fatal: No such remote 'origin'" on stderr
    // when origin isn't configured. That's the ONLY case we treat as the
    // tolerant "absent" outcome. LC_ALL=C pins the message to English.
    if (stderr.includes("no such remote")) {
      return null;
    }
    // "fatal: not a git repository" and friends are environment errors —
    // the caller should not silently proceed. Re-throw with context.
    throw new Error(
      `origin-guard: 'git -C ${repoPath} remote get-url origin' failed ` +
      `(exit ${err.status ?? '?'}): ${String(err.stderr ?? err.message).trim()}`,
    );
  }
}

// GitHub treats owner/name as case-insensitive (github.com/Jmolz/M0lz.00 and
// github.com/jmolz/m0lz.00 resolve to the same repo). Exact-case comparison
// would false-fail on operator configs that don't match the casing of the
// actual remote. Normalize both sides before comparing (Codex Pass 3 Minor #2).
function coordsMatch(
  parsed: { owner: string; name: string },
  expectedOwner: string,
  expectedName: string,
): boolean {
  return (
    parsed.owner.toLowerCase() === expectedOwner.toLowerCase() &&
    parsed.name.toLowerCase() === expectedName.toLowerCase()
  );
}

function throwMismatch(repoPath: string, parsed: { owner: string; name: string }, expectedOwner: string, expectedName: string): never {
  throw new Error(
    `Repo at '${repoPath}' origin points to 'github.com/${parsed.owner}/${parsed.name}' ` +
    `but the pipeline expected 'github.com/${expectedOwner}/${expectedName}'. ` +
    `Refusing to push — doing so would mutate an unrelated repository. ` +
    `Fix with 'git -C ${repoPath} remote set-url origin https://github.com/${expectedOwner}/${expectedName}.git' before retrying.`,
  );
}

function throwUnrecognized(repoPath: string, raw: string, expectedOwner: string, expectedName: string): never {
  throw new Error(
    `Repo at '${repoPath}' has origin '${raw.trim()}' ` +
    `which is not a recognized GitHub URL. ` +
    `Expected 'github.com/${expectedOwner}/${expectedName}'. ` +
    `Fix with 'git -C ${repoPath} remote set-url origin ...' before retrying.`,
  );
}

// Tolerant: returns 'absent' when origin is unconfigured; 'matches' when
// it points at the expected target; THROWS on wrong-target or
// unrecognized-URL. Used by pushCompanionRepo where the scaffold may be
// created before origin is added.
export function getOriginState(
  repoPath: string,
  expectedOwner: string,
  expectedName: string,
): OriginState {
  const raw = readOriginUrl(repoPath);
  if (raw === null) return 'absent';
  const parsed = parseGitHubRemoteUrl(raw);
  if (!parsed) throwUnrecognized(repoPath, raw, expectedOwner, expectedName);
  if (!coordsMatch(parsed, expectedOwner, expectedName)) {
    throwMismatch(repoPath, parsed, expectedOwner, expectedName);
  }
  return 'matches';
}

// Strict: requires origin to be configured. THROWS on absent, mismatch,
// or unrecognized URL. Used by unpublish site/readme and any flow where
// "no origin" is an operator error, not a pipeline-addressable state.
export function requireOriginMatch(
  repoPath: string,
  expectedOwner: string,
  expectedName: string,
): void {
  const raw = readOriginUrl(repoPath);
  if (raw === null) {
    throw new Error(
      `Repo at '${repoPath}' has no 'origin' remote configured. ` +
      `Expected 'github.com/${expectedOwner}/${expectedName}'. ` +
      `Add with 'git -C ${repoPath} remote add origin https://github.com/${expectedOwner}/${expectedName}.git' before retrying.`,
    );
  }
  const parsed = parseGitHubRemoteUrl(raw);
  if (!parsed) throwUnrecognized(repoPath, raw, expectedOwner, expectedName);
  if (!coordsMatch(parsed, expectedOwner, expectedName)) {
    throwMismatch(repoPath, parsed, expectedOwner, expectedName);
  }
}

// No `assertOriginMatches` alias — Pass 3 migrated every caller to the
// explicit getOriginState (tolerant) or requireOriginMatch (strict)
// name so call sites document their trust boundary at the import.

// Assert that `<branch>` in `repoPath` has no local commits beyond
// `origin/<branch>`. Throws `[AGENT_ERROR] ORIGIN_OUT_OF_SYNC` when
// `git rev-list --count origin/<branch>..<branch>` is non-zero. This
// closes the dogfood failure where `createSitePR` cut a feature branch
// from a local main that was ahead of origin/main, so the PR included
// unpushed commits the operator never meant to ship with this post.
//
// Narrows the catch of `git fetch`/`rev-list` failures to the specific
// "unknown revision or path" case git reports when `origin/<branch>`
// doesn't exist yet (fresh clone, just-created branch). Any other
// subprocess failure (network error, auth failure, missing git binary,
// not a git repo) is re-thrown with context — a network-disconnected
// operator's laptop should surface the disconnect loudly, not silently
// bypass the guard.
export function assertOriginInSync(
  repoPath: string,
  branch: string = 'main',
): void {
  // Refresh origin/<branch> so the count is against current remote
  // state. --quiet suppresses progress noise but NOT errors.
  try {
    execFileSync('git', ['-C', repoPath, 'fetch', 'origin', branch, '--quiet'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
  } catch (e) {
    const err = e as Error & { stderr?: Buffer | string; status?: number };
    const stderr = String(err.stderr ?? '').toLowerCase();
    // `couldn't find remote ref <branch>` surfaces when the branch
    // exists locally but not on origin — semantically the same out-of-sync
    // condition as "local has commits origin doesn't know about", so
    // surface it with the same ORIGIN_OUT_OF_SYNC sentinel rather than
    // the generic subprocess-failure wrapper.
    if (stderr.includes("couldn't find remote ref") || stderr.includes('could not find remote ref')) {
      throw new Error(
        `[AGENT_ERROR] ORIGIN_OUT_OF_SYNC: origin has no ref for ${branch} at '${repoPath}'. ` +
        `Push local ${branch} to establish the remote tracking branch, ` +
        `or pass --allow-main-ahead to bypass.`,
      );
    }
    throw new Error(
      `origin-guard: 'git -C ${repoPath} fetch origin ${branch}' failed ` +
      `(exit ${err.status ?? '?'}): ${String(err.stderr ?? err.message).trim()}. ` +
      `Resolve the network/auth issue before publishing, or pass --allow-main-ahead ` +
      `if you've already verified local ${branch} is aligned with remote.`,
    );
  }

  let countOut: string;
  try {
    countOut = execFileSync(
      'git',
      ['-C', repoPath, 'rev-list', '--count', `origin/${branch}..${branch}`],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      },
    );
  } catch (e) {
    const err = e as Error & { stderr?: Buffer | string; status?: number };
    const stderr = String(err.stderr ?? '').toLowerCase();
    // `unknown revision or path not in the working tree` surfaces when
    // origin/<branch> doesn't exist (e.g., unpushed local branch). Treat
    // as out-of-sync rather than pretending the count was 0 — the
    // operator explicitly asked for origin comparison.
    if (stderr.includes('unknown revision') || stderr.includes('ambiguous argument')) {
      throw new Error(
        `[AGENT_ERROR] ORIGIN_OUT_OF_SYNC: origin/${branch} not found at '${repoPath}'. ` +
        `Push local ${branch} to establish the remote tracking branch, ` +
        `or pass --allow-main-ahead to bypass (the unpushed commits will be included in the PR).`,
      );
    }
    throw new Error(
      `origin-guard: 'git -C ${repoPath} rev-list --count origin/${branch}..${branch}' failed ` +
      `(exit ${err.status ?? '?'}): ${String(err.stderr ?? err.message).trim()}`,
    );
  }

  const ahead = Number(countOut.trim());
  if (!Number.isFinite(ahead)) {
    throw new Error(
      `origin-guard: could not parse rev-list --count output at '${repoPath}': ${JSON.stringify(countOut)}`,
    );
  }
  if (ahead > 0) {
    throw new Error(
      `[AGENT_ERROR] ORIGIN_OUT_OF_SYNC: local ${branch} is ${ahead} commit(s) ahead of origin/${branch}. ` +
      `Push or rebase before publishing, or pass --allow-main-ahead to explicitly include these commits in the PR.`,
    );
  }
}

// Resolve the expected GitHub coordinates for the site repo. Prefers
// the explicit `config.site.github_repo` field when set; otherwise
// falls back to `{author.github}/basename(repo_path)` — the Phase 6
// implicit convention. Documented in `.claude/rules/lifecycle.md`.
//
// Export as a named helper so every site-touching step computes the
// expected identity the same way; previously this was inlined in two
// places with slightly different trimming rules.
export function expectedSiteCoords(config: BlogConfig): { owner: string; name: string } {
  if (config.site.github_repo) {
    const [owner, name] = config.site.github_repo.split('/');
    return { owner, name };
  }
  const name = basename(config.site.repo_path.replace(/\/+$/, ''));
  return { owner: config.author.github, name };
}
