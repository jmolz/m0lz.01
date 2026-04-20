import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

// Slug-scoped cooperative lock for `blog agent apply`. Serializes concurrent
// applies for the SAME slug — including DIFFERENT plan_ids for that slug —
// so two processes cannot both read the DB's "these steps are not yet
// completed" state, both spawn `blog` for the same step, and both record
// the result. The classic check-then-act race.
//
// Slug scope (not plan-id scope): two different approved plans for the same
// slug can legitimately exist (e.g., a first plan failed mid-apply, the
// operator writes a corrected second plan). Both plans mutate the same
// underlying post state; applying them concurrently is never correct.
// Serializing by slug is what the downstream publish/update/unpublish locks
// already assume (see `acquirePublishLock` in `src/core/publish/lock.ts`) —
// this lock just covers the research/draft/evaluate phases that run under
// `apply` but before the publish lock is acquired (Codex adversarial review,
// High #3).
//
// Semantics mirror `acquirePublishLock`: atomic O_CREAT|O_EXCL lockfile,
// structured JSON stamp (PID + acquired-at timestamp), Atomics.wait spin
// with 50 ms slices up to the deadline, throw on timeout.
//
// Stale-lock reclaim policy (honest):
//  - `process.kill(pid, 0)` ESRCH → holder is dead, reclaim.
//  - Kernel says PID is alive → we CANNOT distinguish "original holder
//    still running" from "unrelated process with a reused PID" without a
//    cross-platform way to read another process's start time. Userland
//    Node has no portable API for this (linux /proc/<pid>/stat and macOS
//    sysctl kern.proc require platform-specific code or a subprocess to
//    `ps`). We therefore accept PID-reuse as a known edge case: if a
//    crashed holder's PID gets reused by an unrelated process, the lock
//    stays held until the reusing process exits OR the operator manually
//    deletes the lockfile (`rm .blog-agent/plans/.<slug>.apply.lock`).
//    The `acquired_at` timestamp in the stamp is purely human-readable
//    aid for manual cleanup; it does NOT influence automatic reclaim.
//  - Corrupt stamp (empty / non-JSON / zero-or-negative PID) → reclaim
//    immediately, since the lockfile was never fully written.
//  - Legacy bare-PID stamp (pre-v0.2) → tolerated as PID-only for
//    rollover compatibility.
//
// Not a kernel flock; external writers (text editors, unrelated scripts)
// are unaffected. Threat model: concurrent `blog agent apply` callers,
// not arbitrary filesystem writers.

interface LockStamp {
  pid: number;
  // Human-readable acquire moment. Debugging aid only — stale-reclaim
  // logic never compares against it. See the policy note above.
  acquiredAt: string;
}

function buildStamp(): LockStamp {
  return {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
}

function parseStamp(raw: string): LockStamp | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Legacy format was a bare PID; tolerate it during rollouts so a lock
  // written by an older version still honors liveness checks.
  if (!trimmed.startsWith('{')) {
    const pid = parseInt(trimmed, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return { pid, acquiredAt: '' };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.pid !== 'number' ||
      parsed.pid <= 0
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : '',
    };
  } catch {
    return null;
  }
}

export function acquireApplyLock(lockPath: string, timeoutMs = 10_000): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const sharedBuf = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      const fd = openSync(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      writeSync(fd, JSON.stringify(buildStamp()));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already released */
        }
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw err;

      // Reclaim stale lock if holder PID is dead OR the lockfile is corrupt
      // (empty, non-JSON, zero/negative PID). A corrupt lockfile most likely
      // means a prior writer crashed between O_CREAT and writeSync; treating
      // it as reclaimable is safer than spinning until timeout.
      try {
        const raw = readFileSync(lockPath, 'utf-8');
        const stamp = parseStamp(raw);
        if (!stamp) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* raced */
          }
          continue;
        }
        try {
          process.kill(stamp.pid, 0);
          // PID responds: holder is (probably) alive — fall through to the
          // deadline/spin path. PID reuse by an unrelated process is a
          // known edge case; see the policy note at the top of this file.
        } catch (killErr) {
          if ((killErr as NodeJS.ErrnoException).code === 'ESRCH') {
            try {
              unlinkSync(lockPath);
            } catch {
              /* raced */
            }
            continue;
          }
          // EPERM: PID exists but we lack permission to signal it
          // (different user / sandboxed). Treat as alive.
        }
      } catch {
        /* lockfile unreadable — transient, retry */
      }

      if (Date.now() > deadline) {
        throw new Error(
          `Could not acquire apply lock at ${lockPath} within ${timeoutMs}ms. ` +
            `Another 'blog agent apply' process holds it. If that process crashed, delete the lock file manually.`,
        );
      }
      // Short sleep (50ms) without blocking the event loop forever.
      Atomics.wait(sharedBuf, 0, 0, 50);
    }
  }
}
