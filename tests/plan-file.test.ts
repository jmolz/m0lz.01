import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyPlan, ApplyError, Receipt, defaultReceiptPath, stepToArgv } from '../src/core/plan-file/apply.js';
import { acquireApplyLock } from '../src/core/plan-file/apply-lock.js';
import { canonicalPlanJSON, computePlanHash } from '../src/core/plan-file/hash.js';
import { PlanFile, PlanStep } from '../src/core/plan-file/schema.js';
import {
  readPlanFile,
  validatePlanForApply,
  validatePlanSchema,
  ValidationError,
} from '../src/core/plan-file/validator.js';

function basePlan(overrides: Partial<PlanFile> = {}): PlanFile {
  const base: PlanFile = {
    schema_version: '2',
    plan_id: '01JH0K000000000000000TEST',
    slug: 'test-post',
    workspace_root: '/tmp/workspace',
    created_at: '2026-04-19T18:00:00Z',
    approved_at: null,
    payload_hash: null,
    intent: 'Launch test post',
    content_type: 'project-launch',
    depth: 'fast-path',
    venues: ['hub', 'devto'],
    expected_start_phase: 'research',
    steps: [
      {
        command: 'blog research finalize',
        args: ['test-post'],
        checkpoint_message: 'Finalize research?',
        preconditions: { phase: 'research' },
      },
    ],
  };
  return { ...base, ...overrides };
}

function approvedPlan(overrides: Partial<PlanFile> = {}): PlanFile {
  const plan = basePlan(overrides);
  plan.approved_at = '2026-04-19T18:05:00Z';
  plan.payload_hash = computePlanHash(plan);
  return plan;
}

describe('canonicalPlanJSON', () => {
  it('is byte-identical regardless of key insertion order', () => {
    const a = basePlan();
    const b: PlanFile = {
      steps: a.steps,
      expected_start_phase: a.expected_start_phase,
      venues: a.venues,
      depth: a.depth,
      content_type: a.content_type,
      intent: a.intent,
      payload_hash: a.payload_hash,
      approved_at: a.approved_at,
      created_at: a.created_at,
      workspace_root: a.workspace_root,
      slug: a.slug,
      plan_id: a.plan_id,
      schema_version: a.schema_version,
    };
    expect(canonicalPlanJSON(a)).toBe(canonicalPlanJSON(b));
  });

  it('ignores approved_at and payload_hash', () => {
    const unapproved = basePlan();
    const approved = approvedPlan();
    expect(canonicalPlanJSON(unapproved)).toBe(canonicalPlanJSON(approved));
  });

  it('changes when any step field changes', () => {
    const a = basePlan();
    const b = basePlan({ steps: [{ command: 'blog research finalize', args: ['other-slug'] }] });
    expect(canonicalPlanJSON(a)).not.toBe(canonicalPlanJSON(b));
  });
});

describe('computePlanHash', () => {
  it('is deterministic', () => {
    const plan = basePlan();
    expect(computePlanHash(plan)).toBe(computePlanHash(plan));
  });

  it('produces different hashes for different step content', () => {
    const a = basePlan();
    const b = basePlan({ steps: [{ command: 'blog research finalize', args: ['different'] }] });
    expect(computePlanHash(a)).not.toBe(computePlanHash(b));
  });

  it('is identical before and after setting approved_at + payload_hash', () => {
    const unapproved = basePlan();
    const approved = approvedPlan();
    expect(computePlanHash(unapproved)).toBe(computePlanHash(approved));
  });
});

