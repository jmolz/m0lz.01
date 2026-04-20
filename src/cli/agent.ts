import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { loadConfig } from '../core/config/loader.js';
import { printEnvelope } from '../core/json-envelope.js';
import { validateSlug } from '../core/research/document.js';
import { findWorkspaceRoot, WorkspaceNotFoundError } from '../core/workspace/root.js';
import { resolveUserPath } from '../core/workspace/user-path.js';
import { applyPlan, ApplyError } from '../core/plan-file/apply.js';
import { computePlanHash } from '../core/plan-file/hash.js';
import {
  PLAN_CONTENT_TYPES,
  PLAN_DEPTHS,
  PlanContentType,
  PlanDepth,
  PlanFile,
  PlanStep,
} from '../core/plan-file/schema.js';
import {
  readPlanFile,
  validatePlanForApply,
  validatePlanSchema,
  ValidationError,
} from '../core/plan-file/validator.js';

const DB_PATH = resolve('.blog-agent', 'state.db');
const CLI_VERSION = '0.1.0';

// Exit codes. Every error except STEP_FAILED is exit=2 (unrecoverable
// validation); STEP_FAILED preserves the child's actual exit.
const EXIT_SCHEMA = 2;
const EXIT_VALIDATION = 2;
const EXIT_STEP_FAILED = 1;

function emitAgentError(code: string, message: string): void {
  process.stderr.write(`[AGENT_ERROR] ${code}: ${message}\n`);
}

function generatePlanId(): string {
  // 26-char-ish random base32 — not a true ULID but monotonic enough for this
  // use case (plan_id is a receipt-file key, not a sort key).
  const bytes = randomBytes(16).toString('hex').toUpperCase();
  return `01${Date.now().toString(16).toUpperCase().padStart(12, '0')}${bytes}`.slice(0, 26);
}

// -- preflight ---------------------------------------------------------------

interface PreflightData {
  workspace_root: string | null;
  workspace_detected: boolean;
  workspace_error: string | null;
  config_valid: boolean;
  config_errors: string[];
  schema_version: '2';
  cli_version: string;
}

function runPreflight(opts: { json?: boolean }): void {
  let workspaceRoot: string | null = null;
  let workspaceError: string | null = null;
  // The CLI startup shim in `src/cli/index.ts` has already applied the full
  // precedence `--workspace > BLOG_WORKSPACE > ancestor walk` and `chdir`'d
  // into the selected root. Preflight therefore trusts `process.cwd()`.
  //
  // Passing `envVar` a SECOND time here would break precedence: a session
  // launched as `BLOG_WORKSPACE=/env/ws blog --workspace /override/ws agent
  // preflight` would get the env-var path instead of the override, because
  // `findWorkspaceRoot` checks `envVar` before walking cwd (Codex Pass-4
  // Medium). We omit envVar so the resolver only confirms cwd actually
  // contains a workspace.
  try {
    workspaceRoot = findWorkspaceRoot(process.cwd());
  } catch (e) {
    if (e instanceof WorkspaceNotFoundError) {
      workspaceError = e.message;
    } else {
      workspaceError = (e as Error).message;
    }
  }

  let configValid = false;
  const configErrors: string[] = [];
  if (workspaceRoot) {
    const configPath = resolve(workspaceRoot, '.blogrc.yaml');
    if (!existsSync(configPath)) {
      configErrors.push(`config missing: ${configPath}`);
    } else {
      try {
        loadConfig(configPath);
        configValid = true;
      } catch (e) {
        configErrors.push((e as Error).message);
      }
    }
  }

  const data: PreflightData = {
    workspace_root: workspaceRoot,
    workspace_detected: workspaceRoot !== null,
    workspace_error: workspaceError,
    config_valid: configValid,
    config_errors: configErrors,
    schema_version: '2',
    cli_version: CLI_VERSION,
  };

  if (opts.json) {
    printEnvelope<'AgentPreflight', PreflightData>('AgentPreflight', data);
    return;
  }

  console.log(`workspace_detected:  ${data.workspace_detected}`);
  console.log(`workspace_root:      ${data.workspace_root ?? '(not found)'}`);
  if (data.workspace_error) console.log(`workspace_error:     ${data.workspace_error}`);
  console.log(`config_valid:        ${data.config_valid}`);
  if (data.config_errors.length > 0) {
    console.log('config_errors:');
    for (const err of data.config_errors) console.log(`  - ${err}`);
  }
  console.log(`schema_version:      ${data.schema_version}`);
  console.log(`cli_version:         ${data.cli_version}`);
}

// -- plan --------------------------------------------------------------------

