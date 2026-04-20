import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { ReviewerType } from '../core/db/types.js';
import { validateSlug } from '../core/research/document.js';
import { resolveUserPath } from '../core/workspace/user-path.js';
import { printEnvelope } from '../core/json-envelope.js';
import { runStructuralAutocheck } from '../core/evaluate/autocheck.js';
import {
  initEvaluation,
  recordReview,
  runSynthesis,
  completeEvaluation,
  rejectEvaluation,
  listRecordedReviewers,
  listRecordedReviewersInCycle,
  latestSynthesis,
  latestSynthesisInCycle,
  readManifest,
  evaluationDir,
  readReviewerOutputFromFile,
} from '../core/evaluate/state.js';

const DB_PATH = resolve('.blog-agent', 'state.db');
const EVALUATIONS_DIR = resolve('.blog-agent', 'evaluations');
const DRAFTS_DIR = resolve('.blog-agent', 'drafts');
const BENCHMARK_DIR = resolve('.blog-agent', 'benchmarks');

export interface EvaluatePaths {
  dbPath?: string;
  evaluationsDir?: string;
  draftsDir?: string;
  benchmarkDir?: string;
  json?: boolean;
}

const VALID_REVIEWERS: readonly ReviewerType[] = ['structural', 'adversarial', 'methodology'] as const;

function requireDb(dbPath: string): void {
  if (!existsSync(dbPath)) {
    console.error("No state database found. Run 'blog init' first.");
    process.exit(1);
  }
}

function validateSlugOrFail(slug: string): boolean {
  try {
    validateSlug(slug);
    return true;
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return false;
  }
}

export function runEvaluateInit(slug: string, paths: EvaluatePaths = {}): void {
  if (!validateSlugOrFail(slug)) return;

  const dbPath = paths.dbPath ?? DB_PATH;
  const evaluationsDir = paths.evaluationsDir ?? EVALUATIONS_DIR;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    let result;
    try {
      result = initEvaluation(db, slug, evaluationsDir);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    console.log(`Evaluation initialized for ${slug}`);
    console.log(`Workspace: ${result.workspaceDir}`);
    console.log(`Content type: ${result.manifest.content_type}`);
    console.log(`Expected reviewers: ${result.manifest.expected_reviewers.join(', ')}`);
  } finally {
    closeDatabase(db);
  }
}

export function runEvaluateAutocheck(slug: string, paths: EvaluatePaths = {}): void {
  if (!validateSlugOrFail(slug)) return;

  const dbPath = paths.dbPath ?? DB_PATH;
  const evaluationsDir = paths.evaluationsDir ?? EVALUATIONS_DIR;
  const draftsDir = paths.draftsDir ?? DRAFTS_DIR;
  const benchmarkDir = paths.benchmarkDir ?? BENCHMARK_DIR;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    try {
      const workspace = evaluationDir(evaluationsDir, slug);
      mkdirSync(workspace, { recursive: true });

      const issues = runStructuralAutocheck(db, slug, { draftsDir, benchmarkDir });
      const output = `${JSON.stringify(issues, null, 2)}\n`;
      const outputPath = join(workspace, 'structural.lint.json');
      writeFileSync(outputPath, output, 'utf-8');

      const counts = new Map<string, number>();
      for (const issue of issues) {
        counts.set(issue.category, (counts.get(issue.category) ?? 0) + 1);
      }

      console.log(`Autocheck complete for ${slug}`);
      console.log(`Output: ${outputPath}`);
      console.log(`Total issues: ${issues.length}`);
      if (counts.size > 0) {
        for (const [cat, n] of Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b))) {
          console.log(`  ${cat}: ${n}`);
        }
      }
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
    }
  } finally {
    closeDatabase(db);
  }
}

