import { ReviewerOutput } from './reviewer.js';
import { SynthesisResult, IssueCluster } from './synthesize.js';

function verdictBadge(verdict: 'pass' | 'fail'): string {
  return verdict === 'pass' ? '**Verdict: PASS**' : '**Verdict: FAIL**';
}

function renderClusterSection(title: string, subtitle: string, clusters: IssueCluster[]): string[] {
  const lines = [`## ${title}`, '', `_${subtitle}_`, ''];
  if (clusters.length === 0) {
    lines.push('(none)', '');
    return lines;
  }
  clusters.forEach((cluster, idx) => {
    const first = cluster.issues[0].issue;
    const reviewers = Array.from(cluster.reviewers).sort().join(', ');
    lines.push(`### ${idx + 1}. ${first.title}`);
    lines.push('');
    lines.push(`- Reviewers: ${reviewers}`);
    lines.push(`- Severity: ${first.severity}`);
    lines.push(`- Category: ${first.category}`);
    lines.push('');
    for (const contribution of cluster.issues) {
      lines.push(`**${contribution.reviewer}:** ${contribution.issue.description}`);
      lines.push('');
    }
  });
  return lines;
}

function renderDisagreements(result: SynthesisResult): string[] {
  const lines = ['## Reviewer Disagreements', ''];
  const singles = result.categorized.single;
  if (singles.length === 0) {
    lines.push('(none)', '');
    return lines;
  }
  lines.push(
    '_Issues flagged by only one reviewer, grouped by category. Other reviewers did not surface these._',
    '',
  );
  const byCategory = new Map<string, IssueCluster[]>();
  for (const cluster of singles) {
    const category = cluster.issues[0].issue.category;
    const arr = byCategory.get(category);
    if (arr) arr.push(cluster);
    else byCategory.set(category, [cluster]);
  }
  for (const [category, clusters] of Array.from(byCategory.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- **${category}** (${clusters.length}):`);
    for (const cluster of clusters) {
      const reviewer = Array.from(cluster.reviewers)[0];
      const title = cluster.issues[0].issue.title;
      lines.push(`  - ${reviewer}: ${title}`);
    }
  }
  lines.push('');
  return lines;
}

function renderPerReviewerSummaries(outputs: ReviewerOutput[]): string[] {
  const lines = ['## Per-Reviewer Summaries', ''];
  for (const output of outputs) {
    lines.push(`### ${output.reviewer} (${output.model})`);
    lines.push('');
    lines.push(`- Reviewer verdict: ${output.passed ? 'pass' : 'fail'}`);
    lines.push(`- Issues surfaced: ${output.issues.length}`);
    if (output.report_path) {
      lines.push(`- Report: ${output.report_path}`);
    }
    lines.push('');
  }
  return lines;
}

export function renderSynthesisReport(
  slug: string,
  result: SynthesisResult,
  outputs: ReviewerOutput[],
): string {
  const lines: string[] = [];
  lines.push(`# Evaluation: ${slug}`);
  lines.push('');
  lines.push(verdictBadge(result.verdict));
  lines.push('');
  lines.push(
    `- Consensus issues: ${result.counts.consensus}`,
    `- Majority issues: ${result.counts.majority}`,
    `- Single-reviewer issues: ${result.counts.single}`,
    `- Autocheck issues (blocking regardless of reviewer echo): ${result.counts.autocheck}`,
    `- Total issue clusters: ${result.counts.total}`,
    '',
  );

  lines.push(
    ...renderClusterSection(
      'Consensus Issues',
      'Flagged by all expected reviewers — must fix.',
      result.categorized.consensus,
    ),
  );
  lines.push(
    ...renderClusterSection(
      'Majority Issues',
      'Flagged by a strict majority of reviewers — should fix.',
      result.categorized.majority,
    ),
  );
  lines.push(
    ...renderClusterSection(
      'Single-Reviewer Issues',
      'Flagged by one reviewer — advisory.',
      result.categorized.single,
    ),
  );
  lines.push(...renderDisagreements(result));
  lines.push(...renderPerReviewerSummaries(outputs));

  return lines.join('\n');
}
