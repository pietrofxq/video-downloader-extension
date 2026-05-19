/**
 * Run an array of async tasks with a bounded concurrency. Returns an array
 * of results in the same order as the inputs.
 *
 * Designed for v0.6's segment fetch + decrypt fan-out: ~30-300 segments
 * per HLS lesson, limited to 4 in flight so we don't hammer the CDN or
 * exhaust offscreen-document memory.
 *
 * Calls `onProgress({ done, total, value, index })` after each task settles
 * (success or failure). Failures throw immediately and cancel remaining
 * not-yet-started tasks; in-flight tasks still resolve.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} concurrency
 * @param {(p: { done: number, total: number, value: T, index: number }) => void} [onProgress]
 * @returns {Promise<T[]>}
 */
export async function runWithConcurrency(tasks, concurrency, onProgress) {
  if (!Array.isArray(tasks)) throw new TypeError('runWithConcurrency: tasks must be an array');
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('runWithConcurrency: concurrency must be a positive integer');
  }
  const total = tasks.length;
  const results = new Array(total);
  let nextIndex = 0;
  let done = 0;
  let aborted = false;
  let abortError = null;

  async function worker() {
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
