import { createHash } from 'node:crypto';

import type { PlanFile } from './schema.js';

// Canonical serialization drops the two fields that describe approval state —
// approval is the event that *produces* the hash, so they cannot be part of
// the hashed payload. Everything else (including step order, arg order, and
// venue order) is part of the hash; reordering any of it changes identity.
type CanonicalPlan = Omit<PlanFile, 'approved_at' | 'payload_hash'>;

// Stable JSON.stringify: recursively sort object keys so byte-for-byte output
// is independent of authoring order. Arrays preserve their order (order is
// semantic for `steps`, `args`, `venues`).
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k]));
  return '{' + parts.join(',') + '}';
}

export function canonicalPlanJSON(plan: PlanFile): string {
  // Strip approval fields before canonicalizing.
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    approved_at: _a,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    payload_hash: _p,
    ...rest
  } = plan;
  const canonical: CanonicalPlan = rest;
  return stableStringify(canonical);
}

export function computePlanHash(plan: PlanFile): string {
  return createHash('sha256').update(canonicalPlanJSON(plan)).digest('hex');
}
