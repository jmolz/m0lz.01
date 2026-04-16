import { createHash } from 'node:crypto';

import { ReviewerType } from '../db/types.js';

export type IssueSeverity = 'low' | 'medium' | 'high';

export type IssueSource = 'autocheck' | 'reviewer';

export interface Issue {
  id: string;
  category: string;
  severity: IssueSeverity;
  title: string;
  description: string;
  source?: IssueSource;
}

// Required keys every ReviewerOutput must declare in `artifact_hashes`. Missing
// files are declared via the ARTIFACT_ABSENT sentinel ('<absent>') — the key
// itself is never omitted. Keep in sync with computeReviewedArtifactHashes in
// state.ts; the lists must match exactly.
export const REQUIRED_ARTIFACT_HASH_KEYS: readonly string[] = [
  'draft/index.mdx',
  'benchmark/results.json',
  'benchmark/environment.json',
  'evaluation/structural.lint.json',
] as const;

export interface ReviewerOutput {
  reviewer: ReviewerType;
  model: string;
  passed: boolean;
  issues: Issue[];
  report_path?: string;
  // SHA-256 hashes of every reviewed artifact, computed by the reviewer at
  // judgment time. REQUIRED — recordReview rejects outputs that omit this
  // field or any of REQUIRED_ARTIFACT_HASH_KEYS. An optional field would
  // allow a stale reviewer JSON generated against D0 to be recorded after
  // the workspace drifted to D1 simply by omitting the field; requiring it
  // forces every reviewer to commit to the exact file set it judged.
  artifact_hashes: Record<string, string>;
}

const REVIEWER_VALUES: readonly ReviewerType[] = ['structural', 'adversarial', 'methodology'] as const;
const SEVERITY_VALUES: readonly IssueSeverity[] = ['low', 'medium', 'high'] as const;
const SOURCE_VALUES: readonly IssueSource[] = ['autocheck', 'reviewer'] as const;

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function issueFingerprint(reviewer: ReviewerType, title: string, description: string): string {
  const payload = `${reviewer}\n${normalizeText(title)}\n${normalizeText(description)}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 12);
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateReviewerOutput(obj: unknown): ValidationResult {
  const errors: string[] = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['ReviewerOutput must be an object'] };
  }
  const o = obj as Record<string, unknown>;

  if (typeof o.reviewer !== 'string' || !REVIEWER_VALUES.includes(o.reviewer as ReviewerType)) {
    errors.push(`Field 'reviewer' must be one of: ${REVIEWER_VALUES.join(', ')}`);
  }
  if (typeof o.model !== 'string' || o.model.length === 0) {
    errors.push(`Field 'model' must be a non-empty string`);
  }
  if (typeof o.passed !== 'boolean') {
    errors.push(`Field 'passed' must be a boolean`);
  }
  if (!Array.isArray(o.issues)) {
    errors.push(`Field 'issues' must be an array`);
  } else {
    o.issues.forEach((item, idx) => {
      const issueErrors = validateIssue(item, idx);
      errors.push(...issueErrors);
    });
  }
  if (o.report_path !== undefined && typeof o.report_path !== 'string') {
    errors.push(`Field 'report_path' must be a string if present`);
  }
  if (o.artifact_hashes === undefined) {
    errors.push(`Field 'artifact_hashes' is required (must declare: ${REQUIRED_ARTIFACT_HASH_KEYS.join(', ')})`);
  } else if (typeof o.artifact_hashes !== 'object' || o.artifact_hashes === null || Array.isArray(o.artifact_hashes)) {
    errors.push(`Field 'artifact_hashes' must be an object`);
  } else {
    const ah = o.artifact_hashes as Record<string, unknown>;
    for (const required of REQUIRED_ARTIFACT_HASH_KEYS) {
      if (ah[required] === undefined) {
        errors.push(`artifact_hashes['${required}'] is required (use '<absent>' for files that legitimately do not exist)`);
      }
    }
    for (const [k, v] of Object.entries(ah)) {
      if (typeof v !== 'string' || v.length === 0) {
        errors.push(`artifact_hashes['${k}'] must be a non-empty string`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateIssue(item: unknown, idx: number): string[] {
  const errors: string[] = [];
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return [`issues[${idx}] must be an object`];
  }
  const iss = item as Record<string, unknown>;
  if (typeof iss.id !== 'string' || iss.id.length === 0) {
    errors.push(`issues[${idx}].id must be a non-empty string`);
  }
  if (typeof iss.category !== 'string' || iss.category.length === 0) {
    errors.push(`issues[${idx}].category must be a non-empty string`);
  }
  if (typeof iss.severity !== 'string' || !SEVERITY_VALUES.includes(iss.severity as IssueSeverity)) {
    errors.push(`issues[${idx}].severity must be one of: ${SEVERITY_VALUES.join(', ')}`);
  }
  if (typeof iss.title !== 'string' || iss.title.length === 0) {
    errors.push(`issues[${idx}].title must be a non-empty string`);
  } else if (normalizeText(iss.title).length === 0) {
    errors.push(`issues[${idx}].title must contain at least one alphanumeric character after normalization`);
  }
  if (typeof iss.description !== 'string' || iss.description.length === 0) {
    errors.push(`issues[${idx}].description must be a non-empty string`);
  } else if (normalizeText(iss.description).length === 0) {
    errors.push(`issues[${idx}].description must contain at least one alphanumeric character after normalization`);
  }
  if (iss.source !== undefined && (typeof iss.source !== 'string' || !SOURCE_VALUES.includes(iss.source as IssueSource))) {
    errors.push(`issues[${idx}].source must be one of: ${SOURCE_VALUES.join(', ')}`);
  }
  return errors;
}

export function parseReviewerOutput(jsonString: string): ReviewerOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }
  const result = validateReviewerOutput(parsed);
  if (!result.ok) {
    throw new Error(`ReviewerOutput schema violation:\n  - ${result.errors.join('\n  - ')}`);
  }
  return parsed as ReviewerOutput;
}
