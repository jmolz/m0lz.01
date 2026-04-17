import { execFileSync } from 'node:child_process';

// Shared trust-boundary helper for repo-touching steps. Extracted from
// `repo.ts` in Phase 7 so unpublish/site and unpublish/readme can reuse
// the same check instead of inlining an equivalent (and slightly
// divergent) guard.
//
// Usage: every code path that runs `git push` against a user-owned repo
// MUST call `assertOriginMatches` first. Silent push to an unrelated
// repository because origin was misconfigured is a trust-boundary
// violation that looks indistinguishable from success in the pipeline.

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

// Assert that `repoPath`'s origin remote points at
// `github.com/{expectedOwner}/{expectedName}`. Returns 'absent' when no
// origin is configured (the caller may add one); returns 'matches' on a
// successful match; THROWS when origin points at a different GitHub
// target or at an unrecognized URL. Callers receiving 'absent' must
// either configure origin or abort.
export function assertOriginMatches(
  repoPath: string,
  expectedOwner: string,
  expectedName: string,
): OriginState {
  let originRaw: string;
  try {
    originRaw = String(
      execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  } catch {
    return 'absent';
  }
  const parsed = parseGitHubRemoteUrl(originRaw);
  if (!parsed) {
    throw new Error(
      `Repo at '${repoPath}' has origin '${originRaw.trim()}' ` +
      `which is not a recognized GitHub URL. ` +
      `Expected 'github.com/${expectedOwner}/${expectedName}'. ` +
      `Fix with 'git -C ${repoPath} remote set-url origin ...' before retrying.`,
    );
  }
  if (parsed.owner !== expectedOwner || parsed.name !== expectedName) {
    throw new Error(
      `Repo at '${repoPath}' origin points to 'github.com/${parsed.owner}/${parsed.name}' ` +
      `but the pipeline expected 'github.com/${expectedOwner}/${expectedName}'. ` +
      `Refusing to push — doing so would mutate an unrelated repository. ` +
      `Fix with 'git -C ${repoPath} remote set-url origin https://github.com/${expectedOwner}/${expectedName}.git' before retrying.`,
    );
  }
  return 'matches';
}
