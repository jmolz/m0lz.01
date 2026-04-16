import { createHash } from 'node:crypto';

import { ReviewerType } from '../db/types.js';
import { Issue, ReviewerOutput, normalizeText } from './reviewer.js';

export const JACCARD_THRESHOLD = 0.6;

export interface IssueContribution {
  reviewer: ReviewerType;
  issue: Issue;
}

export interface IssueCluster {
  reviewers: Set<ReviewerType>;
  issues: IssueContribution[];
}

export interface CategorizedClusters {
  consensus: IssueCluster[];
  majority: IssueCluster[];
  single: IssueCluster[];
}

export interface IssueCounts {
  consensus: number;
  majority: number;
  single: number;
  // Subset of the total surface: clusters that contain at least one issue
  // with `source: 'autocheck'`. Autocheck findings are produced by the
  // deterministic CLI lints and merged into the structural reviewer's
  // output at synthesis time. They are authoritative — a passing verdict
  // cannot coexist with an outstanding autocheck lint, regardless of
  // whether other reviewers echoed it.
  autocheck: number;
  total: number;
}

export type Verdict = 'pass' | 'fail';

// Stable identity of a cluster for coverage comparison. The representative's
// cross-reviewer fingerprint (SHA-256 of normalized title+description) is the
// same field used for exact-match clustering, so two synthesis runs that
// produced the same clusters over the same inputs produce the same identity
// set. Sorted for deterministic comparison.
export interface SynthesisClusterIdentity {
  consensus: string[];
  majority: string[];
  single: string[];
}

export interface SynthesisResult {
  verdict: Verdict;
  counts: IssueCounts;
  categorized: CategorizedClusters;
  // Per-bucket cluster representative fingerprints. Used by
  // completeEvaluation to verify DB-authoritative re-derivation matches the
  // stored synthesis at CLUSTER IDENTITY level, not just bucket counts —
  // closes the "re-record with different issues but same count distribution"
  // bypass where the counts coincide.
  cluster_identity: SynthesisClusterIdentity;
}

