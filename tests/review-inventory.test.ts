import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function currentTestFiles(): string[] {
  return readdirSync('tests')
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `tests/${name}`)
    .sort();
}

function mentionedTestFiles(path: string): string[] {
  const body = readFileSync(path, 'utf-8');
  const matches = body.match(/tests\/[A-Za-z0-9_.-]+\.test\.ts/g) ?? [];
  return Array.from(new Set(matches)).sort();
}

describe('review regression inventory', () => {
  for (const path of [
    '.agents/skills/source-command-review/SKILL.md',
    '.windsurf/workflows/review.md',
  ]) {
    it(`${path} lists every test file`, () => {
      expect(mentionedTestFiles(path)).toEqual(currentTestFiles());
    });
  }
});