describe('validatePlanSchema', () => {
  it('accepts a well-formed plan', () => {
    const plan = basePlan();
    const out = validatePlanSchema(JSON.parse(JSON.stringify(plan)));
    expect(out.slug).toBe('test-post');
  });

  it('rejects non-object input', () => {
    expect(() => validatePlanSchema('not an object')).toThrow(ValidationError);
  });

  it('rejects wrong schema_version', () => {
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.schema_version = '1';
    expect(() => validatePlanSchema(plan)).toThrow(/schema_version/);
  });

  it('rejects unknown content_type', () => {
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.content_type = 'park-research';
    try {
      validatePlanSchema(plan);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ValidationError).code).toBe('SCHEMA_INVALID');
      expect((e as Error).message).toContain('content_type');
    }
  });

  it('rejects unknown depth', () => {
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.depth = 'speedrun';
    expect(() => validatePlanSchema(plan)).toThrow(/depth/);
  });

  it('accepts depth=park', () => {
    const plan = basePlan({ depth: 'park' });
    expect(() => validatePlanSchema(JSON.parse(JSON.stringify(plan)))).not.toThrow();
  });

  it('rejects steps with abstract command (run-panel, init-and-draft)', () => {
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.steps = [{ command: 'blog run-panel', args: [] }];
    expect(() => validatePlanSchema(plan)).toThrow(/unknown subcommand/);
  });

  it('rejects flag-like tokens embedded inside the command field (must live in args)', () => {
    // Codex adversarial review, plus Claude C3: pre-fix the validator only
    // checked the first token after "blog ". A step with `command: "blog status --unsafe"`
    // passed validation because firstWord === "status". The `--unsafe` token
    // then slipped into argv unchecked. Now any flag-like token in `command`
    // is rejected so flags must live in `args` where the hash binds them.
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.steps = [{ command: 'blog status --smuggled-flag', args: [] }];
    try {
      validatePlanSchema(plan);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ValidationError).code).toBe('SCHEMA_INVALID');
      expect((e as Error).message).toMatch(/flag-like tokens/);
    }

    // Short-form flag too.
    const plan2 = basePlan() as unknown as Record<string, unknown>;
    plan2.steps = [{ command: 'blog status -x', args: [] }];
    expect(() => validatePlanSchema(plan2)).toThrow(/flag-like tokens/);
  });

  it('rejects steps that invoke `blog agent` (nested-plan delegation)', () => {
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.steps = [{ command: 'blog agent apply', args: ['other-plan.json'] }];
    try {
      validatePlanSchema(plan);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ValidationError).code).toBe('SCHEMA_INVALID');
      expect((e as Error).message).toMatch(/disallowed subcommand "agent"/);
    }
  });

  it('rejects all blog agent subcommands in plan steps (preflight, plan, approve, verify, apply)', () => {
    for (const sub of ['preflight', 'plan', 'approve', 'verify', 'apply']) {
      const plan = basePlan() as unknown as Record<string, unknown>;
      plan.steps = [{ command: `blog agent ${sub}`, args: [] }];
      expect(() => validatePlanSchema(plan)).toThrow(/disallowed subcommand "agent"/);
    }
  });

  it('rejects --workspace smuggled in args (CLI startup shim would hoist it, bypassing plan.workspace_root)', () => {
    // Closes the Codex High-severity finding: the CLI startup shim parses
    // --workspace from ANY position in argv BEFORE Commander dispatches. A
    // plan step that allowed `args: ["--workspace", "/tmp/attacker"]` would
    // execute an approved step in a different workspace than the plan's
    // hash binds to — breaking the whole approval-gate property.
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.steps = [{ command: 'blog status', args: ['--workspace', '/tmp/attacker'] }];
    try {
      validatePlanSchema(plan);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ValidationError).code).toBe('SCHEMA_INVALID');
      expect((e as Error).message).toMatch(/banned global flag/);
      expect((e as Error).message).toMatch(/--workspace/);
    }

    // `--workspace=/tmp/x` compact form also rejected.
    const plan2 = basePlan() as unknown as Record<string, unknown>;
    plan2.steps = [{ command: 'blog status', args: ['--workspace=/tmp/attacker'] }];
    expect(() => validatePlanSchema(plan2)).toThrow(/banned global flag/);
  });

  it('rejects --help / --version / -h / -V in args (they short-circuit subcommand dispatch)', () => {
    for (const flag of ['--help', '-h', '--version', '-V']) {
      const plan = basePlan() as unknown as Record<string, unknown>;
      plan.steps = [{ command: 'blog status', args: [flag] }];
      expect(() => validatePlanSchema(plan)).toThrow(/banned global flag/);
    }
  });

  it('rejects slug-bearing steps whose args[0] != plan.slug (plan cannot target a different post than its metadata)', () => {
    // Codex Pass-3 High: SLUG_BEARING_STEP_COMMANDS models every `blog X Y
    // <slug>` command. A plan with `slug: alpha` but a step `command:
    // "blog research finalize", args: ["beta"]` would mutate post beta
    // while the apply lock + agent_plan_runs.slug record "alpha" — the
    // slug-scoped audit trail would lie.
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.steps = [
      {
        command: 'blog research finalize',
        args: ['different-post'], // plan.slug is 'test-post'
      },
    ];
    try {
      validatePlanSchema(plan);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ValidationError).code).toBe('SCHEMA_INVALID');
      expect((e as Error).message).toMatch(/must equal plan\.slug/);
    }

    // Slug-bearing step with MISSING args[0] also rejected.
    const plan2 = basePlan() as unknown as Record<string, unknown>;
    plan2.steps = [{ command: 'blog publish start', args: [] }];
    expect(() => validatePlanSchema(plan2)).toThrow(/must equal plan\.slug/);

    // Non-slug-bearing command (e.g., `blog status`) is unaffected.
    const plan3 = basePlan() as unknown as Record<string, unknown>;
    plan3.steps = [{ command: 'blog status', args: [] }];
    expect(() => validatePlanSchema(plan3)).not.toThrow();
  });

  it('rejects commands with >2 positional words (smuggled positional via command field)', () => {
    // Related to Codex Pass-3 High: the attacker could also try
    //   { command: "blog research finalize pwned-slug", args: [] }
    // with three words after "blog", bypassing the
    // SLUG_BEARING_STEP_COMMANDS match. The Pass-4 canonical-leaf allowlist
    // closes this by requiring command to be in KNOWN_LEAF_COMMANDS.
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.steps = [{ command: 'blog research finalize pwned-slug', args: [] }];
    try {
      validatePlanSchema(plan);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ValidationError).code).toBe('SCHEMA_INVALID');
      expect((e as Error).message).toMatch(/not a known leaf command/);
    }
  });

  it('rejects whitespace-variant commands that stepToArgv would normalize (Codex P4 High)', () => {
    // Pre-Pass-4, `{ command: "blog  research  finalize" }` (double-space)
    // passed the `.includes(SLUG_BEARING_STEP_COMMANDS)` lookup because the
    // allowlist entries are single-space canonical, but `stepToArgv`
    // normalized via `split(/\s+/)` → argv ["research","finalize", ...].
    // A plan for slug=alpha could thus execute blog research finalize beta.
    const variants = [
      'blog  research  finalize',          // double-space
      'blog research  finalize',           // double-space internal
      'blog research finalize ',           // trailing space
      'blog\tresearch\tfinalize',          // tabs
      'blog research\nfinalize',           // newline
      ' blog research finalize',           // leading space
    ];
    for (const badCommand of variants) {
      const plan = basePlan() as unknown as Record<string, unknown>;
      plan.steps = [{ command: badCommand, args: ['test-post'] }];
      try {
        validatePlanSchema(plan);
        throw new Error(`should have rejected ${JSON.stringify(badCommand)}`);
      } catch (e) {
        expect((e as ValidationError).code).toBe('SCHEMA_INVALID');
      }
    }
  });

  it('rejects workspace-global mutators (blog init, blog ideas add/start/remove) as plan steps (Codex P5 High)', () => {
    // Pre-Pass-5 the leaf allowlist included `blog init` and the `blog
    // ideas add/start/remove` family. Their effect is workspace-global —
    // `blog ideas start 1` resolves the CURRENT backlog entry by integer
    // INDEX (not by topic/slug), so backlog edits between plan approval
    // and plan apply change which idea the approved plan consumes. The
    // hash binds to the index, not the target topic. That undermines
    // slug-scoped safety; these commands are operator-only at the CLI.
    const workspaceGlobalMutators = [
      { command: 'blog init', args: [] },
      { command: 'blog ideas add', args: ['new topic'] },
      { command: 'blog ideas start', args: ['1'] },
      { command: 'blog ideas remove', args: ['1'] },
    ];
    for (const step of workspaceGlobalMutators) {
      const plan = basePlan() as unknown as Record<string, unknown>;
      plan.steps = [step];
      try {
        validatePlanSchema(plan);
        throw new Error(`should have rejected ${JSON.stringify(step.command)}`);
      } catch (e) {
        expect((e as ValidationError).code).toBe('SCHEMA_INVALID');
        expect((e as Error).message).toMatch(/not a known leaf command/);
      }
    }
  });

  it('accepts safe read-only true-leaf commands (blog status, blog metrics)', () => {
    // Only TRUE LEAVES without Commander subcommands under them are safe.
    // `blog ideas` was removed in Pass-6 because it has add/start/remove
    // children, so args smuggling (`args: ["start", "1"]`) could still
    // dispatch to the mutating subcommand via Commander's default-action.
    const safeReads = [
      { command: 'blog status', args: [] },
      { command: 'blog metrics', args: [] },
      { command: 'blog status', args: ['--json'] }, // flags are fine
    ];
    for (const step of safeReads) {
      const plan = basePlan() as unknown as Record<string, unknown>;
      plan.steps = [step];
      expect(() => validatePlanSchema(plan)).not.toThrow();
    }
  });

  it('rejects blog ideas as a plan step — it has Commander subcommands (Codex P6 High args-smuggling)', () => {
    // Pre-Pass-6, `blog ideas` was in KNOWN_LEAF_COMMANDS as a "safe
    // read-only list". But Commander's default-action pattern meant
    // `{command: "blog ideas", args: ["start", "1"]}` dispatched to the
    // MUTATING start subcommand — inserting a post derived from the
    // current backlog index, outside plan.slug's audit trail.
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.steps = [{ command: 'blog ideas', args: [] }];
    expect(() => validatePlanSchema(plan)).toThrow(/not a known leaf command/);

    // The args-smuggling variant must also fail.
    const plan2 = basePlan() as unknown as Record<string, unknown>;
    plan2.steps = [{ command: 'blog ideas', args: ['start', '1'] }];
    expect(() => validatePlanSchema(plan2)).toThrow(/not a known leaf command/);
  });

  it('rejects namespace-only commands that smuggle the subcommand via args (Codex P4 High)', () => {
    // Pre-Pass-4, `{ command: "blog research", args: ["finalize", "beta"] }`
    // passed — `research` was a known subcommand, commandWords.length was 1.
    // stepToArgv then concatenated commandWords + args and spawned
    // `blog research finalize beta`. The KNOWN_LEAF_COMMANDS allowlist
    // rejects `blog research` (namespace, not leaf).
    const attacks = [
      { command: 'blog research', args: ['finalize', 'attacker-slug'] },
      { command: 'blog publish', args: ['start', 'attacker-slug'] },
      { command: 'blog update', args: ['publish', 'attacker-slug'] },
      { command: 'blog draft', args: ['init', 'attacker-slug'] },
    ];
    for (const step of attacks) {
      const plan = basePlan() as unknown as Record<string, unknown>;
      plan.steps = [step];
      try {
        validatePlanSchema(plan);
        throw new Error(`should have rejected namespace-only command`);
      } catch (e) {
        expect((e as ValidationError).code).toBe('SCHEMA_INVALID');
        expect((e as Error).message).toMatch(/not a known leaf command/);
      }
    }
  });

  it('rejects traversal slugs at the shared-schema layer — not just at CLI boundary', () => {
    // Codex Pass-2 Critical: the CLI clamp + validateSlug() protected
    // `agent plan`-generated plans, but a hand-authored plan with
    // `slug: "../../outside"` would sail through verify/approve/apply and
    // reach defaultReceiptPath / defaultLockPath, which interpolate the
    // raw slug into paths. Validating slug here closes that loop.
    const attacks = [
      '../../outside',
      '..',
      'slug/with/slash',
      'SLUG-WITH-UPPERCASE',
      'slug with space',
      '',
    ];
    for (const badSlug of attacks) {
      const plan = basePlan() as unknown as Record<string, unknown>;
      plan.slug = badSlug;
      try {
        validatePlanSchema(plan);
        throw new Error(`should have rejected slug ${JSON.stringify(badSlug)}`);
      } catch (e) {
        expect((e as ValidationError).code).toBe('SCHEMA_INVALID');
      }
    }
  });

  it('rejects command missing "blog " prefix', () => {
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.steps = [{ command: 'research finalize', args: [] }];
    expect(() => validatePlanSchema(plan)).toThrow(/must start with "blog "/);
  });

  it('rejects step without args array', () => {
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.steps = [{ command: 'blog research finalize' }];
    expect(() => validatePlanSchema(plan)).toThrow(/args/);
  });

  it('rejects empty steps array', () => {
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.steps = [];
    expect(() => validatePlanSchema(plan)).toThrow(/non-empty/);
  });

  it('rejects empty venues array', () => {
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.venues = [];
    expect(() => validatePlanSchema(plan)).toThrow(/venues/);
  });
});

