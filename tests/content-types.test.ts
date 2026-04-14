import { describe, it, expect } from 'vitest';

import { detectContentType } from '../src/core/draft/content-types.js';

describe('content type detection', () => {
  it('returns project-launch for catalog project IDs', () => {
    expect(detectContentType('m0lz.02 structured coding', 'm0lz.02')).toBe('project-launch');
    expect(detectContentType('Announcing m0lz.03', 'm0lz.03')).toBe('project-launch');
  });

  it('returns technical-deep-dive for benchmark keywords', () => {
    expect(detectContentType('benchmark MinIO alternatives on a VPS')).toBe('technical-deep-dive');
    expect(detectContentType('compare S3-compatible storage performance')).toBe('technical-deep-dive');
    expect(detectContentType('measure latency of edge functions')).toBe('technical-deep-dive');
  });

  it('returns analysis-opinion for generic prompts', () => {
    expect(detectContentType('thoughts on agentic harnesses')).toBe('analysis-opinion');
    expect(detectContentType('the state of AI-assisted development')).toBe('analysis-opinion');
  });

  it('prioritizes project ID over benchmark keywords', () => {
    expect(detectContentType('benchmark the m0lz.05 approach', 'm0lz.05')).toBe('project-launch');
  });

  it('handles empty prompt gracefully', () => {
    expect(detectContentType('')).toBe('analysis-opinion');
  });

  it('does not false-positive on "test-driven development"', () => {
    expect(detectContentType('thoughts on test-driven development')).toBe('analysis-opinion');
    expect(detectContentType('testing philosophies and TDD')).toBe('analysis-opinion');
  });
});
