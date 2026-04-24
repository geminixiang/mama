import { afterEach, describe, expect, test, vi } from "vitest";
import * as log from "../src/log.js";
import { SerialWorkQueue } from "../src/adapters/shared/serial-queue.js";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("SerialWorkQueue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("runs queued work sequentially", async () => {
    const queue = new SerialWorkQueue("Queue error");
    const first = createDeferred();
    const events: string[] = [];

    queue.enqueue(async () => {
      events.push("first:start");
      await first.promise;
      events.push("first:end");
    });

    queue.enqueue(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    expect(queue.size()).toBe(1);

    first.resolve();
    await first.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(queue.size()).toBe(0);
  });

  test("continues processing after a queued task throws", async () => {
    const queue = new SerialWorkQueue("Shared queue error");
    const warningSpy = vi.spyOn(log, "logWarning").mockImplementation(() => {});
    const events: string[] = [];

    queue.enqueue(async () => {
      events.push("first");
      throw new Error("boom");
    });

    queue.enqueue(async () => {
      events.push("second");
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["first", "second"]);
    expect(warningSpy).toHaveBeenCalledWith("Shared queue error", "boom");
    expect(queue.size()).toBe(0);
  });

  test("ignores empty follow-up processNext cycles after the queue drains", async () => {
    const queue = new SerialWorkQueue("Queue error");
    const work = vi.fn(async () => {});

    queue.enqueue(work);

    await Promise.resolve();
    await Promise.resolve();

    expect(work).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(0);
  });
});
