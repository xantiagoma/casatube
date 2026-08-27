/**
 * The permit counter that makes `MAX_CONCURRENT_DOWNLOADS` mean something.
 *
 * It meant nothing for most of this project's life: the number was in the PLAN,
 * in docker-compose and in the Dockerfile, and the worker awaited each job in
 * turn, so the real limit was always 1. These tests exist so that stops being
 * possible to believe without checking.
 */
import { expect, test } from "bun:test";
import { Semaphore } from "./semaphore";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("never lets more than N run at once", async () => {
  const gate = deferred();
  const sem = new Semaphore(3);
  let live = 0;
  let peak = 0;

  const tasks = Array.from({ length: 10 }, () =>
    sem.run(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await gate.promise;
      live -= 1;
    }),
  );

  await Bun.sleep(5);
  expect(peak).toBe(3);
  gate.resolve();
  await Promise.all(tasks);
  expect(peak).toBe(3);
});

test("a permit is released even when the work throws", async () => {
  const sem = new Semaphore(1);
  await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  // If the permit leaked, this would hang rather than fail.
  await expect(sem.run(async () => "after")).resolves.toBe("after");
});

test("waiters are served in order, not overtaken by newcomers", async () => {
  const sem = new Semaphore(1);
  const order: number[] = [];
  const held = deferred();

  const first = sem.run(async () => { await held.promise; order.push(0); });
  const rest = [1, 2, 3].map((n) => sem.run(async () => { order.push(n); }));

  held.resolve();
  await Promise.all([first, ...rest]);
  expect(order).toEqual([0, 1, 2, 3]);
});

test("a limit below one is treated as one rather than deadlocking", async () => {
  const sem = new Semaphore(0);
  await expect(sem.run(async () => "ran")).resolves.toBe("ran");
});
