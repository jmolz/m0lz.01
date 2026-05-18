import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import { closeDatabase, getDatabase } from '../src/core/db/database.js';
import { advancePhase, initResearchPost } from '../src/core/research/state.js';
import {
  completeEvaluation,
  computeReviewedArtifactHashes,
  initEvaluation,
  recordReview,
  runSynthesis,
} from '../src/core/evaluate/state.js';
import { ReviewerOutput } from '../src/core/evaluate/reviewer.js';
import { ReviewerType } from '../src/core/db/types.js';
import { PIPELINE_STEPS } from '../src/core/publish/pipeline-registry.js';
import { PipelineContext } from '../src/core/publish/pipeline-types.js';
import { BlogConfig } from '../src/core/config/types.js';

interface Fixture {
  tempDir: string;
  draftsDir: string;
  benchmarkDir: string;
  evaluationsDir: string;
  publishDir: string;
  db: Database.Database;
  config: BlogConfig;
}

let fixture: Fixture | undefined;

function makeConfig(): BlogConfig {
  return {
    site: { repo_path: '/tmp/site', base_url: 'https://m0lz.dev', content_dir: 'content/posts', research_dir: 'content/research' },
    author: { name: 'Tester', github: 'jmolz' },
    ai: {
      primary: 'claude-code',
      reviewers: { structural: 'claude-code', adversarial: 'codex-cli', methodology: 'codex-cli' },
      codex: { adversarial_effort: 'high', methodology_effort: 'xhigh' },
    },
    content_types: {
      'project-launch': { benchmark: 'optional', companion_repo: 'existing', social_prefix: 'Show HN:' },
      'technical-deep-dive': { benchmark: 'required', companion_repo: 'new', social_prefix: '' },
      'analysis-opinion': { benchmark: 'skip', companion_repo: 'optional', social_prefix: '' },
    },
    benchmark: { capture_environment: true, methodology_template: true, preserve_raw_data: true, multiple_runs: 3 },
    publish: { devto: true, medium: true, substack: true, github_repos: true, social_drafts: true, research_pages: true },
    social: { platforms: ['linkedin', 'hackernews'], timing_recommendations: true },
    evaluation: {
      require_pass: true,
      min_sources: 3,
      max_reading_level: 12,
      three_reviewer_panel: true,
      consensus_must_fix: true,
      majority_should_fix: true,
      single_advisory: false,
      verify_benchmark_claims: true,
      methodology_completeness: true,
    },
    updates: { preserve_original_data: true, update_notice: true, update_crosspost: true },
  };
}

function setup(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'publish-verify-artifacts-'));
  const draftsDir = join(tempDir, 'drafts');
  const benchmarkDir = join(tempDir, 'benchmarks');
  const evaluationsDir = join(tempDir, 'evaluations');
  const publishDir = join(tempDir, 'publish');
  for (const dir of [draftsDir, benchmarkDir, evaluationsDir, publishDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const db = getDatabase(':memory:');
  fixture = { tempDir, draftsDir, benchmarkDir, evaluationsDir, publishDir, db, config: makeConfig() };
  return fixture;
}

afterEach(() => {
  if (fixture?.db) closeDatabase(fixture.db);
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
});

function artifactPaths(f: Fixture): { draftsDir: string; benchmarkDir: string } {
  return { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir };
}

function currentReviewerOutput(f: Fixture, slug: string, reviewer: ReviewerType): ReviewerOutput {
  return {
    reviewer,
    model: `${reviewer}-model`,
    passed: true,
    issues: [],
    artifact_hashes: computeReviewedArtifactHashes(artifactPaths(f), f.evaluationsDir, slug),
  };
}

function seedCompletedEvaluation(f: Fixture, slug: string): void {
  initResearchPost(f.db, slug, 'topic', 'directed', 'technical-deep-dive');
  advancePhase(f.db, slug, 'benchmark');
  advancePhase(f.db, slug, 'draft');
  advancePhase(f.db, slug, 'evaluate');
  initEvaluation(f.db, slug, f.evaluationsDir);

  mkdirSync(join(f.draftsDir, slug), { recursive: true });
  mkdirSync(join(f.benchmarkDir, slug), { recursive: true });
  writeFileSync(join(f.draftsDir, slug, 'index.mdx'), 'reviewed draft v1\n', 'utf-8');
  writeFileSync(join(f.benchmarkDir, slug, 'results.json'), '{"data":{"ok":true}}\n', 'utf-8');
  writeFileSync(join(f.benchmarkDir, slug, 'environment.json'), '{"node":"test"}\n', 'utf-8');
  writeFileSync(join(f.evaluationsDir, slug, 'structural.lint.json'), '[]\n', 'utf-8');

  for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
    recordReview(
      f.db,
      slug,
      reviewer,
      `/tmp/${reviewer}.md`,
      currentReviewerOutput(f, slug, reviewer),
      f.evaluationsDir,
      artifactPaths(f),
    );
  }
  runSynthesis(f.db, slug, f.evaluationsDir, artifactPaths(f));
  completeEvaluation(f.db, slug, f.evaluationsDir, artifactPaths(f));
}

function makeContext(f: Fixture, slug: string): PipelineContext {
  return {
    db: f.db,
    slug,
    config: f.config,
    paths: {
      dbPath: join(f.tempDir, 'state.db'),
      configPath: join(f.tempDir, '.blogrc.yaml'),
      draftsDir: f.draftsDir,
      benchmarkDir: f.benchmarkDir,
      evaluationsDir: f.evaluationsDir,
      researchDir: join(f.tempDir, 'research'),
      reposDir: join(f.tempDir, 'repos'),
      socialDir: join(f.tempDir, 'social'),
      researchPagesDir: join(f.tempDir, 'research-pages'),
      publishDir: f.publishDir,
      templatesDir: join(f.tempDir, 'templates'),
    },
    urls: {},
    publishMode: 'initial',
    cycleId: 0,
  };
}

describe('publish verify -- evaluation artifact guard', () => {
  it('fails before site-pr when draft bytes changed after evaluation complete', async () => {
    const f = setup();
    const slug = 'drift-after-complete';
    seedCompletedEvaluation(f, slug);

    const verify = PIPELINE_STEPS.find((step) => step.name === 'verify');
    expect(verify).toBeDefined();
    const clean = await verify!.execute(makeContext(f, slug));
    expect(clean.outcome).toBe('completed');

    writeFileSync(join(f.draftsDir, slug, 'index.mdx'), 'unreviewed draft v2\n', 'utf-8');
    const drifted = await verify!.execute(makeContext(f, slug));

    expect(drifted.outcome).toBe('failed');
    expect(drifted.message).toContain('Evaluation artifact verification failed');
    expect(drifted.message).toContain('draft/index.mdx');
    expect(drifted.message).toContain('blog publish reopen-draft');
  });
});
