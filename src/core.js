/**
 * File-based exclusive lock using atomic link() on POSIX systems.
 *
 * Design choice: We use fs.link() to create the lock file because link(2) is
 * atomic on POSIX filesystems — it either succeeds (creating a new hard link)
 * or fails with EEXIST if the target already exists. This is stronger than
 * O_EXCL open() because it survives NFS quirks better, and stronger than
 * rename() because rename overwrites silently.
 *
 * Crash safety: The lock is a file on disk. If the process dies, the file
 * remains. To recover, we store the PID of the lock holder inside the lock
 * file. On acquire, if the lock exists, we read the PID and check whether that
 * PID is still alive. If it is not, we steal the lock by unlinking and
 * re-linking. This is inherently racy (TOCTOU between the liveness check and
 * the steal), but it is the best a userspace library can do without a daemon.
 * We document this clearly.
 *
 * Non-goals: No shared/read locks, no recursive locking, no async API. One
 * process, one exclusive lock, released or stolen. Keeping the surface small
 * makes the edge cases tractable.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * @typedef {Object} FileLockOptions
 * @property {string} [lockPath] - Full path to the lock file. If omitted, a
 *   path is derived from the resource name under the OS temp directory.
 * @property {number} [timeout] - Maximum milliseconds to wait. 0 means try
 *   once and fail immediately. Default 0.
 * @property {number} [pollInterval] - Milliseconds between retry attempts.
 *   Default 100.
 * @property {function(): number} [now] - Clock function returning epoch ms.
 *   Injected for deterministic tests; defaults to Date.now.
 * @property {function(number): void} [sleep] - Sleep function taking ms.
 *   Injected for deterministic tests; defaults to a promise-based delay.
 */

/**
 * Check whether a process is currently running.
 * Uses process.kill(pid, 0) which sends signal 0 (no-op) — it throws if the
 * PID does not exist or we lack permission, and succeeds silently if the PID
 * is alive. We treat EPERM as "alive" (the process exists, we just can't
 * signal it).
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Read the PID stored in a lock file. Returns 0 if the file is empty or
 * contains non-integer content — we treat a corrupt lock as "no owner" so it
 * can be stolen.
 *
 * @param {string} path
 * @returns {Promise<number>}
 */
async function readPid(path) {
  let content;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch {
    return 0;
  }
  const trimmed = content.trim();
  const pid = parseInt(trimmed, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

export class FileLock {
  /**
   * @param {string} resource - A logical name for what is being locked. Used
     *   to derive a default lockPath if none is given.
   * @param {FileLockOptions} [options]
   */
  constructor(resource, options = {}) {
    if (typeof resource !== 'string' || resource.length === 0) {
      throw new TypeError('resource must be a non-empty string');
    }
    this.resource = resource;
    this.lockPath = options.lockPath || join(tmpdir(), `file-lock-${resource}.lock`);
    this.timeout = options.timeout ?? 0;
    this.pollInterval = options.pollInterval ?? 100;
    this.now = options.now || (() => Date.now());
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this._held = false;
  }

  /**
   * Attempt to acquire the lock. Resolves to true if acquired, false if the
   * timeout elapsed without acquiring.
   *
   * The acquire loop: write our PID to a temp file, then try to hard-link it
   * to the lock path. If link succeeds, we hold the lock. If it fails with
   * EEXIST, we check whether the current holder is alive; if not, we steal by
   * unlinking and retrying. If the holder is alive, we sleep and retry until
   * timeout.
   *
   * @returns {Promise<boolean>}
   */
  async acquire() {
    if (this._held) {
      throw new Error('lock already held by this FileLock instance');
    }
    const start = this.now();
    const tempPath = `${this.lockPath}.${process.pid}.${this.now()}.${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tempPath, String(process.pid), 'utf8');

    try {
      for (;;) {
        try {
          await fs.link(tempPath, this.lockPath);
          this._held = true;
          return true;
        } catch (err) {
          if (err.code !== 'EEXIST') {
            throw err;
          }
        }

        // Lock exists. Try to steal if the holder is dead.
        const ownerPid = await readPid(this.lockPath);
        if (ownerPid === 0 || !isProcessAlive(ownerPid)) {
          // Race: another process may have already stolen or released between
          // our check and this unlink. Suppress ENOENT — just retry the link.
          try {
            await fs.unlink(this.lockPath);
          } catch (err) {
            if (err.code !== 'ENOENT') {
              throw err;
            }
          }
          continue;
        }

        // Holder is alive. Check timeout.
        if (this.timeout === 0) {
          return false;
        }
        const elapsed = this.now() - start;
        if (elapsed >= this.timeout) {
          return false;
        }
        await this.sleep(Math.min(this.pollInterval, this.timeout - elapsed));
      }
    } finally {
      // Clean up the temp file whether we succeeded or failed.
      try {
        await fs.unlink(tempPath);
      } catch {
        // Best-effort; temp file is unique so it won't collide.
      }
    }
  }

  /**
   * Release the lock by unlinking the lock file. Safe to call when not held
   * (no-op). Also safe to call multiple times.
   *
   * @returns {Promise<void>}
   */
  async release() {
    if (!this._held) {
      return;
    }
    this._held = false;
    try {
      await fs.unlink(this.lockPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  /**
   * True if this instance currently believes it holds the lock.
   *
   * @returns {boolean}
   */
  isHeld() {
    return this._held;
  }
}
