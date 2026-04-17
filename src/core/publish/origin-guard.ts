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
function readOriginUrl(repoPath: string): string | null {
  try {
    return String(
      execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  } catch (e) {
    const err = e as Error & { stderr?: Buffer | string; status?: number };
    const stderr = String(err.stderr ?? '').toLowerCase();
    // git returns exit 128 with "fatal: No such remote 'origin'" on stderr
    // when origin isn't configured. That's the ONLY case we treat as the
    // tolerant "absent" outcome.
    if (stderr.includes("no such remote") || stderr.includes("no such remote 'origin'")) {
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
  if (parsed.owner !== expectedOwner || parsed.name !== expectedName) {
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
  if (parsed.owner !== expectedOwner || parsed.name !== expectedName) {
    throwMismatch(repoPath, parsed, expectedOwner, expectedName);
  }
}

// No `assertOriginMatches` alias — Pass 3 migrated every caller to the
// explicit getOriginState (tolerant) or requireOriginMatch (strict)
// name so call sites document their trust boundary at the import.

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
