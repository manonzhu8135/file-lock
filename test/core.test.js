import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileLock } from '../src/index.js';

function uniqueLockPath() {
  return join(tmpdir(), `test-file-lock-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`);
}

test('acquire returns true when the lock is free', async () => {
  const path = uniqueLockPath();
  const lock = new FileLock('res', { lockPath: path });
  const acquired = await lock.acquire();
  assert.equal(acquired, true);
  assert.equal(lock.isHeld(), true);
  await lock.release();
});

test('release makes the lock available again', async () => {
  const path = uniqueLockPath();
  const lock1 = new FileLock('res', { lockPath: path });
  const lock2 = new FileLock('res', { lockPath: path });

  assert.equal(await lock1.acquire(), true);
  await lock1.release();
  assert.equal(await lock2.acquire(), true);
  await lock2.release();
});

test('second acquire fails immediately with timeout 0 when held', async () => {
  const path = uniqueLockPath();
  const lock1 = new FileLock('res', { lockPath: path });
  const lock2 = new FileLock('res', { lockPath: path });

  assert.equal(await lock1.acquire(), true);
  assert.equal(await lock2.acquire(), false);
  await lock1.release();
});

test('lock file contains the PID of the holder', async () => {
  const path = uniqueLockPath();
  const lock = new FileLock('res', { lockPath: path });
  await lock.acquire();
  const content = await fs.readFile(path, 'utf8');
  assert.equal(content, String(process.pid));
  await lock.release();
});

test('release is a no-op when not held', async () => {
  const path = uniqueLockPath();
  const lock = new FileLock('res', { lockPath: path });
  // Should not throw
  await lock.release();
});

test('release is idempotent', async () => {
  const path = uniqueLockPath();
  const lock = new FileLock('res', { lockPath: path });
  await lock.acquire();
  await lock.release();
  await lock.release();
});

test('acquire throws if already held by this instance', async () => {
  const path = uniqueLockPath();
  const lock = new FileLock('res', { lockPath: path });
  await lock.acquire();
  await assert.rejects(() => lock.acquire(), { message: 'lock already held by this FileLock instance' });
  await lock.release();
});

test('stale lock from a dead PID is stolen', async () => {
  const path = uniqueLockPath();
  // Write a lock file with a PID that is almost certainly not running.
  // PID 2147483647 is INT_MAX — extremely unlikely to be a live process.
  await fs.writeFile(path, '2147483647', 'utf8');

  const lock = new FileLock('res', { lockPath: path });
  assert.equal(await lock.acquire(), true);
  assert.equal(lock.isHeld(), true);
  await lock.release();
});

test('corrupt lock file (non-integer content) is treated as stale', async () => {
  const path = uniqueLockPath();
  await fs.writeFile(path, 'not-a-pid', 'utf8');

  const lock = new FileLock('res', { lockPath: path });
  assert.equal(await lock.acquire(), true);
  await lock.release();
});

test('empty lock file is treated as stale', async () => {
  const path = uniqueLockPath();
  await fs.writeFile(path, '', 'utf8');

  const lock = new FileLock('res', { lockPath: path });
  assert.equal(await lock.acquire(), true);
  await lock.release();
});

test('timeout with polling eventually acquires after release', async () => {
  const path = uniqueLockPath();
  let currentTime = 1000;
  const sleepCalls = [];

  const lock1 = new FileLock('res', {
    lockPath: path,
    timeout: 5000,
    pollInterval: 100,
    now: () => currentTime,
    sleep: (ms) => { sleepCalls.push(ms); currentTime += ms; return Promise.resolve(); },
  });
  const lock2 = new FileLock('res', {
    lockPath: path,
    timeout: 5000,
    pollInterval: 100,
    now: () => currentTime,
    sleep: (ms) => { sleepCalls.push(ms); currentTime += ms; return Promise.resolve(); },
  });

  assert.equal(await lock1.acquire(), true);

  // lock2 will try, fail, sleep. On the first sleep we release lock1.
  // We override lock2's sleep so that after the first sleep call, lock1 is released.
  let firstSleepDone = false;
  lock2.sleep = async (ms) => {
    sleepCalls.push(ms);
    currentTime += ms;
    if (!firstSleepDone) {
      firstSleepDone = true;
      await lock1.release();
    }
  };

  assert.equal(await lock2.acquire(), true);
  assert.equal(lock2.isHeld(), true);
  await lock2.release();
});

test('timeout expires and returns false', async () => {
  const path = uniqueLockPath();
  let currentTime = 1000;
  const lock1 = new FileLock('res', { lockPath: path });
  const lock2 = new FileLock('res', {
    lockPath: path,
    timeout: 300,
    pollInterval: 100,
    now: () => currentTime,
    sleep: (ms) => { currentTime += ms; return Promise.resolve(); },
  });

  await lock1.acquire();
  // lock1 is held by this process, so it's alive — lock2 cannot steal.
  assert.equal(await lock2.acquire(), false);
  await lock1.release();
});

test('constructor throws on empty resource', () => {
  assert.throws(() => new FileLock(''), TypeError);
});

test('constructor throws on non-string resource', () => {
  assert.throws(() => new FileLock(123), TypeError);
});
