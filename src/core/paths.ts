import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Walk up from a module's file:// URL until a package.json is found, returning
// that directory. Works identically for src/ (under Vitest) and dist/ (after
// compile) — replaces per-file `../..` offset arithmetic that silently breaks
// when files move.
export function findPackageRoot(moduleUrl: string): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`package.json not found walking up from ${moduleUrl}`);
}

export const PACKAGE_ROOT = findPackageRoot(import.meta.url);
export const TEMPLATES_ROOT = resolve(PACKAGE_ROOT, 'templates');
