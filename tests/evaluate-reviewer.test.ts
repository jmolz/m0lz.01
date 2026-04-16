import { describe, it, expect } from 'vitest';

import {
  issueFingerprint,
  normalizeText,
  validateReviewerOutput,
  parseReviewerOutput,
  Issue,
  ReviewerOutput,
} from '../src/core/evaluate/reviewer.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'abc123abc123',
    category: 'thesis',
    severity: 'high',
    title: 'Thesis is unsupported',
    description: 'The central claim lacks evidence from the sources listed.',
    ...overrides,
  };
}

const DEFAULT_HASHES: Record<string, string> = {
  'draft/index.mdx': 'a'.repeat(64),
  'benchmark/results.json': 'b'.repeat(64),
  'benchmark/environment.json': 'c'.repeat(64),
  'evaluation/structural.lint.json': 'd'.repeat(64),
};

function makeOutput(overrides: Partial<ReviewerOutput> = {}): ReviewerOutput {
  return {
    reviewer: 'structural',
    model: 'claude-code',
    passed: false,
    issues: [makeIssue()],
    artifact_hashes: { ...DEFAULT_HASHES },
    ...overrides,
  };
}

describe('normalizeText', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeText('  Hello   WORLD  ')).toBe('hello world');
  });

  it('strips punctuation', () => {
    expect(normalizeText("Claim's value-drops: 10%!")).toBe('claim s value drops 10');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeText('')).toBe('');
  });
});

describe('issueFingerprint', () => {
  it('is deterministic for identical inputs', () => {
    const a = issueFingerprint('structural', 'Hello', 'World');
    const b = issueFingerprint('structural', 'Hello', 'World');
    expect(a).toBe(b);
  });

  it('normalizes whitespace and case', () => {
    const a = issueFingerprint('structural', 'Hello World', 'Some text');
    const b = issueFingerprint('structural', ' HELLO    WORLD ', 'some text!');
    expect(a).toBe(b);
  });

  it('produces different fingerprints for different reviewers', () => {
    const a = issueFingerprint('structural', 'x', 'y');
    const b = issueFingerprint('adversarial', 'x', 'y');
    expect(a).not.toBe(b);
  });

  it('produces 12-character hex output', () => {
    const fp = issueFingerprint('methodology', 'foo', 'bar');
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('validateReviewerOutput', () => {
  it('accepts a valid output', () => {
    const result = validateReviewerOutput(makeOutput());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts empty issues array', () => {
    const result = validateReviewerOutput(makeOutput({ issues: [] }));
    expect(result.ok).toBe(true);
  });

  it('rejects missing reviewer', () => {
    const obj = makeOutput();
    delete (obj as Partial<ReviewerOutput>).reviewer;
    const result = validateReviewerOutput(obj);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('reviewer'))).toBe(true);
  });

  it('rejects unknown reviewer enum value', () => {
    const result = validateReviewerOutput({ ...makeOutput(), reviewer: 'junior-dev' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('reviewer'))).toBe(true);
  });

  it('rejects non-boolean passed field', () => {
    const result = validateReviewerOutput({ ...makeOutput(), passed: 'true' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('passed'))).toBe(true);
  });

  it('rejects non-array issues', () => {
    const result = validateReviewerOutput({ ...makeOutput(), issues: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('issues'))).toBe(true);
  });

  it('rejects malformed issue items', () => {
    const badIssue = { ...makeIssue(), severity: 'catastrophic' };
    const result = validateReviewerOutput({ ...makeOutput(), issues: [badIssue] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('severity'))).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(validateReviewerOutput(null).ok).toBe(false);
    expect(validateReviewerOutput('string').ok).toBe(false);
    expect(validateReviewerOutput([]).ok).toBe(false);
  });

  it('rejects output without artifact_hashes', () => {
    const obj = makeOutput();
    delete (obj as Partial<ReviewerOutput>).artifact_hashes;
    const result = validateReviewerOutput(obj);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('artifact_hashes') && e.includes('required'))).toBe(true);
  });

  it('rejects artifact_hashes missing a required key', () => {
    const partial = { ...DEFAULT_HASHES };
    delete partial['evaluation/structural.lint.json'];
    const result = validateReviewerOutput(makeOutput({ artifact_hashes: partial }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('evaluation/structural.lint.json') && e.includes('required'))).toBe(true);
  });

  it('accepts artifact_hashes with <absent> sentinel for legitimately-missing files', () => {
    const absentSet = {
      'draft/index.mdx': '<absent>',
      'benchmark/results.json': '<absent>',
      'benchmark/environment.json': '<absent>',
      'evaluation/structural.lint.json': '<absent>',
    };
    const result = validateReviewerOutput(makeOutput({ artifact_hashes: absentSet }));
    expect(result.ok).toBe(true);
  });
});

describe('parseReviewerOutput', () => {
  it('parses valid JSON', () => {
    const json = JSON.stringify(makeOutput());
    const parsed = parseReviewerOutput(json);
    expect(parsed.reviewer).toBe('structural');
    expect(parsed.issues).toHaveLength(1);
  });

  it('throws descriptive error for invalid JSON', () => {
    expect(() => parseReviewerOutput('{not json')).toThrow(/Invalid JSON/);
  });

  it('throws descriptive error for schema violation', () => {
    const json = JSON.stringify({ ...makeOutput(), reviewer: 'bogus' });
    expect(() => parseReviewerOutput(json)).toThrow(/schema violation/);
  });
});
