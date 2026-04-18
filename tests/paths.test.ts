import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

import { findPackageRoot, PACKAGE_ROOT, TEMPLATES_ROOT } from '../src/core/paths.js';

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined as unknown as string;
});

describe('findPackageRoot', () => {
  it('returns the repo root when called from a real test module', () => {
    // import.meta.url here points to tests/paths.test.ts (under Vitest src
    // resolution). Walk-up must find the repo's own package.json.
    const root = findPackageRoot(import.meta.url);
    expect(root).toBe(PACKAGE_ROOT);
    // TEMPLATES_ROOT is derived from PACKAGE_ROOT — sanity check it resolves
    // under the same root.
    expect(TEMPLATES_ROOT).toBe(resolve(root, 'templates'));
  });

  it('resolves from a synthetic src/ layout', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'paths-src-'));
    writeFileSync(join(tempDir, 'package.json'), '{"name":"fake"}');
    mkdirSync(join(tempDir, 'src', 'cli'), { recursive: true });
    const fakeModule = join(tempDir, 'src', 'cli', 'foo.ts');
    writeFileSync(fakeModule, '');

    const root = findPackageRoot(pathToFileURL(fakeModule).href);
    expect(root).toBe(tempDir);
  });

  it('resolves from a synthetic dist/ layout', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'paths-dist-'));
    writeFileSync(join(tempDir, 'package.json'), '{"name":"fake"}');
    mkdirSync(join(tempDir, 'dist', 'cli'), { recursive: true });
    const fakeModule = join(tempDir, 'dist', 'cli', 'foo.js');
    writeFileSync(fakeModule, '');

    const root = findPackageRoot(pathToFileURL(fakeModule).href);
    expect(root).toBe(tempDir);
  });

  it('throws with a useful message when no package.json is found', () => {
    // tmpdir itself sits in a hierarchy that may or may not have a
    // package.json above it depending on the OS. Guard by creating a deep
    // isolated subtree with a sentinel file far from any real project — then
    // manually walk the input URL and assert the error surfaces.
    tempDir = mkdtempSync(join(tmpdir(), 'paths-nofile-'));
    // We can't realistically guarantee zero package.json above tmpdir, but
    // we CAN point at a path whose file:// URL doesn't exist and assert the
    // error message format. Construct a URL in a hierarchy with no
    // package.json by pointing at a synthetic root.
    const synthetic = '/this/path/definitely/does/not/exist/anywhere/foo.ts';
    // On macOS/Linux, no package.json on the ancestors of /this — walk hits
    // '/' and throws.
    expect(() => findPackageRoot(pathToFileURL(synthetic).href)).toThrow(
      /package\.json not found walking up/,
    );
  });
});
