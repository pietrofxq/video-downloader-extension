import { describe, it, expect } from 'vitest';
import { runWithConcurrency } from './concurrency.js';

function defer() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
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
    const events = [];
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
    await expect(runWithConcurrency(null, 1)).rejects.toThrow();
  });

  it('survives an onProgress callback that throws', async () => {
    const tasks = [() => Promise.resolve('a'), () => Promise.resolve('b')];
    const out = await runWithConcurrency(tasks, 1, () => {
      throw new Error('observer error');
    });
    expect(out).toEqual(['a', 'b']);
  });

  it('does not start more tasks after an in-flight failure', async () => {
    const started = [];
    const d = defer();
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