export function runEvaluateRecord(
  slug: string,
  opts: { reviewer: string; report: string; issues: string },
  paths: EvaluatePaths = {},
): void {
  if (!validateSlugOrFail(slug)) return;

  if (!VALID_REVIEWERS.includes(opts.reviewer as ReviewerType)) {
    console.error(`Invalid reviewer: '${opts.reviewer}'. Valid values: ${VALID_REVIEWERS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const evaluationsDir = paths.evaluationsDir ?? EVALUATIONS_DIR;
  const draftsDir = paths.draftsDir ?? DRAFTS_DIR;
  const benchmarkDir = paths.benchmarkDir ?? BENCHMARK_DIR;
  requireDb(dbPath);

  let output;
  try {
    output = readReviewerOutputFromFile(opts.issues);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const db = getDatabase(dbPath);
  try {
    try {
      recordReview(db, slug, opts.reviewer as ReviewerType, opts.report, output, evaluationsDir, { draftsDir, benchmarkDir });
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    console.log(`Recorded ${opts.reviewer} review for ${slug}`);
    console.log(`Issues: ${output.issues.length}`);
    console.log(`Reviewer verdict: ${output.passed ? 'pass' : 'fail'}`);
  } finally {
    closeDatabase(db);
  }
}

export function runEvaluateShow(slug: string, paths: EvaluatePaths = {}): void {
  if (!validateSlugOrFail(slug)) return;

  const dbPath = paths.dbPath ?? DB_PATH;
  const evaluationsDir = paths.evaluationsDir ?? EVALUATIONS_DIR;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as { slug: string; phase: string; content_type: string | null } | undefined;
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }

    // Informational command: readManifest throws on tampered/malformed manifest.
    // Treat that as a display issue, not a fatal error — we still want to show
    // the DB-side state (phase, content_type, historical reviewers/verdict) so
    // an operator recovering from workspace damage can see what exists.
    let manifest: ReturnType<typeof readManifest>;
    let manifestError: string | undefined;
    try {
      manifest = readManifest(evaluationsDir, slug);
    } catch (e) {
      manifest = null;
      manifestError = (e as Error).message;
    }

    if (paths.json) {
      const currentCycle = manifest && manifest.cycles.length > 0
        ? manifest.cycles[manifest.cycles.length - 1]
        : null;
      const inCycle = currentCycle
        ? listRecordedReviewersInCycle(db, slug, currentCycle.evaluation_id_floor)
        : [];
      const synthesis = currentCycle
        ? latestSynthesisInCycle(db, slug, currentCycle.synthesis_id_floor)
        : null;
      printEnvelope<'EvaluationState', {
        slug: string;
        phase: string;
        content_type: string | null;
        manifest_readable: boolean;
        manifest_error: string | null;
        cycle_id: number | null;
        cycle_number: number | null;
        cycle_status: string | null;
        expected_reviewers: string[];
        reviewers: Array<{ reviewer: string; status: 'recorded' | 'pending' }>;
        verdict: string | null;
        consensus_issues: number | null;
        majority_issues: number | null;
        single_issues: number | null;
      }>('EvaluationState', {
        slug: post.slug,
        phase: post.phase,
        content_type: post.content_type,
        manifest_readable: manifest !== null,
        manifest_error: manifestError ?? null,
        cycle_id: currentCycle ? currentCycle.evaluation_id_floor : null,
        cycle_number: manifest ? manifest.cycles.length : null,
        cycle_status: currentCycle ? (currentCycle.ended_reason ?? 'open') : null,
        expected_reviewers: manifest ? [...manifest.expected_reviewers] : [],
        reviewers: manifest
          ? manifest.expected_reviewers.map((r) => ({
              reviewer: r,
              status: (inCycle.includes(r) ? 'recorded' : 'pending') as 'recorded' | 'pending',
            }))
          : [],
        verdict: synthesis ? synthesis.verdict : null,
        consensus_issues: synthesis ? synthesis.consensus_issues : null,
        majority_issues: synthesis ? synthesis.majority_issues : null,
        single_issues: synthesis ? synthesis.single_issues : null,
      });
      return;
    }

    console.log(`slug:               ${post.slug}`);
    console.log(`phase:              ${post.phase}`);
    console.log(`content_type:       ${post.content_type ?? 'unknown'}`);
    if (manifestError) {
      console.log(`manifest:           (unreadable: ${manifestError})`);
    }

    if (!manifest) {
      if (!manifestError) {
        console.log(`manifest:           (not initialized — run 'blog evaluate init ${slug}')`);
      }
      // No manifest = no cycle context. Fall back to the global view so an
      // operator exploring a broken workspace can still see what exists.
      const recorded = listRecordedReviewers(db, slug);
      const synthesis = latestSynthesis(db, slug);
      if (recorded.length > 0) {
        console.log(`recorded (historical): ${recorded.join(', ')}`);
      }
      if (synthesis) {
        console.log(`verdict (historical): ${synthesis.verdict}`);
      } else {
        console.log(`verdict:            (not synthesized)`);
      }
    } else {
      // Cycle-scoped view: report reviewer status and verdict for the CURRENT
      // cycle only. After a reject+re-init, the prior cycle's recorded reviewers
      // and pass verdict must not be displayed as current — that would lie to
      // an operator about whether the gate is satisfied. Prior cycles are
      // summarized as historical metadata.
      //
      // Belt-and-braces: wrap the cycle-rendering body in a best-effort catch
      // so any unexpected shape in manifest.cycles (despite readManifest's
      // validators) degrades to a warning line instead of a raw TypeError
      // stack trace. Informational commands must never hard-fail on display.
      try {
        const cycle = manifest.cycles[manifest.cycles.length - 1];
        const inCycle = listRecordedReviewersInCycle(db, slug, cycle.evaluation_id_floor);
        const synthesis = latestSynthesisInCycle(db, slug, cycle.synthesis_id_floor);
        const cycleNumber = manifest.cycles.length;
        const cycleStatus = cycle.ended_reason ?? 'open';

        console.log(`manifest:           ${manifest.initialized_at}`);
        console.log(`cycle:              ${cycleNumber} (${cycleStatus}, started ${cycle.started_at})`);
        console.log(`expected_reviewers: ${manifest.expected_reviewers.join(', ')}`);
        for (const reviewer of manifest.expected_reviewers) {
          const status = inCycle.includes(reviewer) ? 'recorded' : 'pending';
          console.log(`  ${reviewer.padEnd(12)}: ${status}`);
        }

        if (synthesis) {
          console.log(`verdict:            ${synthesis.verdict}`);
          console.log(`  consensus: ${synthesis.consensus_issues}`);
          console.log(`  majority:  ${synthesis.majority_issues}`);
          console.log(`  single:    ${synthesis.single_issues}`);
          console.log(`report:             ${synthesis.report_path}`);
        } else {
          console.log(`verdict:            (not synthesized in current cycle)`);
        }

        if (manifest.cycles.length > 1) {
          const priorPassed = manifest.cycles.slice(0, -1).filter((c) => c.ended_reason === 'passed').length;
          const priorRejected = manifest.cycles.slice(0, -1).filter((c) => c.ended_reason === 'rejected').length;
          console.log(`prior cycles:       ${priorPassed} passed, ${priorRejected} rejected (historical, not part of gate)`);
        }
      } catch (e) {
        console.log(`cycle view:         (render failed: ${(e as Error).message})`);
      }
    }
  } finally {
    closeDatabase(db);
  }
}

export function runEvaluateSynthesize(slug: string, paths: EvaluatePaths = {}): void {
  if (!validateSlugOrFail(slug)) return;

  const dbPath = paths.dbPath ?? DB_PATH;
  const evaluationsDir = paths.evaluationsDir ?? EVALUATIONS_DIR;
  const draftsDir = paths.draftsDir ?? DRAFTS_DIR;
  const benchmarkDir = paths.benchmarkDir ?? BENCHMARK_DIR;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    let result;
    try {
      result = runSynthesis(db, slug, evaluationsDir, { draftsDir, benchmarkDir });
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    console.log(`Synthesis complete for ${slug}`);
    console.log(`Verdict: ${result.synthesis.verdict}`);
    console.log(`  consensus: ${result.synthesis.counts.consensus}`);
    console.log(`  majority:  ${result.synthesis.counts.majority}`);
    console.log(`  single:    ${result.synthesis.counts.single}`);
    console.log(`  autocheck: ${result.synthesis.counts.autocheck}`);
    console.log(`Report: ${result.reportPath}`);
  } finally {
    closeDatabase(db);
  }
}

export function runEvaluateComplete(slug: string, paths: EvaluatePaths = {}): void {
  if (!validateSlugOrFail(slug)) return;

  const dbPath = paths.dbPath ?? DB_PATH;
  const evaluationsDir = paths.evaluationsDir ?? EVALUATIONS_DIR;
  const draftsDir = paths.draftsDir ?? DRAFTS_DIR;
  const benchmarkDir = paths.benchmarkDir ?? BENCHMARK_DIR;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    try {
      completeEvaluation(db, slug, evaluationsDir, { draftsDir, benchmarkDir });
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    console.log(`Evaluation complete for ${slug}. Phase advanced to publish.`);
  } finally {
    closeDatabase(db);
  }
}

export function runEvaluateReject(slug: string, paths: EvaluatePaths = {}): void {
  if (!validateSlugOrFail(slug)) return;

  const dbPath = paths.dbPath ?? DB_PATH;
  const evaluationsDir = paths.evaluationsDir ?? EVALUATIONS_DIR;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    try {
      rejectEvaluation(db, slug, evaluationsDir);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    console.log(`Evaluation rejected for ${slug}. Phase moved back to draft.`);
  } finally {
    closeDatabase(db);
  }
}

export function registerEvaluate(program: Command): void {
  const evaluate = program.command('evaluate').description('Evaluation phase operations');

  evaluate
    .command('init <slug>')
    .description('Initialize evaluation workspace and manifest')
    .action((slug: string) => {
      runEvaluateInit(slug);
    });

  evaluate
    .command('structural-autocheck <slug>')
    .description('Run deterministic structural lints, write structural.lint.json')
    .action((slug: string) => {
      runEvaluateAutocheck(slug);
    });

  evaluate
    .command('record <slug>')
    .description('Record a reviewer output file into the evaluations table')
    .requiredOption('--reviewer <reviewer>', 'Reviewer type: structural, adversarial, methodology')
    .requiredOption('--report <path>', 'Path to the reviewer markdown report', resolveUserPath)
    .requiredOption('--issues <path>', 'Path to the reviewer JSON output (ReviewerOutput schema)', resolveUserPath)
    .action((slug: string, opts: { reviewer: string; report: string; issues: string }) => {
      runEvaluateRecord(slug, opts);
    });

  evaluate
    .command('show <slug>')
    .description('Show evaluation state: reviewers recorded, verdict, report path')
    .option('--json', 'Emit JSON envelope for machine consumers')
    .action((slug: string, opts: { json?: boolean }) => {
      runEvaluateShow(slug, { json: opts.json });
    });

  evaluate
    .command('synthesize <slug>')
    .description('Synthesize reviewer outputs into consensus/majority/single issues and a verdict')
    .action((slug: string) => {
      runEvaluateSynthesize(slug);
    });

  evaluate
    .command('complete <slug>')
    .description('Advance to publish phase (requires pass verdict)')
    .action((slug: string) => {
      runEvaluateComplete(slug);
    });

  evaluate
    .command('reject <slug>')
    .description('Move post back to draft for rework')
    .action((slug: string) => {
      runEvaluateReject(slug);
    });
}
