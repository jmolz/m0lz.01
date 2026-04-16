import { describe, it, expect } from 'vitest';

import {
  tokenize,
  jaccardSimilarity,
  matchIssues,
  categorize,
  computeVerdict,
  synthesize,
  JACCARD_THRESHOLD,
} from '../src/core/evaluate/synthesize.js';
import { Issue, ReviewerOutput, issueFingerprint } from '../src/core/evaluate/reviewer.js';
import { ReviewerType } from '../src/core/db/types.js';

function makeIssue(reviewer: ReviewerType, title: string, description: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id: issueFingerprint(reviewer, title, description),
    category: 'general',
    severity: 'high',
    title,
    description,
    ...overrides,
  };
}

function makeOutput(
  reviewer: ReviewerType,
  issues: Issue[],
  model = `${reviewer}-model`,
): ReviewerOutput {
  return { reviewer, model, passed: issues.length === 0, issues, artifact_hashes: {} };
}

describe('matchIssues — representative-anchored (no category guard)', () => {
  it('clusters identical normalized text across reviewers regardless of category (Tier 1)', () => {
    const a = makeOutput('structural', [
      makeIssue('structural', 'Missing companion repo reference', 'The draft does not link a companion repo value here', { category: 'missing-companion-repo' }),
    ]);
    const b = makeOutput('adversarial', [
      makeIssue('adversarial', 'Missing companion repo reference', 'The draft does not link a companion repo value here', { category: 'thesis' }),
    ]);
    const clusters = matchIssues([a, b]);
    expect(clusters).toHaveLength(1);
  });

  it('clusters paraphrased issues across reviewers even when categories differ (Tier 2)', () => {
    // Two reviewers describing the same real defect can pick different category
    // labels ("benchmark-claim-unbacked" vs "methodology") when their taxonomies
    // don't align perfectly. The gate's sensitivity must not depend on reviewers
    // using identical category strings — Jaccard on normalized title+description
    // is the authoritative cross-reviewer signal.
    const a = makeOutput('structural', [
      makeIssue('structural', 'Benchmark claim unbacked by data', 'The paragraph asserts latency numbers not found in results json', { category: 'benchmark-claim-unbacked' }),
    ]);
    const b = makeOutput('methodology', [
      makeIssue('methodology', 'Unbacked benchmark claim in prose', 'Numbers in paragraph are not found within results json data', { category: 'methodology' }),
    ]);
    const clusters = matchIssues([a, b]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].reviewers.size).toBe(2);
  });

  it('does not build a transitive chain when A~B and B~C but A and C would not independently match', () => {
    // Representative-anchored matching rejects transitive closure: a candidate
    // is only compared against the cluster representative, never the latest
    // member. Three nodes with pairwise overlap only between adjacent pairs
    // therefore stay as three separate clusters.
    const a = makeOutput('structural', [
      makeIssue('structural', 'Alpha issue', 'one two three four five', { category: 'general' }),
    ]);
    const b = makeOutput('adversarial', [
      makeIssue('adversarial', 'Beta issue', 'three four five six seven', { category: 'general' }),
    ]);
    const c = makeOutput('methodology', [
      makeIssue('methodology', 'Gamma issue', 'six seven eight nine ten', { category: 'general' }),
    ]);
    const clusters = matchIssues([a, b, c]);
    expect(clusters).toHaveLength(3);
  });
});

