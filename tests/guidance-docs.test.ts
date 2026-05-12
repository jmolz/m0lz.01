import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const REVIEW_DOCS = [
  '.claude/commands/review.md',
  '.agents/skills/source-command-review/SKILL.md',
  '.windsurf/workflows/review.md',
] as const;

const EXTERNAL_EVALUATOR_DOCS = [
  '.claude/commands/evaluate.md',
  '.agents/skills/source-command-evaluate/SKILL.md',
  '.claude/commands/plan-feature.md',
  '.agents/skills/source-command-plan-feature/SKILL.md',
] as const;

function postFrontmatterContractLine(markdown: string): string {
  const line = markdown
    .split(/\r?\n/)
    .find((candidate) =>
      candidate.includes('`PostFrontmatter` in `src/core/draft/frontmatter.ts` has exactly these fields:'),
    );
  if (!line) throw new Error('PostFrontmatter contract line not found');
  return line;
}

describe('guidance docs', () => {
  it('review docs describe Dev.to tags as alphanumeric-only', () => {
    for (const rel of REVIEW_DOCS) {
      const body = read(rel);
      expect(body, rel).toContain('alphanumeric-only');
      expect(body, rel).toContain('strips non-alphanumerics');
      expect(body, rel).toContain('developertools');
      expect(body, rel).not.toMatch(/hyphenates?(?:\s+spaces)?|lowercases\/hyphenates/i);
    }
  });

  it('external evaluator docs treat tenant-policy denials as no-fallback stops', () => {
    for (const rel of EXTERNAL_EVALUATOR_DOCS) {
      const body = read(rel);
      expect(body, rel).toContain('policy-blocked');
      expect(body, rel).toMatch(/do not attempt the OpenAI Responses API fallback/i);
      expect(body, rel).toMatch(/data[- ]exfiltration/i);
    }
  });

  it('Codex review skill references the real packaged blog plugin surface', () => {
    const body = read('.agents/skills/source-command-review/SKILL.md');
    expect(body).toContain('.claude-plugin/skills/blog/SKILL.md');
    expect(body).toContain('.claude/skills/blog');
    expect(body).not.toContain('.codex-plugin');
    expect(body).not.toContain('.agents/skills/blog');
    expect(body).not.toContain('`/blog` Codex plugin');
  });

  it('Claude and Codex drafting rules agree on PostFrontmatter fields', () => {
    const claudeLine = postFrontmatterContractLine(read('.claude/rules/drafting.md'));
    const codexLine = postFrontmatterContractLine(read('.codex/rules/drafting.md'));
    expect(claudeLine).toBe(codexLine);
    for (const field of [
      'substack_url',
      'devto_main_image',
      'medium_featured_image',
      'substack_header_image',
      'unpublished_at',
      'updated_at',
      'update_count',
    ]) {
      expect(codexLine).toContain(field);
    }
  });
});
