import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class WorkspaceNotFoundError extends Error {
  constructor(public readonly searchedFrom: string) {
    super(
      `No m0lz.01 workspace detected. Searched from ${searchedFrom} upwards for ` +
        `\`.blog-agent/state.db\`. Run \`blog init\` in an empty directory, ` +
        `or \`cd\` into an existing workspace. Override with \`--workspace <path>\` ` +
        `or \`BLOG_WORKSPACE=<path>\`.`,
    );
    this.name = 'WorkspaceNotFoundError';
  }
}

export interface FindWorkspaceOpts {
  override?: string;
  envVar?: string;
}

// Walk upward from `cwd` looking for `.blog-agent/state.db`. That file is the
// unambiguous signature of an initialized m0lz.01 workspace — `blog init`
// creates it before anything else.
//
// Resolution order (first match wins):
//   1. `opts.override`  — explicit `--workspace <path>` flag
//   2. `opts.envVar`    — `BLOG_WORKSPACE` env var
//   3. ancestor walk from `cwd`
export function findWorkspaceRoot(cwd: string, opts: FindWorkspaceOpts = {}): string {
  if (opts.override) {
    const root = resolve(opts.override);
    if (!existsSync(resolve(root, '.blog-agent', 'state.db'))) {
      throw new WorkspaceNotFoundError(root);
    }
    return root;
  }

  if (opts.envVar) {
    const root = resolve(opts.envVar);
    if (!existsSync(resolve(root, '.blog-agent', 'state.db'))) {
      throw new WorkspaceNotFoundError(root);
    }
    return root;
  }

  let dir = resolve(cwd);
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, '.blog-agent', 'state.db'))) return dir;
    dir = dirname(dir);
  }
  // Check the filesystem root itself once more.
  if (existsSync(resolve(dir, '.blog-agent', 'state.db'))) return dir;
  throw new WorkspaceNotFoundError(cwd);
}
