import { resolve } from 'node:path';

// After CLI startup chdirs to the workspace root, `resolve('.blog-agent/...')`
// already yields the correct absolute path. This helper exists so code that
// wants to be explicit about "this path lives inside the workspace" — e.g.
// `--json` outputs that embed paths — can say so unambiguously.
export function workspaceRelative(subpath: string): string {
  return resolve(subpath);
}
