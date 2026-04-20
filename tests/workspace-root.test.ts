import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findWorkspaceRoot, WorkspaceNotFoundError } from '../src/core/workspace/root.js';
import { resolveUserPath } from '../src/core/workspace/user-path.js';

describe('findWorkspaceRoot', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'm0lz-workspace-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function seedWorkspace(root: string): void {
    mkdirSync(resolve(root, '.blog-agent'), { recursive: true });
    writeFileSync(resolve(root, '.blog-agent', 'state.db'), '');
  }

  it('returns the workspace when .blog-agent/state.db lives in cwd', () => {
    seedWorkspace(tmp);
    expect(findWorkspaceRoot(tmp)).toBe(tmp);
  });

  it('walks up ancestors to find the workspace root', () => {
    seedWorkspace(tmp);
    const nested = resolve(tmp, 'deeply', 'nested', 'subdir');
    mkdirSync(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBe(tmp);
  });

  it('throws WorkspaceNotFoundError when no ancestor has .blog-agent/state.db', () => {
    expect(() => findWorkspaceRoot(tmp)).toThrow(WorkspaceNotFoundError);
  });

  it('error message cites the searched path and override hints', () => {
    try {
      findWorkspaceRoot(tmp);
      throw new Error('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(tmp);
      expect(msg).toContain('--workspace');
      expect(msg).toContain('BLOG_WORKSPACE');
    }
  });

  it('honors explicit override before ancestor walk', () => {
    const other = mkdtempSync(resolve(tmpdir(), 'm0lz-ws-other-'));
    try {
      seedWorkspace(other);
      // cwd is `tmp` (no workspace), override points at `other`
      expect(findWorkspaceRoot(tmp, { override: other })).toBe(other);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('throws when override points at a directory without .blog-agent/state.db', () => {
    expect(() => findWorkspaceRoot(tmp, { override: tmp })).toThrow(WorkspaceNotFoundError);
  });

  it('honors envVar before ancestor walk', () => {
    const other = mkdtempSync(resolve(tmpdir(), 'm0lz-ws-env-'));
    try {
      seedWorkspace(other);
      expect(findWorkspaceRoot(tmp, { envVar: other })).toBe(other);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('override takes precedence over envVar', () => {
    const overrideDir = mkdtempSync(resolve(tmpdir(), 'm0lz-override-'));
    const envDir = mkdtempSync(resolve(tmpdir(), 'm0lz-env-'));
    try {
      seedWorkspace(overrideDir);
      seedWorkspace(envDir);
      expect(findWorkspaceRoot(tmp, { override: overrideDir, envVar: envDir })).toBe(overrideDir);
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
      rmSync(envDir, { recursive: true, force: true });
    }
  });
});

describe('resolveUserPath', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env._BLOG_ORIGINAL_CWD;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env._BLOG_ORIGINAL_CWD;
    else process.env._BLOG_ORIGINAL_CWD = originalEnv;
  });

  it('resolves a relative path against _BLOG_ORIGINAL_CWD when set', () => {
    process.env._BLOG_ORIGINAL_CWD = '/tmp/user-dir';
    expect(resolveUserPath('./foo.json')).toBe('/tmp/user-dir/foo.json');
  });

  it('resolves against process.cwd() when _BLOG_ORIGINAL_CWD is unset', () => {
    delete process.env._BLOG_ORIGINAL_CWD;
    expect(resolveUserPath('./foo.json')).toBe(resolve(process.cwd(), 'foo.json'));
  });

  it('returns absolute paths unchanged', () => {
    process.env._BLOG_ORIGINAL_CWD = '/tmp/user-dir';
    expect(resolveUserPath('/absolute/path.json')).toBe('/absolute/path.json');
  });
});
