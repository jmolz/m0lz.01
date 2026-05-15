import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PACKAGE_ROOT } from './paths.js';

interface PackageJson {
  version?: unknown;
}

let cachedVersion: string | null = null;

export function getPackageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;

  const packageJsonPath = resolve(PACKAGE_ROOT, 'package.json');
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJson;
  if (typeof parsed.version !== 'string' || parsed.version.trim().length === 0) {
    throw new Error(`package.json at ${packageJsonPath} is missing a string version`);
  }

  cachedVersion = parsed.version;
  return cachedVersion;
}
