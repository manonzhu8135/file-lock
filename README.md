# file-lock

Exclusive file locking for Node.js with crash recovery. Uses atomic `link(2)` to acquire and PID-checking to steal locks left behind by dead processes.

## Usage

```js
import { FileLock } from 'file-lock';

const lock = new FileLock('my-resource', {
  lockPath: '/tmp/my-resource.lock',
  timeout: 5000,
  pollInterval: 100,
});

if (await lock.acquire()) {
  try {
    // critical section
  } finally {
    await lock.release();
  }
}
```

## Why

`flock(2)` locks are automatically released when a process exits, but they are
not visible across NFS or to other tools that inspect the filesystem. A lock
*file* is visible everywhere, but it does not clean itself up after a crash.
This library bridges that gap: it uses a lock file for portability and
visibility, and recovers from crashes by checking whether the PID written
inside the lock file is still alive.

The trade-off is a TOCTOU race between the liveness check and the steal. If a
process is killed and another process starts in the exact window between the
check and the `unlink`, the new process could steal a lock that was about to be
reused. There is no way to close this race in userspace without a daemon, and a
daemon would violate the zero-dependency constraint.

## Edge case you will hit

If two processes both try to steal a stale lock simultaneously, one will win the
`link(2)` and the other will get `EEXIST` and retry. This is correct and safe —
the loser will see the winner's PID on the next iteration and back off. But if
you see acquire times longer than expected under contention, this retry loop is
why.

## API

**`new FileLock(resource, options?)`**

- `resource` (string, required): logical name, used to derive a default lock path.
- `options.lockPath` (string): full path to the lock file. Defaults to
  `$TMPDIR/file-lock-<resource>.lock`.
- `options.timeout` (number): max ms to wait. `0` means try once. Default `0`.
- `options.pollInterval` (number): ms between retries. Default `100`.
- `options.now` (function): clock returning epoch ms, for testing.
- `options.sleep` (function): `async (ms) => void`, for testing.

**`lock.acquire()`** → `Promise<boolean>`

Returns `true` if the lock was acquired, `false` if the timeout elapsed. Throws
if already held by this instance.

**`lock.release()`** → `Promise<void>`

Unlinks the lock file. Safe to call when not held or multiple times.

**`lock.isHeld()`** → `boolean`

Whether this instance currently holds the lock.
