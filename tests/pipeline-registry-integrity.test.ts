import { describe, it, expect } from 'vitest';

// IMPORTANT: this test imports the REAL pipeline-registry module — no
// vi.mock. The update-runner and cross-flow tests mock PIPELINE_STEPS
// for isolation; this test is the counter-weight ensuring the real
// export stays aligned with the authoritative step-name tuples.
import { PIPELINE_STEPS } from '../src/core/publish/pipeline-registry.js';
import { PUBLISH_STEP_NAMES, UPDATE_STEP_NAMES } from '../src/core/publish/types.js';

describe('PIPELINE_STEPS registry integrity', () => {
  it('exports every PUBLISH_STEP_NAMES entry exactly once', () => {
    const registryNames = PIPELINE_STEPS.map((s) => s.name);
    for (const publishName of PUBLISH_STEP_NAMES) {
      expect(registryNames).toContain(publishName);
    }
  });

  it('exports every UPDATE_STEP_NAMES entry exactly once', () => {
    const registryNames = PIPELINE_STEPS.map((s) => s.name);
    for (const updateName of UPDATE_STEP_NAMES) {
      expect(registryNames).toContain(updateName);
    }
  });

  it('registry names are pairwise unique (no duplicates in the array)', () => {
    const registryNames = PIPELINE_STEPS.map((s) => s.name);
    const deduped = Array.from(new Set(registryNames));
    expect(registryNames.length).toBe(deduped.length);
  });

  it('step numbers cover the 1..11 publish range (update shares slot 3 with site-update)', () => {
    // Initial publish uses step numbers 1..11. Update mode reuses 1..9
    // with `site-update` at slot 3 (replacing `site-pr`). So the registry
    // legitimately has two entries at slot 3 — one per mode — and we
    // assert the covered range rather than strict monotonic uniqueness.
    const numbers = PIPELINE_STEPS.map((s) => s.number);
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    expect(min).toBe(1);
    expect(max).toBe(PUBLISH_STEP_NAMES.length);
    for (let n = 1; n <= PUBLISH_STEP_NAMES.length; n += 1) {
      expect(numbers.includes(n)).toBe(true);
    }
  });

  it('each step name maps to a single consistent step number', () => {
    const nameToNumber = new Map<string, number>();
    for (const step of PIPELINE_STEPS) {
      const existing = nameToNumber.get(step.name);
      if (existing !== undefined) {
        expect(existing).toBe(step.number);
      }
      nameToNumber.set(step.name, step.number);
    }
  });

  it('every registry step has an executable `execute` function', () => {
    for (const step of PIPELINE_STEPS) {
      expect(typeof step.execute).toBe('function');
    }
  });

  it('no registry step name falls outside the union of publish + update tuples', () => {
    // Prevents silent addition of a third step name that neither tuple knows
    // about. New steps must land in BOTH the authoritative tuple AND the
    // registry in the same commit.
    const validNames = new Set<string>([...PUBLISH_STEP_NAMES, ...UPDATE_STEP_NAMES]);
    for (const step of PIPELINE_STEPS) {
      expect(validNames.has(step.name)).toBe(true);
    }
  });

  it('createPipelineSteps seeds DB step_numbers that match tuple positions (per-mode, not registry.number) — Codex Pass 4 Minor #3', async () => {
    // Codex Pass 4 Minor #3 flagged that the earlier tests don't prove
    // each name maps to its correct position. The ACTUAL position
    // invariant lives in the DB — createPipelineSteps iterates through
    // stepNamesForMode(publishMode) and seeds step_number = idx+1 for
    // that mode's tuple. `registry.number` is advisory metadata used
    // only for logging; the runner orders steps via DB step_number,
    // which comes from the tuple, not the registry.
    //
    // This test proves the DB invariant directly: for each mode, every
    // seeded row's step_number equals (tuple_index + 1) for its step_name.
    // A future refactor that swaps numbers would break this immediately.
    const Database = (await import('better-sqlite3')).default;
    const { getDatabase, closeDatabase } = await import('../src/core/db/database.js');
    const { createPipelineSteps } = await import('../src/core/publish/steps-crud.js');
    const { initResearchPost, advancePhase } = await import('../src/core/research/state.js');

    const db = getDatabase(':memory:');
    try {
      const config = {
        site: { repo_path: '/tmp', base_url: 'https://x', content_dir: 'c', research_dir: 'r' },
        author: { name: 'T', github: 't' },
        ai: { primary: 'c', reviewers: { structural: 'c', adversarial: 'c', methodology: 'c' }, codex: { adversarial_effort: 'high', methodology_effort: 'xhigh' } },
        content_types: {
          'project-launch': { benchmark: 'optional', companion_repo: 'existing', social_prefix: 'Show HN:' },
          'technical-deep-dive': { benchmark: 'required', companion_repo: 'new', social_prefix: '' },
          'analysis-opinion': { benchmark: 'skip', companion_repo: 'optional', social_prefix: '' },
        },
        benchmark: { capture_environment: true, methodology_template: true, preserve_raw_data: true, multiple_runs: 3 },
        publish: { devto: true, medium: true, substack: true, github_repos: true, social_drafts: true, research_pages: true },
        social: { platforms: [], timing_recommendations: true },
        evaluation: { require_pass: true, min_sources: 3, max_reading_level: 12, three_reviewer_panel: true, consensus_must_fix: true, majority_should_fix: true, single_advisory: true, verify_benchmark_claims: true, methodology_completeness: true },
        updates: { preserve_original_data: true, update_notice: true, update_crosspost: true, devto_update: true, refresh_paste_files: true, notice_template: 'x', require_summary: true, site_update_mode: 'pr' as const },
        unpublish: { devto: true, medium: true, substack: true, readme: true },
      };

      // INITIAL mode → rows match PUBLISH_STEP_NAMES positions.
      initResearchPost(db, 'init-post', 'topic', 'directed', 'technical-deep-dive');
      advancePhase(db, 'init-post', 'benchmark');
      advancePhase(db, 'init-post', 'draft');
      advancePhase(db, 'init-post', 'evaluate');
      db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run('init-post');
      advancePhase(db, 'init-post', 'publish');
      createPipelineSteps(db, 'init-post', 'technical-deep-dive', config as unknown as Parameters<typeof createPipelineSteps>[3], undefined, 0, 'initial');

      const initialRows = db
        .prepare('SELECT step_name, step_number FROM pipeline_steps WHERE post_slug = ? AND cycle_id = 0 ORDER BY step_number')
        .all('init-post') as Array<{ step_name: string; step_number: number }>;
      for (const row of initialRows) {
        const idx = PUBLISH_STEP_NAMES.indexOf(row.step_name as typeof PUBLISH_STEP_NAMES[number]);
        expect(idx, `step ${row.step_name} should be in PUBLISH_STEP_NAMES`).toBeGreaterThanOrEqual(0);
        expect(row.step_number, `initial step ${row.step_name} has wrong step_number`).toBe(idx + 1);
      }

      // UPDATE mode → rows match UPDATE_STEP_NAMES positions (different tuple).
      advancePhase(db, 'init-post', 'published');
      createPipelineSteps(db, 'init-post', 'technical-deep-dive', config as unknown as Parameters<typeof createPipelineSteps>[3], undefined, 42, 'update');

      const updateRows = db
        .prepare('SELECT step_name, step_number FROM pipeline_steps WHERE post_slug = ? AND cycle_id = ? ORDER BY step_number')
        .all('init-post', 42) as Array<{ step_name: string; step_number: number }>;
      for (const row of updateRows) {
        const idx = UPDATE_STEP_NAMES.indexOf(row.step_name as typeof UPDATE_STEP_NAMES[number]);
        expect(idx, `step ${row.step_name} should be in UPDATE_STEP_NAMES`).toBeGreaterThanOrEqual(0);
        expect(row.step_number, `update step ${row.step_name} has wrong step_number`).toBe(idx + 1);
      }
    } finally {
      closeDatabase(db);
    }
  });
});
