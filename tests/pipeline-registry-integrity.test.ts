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
});