interface PlanOptions {
  intent: string;
  contentType: PlanContentType;
  depth: PlanDepth;
  venues: string;
  expectedStartPhase?: string;
  stepsJson?: string;
  stepsInline?: string;
  output?: string;
}

function runAgentPlan(slug: string, opts: PlanOptions): void {
  const workspaceRoot = process.cwd();

  // Validate slug at the CLI boundary BEFORE it influences any path. Without
  // this a slug like `../../escape` would traverse out of the plans directory
  // in the default `outPath` branch, restoring the write-anywhere primitive
  // the --output clamp was built to close (Codex adversarial review, Critical).
  // validateSlug's regex also guarantees the slug contains no shell
  // metacharacters, path separators, or leading dots.
  try {
    validateSlug(slug);
  } catch (e) {
    emitAgentError('SCHEMA_INVALID', (e as Error).message);
    process.exit(EXIT_VALIDATION);
  }

  // Venues come in as comma-separated string: "hub,devto,hn".
  const venues = opts.venues
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (venues.length === 0) {
    emitAgentError('SCHEMA_INVALID', '--venues must be a non-empty comma-separated list');
    process.exit(EXIT_VALIDATION);
  }

  // Steps come from:
  //   --steps-inline: JSON array string on the command line (preferred; the
  //     /blog skill uses this so it never needs Write/Edit tool scope)
  //   --steps-json: path to a JSON file (retained for operator / CI use)
  //   otherwise: a built-in single-step placeholder skeleton
  // --steps-inline and --steps-json are mutually exclusive.
  let steps: PlanStep[];
  if (opts.stepsInline && opts.stepsJson) {
    emitAgentError(
      'SCHEMA_INVALID',
      '--steps-inline and --steps-json are mutually exclusive; pass one or neither.',
    );
    process.exit(EXIT_SCHEMA);
  }
  if (opts.stepsInline) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.stepsInline);
    } catch (e) {
      emitAgentError('SCHEMA_INVALID', `steps-inline is not valid JSON: ${(e as Error).message}`);
      process.exit(EXIT_SCHEMA);
    }
    if (!Array.isArray(parsed)) {
      emitAgentError('SCHEMA_INVALID', 'steps-inline must be a top-level array of step objects');
      process.exit(EXIT_SCHEMA);
    }
    steps = parsed as PlanStep[];
  } else if (opts.stepsJson) {
    const raw = readFileSync(opts.stepsJson, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      emitAgentError('SCHEMA_INVALID', `steps-json is not valid JSON: ${(e as Error).message}`);
      process.exit(EXIT_SCHEMA);
    }
    if (!Array.isArray(parsed)) {
      emitAgentError('SCHEMA_INVALID', 'steps-json must be a top-level array of step objects');
      process.exit(EXIT_SCHEMA);
    }
    steps = parsed as PlanStep[];
  } else {
    steps = defaultStepsForSlug(slug, opts.depth);
  }

  const expectedStartPhase = opts.expectedStartPhase ?? detectStartPhase(slug);

  const plan: PlanFile = {
    schema_version: '2',
    plan_id: generatePlanId(),
    slug,
    workspace_root: workspaceRoot,
    created_at: new Date().toISOString(),
    approved_at: null,
    payload_hash: null,
    intent: opts.intent,
    content_type: opts.contentType,
    depth: opts.depth,
    venues,
    expected_start_phase: expectedStartPhase,
    steps,
  };

  // Validate our own output — CLI-generated skeleton must always be shape-valid.
  try {
    validatePlanSchema(JSON.parse(JSON.stringify(plan)));
  } catch (e) {
    emitAgentError((e as ValidationError).code ?? 'SCHEMA_INVALID', (e as Error).message);
    process.exit(EXIT_SCHEMA);
  }

  // Clamp the final plan-file path to <workspace>/.blog-agent/plans/*.plan.json.
  // Without this, --output + --steps-inline would let the skill synthesize an
  // arbitrary plan payload in-memory and persist it anywhere the operator can
  // write — a file-write primitive masquerading as an orchestration surface
  // (Codex adversarial review, Critical). Both branches (explicit --output and
  // default <slug>.plan.json) run the SAME containment + symlink checks.
  //
  // Symlink discipline:
  //  - Parent directory: realpath both sides so macOS tmpdir quirks
  //    (/var/folders/... -> /private/var/folders/...) don't falsely reject.
  //  - Final path: lstat (not stat) and reject if it already exists as a
  //    symlink — follow-through would write outside the canonicalized parent.
  const plansDir = resolve(workspaceRoot, '.blog-agent', 'plans');
  mkdirSync(plansDir, { recursive: true });
  const plansDirCanonical = realpathSync(plansDir);

  const outPath = clampOutputPath(opts.output, slug, plansDirCanonical);
  writeFileSync(outPath, JSON.stringify(plan, null, 2) + '\n');
  console.log(outPath);
}