describe('tokenize', () => {
  it('splits on whitespace into unique tokens', () => {
    const tokens = tokenize('alpha beta alpha gamma');
    expect(tokens.size).toBe(3);
    expect(tokens.has('alpha')).toBe(true);
  });

  it('returns empty set for empty input', () => {
    expect(tokenize('').size).toBe(0);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('returns expected ratio for partial overlap', () => {
    expect(jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBeCloseTo(2 / 4);
  });
});

describe('matchIssues — exact fingerprint tier', () => {
  it('clusters identical-normalized issues across reviewers', () => {
    const title = 'Thesis is unsupported';
    const desc = 'The central claim lacks backing from the listed sources.';
    const outputs = [
      makeOutput('structural', [makeIssue('structural', title, desc)]),
      makeOutput('adversarial', [makeIssue('adversarial', title, desc)]),
      makeOutput('methodology', [makeIssue('methodology', title, desc)]),
    ];
    const clusters = matchIssues(outputs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].reviewers.size).toBe(3);
  });

  it('matches despite whitespace and case differences', () => {
    const outputs = [
      makeOutput('structural', [makeIssue('structural', 'Bias in Sample', 'only benchmarks on mac')]),
      makeOutput('adversarial', [makeIssue('adversarial', ' BIAS   IN  sample ', 'Only benchmarks on Mac!')]),
    ];
    const clusters = matchIssues(outputs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].reviewers.size).toBe(2);
  });
});

describe('matchIssues — Jaccard fallback', () => {
  it('matches paraphrased issues that exceed the threshold', () => {
    const outputs = [
      makeOutput('structural', [makeIssue(
        'structural',
        'Sample size is very small',
        'Only three benchmark runs were collected which limits statistical confidence significantly',
      )]),
      makeOutput('adversarial', [makeIssue(
        'adversarial',
        'Sample size is very small',
        'Only three benchmark runs were collected which caps statistical confidence significantly',
      )]),
    ];
    const clusters = matchIssues(outputs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].reviewers.size).toBe(2);
  });

  it('does NOT match when similarity falls below the threshold', () => {
    const outputs = [
      makeOutput('structural', [makeIssue('structural', 'Issue One', 'alpha beta gamma delta')]),
      makeOutput('adversarial', [makeIssue('adversarial', 'Issue Two', 'epsilon zeta eta theta')]),
    ];
    const clusters = matchIssues(outputs);
    expect(clusters).toHaveLength(2);
  });

  it('does not inflate cluster.reviewers when a single reviewer reports duplicates', () => {
    // Tier 1 fingerprint match dedupes identical issues from the same reviewer into
    // one cluster, but cluster.reviewers.size stays at 1 — categorization sees a
    // single-reviewer issue either way, so the reviewer can't game consensus by spam.
    const outputs = [
      makeOutput('structural', [
        makeIssue('structural', 'Prose weakness', 'The prose is weak in section two and three'),
        makeIssue('structural', 'Prose weakness', 'The prose is weak in section two and three'),
      ]),
    ];
    const clusters = matchIssues(outputs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].reviewers.size).toBe(1);
  });
});

describe('categorize', () => {
  it('returns consensus when all expected reviewers are in the cluster', () => {
    const title = 'Same issue';
    const desc = 'Same description of the same issue here';
    const outputs = [
      makeOutput('structural', [makeIssue('structural', title, desc)]),
      makeOutput('adversarial', [makeIssue('adversarial', title, desc)]),
      makeOutput('methodology', [makeIssue('methodology', title, desc)]),
    ];
    const clusters = matchIssues(outputs);
    const cat = categorize(clusters, ['structural', 'adversarial', 'methodology']);
    expect(cat.consensus).toHaveLength(1);
    expect(cat.majority).toHaveLength(0);
    expect(cat.single).toHaveLength(0);
  });

  it('returns majority when 2/3 reviewers touch a cluster', () => {
    const title = 'Shared issue';
    const desc = 'Shared description of the shared issue to match across';
    const outputs = [
      makeOutput('structural', [makeIssue('structural', title, desc)]),
      makeOutput('adversarial', [makeIssue('adversarial', title, desc)]),
      makeOutput('methodology', [makeIssue('methodology', 'other', 'completely unrelated words here zzz qqq')]),
    ];
    const clusters = matchIssues(outputs);
    const cat = categorize(clusters, ['structural', 'adversarial', 'methodology']);
    expect(cat.consensus).toHaveLength(0);
    expect(cat.majority).toHaveLength(1);
    expect(cat.single).toHaveLength(1);
  });

  it('treats 2/2 as consensus for analysis-opinion two-reviewer mode', () => {
    const title = 'Shared';
    const desc = 'Same shared text here for matching';
    const outputs = [
      makeOutput('structural', [makeIssue('structural', title, desc)]),
      makeOutput('adversarial', [makeIssue('adversarial', title, desc)]),
    ];
    const clusters = matchIssues(outputs);
    const cat = categorize(clusters, ['structural', 'adversarial']);
    expect(cat.consensus).toHaveLength(1);
    expect(cat.majority).toHaveLength(0);
    expect(cat.single).toHaveLength(0);
  });

  it('treats 1/2 as single for analysis-opinion two-reviewer mode (no majority bucket)', () => {
    const outputs = [
      makeOutput('structural', [makeIssue('structural', 'lonely', 'only one reviewer flagged this thing')]),
      makeOutput('adversarial', []),
    ];
    const clusters = matchIssues(outputs);
    const cat = categorize(clusters, ['structural', 'adversarial']);
    expect(cat.consensus).toHaveLength(0);
    expect(cat.majority).toHaveLength(0);
    expect(cat.single).toHaveLength(1);
  });
});