describe('validatePlanForApply', () => {
  it('passes a well-formed approved plan', () => {
    const plan = approvedPlan();
    const out = validatePlanForApply(JSON.parse(JSON.stringify(plan)), {
      workspaceRoot: plan.workspace_root,
    });
    expect(out.slug).toBe('test-post');
  });

  it('throws NO_APPROVAL when approved_at is null', () => {
    const plan = basePlan();
    try {
      validatePlanForApply(JSON.parse(JSON.stringify(plan)), {
        workspaceRoot: plan.workspace_root,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ValidationError).code).toBe('NO_APPROVAL');
    }
  });

  it('throws HASH_MISMATCH when steps are tampered after approval', () => {
    const plan = approvedPlan();
    const tampered = JSON.parse(JSON.stringify(plan)) as PlanFile;
    // Mutate a schema-valid-but-hash-covered field. Using `args[0]` here
    // would trip the slug-binding SCHEMA_INVALID check before reaching
    // HASH_MISMATCH; checkpoint_message mutation is accepted by the
    // schema so the hash mismatch is the only violation.
    tampered.steps[0].checkpoint_message = 'tampered-after-approval';
    try {
      validatePlanForApply(tampered, { workspaceRoot: plan.workspace_root });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ValidationError).code).toBe('HASH_MISMATCH');
    }
  });

  it('throws WORKSPACE_MISMATCH when workspace_root differs', () => {
    const plan = approvedPlan();
    try {
      validatePlanForApply(JSON.parse(JSON.stringify(plan)), {
        workspaceRoot: '/different/workspace',
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ValidationError).code).toBe('WORKSPACE_MISMATCH');
    }
  });

  it('throws NO_APPROVAL when approved_at is set but payload_hash is null', () => {
    const plan = basePlan();
    plan.approved_at = '2026-04-19T18:05:00Z';
    plan.payload_hash = null;
    try {
      validatePlanForApply(JSON.parse(JSON.stringify(plan)), {
        workspaceRoot: plan.workspace_root,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ValidationError).code).toBe('NO_APPROVAL');
    }
  });
});

