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
      'substack_preview_image',
      'substack_header_image',
      'unpublished_at',
      'updated_at',
      'update_count',
    ]) {
      expect(codexLine).toContain(field);
    }
  });

  it('Claude and Codex publish rules capture platform-image review regressions', () => {
    const claudeRule = read('.claude/rules/publish.md');
    const codexRule = read('.codex/rules/publish.md');
    expect(claudeRule).toBe(codexRule);
    for (const required of [
      'updateFrontmatter: false',
      'writeReceipt: false',
      'http(s)',
      'configured external references',
      'blog draft platform-images <slug>',
      'config.site.base_url',
      'config.author.github',
      'same fallback SVG article-card framework',
      'origin/main..HEAD',
      'before it mutates files',
      'stacking a second commit',
      'fixed manifest paths',
      'recalculate every recorded SHA256',
      'tampered bytes beside stale provenance',
    ]) {
      expect(codexRule).toContain(required);
    }
  });

  it('Claude and Codex evaluation/lifecycle rules preserve update-review phase gates', () => {
    const claudeEvaluation = read('.claude/rules/evaluation.md');
    const codexEvaluation = read('.codex/rules/evaluation.md');
    const claudeLifecycle = read('.claude/rules/lifecycle.md');
    const codexLifecycle = read('.codex/rules/lifecycle.md');

    expect(claudeEvaluation).toBe(codexEvaluation);
    expect(claudeLifecycle).toBe(codexLifecycle);
    expect(codexEvaluation).not.toContain('whenever `manifest.cycles.length > 1`');
    for (const required of [
      'explicit `is_update_cycle` flag',
      'Update-review is the only `published` exception',
      'activeCycle.is_update_cycle === true',
      'allows structural autocheck for an open update-review cycle while the post remains published',
    ]) {
      expect(codexEvaluation).toContain(required);
    }
    for (const required of [
      'Evaluation has only manifest-gated update-review exceptions',
      '`runEvaluateAutocheck` may operate while `posts.phase=',
      'when the active manifest cycle is open and `is_update_cycle=true`',
    ]) {
      expect(codexLifecycle).toContain(required);
    }
  });
});