export function tokenize(normalized: string): Set<string> {
  if (normalized.length === 0) return new Set();
  return new Set(normalized.split(/\s+/).filter((t) => t.length > 0));
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

// Content-only fingerprint (no reviewer prefix) so exact-match detection
// can collide identical issues across reviewers. Distinct from the
// per-reviewer Issue.id which scopes by reviewer for stable local IDs.
export function crossReviewerFingerprint(title: string, description: string): string {
  const payload = `${normalizeText(title)}\n${normalizeText(description)}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 12);
}

interface Node {
  contribution: IssueContribution;
  fingerprint: string;
  category: string;
  tokens: Set<string>;
}

interface WorkingCluster extends IssueCluster {
  representativeTokens: Set<string>;
  representativeFingerprint: string;
}

function buildNodes(outputs: ReviewerOutput[]): Node[] {
  const nodes: Node[] = [];
  for (const output of outputs) {
    for (const issue of output.issues) {
      const normalized = `${normalizeText(issue.title)} ${normalizeText(issue.description)}`.trim();
      nodes.push({
        contribution: { reviewer: output.reviewer, issue },
        fingerprint: crossReviewerFingerprint(issue.title, issue.description),
        category: issue.category,
        tokens: tokenize(normalized),
      });
    }
  }
  return nodes;
}

// Greedy single-link clustering against cluster representatives. The representative
// is the first node to seed the cluster; a candidate joins only if
// jaccard(candidate, representative) >= threshold. No transitive chaining
// (A~B, B~C, A!~C) because each candidate is compared against the representative
// only, not against every cluster member. Tier 1 (exact cross-reviewer fingerprint)
// still collapses identical issues regardless of category, since identical
// title+description is authoritative. Category is NOT used as a guard — two
// reviewers describing the same defect under different category labels
// (e.g., "thesis" vs "argument-gap") must still cluster as long as the token
// overlap exceeds the threshold; otherwise the gate's sensitivity degrades
// silently when reviewers use slightly different taxonomies.
export function matchIssues(outputs: ReviewerOutput[]): IssueCluster[] {
  const nodes = buildNodes(outputs);
  if (nodes.length === 0) return [];

  const clusters: WorkingCluster[] = [];

  for (const node of nodes) {
    let target: WorkingCluster | undefined;

    for (const cluster of clusters) {
      if (cluster.representativeFingerprint === node.fingerprint) {
        target = cluster;
        break;
      }
    }

    if (!target) {
      let best: WorkingCluster | undefined;
      let bestSim = JACCARD_THRESHOLD;
      for (const cluster of clusters) {
        if (cluster.reviewers.has(node.contribution.reviewer)) continue;
        const sim = jaccardSimilarity(node.tokens, cluster.representativeTokens);
        if (sim >= bestSim) {
          best = cluster;
          bestSim = sim;
        }
      }
      target = best;
    }

    if (target) {
      target.reviewers.add(node.contribution.reviewer);
      target.issues.push(node.contribution);
    } else {
      clusters.push({
        reviewers: new Set([node.contribution.reviewer]),
        issues: [node.contribution],
        representativeTokens: node.tokens,
        representativeFingerprint: node.fingerprint,
      });
    }
  }

  return clusters.map(({ reviewers, issues }) => ({ reviewers, issues }));
}

export function categorize(
  clusters: IssueCluster[],
  expectedReviewers: ReviewerType[],
): CategorizedClusters {
  const expectedCount = expectedReviewers.length;
  const consensus: IssueCluster[] = [];
  const majority: IssueCluster[] = [];
  const single: IssueCluster[] = [];

  // Strict majority = more than half, but not all. Undefined when only 2 reviewers
  // (there is no integer count strictly between 1 and 2), so the majority bucket
  // is unreachable for analysis-opinion posts and every cluster falls into
  // consensus or single — exactly what the plan specifies.
  const majorityThreshold = Math.floor(expectedCount / 2) + 1;

  for (const cluster of clusters) {
    const touched = cluster.reviewers.size;
    if (touched >= expectedCount) {
      consensus.push(cluster);
    } else if (touched >= majorityThreshold) {
      majority.push(cluster);
    } else {
      single.push(cluster);
    }
  }

  return { consensus, majority, single };
}

export function computeVerdict(
  counts: Pick<IssueCounts, 'consensus' | 'majority' | 'autocheck'>,
): Verdict {
  // Autocheck findings are deterministic mechanical lints — any outstanding
  // autocheck cluster blocks the verdict even if it landed in the `single`
  // bucket (no reviewer echoed it). This prevents a broken frontmatter / MDX
  // / internal link / unbacked benchmark claim from shipping merely because
  // one human reviewer missed it.
  if (counts.autocheck > 0) return 'fail';
  return counts.consensus > 0 || counts.majority > 0 ? 'fail' : 'pass';
}

// Count clusters that intersect the authoritative autocheck fingerprint set.
// Authority derives from `structural.lint.json` fingerprints — NOT from any
// reviewer-controlled `issue.source` tag. A reviewer mirroring an autocheck
// finding under `source: 'reviewer'` cannot strip the block: if the cluster
// contains any issue whose normalized (title, description) matches a lint,
// it is autocheck-blocking.
function countAutocheckClusters(clusters: IssueCluster[], autocheckFingerprints: Set<string>): number {
  if (autocheckFingerprints.size === 0) return 0;
  let n = 0;
  for (const cluster of clusters) {
    const hit = cluster.issues.some((c) =>
      autocheckFingerprints.has(crossReviewerFingerprint(c.issue.title, c.issue.description)),
    );
    if (hit) n++;
  }
  return n;
}

// Compute the representative fingerprint of a cluster. Uses the first
// contribution's normalized title+description — same fingerprint that drove
// exact-match clustering in matchIssues. Stable across re-derivation on the
// same inputs.
function clusterRepresentativeFingerprint(cluster: IssueCluster): string {
  const first = cluster.issues[0];
  if (!first) return '';
  return crossReviewerFingerprint(first.issue.title, first.issue.description);
}

function clusterIdentityOf(categorized: CategorizedClusters): SynthesisClusterIdentity {
  const toFingerprints = (cs: IssueCluster[]): string[] =>
    cs.map(clusterRepresentativeFingerprint).filter((fp) => fp.length > 0).sort();
  return {
    consensus: toFingerprints(categorized.consensus),
    majority: toFingerprints(categorized.majority),
    single: toFingerprints(categorized.single),
  };
}

export function synthesize(
  outputs: ReviewerOutput[],
  expectedReviewers: ReviewerType[],
  // SHA-256 fingerprints of every issue in `structural.lint.json` (computed
  // by state.ts via crossReviewerFingerprint). Authoritative — any cluster
  // whose normalized text matches one of these fingerprints is autocheck-
  // blocking, independent of the `issue.source` tag on contributing issues.
  autocheckFingerprints: Set<string> = new Set(),
): SynthesisResult {
  const clusters = matchIssues(outputs);
  const categorized = categorize(clusters, expectedReviewers);
  const counts: IssueCounts = {
    consensus: categorized.consensus.length,
    majority: categorized.majority.length,
    single: categorized.single.length,
    autocheck: countAutocheckClusters(clusters, autocheckFingerprints),
    total: clusters.length,
  };
  const verdict = computeVerdict(counts);
  const cluster_identity = clusterIdentityOf(categorized);
  return { verdict, counts, categorized, cluster_identity };
}