// A fake `blog` binary for apply tests: a tiny node script that exits 0
// for "ok" arg lists and non-zero for anything containing "fail". Writes the
// argv to a marker file so tests can assert call order + cwd handling.
function makeFakeBlogBin(markerDir: string): { cmd: string; prefixArgs: string[] } {
  const script = resolve(markerDir, 'fake-blog.mjs');
  writeFileSync(
    script,
    `
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Post-Pass-6, applyPlan prepends '--workspace <plan.workspace_root>'. Mirror
// the real CLI startup shim's behavior: consume the --workspace flag+operand
// out of argv before echoing. Both forms supported.
const rawArgs = process.argv.slice(2);
const args = [];
for (let i = 0; i < rawArgs.length; i++) {
  const t = rawArgs[i];
  if (t === '--workspace') { i += 1; continue; }
  if (t.startsWith('--workspace=')) continue;
  args.push(t);
}
const markerPath = resolve(${JSON.stringify(markerDir)}, 'marker.log');
appendFileSync(markerPath, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args.includes('fail')) {
  process.stderr.write('intentional failure\\n');
  process.exit(42);
}
process.stdout.write('ok ' + args.join(' ') + '\\n');
process.exit(0);
`,
  );
  return { cmd: process.execPath, prefixArgs: [script] };
}

describe('stepToArgv', () => {
  it('strips leading "blog" and concatenates command words with args', () => {
    const step: PlanStep = { command: 'blog research finalize', args: ['test-slug'] };
    expect(stepToArgv(step)).toEqual(['research', 'finalize', 'test-slug']);
  });

  it('handles single-word commands like "blog status"', () => {
    expect(stepToArgv({ command: 'blog status', args: [] })).toEqual(['status']);
  });

  it('throws UNKNOWN_COMMAND when command omits blog prefix', () => {
    expect(() => stepToArgv({ command: 'rm -rf /', args: [] })).toThrow(ApplyError);
  });
});

