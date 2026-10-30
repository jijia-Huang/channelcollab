/** One run at a time per thread; later messages wait their turn (busy_policy "queue"). */
const tails = new Map<string, Promise<void>>();
const pending = new Map<string, number>();

/** Queue `job` behind whatever is running in `key`. Returns whether it had to wait. */
export function enqueue(key: string, job: () => Promise<void>): { queued: boolean } {
  const ahead = pending.get(key) ?? 0;
  pending.set(key, ahead + 1);
  const run = async () => {
    try {
      await job();
    } finally {
      const left = (pending.get(key) ?? 1) - 1;
      if (left > 0) pending.set(key, left);
      else pending.delete(key);
    }
  };
  const tail = (tails.get(key) ?? Promise.resolve()).then(run, run);
  tails.set(key, tail);
  void tail.finally(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return { queued: ahead > 0 };
}

/** A job for `key` is running or waiting. */
export function isPending(key: string): boolean {
  return pending.has(key);
}

/** Any job, in any thread, is running or waiting. */
export function anyPending(): boolean {
  return pending.size > 0;
}
