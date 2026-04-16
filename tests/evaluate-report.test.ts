import { describe, it, expect } from 'vitest';

import { renderSynthesisReport } from '../src/core/evaluate/report.js';
import { synthesize } from '../src/core/evaluate/synthesize.js';
import { Issue, ReviewerOutput, issueFingerprint } from '../src/core/evaluate/reviewer.js';
import { ReviewerType } from '../src/core/db/types.js';

function makeIssue(reviewer: ReviewerType, title: string, description: string): Issue {
  return {
    id: issueFingerprint(reviewer, title, description),
    category: 'thesis',
    severity: 'high',
    title,
    description,
  };
}

function makeOutput(reviewer: ReviewerType, issues: Issue[]): ReviewerOutput {
  return { reviewer, model: `${reviewer}-model`, passed: issues.length === 0, issues, artifact_hashes: {} };
}

describe('renderSynthesisReport', () => {
  it('renders all five sections for a fail verdict with mixed issue categories', () => {
    const consensusTitle = 'Shared by all';
    const consensusDesc = 'Specific description that will be matched exactly across reviewers';
    const outputs = [
      makeOutput('structural', [
        makeIssue('structural', consensusTitle, consensusDesc),
        makeIssue('structural', 'Unique structural', 'Only structural sees this particular concern here'),
      ]),
      makeOutput('adversarial', [
        makeIssue('adversarial', consensusTitle, consensusDesc),
      ]),
      makeOutput('methodology', [
        makeIssue('methodology', consensusTitle, consensusDesc),
      ]),
    ];
    const result = synthesize(outputs, ['structural', 'adversarial', 'methodology']);
    const report = renderSynthesisReport('my-post', result, outputs);

    expect(report).toContain('# Evaluation: my-post');
    expect(report).toContain('**Verdict: FAIL**');
    expect(report).toContain('## Consensus Issues');
    expect(report).toContain('## Majority Issues');
    expect(report).toContain('## Single-Reviewer Issues');
    expect(report).toContain('## Reviewer Disagreements');
    expect(report).toContain('## Per-Reviewer Summaries');

    // Titles and descriptions appear in the body
    expect(report).toContain(consensusTitle);
    expect(report).toContain('Unique structural');
  });

  it('renders pass verdict when there are no consensus or majority issues', () => {
    const outputs = [
      makeOutput('structural', []),
      makeOutput('adversarial', []),
      makeOutput('methodology', []),
    ];
    const result = synthesize(outputs, ['structural', 'adversarial', 'methodology']);
    const report = renderSynthesisReport('clean-post', result, outputs);

    expect(report).toContain('**Verdict: PASS**');
  });

  it('renders "(none)" for empty issue categories', () => {
    const outputs = [
      makeOutput('structural', []),
      makeOutput('adversarial', []),
      makeOutput('methodology', []),
    ];
    const result = synthesize(outputs, ['structural', 'adversarial', 'methodology']);
    const report = renderSynthesisReport('clean', result, outputs);

    // Each cluster section should show "(none)" when empty
    const consensusSection = report.split('## Consensus Issues')[1].split('## Majority Issues')[0];
    expect(consensusSection).toContain('(none)');
  });

  it('includes per-reviewer model and issue count', () => {
    const outputs = [
      makeOutput('structural', [makeIssue('structural', 't', 'd description here long enough')]),
      makeOutput('adversarial', []),
      makeOutput('methodology', []),
    ];
    const result = synthesize(outputs, ['structural', 'adversarial', 'methodology']);
    const report = renderSynthesisReport('p', result, outputs);

    expect(report).toContain('structural (structural-model)');
    expect(report).toContain('Issues surfaced: 1');
    expect(report).toContain('Issues surfaced: 0');
  });
});