describe('computeVerdict', () => {
  it('is pass when both consensus and majority are zero', () => {
    expect(computeVerdict({ consensus: 0, majority: 0 })).toBe('pass');
  });

  it('is fail when consensus > 0', () => {
    expect(computeVerdict({ consensus: 1, majority: 0 })).toBe('fail');
  });

  it('is fail when majority > 0', () => {
    expect(computeVerdict({ consensus: 0, majority: 1 })).toBe('fail');
  });
});

describe('synthesize — end-to-end', () => {
  it('produces the plan\'s canonical mixed scenario: 1 consensus + 1 majority + 1 single', () => {
    const consensusTitle = 'All see';
    const consensusDesc = 'A very specific shared issue that all three reviewers catch';
    const majorityTitle = 'Two see';
    const majorityDesc = 'A different specific shared issue that only two reviewers catch';
    const outputs = [
      makeOutput('structural', [
        makeIssue('structural', consensusTitle, consensusDesc),
        makeIssue('structural', majorityTitle, majorityDesc),
      ]),
      makeOutput('adversarial', [
        makeIssue('adversarial', consensusTitle, consensusDesc),
        makeIssue('adversarial', majorityTitle, majorityDesc),
      ]),
      makeOutput('methodology', [
        makeIssue('methodology', consensusTitle, consensusDesc),
        makeIssue('methodology', 'Unique to one reviewer', 'Totally unique words here nobody else says these aardvarks penguins'),
      ]),
    ];
    const result = synthesize(outputs, ['structural', 'adversarial', 'methodology']);
    expect(result.counts.consensus).toBe(1);
    expect(result.counts.majority).toBe(1);
    expect(result.counts.single).toBe(1);
    expect(result.verdict).toBe('fail');
  });

  it('returns pass with all-zero counts when every reviewer has empty issues', () => {
    const outputs: ReviewerOutput[] = [
      makeOutput('structural', []),
      makeOutput('adversarial', []),
      makeOutput('methodology', []),
    ];
    const result = synthesize(outputs, ['structural', 'adversarial', 'methodology']);
    expect(result.counts.consensus).toBe(0);
    expect(result.counts.majority).toBe(0);
    expect(result.counts.single).toBe(0);
    expect(result.counts.total).toBe(0);
    expect(result.verdict).toBe('pass');
  });

  it('treats single-reviewer issues as advisory (pass verdict)', () => {
    const outputs = [
      makeOutput('structural', [makeIssue('structural', 'Only one', 'Only one reviewer saw this minor issue')]),
      makeOutput('adversarial', []),
      makeOutput('methodology', []),
    ];
    const result = synthesize(outputs, ['structural', 'adversarial', 'methodology']);
    expect(result.counts.single).toBe(1);
    expect(result.counts.consensus).toBe(0);
    expect(result.counts.majority).toBe(0);
    expect(result.verdict).toBe('pass');
  });
});

describe('JACCARD_THRESHOLD', () => {
  it('is exported as a named constant with value 0.6', () => {
    expect(JACCARD_THRESHOLD).toBe(0.6);
  });
});
