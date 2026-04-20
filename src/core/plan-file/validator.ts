import { readFileSync } from 'node:fs';

import { validateSlug } from '../research/document.js';
import { computePlanHash } from './hash.js';
import {
  BANNED_ARG_FLAGS,
  DENY_STEP_SUBCOMMANDS,
  KNOWN_LEAF_COMMANDS,
  KNOWN_SUBCOMMANDS,
  PLAN_CONTENT_TYPES,
  PLAN_DEPTHS,
  PlanContentType,
  PlanDepth,
  PlanFile,
  PlanStep,
  SLUG_BEARING_STEP_COMMANDS,
} from './schema.js';

// Error taxonomy emitted on stderr as `[AGENT_ERROR] <CODE>: <msg>`. Codes map
// to CLI exit codes (see `src/cli/agent.ts`).
export type ValidationErrorCode =
  | 'SCHEMA_INVALID'
  | 'NO_APPROVAL'
  | 'HASH_MISMATCH'
  | 'WORKSPACE_MISMATCH'
  | 'UNKNOWN_COMMAND';

export class ValidationError extends Error {
  constructor(public readonly code: ValidationErrorCode, message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Schema check — throws SCHEMA_INVALID on any shape violation, enum value, or
// abstract step command. Returns a typed PlanFile on success.
export function validatePlanSchema(raw: unknown): PlanFile {
  if (!isPlainObject(raw)) {
    throw new ValidationError('SCHEMA_INVALID', 'plan must be a JSON object');
  }

  const requireString = (key: string): string => {
    const v = raw[key];
    if (!isString(v) || v.length === 0) {
      throw new ValidationError('SCHEMA_INVALID', `missing or empty string field: ${key}`);
    }
    return v;
  };

  if (raw.schema_version !== '2') {
    throw new ValidationError('SCHEMA_INVALID', `schema_version must be "2" (got ${JSON.stringify(raw.schema_version)})`);
  }

  const plan_id = requireString('plan_id');
  const slug = requireString('slug');
  // Guard the slug at the shared-schema layer, not just at `agent plan`. A
  // hand-authored or edited plan with `slug: "../../outside"` would otherwise
  // pass verify/approve/apply and reach `defaultReceiptPath()` /
  // `defaultLockPath()`, which concatenate the raw slug into paths under
  // `.blog-agent/plans/` — restoring the write-anywhere primitive the CLI
  // clamp was built to close (Codex adversarial review Pass 2, Critical).
  try {
    validateSlug(slug);
  } catch (e) {
    throw new ValidationError(
      'SCHEMA_INVALID',
      `plan.slug is invalid: ${(e as Error).message}`,
    );
  }
  const workspace_root = requireString('workspace_root');
  const created_at = requireString('created_at');
  const intent = requireString('intent');
  const expected_start_phase = requireString('expected_start_phase');

  const content_type = raw.content_type;
  if (!isString(content_type) || !PLAN_CONTENT_TYPES.includes(content_type as PlanContentType)) {
    throw new ValidationError(
      'SCHEMA_INVALID',
      `content_type must be one of [${PLAN_CONTENT_TYPES.join(', ')}] (got ${JSON.stringify(content_type)})`,
    );
  }

  const depth = raw.depth;
  if (!isString(depth) || !PLAN_DEPTHS.includes(depth as PlanDepth)) {
    throw new ValidationError(
      'SCHEMA_INVALID',
      `depth must be one of [${PLAN_DEPTHS.join(', ')}] (got ${JSON.stringify(depth)})`,
    );
  }

  const venues = raw.venues;
  if (!isStringArray(venues) || venues.length === 0) {
    throw new ValidationError('SCHEMA_INVALID', 'venues must be a non-empty array of strings');
  }

  const approved_at = raw.approved_at;
  if (approved_at !== null && !isString(approved_at)) {
    throw new ValidationError('SCHEMA_INVALID', 'approved_at must be null or an ISO 8601 string');
  }

  const payload_hash = raw.payload_hash;
  if (payload_hash !== null && !isString(payload_hash)) {
    throw new ValidationError('SCHEMA_INVALID', 'payload_hash must be null or a hex string');
  }

  const stepsRaw = raw.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new ValidationError('SCHEMA_INVALID', 'steps must be a non-empty array');
  }

  const steps: PlanStep[] = stepsRaw.map((stepRaw, idx) => validateStep(stepRaw, idx));

  // Second pass: slug-binding. Every slug-bearing subcommand (enumerated in
  // SLUG_BEARING_STEP_COMMANDS) takes the target post's slug as args[0]. A
  // plan that declares `slug: alpha` but has a step `command: "blog research
  // finalize"` with `args: ["beta", ...]` would mutate the WRONG post while
  // the apply lock + agent_plan_runs.slug record "alpha" — bypassing the
  // slug-scoped audit trail entirely (Codex Pass-3 High).
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (SLUG_BEARING_STEP_COMMANDS.includes(step.command)) {
      if (step.args.length === 0 || step.args[0] !== slug) {
        throw new ValidationError(
          'SCHEMA_INVALID',
          `steps[${i}].args[0] must equal plan.slug=${JSON.stringify(slug)} for ` +
            `slug-bearing command ${JSON.stringify(step.command)} (got ${JSON.stringify(step.args[0] ?? null)}). ` +
            `This prevents a plan from mutating a different post than the metadata, lock, and audit trail record.`,
        );
      }
    }
  }