describe('applyPlan', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'm0lz-apply-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function buildPlan(steps: PlanStep[]): PlanFile {
    const plan: PlanFile = {
      schema_version: '2',
      plan_id: '01JH0K000000000000000TEST',
      slug: 'apply-test',
      workspace_root: tmp,
      created_at: '2026-04-19T18:00:00Z',
      approved_at: '2026-04-19T18:05:00Z',
      payload_hash: '',
      intent: 'test',
      content_type: 'project-launch',
      depth: 'fast-path',
      venues: ['hub'],
      expected_start_phase: 'research',
      steps,
    };
    plan.payload_hash = computePlanHash(plan);
    return plan;
  }

  it('runs every step and writes a receipt on success', () => {
    const plan = buildPlan([
      { command: 'blog status', args: [] },
      { command: 'blog research finalize', args: ['apply-test'] },
    ]);
    const bin = makeFakeBlogBin(tmp);
    const receiptPath = resolve(tmp, 'receipt.json');
    const result = applyPlan(plan, { binOverride: bin, receiptPath });
    expect(result.overall_exit).toBe(0);
    expect(result.receipt.steps.length).toBe(2);
    expect(result.receipt.steps.every((s) => s.status === 'completed')).toBe(true);
    const fromDisk = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
    expect(fromDisk.plan_id).toBe(plan.plan_id);
    expect(fromDisk.completed_at).not.toBeNull();
  });

  it('writes a partial receipt and throws STEP_FAILED on non-zero exit', () => {
    const plan = buildPlan([
      { command: 'blog status', args: [] },
      { command: 'blog status', args: ['fail'] },
      { command: 'blog status', args: ['never-reached'] },
    ]);
    const bin = makeFakeBlogBin(tmp);
    const receiptPath = resolve(tmp, 'receipt.json');
    try {
      applyPlan(plan, { binOverride: bin, receiptPath });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ApplyError).code).toBe('STEP_FAILED');
    }
    const fromDisk = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
    expect(fromDisk.completed_at).toBeNull();
    expect(fromDisk.overall_exit).toBe(42);
    expect(fromDisk.steps.length).toBe(2); // third never ran
    expect(fromDisk.steps[0].status).toBe('completed');
    expect(fromDisk.steps[1].status).toBe('failed');
    expect(fromDisk.steps[1].stderr_tail).toContain('intentional failure');
  });

  it('resumes from existing receipt by default — skips completed steps', () => {
    const plan = buildPlan([
      { command: 'blog status', args: ['one'] },
      { command: 'blog status', args: ['two'] },
    ]);
    const bin = makeFakeBlogBin(tmp);
    const receiptPath = resolve(tmp, 'receipt.json');

    // Run once — both succeed.
    const first = applyPlan(plan, { binOverride: bin, receiptPath });
    expect(first.overall_exit).toBe(0);

    // Clear the marker file to prove steps didn't re-run.
    const markerPath = resolve(tmp, 'marker.log');
    writeFileSync(markerPath, '');

    // Re-invoke — should skip both completed steps.
    applyPlan(plan, { binOverride: bin, receiptPath });
    const markerContents = readFileSync(markerPath, 'utf8');
    expect(markerContents).toBe(''); // no step re-ran
  });

  it('--restart re-executes every step', () => {
    const plan = buildPlan([{ command: 'blog status', args: ['only'] }]);
    const bin = makeFakeBlogBin(tmp);
    const receiptPath = resolve(tmp, 'receipt.json');

    applyPlan(plan, { binOverride: bin, receiptPath });
    const markerPath = resolve(tmp, 'marker.log');
    const firstMarker = readFileSync(markerPath, 'utf8');
    expect(firstMarker.split('\n').filter(Boolean).length).toBe(1);

    applyPlan(plan, { binOverride: bin, receiptPath, restart: true });
    const secondMarker = readFileSync(markerPath, 'utf8');
    expect(secondMarker.split('\n').filter(Boolean).length).toBe(2);
  });

  it('--restart clears stale open runs from OTHER plan_ids, not just the current one', () => {
    // Codex Pass-2 High: the previous --restart only cleared the current
    // plan_id's row, so a crashed plan A + --restart on plan B left plan
    // A's open row in the DB. Plan C would then hit RECEIPT_CONFLICT
    // permanently. Fix: --restart deletes every open run for the slug.
    const planA = buildPlan([
      { command: 'blog status', args: ['a-one'] },
      { command: 'blog status', args: ['fail'] }, // leaves A's run open
    ]);
    const planB = buildPlan([{ command: 'blog status', args: ['b'] }]);
    planB.plan_id = '01JH0K999999999999999TEST';
    planB.payload_hash = computePlanHash(planB);
    const planC = buildPlan([{ command: 'blog status', args: ['c'] }]);
    planC.plan_id = '01JH0KAAAAAAAAAAAAAA-TEST';
    planC.payload_hash = computePlanHash(planC);

    const bin = makeFakeBlogBin(tmp);

    // A crashes mid-apply → open row in agent_plan_runs.
    try {
      applyPlan(planA, { binOverride: bin, receiptPath: resolve(tmp, 'a.r.json') });
    } catch (e) {
      expect((e as ApplyError).code).toBe('STEP_FAILED');
    }

    // B recovers via --restart. Should clear A's row too.
    const resultB = applyPlan(planB, {
      binOverride: bin,
      receiptPath: resolve(tmp, 'b.r.json'),
      restart: true,
    });
    expect(resultB.overall_exit).toBe(0);

    // C (normal, no --restart) must now succeed — no stale open row survived.
    const resultC = applyPlan(planC, {
      binOverride: bin,
      receiptPath: resolve(tmp, 'c.r.json'),
    });
    expect(resultC.overall_exit).toBe(0);
  });

  it('throws CRASH_RECOVERY_REQUIRED when an attempt sentinel exists without a completed DB row (Codex P7 High)', () => {
    // Simulate a parent crash: write an attempt sentinel for step 2, then
    // call applyPlan. Pre-fix the runner would silently re-run step 2
    // which is unsafe for non-idempotent commands. Post-fix it throws
    // CRASH_RECOVERY_REQUIRED until the operator uses --restart.
    const plan = buildPlan([
      { command: 'blog status', args: ['one'] },
      { command: 'blog status', args: ['two'] },
    ]);
    const bin = makeFakeBlogBin(tmp);
    const receiptPath = resolve(tmp, 'receipt.json');

    // First run: applies both steps fully.
    const first = applyPlan(plan, { binOverride: bin, receiptPath });
    expect(first.overall_exit).toBe(0);

    // Forge the crash condition: ensure completed rows for step 1 but
    // not step 2, and plant a sentinel for step 2. This mimics "parent
    // died between child exit and recordStep".
    const db = new (require('better-sqlite3') as typeof import('better-sqlite3'))(
      resolve(plan.workspace_root, '.blog-agent/state.db'),
    );
    try {
      db.prepare('DELETE FROM agent_plan_steps WHERE plan_id = ? AND step_number = 2').run(
        plan.plan_id,
      );
    } finally {
      db.close();
    }
    const sentinelPath = resolve(
      plan.workspace_root,
      '.blog-agent/plans',
      `.${plan.plan_id}.attempt-2`,
    );
    mkdirSync(dirname(sentinelPath), { recursive: true });
    writeFileSync(sentinelPath, new Date().toISOString());

    // Resume without --restart should refuse.
    try {
      applyPlan(plan, { binOverride: bin, receiptPath });
      throw new Error('should have thrown CRASH_RECOVERY_REQUIRED');
    } catch (e) {
      expect((e as ApplyError).code).toBe('CRASH_RECOVERY_REQUIRED');
      expect((e as Error).message).toMatch(/attempt sentinel/);
    }

    // --restart clears sentinels + stale open rows and succeeds.
    const recovered = applyPlan(plan, {
      binOverride: bin,
      receiptPath,
      restart: true,
    });
    expect(recovered.overall_exit).toBe(0);
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it('throws RECEIPT_CONFLICT when an open run for the same slug has a different plan_id (DB-authoritative, not file-based)', () => {
    // The old implementation keyed this conflict on a prior receipt FILE; a
    // hand-edited receipt could therefore either force a spurious conflict
    // (DoS) or hide a real one. DB authority means the check queries
    // agent_plan_runs for incomplete runs with matching slug — the receipt
    // JSON is ignored (Codex adversarial review, Medium).
    const planA = buildPlan([
      { command: 'blog status', args: ['a-one'] },
      { command: 'blog status', args: ['fail'] }, // step 2 of A fails → run stays open
    ]);
    const planB = buildPlan([{ command: 'blog status', args: ['b'] }]);
    planB.plan_id = '01JH0K999999999999999TEST';
    planB.payload_hash = computePlanHash(planB);

    const bin = makeFakeBlogBin(tmp);
    // Apply planA; step 2 fails → run row exists with completed_at IS NULL.
    try {
      applyPlan(planA, { binOverride: bin, receiptPath: resolve(tmp, 'a.receipt.json') });
    } catch (e) {
      expect((e as ApplyError).code).toBe('STEP_FAILED');
    }

    // Now apply planB: same slug, different plan_id — DB has an open run for
    // this slug under planA's id, so conflict triggers.
    try {
      applyPlan(planB, { binOverride: bin, receiptPath: resolve(tmp, 'b.receipt.json') });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ApplyError).code).toBe('RECEIPT_CONFLICT');
      expect((e as Error).message).toMatch(/agent_plan_runs/);
    }
  });

  it('RECEIPT_CONFLICT cannot be forced by a forged receipt — DB is authoritative', () => {
    // Forge a receipt file claiming a different plan_id owns the slug. Under
    // the old file-based check this would force RECEIPT_CONFLICT on the next
    // apply. Under DB authority the forged file is ignored and the apply
    // proceeds.
    const plan = buildPlan([{ command: 'blog status', args: ['first'] }]);
    const receiptPath = resolve(tmp, `${plan.slug}.receipt.json`);
    const forged: Receipt = {
      plan_id: '01JHFORGED-DIFFERENT-PLAN-ID',
      plan_payload_hash: '0'.repeat(64),
      slug: plan.slug,
      workspace_root: plan.workspace_root,
      applied_at: new Date().toISOString(),
      completed_at: null,
      overall_exit: 0,
      steps: [],
    };
    writeFileSync(receiptPath, JSON.stringify(forged, null, 2));

    const bin = makeFakeBlogBin(tmp);
    // Should succeed — the forged receipt is not consulted.
    const result = applyPlan(plan, { binOverride: bin, receiptPath });
    expect(result.overall_exit).toBe(0);
    const refreshed = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
    // Receipt was regenerated from the DB; the forged plan_id is gone.
    expect(refreshed.plan_id).toBe(plan.plan_id);
    expect(refreshed.plan_payload_hash).toBe(plan.payload_hash);
  });

  it('receipt records plan_payload_hash on write (mirror of DB authoritative value)', () => {
    const plan = buildPlan([{ command: 'blog status', args: ['hash-bind'] }]);
    const bin = makeFakeBlogBin(tmp);
    const receiptPath = resolve(tmp, 'receipt.json');
    const result = applyPlan(plan, { binOverride: bin, receiptPath });
    expect(result.receipt.plan_payload_hash).toBe(plan.payload_hash);
    const fromDisk = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
    expect(fromDisk.plan_payload_hash).toBe(plan.payload_hash);
  });

  it('tampering the receipt JSON is a no-op — DB remains authoritative (forged-skip vector closed)', () => {
    // This was the Phase-8 Codex adversarial finding (High #1). Pre-DB-authority,
    // a forged receipt with `status: "completed"` for future steps could suppress
    // their execution. Post-v4, the DB is the trust surface; the receipt is
    // audit output and tampering is harmless.
    const plan = buildPlan([
      { command: 'blog status', args: ['one'] },
      { command: 'blog status', args: ['two'] },
    ]);
    const bin = makeFakeBlogBin(tmp);
    const receiptPath = resolve(tmp, 'receipt.json');

    // Run step 1 only by pretending step 2 doesn't exist.
    const truncated = { ...plan, steps: [plan.steps[0]] };
    truncated.payload_hash = computePlanHash(truncated);
    applyPlan(truncated, { binOverride: bin, receiptPath });

    // Forge a receipt claiming both steps are completed for the FULL plan's id.
    const forged: Receipt = {
      plan_id: plan.plan_id,
      plan_payload_hash: plan.payload_hash,
      slug: plan.slug,
      workspace_root: plan.workspace_root,
      applied_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      overall_exit: 0,
      steps: [
        {
          step_number: 1,
          command: 'blog status',
          args: ['one'],
          status: 'completed',
          exit_code: 0,
          stdout_tail: 'forged',
          stderr_tail: '',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: 0,
        },
        {
          step_number: 2,
          command: 'blog status',
          args: ['two'],
          status: 'completed',
          exit_code: 0,
          stdout_tail: 'forged',
          stderr_tail: '',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: 0,
        },
      ],
    };
    writeFileSync(receiptPath, JSON.stringify(forged, null, 2));

    // Clear the marker so we can observe which steps actually ran this time.
    const markerPath = resolve(tmp, 'marker.log');
    writeFileSync(markerPath, '');

    // Apply the FULL plan. The forged "step 2 completed" row must NOT fool
    // the runner — the DB knows only step 1 ran under `truncated`, so we
    // get RECEIPT_HASH_MISMATCH (truncated.payload_hash != plan.payload_hash
    // at the same plan_id). This is the correct refusal: --restart is the
    // escape hatch.
    try {
      applyPlan(plan, { binOverride: bin, receiptPath });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ApplyError).code).toBe('RECEIPT_HASH_MISMATCH');
    }

    // With --restart the forged receipt is discarded, the DB wiped, and
    // BOTH steps run fresh — proving the receipt was never trusted.
    applyPlan(plan, { binOverride: bin, receiptPath, restart: true });
    const markerAfter = readFileSync(markerPath, 'utf8');
    const lines = markerAfter.split('\n').filter(Boolean);
    expect(lines.length).toBe(2); // both steps re-ran
  });

  it('throws RECEIPT_HASH_MISMATCH when the same plan_id is re-applied with different content', () => {
    // The only legitimate path to RECEIPT_HASH_MISMATCH under DB authority:
    // plan content changed and was re-approved, producing a new hash at the
    // same plan_id. The DB's stored hash no longer matches.
    const planV1 = buildPlan([{ command: 'blog status', args: ['v1'] }]);
    const bin = makeFakeBlogBin(tmp);
    const receiptPath = resolve(tmp, 'receipt.json');
    applyPlan(planV1, { binOverride: bin, receiptPath });

    const planV2 = buildPlan([{ command: 'blog status', args: ['v2-different-arg'] }]);
    // Force same plan_id (builder uses a fixed id) with different content →
    // different payload_hash.
    expect(planV2.plan_id).toBe(planV1.plan_id);
    expect(planV2.payload_hash).not.toBe(planV1.payload_hash);

    try {
      applyPlan(planV2, { binOverride: bin, receiptPath });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ApplyError).code).toBe('RECEIPT_HASH_MISMATCH');
      expect((e as Error).message).toMatch(/re-approved with different content/);
    }
  });

  it('--restart clears both RECEIPT_CONFLICT and a re-approval RECEIPT_HASH_MISMATCH', () => {
    const planV1 = buildPlan([{ command: 'blog status', args: ['v1'] }]);
    const bin = makeFakeBlogBin(tmp);
    const receiptPath = resolve(tmp, 'receipt.json');
    applyPlan(planV1, { binOverride: bin, receiptPath });

    const planV2 = buildPlan([{ command: 'blog status', args: ['v2'] }]);
    // Without --restart it throws RECEIPT_HASH_MISMATCH (same plan_id, new hash).
    expect(() => applyPlan(planV2, { binOverride: bin, receiptPath })).toThrow(ApplyError);

    // With --restart it succeeds and rewrites DB + receipt.
    const result = applyPlan(planV2, { binOverride: bin, receiptPath, restart: true });
    expect(result.overall_exit).toBe(0);
    expect(result.receipt.plan_payload_hash).toBe(planV2.payload_hash);
  });

  it('defaultReceiptPath resolves to .blog-agent/plans/<slug>.receipt.json', () => {
    expect(defaultReceiptPath('/ws', 'foo')).toBe('/ws/.blog-agent/plans/foo.receipt.json');
  });

  it('captures stdout + stderr tails per step', () => {
    const plan = buildPlan([{ command: 'blog status', args: ['hello'] }]);
    const bin = makeFakeBlogBin(tmp);
    const receiptPath = resolve(tmp, 'receipt.json');
    const result = applyPlan(plan, { binOverride: bin, receiptPath });
    expect(result.receipt.steps[0].stdout_tail).toContain('ok status hello');
    expect(result.receipt.steps[0].stderr_tail).toBe('');
    expect(result.receipt.steps[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('spawns each step with cwd = plan.workspace_root', () => {
    const plan = buildPlan([{ command: 'blog status', args: ['cwd-check'] }]);
    const bin = makeFakeBlogBin(tmp);
    const receiptPath = resolve(tmp, 'receipt.json');
    applyPlan(plan, { binOverride: bin, receiptPath });
    const marker = readFileSync(resolve(tmp, 'marker.log'), 'utf8').trim();
    const parsed = JSON.parse(marker) as { cwd: string };
    // macOS prefixes tmpdir paths with /private; realpath-normalize both sides.
    const { realpathSync } = require('node:fs') as typeof import('node:fs');
    expect(realpathSync(parsed.cwd)).toBe(realpathSync(tmp));
  });
});

describe('acquireApplyLock', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'm0lz-lock-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('second acquirer times out while first holder is alive (lock serializes concurrent applies)', () => {
    const lockPath = resolve(tmp, '.plan.apply.lock');
    const release1 = acquireApplyLock(lockPath, 200);
    try {
      expect(() => acquireApplyLock(lockPath, 200)).toThrow(/Could not acquire apply lock/);
    } finally {
      release1();
    }
  });

  it('second acquirer succeeds after first releases', () => {
    const lockPath = resolve(tmp, '.plan.apply.lock');
    const release1 = acquireApplyLock(lockPath, 200);
    release1();
    const release2 = acquireApplyLock(lockPath, 200);
    expect(typeof release2).toBe('function');
    release2();
  });

  it('reclaims a corrupt (empty-PID) stale lockfile instead of hanging until timeout', () => {
    const lockPath = resolve(tmp, '.plan.apply.lock');
    writeFileSync(lockPath, ''); // zero-length — can happen if a prior writer crashed between create + write
    // Should NOT spin to the deadline; should reclaim and return quickly.
    const t0 = Date.now();
    const release = acquireApplyLock(lockPath, 500);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(300);
    release();
  });

  it('reclaims a legacy bare-PID-format stale lockfile', () => {
    // Pre-v0.2 the lock format was a bare PID. The v0.2 stamp is JSON with
    // pid + acquiredAt, but we tolerate the legacy shape so a lock written
    // by an older version still honors liveness checks.
    const lockPath = resolve(tmp, '.plan.apply.lock');
    writeFileSync(lockPath, '1'); // PID 1 exists on every POSIX system → treated as alive
    // Without liveness tolerance this would reclaim immediately. With PID 1
    // we spin to the deadline and throw.
    expect(() => acquireApplyLock(lockPath, 150)).toThrow(/Could not acquire/);
  });

  it('live PID holds the lock until release — even across reacquire attempts (PID-liveness policy)', () => {
    // Codex Pass-2 High resolution: the lock does NOT attempt to detect PID
    // reuse (cross-platform Node has no portable way to read another
    // process's start time without a subprocess). The honest policy is
    // "PID alive → held; PID dead → reclaim". This test locks in the
    // policy: while our own PID still exists (which it does — we ARE the
    // process), a second acquirer cannot succeed until we release.
    const lockPath = resolve(tmp, '.plan.apply.lock');
    const release = acquireApplyLock(lockPath, 200);
    // Second acquire must time out (our PID is alive, same-stamp-visible).
    expect(() => acquireApplyLock(lockPath, 150)).toThrow(/Could not acquire/);
    release();
    // After release the path is gone; third acquire succeeds.
    const r2 = acquireApplyLock(lockPath, 150);
    r2();
  });

  it('slug-scoped lock serializes different plan_ids for the same slug', () => {
    // Two approved plans for the same slug must not race through the apply
    // runner. Before the re-keying (plan_id → slug), each plan took a
    // DIFFERENT lockfile, letting both run concurrently and interleave
    // research/draft state mutations — covered earlier phases of the pipeline
    // that have no downstream slug-lock protection (Codex adversarial
    // review, High #3). A slug-scoped lock closes the race.
    const slugScopedLock = resolve(tmp, '.same-slug.apply.lock');
    const release1 = acquireApplyLock(slugScopedLock, 200);
    try {
      // A second caller for the same slug (even with a different plan_id
      // conceptually) points at the SAME lock path and times out.
      expect(() => acquireApplyLock(slugScopedLock, 200)).toThrow(/Could not acquire/);
    } finally {
      release1();
    }
    // After release, the second caller succeeds.
    const release2 = acquireApplyLock(slugScopedLock, 200);
    release2();
  });
});

describe('readPlanFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'm0lz-plan-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads and parses a valid plan file', () => {
    const plan = basePlan();
    const path = resolve(tmp, 'plan.json');
    writeFileSync(path, JSON.stringify(plan, null, 2));
    const raw = readPlanFile(path);
    expect(validatePlanSchema(raw).slug).toBe('test-post');
  });

  it('throws SCHEMA_INVALID on malformed JSON', () => {
    const path = resolve(tmp, 'bad.json');
    writeFileSync(path, '{ this is not json');
    try {
      readPlanFile(path);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ValidationError).code).toBe('SCHEMA_INVALID');
    }
  });
});
