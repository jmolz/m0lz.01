import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

// Slug-scoped cooperative lock for publish pipeline operations. Serializes
// CLI callers that mutate publish state on the same slug so two concurrent
// `blog publish ...` processes cannot interleave step reads, step flips, and
// pipeline_steps INSERTs.
//
// Semantics mirror `acquireEvaluateLock` in `src/core/evaluate/state.ts`
// exactly: atomic O_CREAT|O_EXCL lockfile creation, PID stamp for stale-lock
// reclaim, Atomics.wait spin with 50 ms slices up to the deadline, throw
// with descriptive error on timeout. Release function unlinks the file and
// swallows ENOENT from races.
//
// Not a kernel flock — external processes (text editors, scripts that don't
// use this helper) are unaffected. That limitation is acknowledged in the
// threat model: concurrent CLI callers serialize on this lock; arbitrary FS
// writers do not.
export function acquirePublishLock(
  publishDir: string,
  slug: string,
  timeoutMs = 10_000,
): () => void {
  const workspaceDir = join(publishDir, slug);
  mkdirSync(workspaceDir, { recursive: true });
  const lockPath = join(workspaceDir, '.publish.lock');
  const deadline = Date.now() + timeoutMs;
  const sharedBuf = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(lockPath); } catch { /* already released */ } };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw err;
      // Reclaim stale lock if holder PID is dead OR the lockfile is corrupt
      // (empty, non-numeric, zero/negative PID). A corrupt lockfile most
      // likely means a prior writer crashed between O_CREAT and writeSync;
      // treating it as reclaimable is safer than spinning until timeout and
      // surfacing a misleading "another process holds it" error.
      try {
        const raw = readFileSync(lockPath, 'utf-8').trim();
        const heldPid = raw.length === 0 ? NaN : parseInt(raw, 10);
        if (!Number.isFinite(heldPid) || heldPid <= 0) {
          try { unlinkSync(lockPath); } catch { /* raced */ }
          continue;
        }
        try {
          process.kill(heldPid, 0);
        } catch (killErr) {
          if ((killErr as NodeJS.ErrnoException).code === 'ESRCH') {
            try { unlinkSync(lockPath); } catch { /* raced */ }
            continue;
          }
          // EPERM means the PID exists but we lack permission to signal it —
          // treat as alive and fall through to the deadline/spin path.
        }
      } catch { /* lockfile unreadable — transient, retry */ }
      if (Date.now() > deadline) {
        throw new Error(
          `Could not acquire publish lock for '${slug}' within ${timeoutMs}ms at ${lockPath}. ` +
          `Another 'blog publish' process holds it. If that process crashed, delete the lock file manually.`,
        );
      }
      // Short sleep (50ms) without blocking the event loop forever. Atomics.wait
      // on a zeroed shared int returns 'timed-out' after the delay.
      Atomics.wait(sharedBuf, 0, 0, 50);
    }
  }
}