// Resolve + clamp + symlink-check the final plan path. Returns the canonical
// absolute path where the plan may be safely written. Exits with
// SCHEMA_INVALID on any containment/symlink/extension violation.
function clampOutputPath(
  userOutput: string | undefined,
  slug: string,
  plansDirCanonical: string,
): string {
  let rawPath: string;
  if (userOutput) {
    rawPath = resolve(userOutput);
  } else {
    // validateSlug() was called upstream — slug is safe to interpolate.
    rawPath = resolve(plansDirCanonical, `${slug}.plan.json`);
  }

  const parent = dirname(rawPath);
  let parentCanonical: string;
  try {
    parentCanonical = realpathSync(parent);
  } catch {
    emitAgentError(
      'SCHEMA_INVALID',
      `output parent directory does not exist (got ${rawPath}). ` +
        `Plan files must live inside ${plansDirCanonical}.`,
    );
    process.exit(EXIT_SCHEMA);
  }

  const outCanonical = resolve(parentCanonical, basename(rawPath));
  const rel = relative(plansDirCanonical, outCanonical);
  if (rel === '' || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) {
    emitAgentError(
      'SCHEMA_INVALID',
      `output path must live inside ${plansDirCanonical} (got ${outCanonical})`,
    );
    process.exit(EXIT_SCHEMA);
  }

  if (!outCanonical.endsWith('.plan.json')) {
    emitAgentError(
      'SCHEMA_INVALID',
      `output path must end in .plan.json (got ${outCanonical})`,
    );
    process.exit(EXIT_SCHEMA);
  }

  // lstat (not stat) so a PRE-EXISTING SYMLINK at the final slot is rejected.
  // Without this, an attacker who can drop a symlink into plans/ before the
  // CLI runs could redirect writes to any path the process can reach. The
  // parent-realpath check catches directory-level symlink games; this catches
  // leaf-level ones.
  try {
    const st = lstatSync(outCanonical);
    if (st.isSymbolicLink()) {
      emitAgentError(
        'SCHEMA_INVALID',
        `plan path ${outCanonical} is a symbolic link; refusing to follow. ` +
          `Remove it and rerun, or pass a different --output.`,
      );
      process.exit(EXIT_SCHEMA);
    }
  } catch (e) {
    // ENOENT is expected (fresh plan); every other error (EACCES, ELOOP, …)
    // is an environment problem we should surface, not swallow.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      emitAgentError(
        'SCHEMA_INVALID',
        `could not stat plan path ${outCanonical}: ${(e as Error).message}`,
      );
      process.exit(EXIT_SCHEMA);
    }
  }

  return outCanonical;
}

function detectStartPhase(slug: string): string {
  if (!existsSync(DB_PATH)) return 'research';
  const db = getDatabase(DB_PATH);
  try {
    const row = db
      .prepare('SELECT phase FROM posts WHERE slug = ?')
      .get(slug) as { phase: string } | undefined;
    return row?.phase ?? 'research';
  } finally {
    closeDatabase(db);
  }
}

// Minimal always-valid skeleton — the skill expands this via Edit before
// calling `approve`. park depth yields just a status read; fast-path and full
// emit a placeholder status step so the file passes validation immediately.
function defaultStepsForSlug(slug: string, depth: PlanDepth): PlanStep[] {
  const placeholder: PlanStep = {
    command: 'blog status',
    args: [],
    checkpoint_message: `Inspect ${slug} before proceeding (${depth}).`,
  };
  return [placeholder];
}

// -- approve -----------------------------------------------------------------

function runAgentApprove(planPath: string): void {
  let raw: unknown;
  try {
    raw = readPlanFile(planPath);
  } catch (e) {
    emitAgentError((e as ValidationError).code, (e as Error).message);
    process.exit(EXIT_SCHEMA);
  }
  let plan: PlanFile;
  try {
    plan = validatePlanSchema(raw);
  } catch (e) {
    emitAgentError((e as ValidationError).code, (e as Error).message);
    process.exit(EXIT_SCHEMA);
  }

  if (plan.approved_at !== null && plan.payload_hash !== null) {
    // Already approved — re-computing would invalidate if content diverges.
    const recomputed = computePlanHash(plan);
    if (recomputed === plan.payload_hash) {
      console.log(`already approved at ${plan.approved_at}`);
      return;
    }
    // Diverged — re-approve against current content.
  }

  plan.approved_at = new Date().toISOString();
  plan.payload_hash = computePlanHash(plan);
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
  console.log(`approved at ${plan.approved_at}`);
  console.log(`payload_hash: ${plan.payload_hash}`);
}