  return {
    schema_version: '2',
    plan_id,
    slug,
    workspace_root,
    created_at,
    approved_at,
    payload_hash,
    intent,
    content_type: content_type as PlanContentType,
    depth: depth as PlanDepth,
    venues,
    expected_start_phase,
    steps,
  };
}

function validateStep(stepRaw: unknown, idx: number): PlanStep {
  if (!isPlainObject(stepRaw)) {
    throw new ValidationError('SCHEMA_INVALID', `steps[${idx}] must be an object`);
  }

  const command = stepRaw.command;
  if (!isString(command) || command.length === 0) {
    throw new ValidationError('SCHEMA_INVALID', `steps[${idx}].command must be a non-empty string`);
  }
  if (!command.startsWith('blog ') && command !== 'blog') {
    throw new ValidationError(
      'SCHEMA_INVALID',
      `steps[${idx}].command must start with "blog " (got ${JSON.stringify(command)})`,
    );
  }

  // Parse into words. `commandWords` is used for ALL downstream checks
  // (flag-token guard, subcommand recognition, leaf allowlist match) so
  // validation's view of the command exactly matches what `stepToArgv`
  // produces at spawn time (it does `afterBlog.split(/\s+/)` too). Any
  // divergence between these two views is the source of every Pass-4
  // bypass — see schema.ts KNOWN_LEAF_COMMANDS doc.
  const afterBlog = command.slice('blog '.length).trim();
  const commandWords = afterBlog.length === 0 ? [] : afterBlog.split(/\s+/).filter((w) => w.length > 0);
  const firstWord = commandWords[0] ?? '';
  if (!KNOWN_SUBCOMMANDS.includes(firstWord)) {
    throw new ValidationError(
      'SCHEMA_INVALID',
      `steps[${idx}].command references unknown subcommand "${firstWord}". Known: [${KNOWN_SUBCOMMANDS.join(', ')}]`,
    );
  }

  // No flag-like tokens inside `command`. A payload like
  //   { "command": "blog status --foo", "args": [] }
  // would otherwise pass and then spawn commander with `--foo`, letting a
  // forged plan smuggle a flag into an otherwise whitelisted subcommand.
  // All flags must live in `args` where the banned-flag check covers them.
  for (let w = 0; w < commandWords.length; w++) {
    if (commandWords[w].startsWith('-')) {
      throw new ValidationError(
        'SCHEMA_INVALID',
        `steps[${idx}].command cannot contain flag-like tokens; move "${commandWords[w]}" into args. Got ${JSON.stringify(command)}.`,
      );
    }
  }

  // `agent` is the gate itself — a plan step that invokes `blog agent
  // approve/apply/verify <other-plan>` would let one hash-verified plan
  // run a different, unverified plan underneath. The outer hash covers
  // the literal step string, not the nested plan's content. Reject it.
  if (DENY_STEP_SUBCOMMANDS.includes(firstWord)) {
    throw new ValidationError(
      'SCHEMA_INVALID',
      `steps[${idx}].command references disallowed subcommand "${firstWord}" (banned to prevent nested-plan delegation). Disallowed: [${DENY_STEP_SUBCOMMANDS.join(', ')}]`,
    );
  }

  // Reject non-canonical whitespace forms. `commandWords.join(' ')` is the
  // single-space canonical; step.command must exactly equal
  // `'blog ' + canonical`. This closes:
  //   - double-space variants: `"blog  research  finalize"` (Claude P4)
  //   - trailing whitespace: `"blog research finalize "`
  //   - tab/newline variants: `"blog\tresearch\nfinalize"`
  // All of those previously bypassed the `.includes()` allowlist lookup
  // because stepToArgv normalized via split(/\s+/) while the validator
  // compared the raw whitespace-preserved string.
  const canonical = 'blog ' + commandWords.join(' ');
  if (command !== canonical) {
    throw new ValidationError(
      'SCHEMA_INVALID',
      `steps[${idx}].command must be single-space canonical form ${JSON.stringify(canonical)} ` +
        `(got ${JSON.stringify(command)}). Non-canonical whitespace is rejected to prevent ` +
        `validator/executor view divergence (Codex P4).`,
    );
  }

  // `command` must be a full LEAF command (executable CLI entry), not a
  // namespace. `blog research` alone was previously accepted because
  // `research` is a known subcommand and commandWords.length was only 1 —
  // but stepToArgv would then concatenate args and run `blog research
  // finalize <attacker-slug>`, bypassing slug binding (Codex P4 High).
  // KNOWN_LEAF_COMMANDS enumerates every valid full path.
  if (!KNOWN_LEAF_COMMANDS.includes(canonical)) {
    throw new ValidationError(
      'SCHEMA_INVALID',
      `steps[${idx}].command is not a known leaf command ${JSON.stringify(canonical)}. ` +
        `Namespaces like "blog research" (without a subcommand) are rejected — plans must ` +
        `name the full executable path. Known leaves: [${KNOWN_LEAF_COMMANDS.join(', ')}]`,
    );
  }

  const args = stepRaw.args;
  if (!isStringArray(args)) {
    throw new ValidationError('SCHEMA_INVALID', `steps[${idx}].args must be an array of strings`);
  }

  // Reject flags that re-enter the CLI startup shim with attacker-chosen
  // values. --workspace is the high-severity case: `src/cli/index.ts` hoists
  // it from ANY position in argv before Commander runs, so a plan step like
  //   { command: "blog status", args: ["--workspace", "/tmp/attacker"] }
  // would execute an approved step against a workspace other than the one
  // the plan's hash binds to (Codex adversarial review, High). --help and
  // --version are lower severity but also bypass subcommand dispatch and
  // have no legitimate use inside an approved plan step.
  //
  // Covers both `--flag value` and `--flag=value` forms. Nothing in the
  // positive args surface legitimately starts with these — every existing
  // subcommand that takes `--workspace`-like options defines them at the
  // program level, not the step level.
  for (let a = 0; a < args.length; a++) {
    const arg = args[a];
    const banned = BANNED_ARG_FLAGS;
    const eqIdx = arg.indexOf('=');
    const head = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    if (banned.includes(head)) {
      throw new ValidationError(
        'SCHEMA_INVALID',
        `steps[${idx}].args contains banned global flag "${arg}". ` +
          `Flags [${banned.join(', ')}] cannot appear in plan-step args because they ` +
          `alter CLI global behavior (e.g. --workspace changes the workspace the step runs against, ` +
          `bypassing the plan's hash binding).`,
      );
    }
  }

  const checkpoint_message = stepRaw.checkpoint_message;
  if (checkpoint_message !== undefined && !isString(checkpoint_message)) {
    throw new ValidationError('SCHEMA_INVALID', `steps[${idx}].checkpoint_message must be a string if present`);
  }

  const preconditions = stepRaw.preconditions;
  if (preconditions !== undefined && !isPlainObject(preconditions)) {
    throw new ValidationError('SCHEMA_INVALID', `steps[${idx}].preconditions must be an object if present`);
  }

  return {
    command,
    args,
    ...(checkpoint_message !== undefined ? { checkpoint_message } : {}),
    ...(preconditions !== undefined ? { preconditions } : {}),
  };
}

