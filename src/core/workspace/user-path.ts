import { resolve } from 'node:path';

// After the CLI startup shim chdirs to the workspace root, relative paths the
// user typed (e.g. `--report ./foo.md` from a subdirectory) would otherwise
// resolve against the wrong cwd. The shim stashes the user's original cwd in
// `_BLOG_ORIGINAL_CWD`; this helper resolves relative paths against it.
//
// Commander flag parsers wrap user-path options with `.argParser(resolveUserPath)`
// so the resolved absolute path flows into handlers unchanged.
export function resolveUserPath(p: string): string {
  const base = process.env._BLOG_ORIGINAL_CWD || process.cwd();
  return resolve(base, p);
}
