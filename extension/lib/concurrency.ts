// Run an array of async tasks with a bounded concurrency. Returns
// results in input order. Designed for v0.6's segment fetch + decrypt
// fan-out (~30-300 segments per HLS lesson, 4 in flight). Failures
// throw immediately and cancel remaining not-yet-started tasks;
// in-flight tasks still resolve.

export interface ConcurrencyProgress<T> {
  done: number;
  total: number;
  value: T;
  index: number;
}

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onProgress?: (p: ConcurrencyProgress<T>) => void,
): Promise<T[]> {
  if (!Array.isArray(tasks)) throw new TypeError('runWithConcurrency: tasks must be an array');
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('runWithConcurrency: concurrency must be a positive integer');
  }
  const total = tasks.length;
  const results: T[] = new Array(total);
  let nextIndex = 0;
  let done = 0;
  let aborted = false;
  let abortError: unknown = null;

  async function worker(): Promise<void> {
    while (true) {
      if (aborted) return;
      const i = nextIndex++;
      if (i >= total) return;
      try {
        const value = await tasks[i]();
        if (aborted) return;
        results[i] = value;
        done += 1;
        try {
          onProgress?.({ done, total, value, index: i });
        } catch {
          // ignore observer errors
        }
      } catch (err) {
        aborted = true;
        abortError = err;
        return;
      }
    }
  }

  const lanes = Math.min(concurrency, Math.max(total, 1));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  if (aborted) throw abortError;
  return results;
}