export interface ValidateForApplyOpts {
  workspaceRoot: string;
}

// Full validation for `blog agent apply`: schema + approval + hash + workspace
// root. Returns the typed PlanFile on success. Throws the most specific
// ValidationError on failure.
export function validatePlanForApply(raw: unknown, opts: ValidateForApplyOpts): PlanFile {
  const plan = validatePlanSchema(raw);

  if (plan.approved_at === null) {
    throw new ValidationError(
      'NO_APPROVAL',
      `plan is not approved (approved_at: null). Run \`blog agent approve <path>\` first.`,
    );
  }

  if (plan.payload_hash === null) {
    throw new ValidationError(
      'NO_APPROVAL',
      `plan is approved but payload_hash is null. Re-run \`blog agent approve <path>\`.`,
    );
  }

  const recomputed = computePlanHash(plan);
  if (recomputed !== plan.payload_hash) {
    throw new ValidationError(
      'HASH_MISMATCH',
      `plan content was modified after approval. Expected hash ${plan.payload_hash}, recomputed ${recomputed}. Re-approve with \`blog agent approve <path>\`.`,
    );
  }

  if (plan.workspace_root !== opts.workspaceRoot) {
    throw new ValidationError(
      'WORKSPACE_MISMATCH',
      `plan.workspace_root (${plan.workspace_root}) does not match detected workspace root (${opts.workspaceRoot}).`,
    );
  }

  return plan;
}

// Read + validate a plan file from disk. `raw` is the parsed JSON; any JSON
// parse error surfaces as SCHEMA_INVALID.
export function readPlanFile(path: string): unknown {
  const bytes = readFileSync(path, 'utf8');
  try {
    return JSON.parse(bytes);
  } catch (e) {
    throw new ValidationError('SCHEMA_INVALID', `plan file is not valid JSON: ${(e as Error).message}`);
  }
}