// -- verify ------------------------------------------------------------------

function runAgentVerify(planPath: string): void {
  const workspaceRoot = process.cwd();
  let raw: unknown;
  try {
    raw = readPlanFile(planPath);
  } catch (e) {
    emitAgentError((e as ValidationError).code, (e as Error).message);
    process.exit(EXIT_SCHEMA);
  }
  try {
    validatePlanForApply(raw, { workspaceRoot });
    console.log('OK');
  } catch (e) {
    emitAgentError((e as ValidationError).code, (e as Error).message);
    process.exit(EXIT_VALIDATION);
  }
}

// -- apply -------------------------------------------------------------------

function runAgentApply(planPath: string, opts: { restart?: boolean }): void {
  const workspaceRoot = process.cwd();
  let raw: unknown;
  try {
    raw = readPlanFile(planPath);
  } catch (e) {
    emitAgentError((e as ValidationError).code, (e as Error).message);
    process.exit(EXIT_SCHEMA);
  }

  let plan: PlanFile;
  try {
    plan = validatePlanForApply(raw, { workspaceRoot });
  } catch (e) {
    emitAgentError((e as ValidationError).code, (e as Error).message);
    process.exit(EXIT_VALIDATION);
  }

  try {
    const result = applyPlan(plan, { restart: opts.restart });
    console.log(
      `applied ${plan.steps.length} step(s), overall_exit=${result.overall_exit}. Receipt: ` +
        resolve(workspaceRoot, '.blog-agent', 'plans', `${plan.slug}.receipt.json`),
    );
  } catch (e) {
    if (e instanceof ApplyError) {
      emitAgentError(e.code, e.message);
      process.exit(e.code === 'STEP_FAILED' ? EXIT_STEP_FAILED : EXIT_VALIDATION);
    }
    throw e;
  }
}

// -- registration ------------------------------------------------------------

export function registerAgent(program: Command): void {
  const agent = program
    .command('agent')
    .description('Orchestration surface for the /blog skill (preflight/plan/approve/verify/apply)');

  agent
    .command('preflight')
    .description('Report workspace root, config validity, schema + CLI version')
    .option('--json', 'Emit JSON envelope for machine consumers')
    .action((opts: { json?: boolean }) => runPreflight(opts));

  agent
    .command('plan <slug>')
    .description('Write a plan skeleton (unapproved)')
    .requiredOption('--intent <text>', 'One-line user intent')
    .requiredOption(
      '--content-type <type>',
      `Content type: ${PLAN_CONTENT_TYPES.join(' | ')}`,
    )
    .requiredOption('--depth <depth>', `Depth: ${PLAN_DEPTHS.join(' | ')}`)
    .requiredOption('--venues <list>', 'Comma-separated venue list (e.g. "hub,devto,hn")')
    .option('--expected-start-phase <phase>', 'Override phase detection')
    .option('--steps-inline <json>', 'Inline JSON array of step objects (preferred for the /blog skill)')
    .option('--steps-json <path>', 'Path to a JSON file containing the steps array', resolveUserPath)
    .option('--output <path>', 'Override output plan path', resolveUserPath)
    .action((slug: string, opts: PlanOptions) => {
      if (!PLAN_CONTENT_TYPES.includes(opts.contentType as PlanContentType)) {
        emitAgentError('SCHEMA_INVALID', `unknown content-type: ${opts.contentType}`);
        process.exit(EXIT_SCHEMA);
      }
      if (!PLAN_DEPTHS.includes(opts.depth as PlanDepth)) {
        emitAgentError('SCHEMA_INVALID', `unknown depth: ${opts.depth}`);
        process.exit(EXIT_SCHEMA);
      }
      runAgentPlan(slug, opts);
    });

  agent
    .command('approve <plan-path>')
    .description('Atomically set approved_at + payload_hash on a plan file')
    .action((planPath: string) => runAgentApprove(resolveUserPath(planPath)));

  agent
    .command('verify <plan-path>')
    .description('Dry-run validate a plan for apply; exit 2 with [AGENT_ERROR] on failure')
    .action((planPath: string) => runAgentVerify(resolveUserPath(planPath)));

  agent
    .command('apply <plan-path>')
    .description('Validate and execute a plan step by step (resumable via receipt)')
    .option('--restart', 'Ignore the existing receipt and re-run every step')
    .action((planPath: string, opts: { restart?: boolean }) =>
      runAgentApply(resolveUserPath(planPath), opts),
    );
}
