import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const STORAGE_LOCK_FILE = '.jizhang-storage.lock';
export const RESTORE_PENDING_FILE = '.jizhang-restore-in-progress';

/** Cooperating server/maintenance processes hold this for their entire storage lifetime. */
export function acquireStorageLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  try {
    readFileSync(path.join(dataDir, RESTORE_PENDING_FILE));
    throw new Error(
      'An incomplete restore exists in this data directory. Recover into a new empty directory before starting.',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const file = path.join(dataDir, STORAGE_LOCK_FILE);
  const token = randomUUID();
  let descriptor: number;
  try {
    descriptor = openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Storage is locked: ${file}. Stop every server/maintenance writer first. ` +
          'After a crash, verify that no writer is running before manually removing this lock. ' +
          'A PID from another container is not evidence that the lock is stale.',
      );
    }
    throw error;
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(file);
    throw error;
  }
  closeSync(descriptor);
  let released = false;
  return () => {
    if (released) return;
    const current = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown };
    if (current.token !== token)
      throw new Error('Storage lock ownership changed; refusing to remove it.');
    unlinkSync(file);
    released = true;
  };
}
