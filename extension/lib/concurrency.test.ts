import { describe, it, expect } from 'vitest';
import { runWithConcurrency, type ConcurrencyProgress } from './concurrency.js';

function defer<T = string>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runWithConcurrency', () => {
  it('returns results in input order even with mixed timing', async () => {
    const tasks = [
      () => new Promise((r) => setTimeout(() => r('a'), 30)),
      () => new Promise((r) => setTimeout(() => r('b'), 5)),
      () => new Promise((r) => setTimeout(() => r('c'), 15)),
    ];
    const out = await runWithConcurrency(tasks, 2);
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('respects the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return i;
    });
    await runWithConcurrency(tasks, 3);
    expect(maxInFlight).toBe(3);
  });

  it('calls onProgress after each task settles', async () => {
    const events: ConcurrencyProgress<string>[] = [];
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ];
    await runWithConcurrency(tasks, 2, (p) => events.push(p));
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.total === 3)).toBe(true);
    expect(events[events.length - 1].done).toBe(3);
  });

  it('rejects on first error', async () => {
    const tasks = [
      () => Promise.resolve(1),
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve(3),
    ];
    await expect(runWithConcurrency(tasks, 2)).rejects.toThrow('boom');
  });

  it('handles empty input', async () => {
    expect(await runWithConcurrency([], 4)).toEqual([]);
  });

  it('rejects invalid concurrency', async () => {
    await expect(runWithConcurrency([], 0)).rejects.toThrow();
    await expect(runWithConcurrency([], -1)).rejects.toThrow();
    await expect(runWithConcurrency([], 1.5)).rejects.toThrow();
  });

  it('rejects invalid task array', async () => {
    await expect(
      runWithConcurrency(null as unknown as (() => Promise<unknown>)[], 1),
    ).rejects.toThrow();
  });

  it('survives an onProgress callback that throws', async () => {
    const tasks = [() => Promise.resolve('a'), () => Promise.resolve('b')];
    const out = await runWithConcurrency(tasks, 1, () => {
      throw new Error('observer error');
    });
    expect(out).toEqual(['a', 'b']);
  });

  it('rejects synchronously when called with an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort(new Error('pre-aborted'));
    const tasks = [() => Promise.resolve('a')];
    await expect(runWithConcurrency(tasks, 2, undefined, ac.signal)).rejects.toThrow('pre-aborted');
  });

  it('stops starting new tasks once the signal aborts mid-run', async () => {
    const started: number[] = [];
    const ac = new AbortController();
    // Both initial tasks hang on deferreds so the two workers are stuck
    // and can't naturally advance to indices 2..5 — that way, any task
    // beyond the first wave that DOES start can only have been picked
    // up because the abort path didn't actually short-circuit.
    const d0 = defer<string>();
    const d1 = defer<string>();
    const tasks = Array.from({ length: 6 }, (_, i) => async () => {
      started.push(i);
      if (i === 0) return d0.promise;
      if (i === 1) return d1.promise;
      return `r${i}`;
    });
    const runPromise = runWithConcurrency(tasks, 2, undefined, ac.signal);
    // Yield once so both workers actually enter their first task.
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual([0, 1]);
    ac.abort(new Error('user canceled'));
    // Resolve both blockers — workers wake up, see aborted=true, and bail
    // BEFORE pulling the next index out of the queue.
    d0.resolve('a');
    d1.resolve('b');
    await expect(runPromise).rejects.toThrow('user canceled');
    expect(started).toEqual([0, 1]);
  });

  it('rejects with the signal.reason when one is provided', async () => {
    const ac = new AbortController();
    const tasks = Array.from({ length: 4 }, () => async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'x';
    });
    const runPromise = runWithConcurrency(tasks, 2, undefined, ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    const reason = new Error('custom abort reason');
    ac.abort(reason);
    await expect(runPromise).rejects.toBe(reason);
  });

  it('does not start more tasks after an in-flight failure', async () => {
    const started: number[] = [];
    const d = defer<string>();
    const tasks = [
      () => {
        started.push(0);
        return Promise.reject(new Error('fail'));
      },
      () => {
        started.push(1);
        return d.promise;
      },
      () => {
        started.push(2);
        return Promise.resolve('c');
      },
      () => {
        started.push(3);
        return Promise.resolve('d');
      },
    ];
    d.resolve('b');
    await expect(runWithConcurrency(tasks, 2)).rejects.toThrow('fail');
    // 0 and 1 start in the first wave; 2 and 3 must not start after the failure.
    expect(started).toEqual([0, 1]);
  });
});
