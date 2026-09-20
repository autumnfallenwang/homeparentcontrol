import { afterEach, describe, expect, it, vi } from "vitest";
import { type Job, runJobNow, startScheduler, stopScheduler } from "./scheduler.js";

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
});

const job = (over: Partial<Job> = {}): Job => ({
  name: `job-${Math.random()}`,
  everyMs: 1000,
  run: async () => {},
  ...over,
});

describe("runJobNow", () => {
  it("runs the body", async () => {
    const run = vi.fn(async () => {});
    await runJobNow(job({ run }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ The property that matters most. An unhandled rejection inside a
   * setInterval callback takes the whole process down under Node's default
   * policy — so one bad row in the 60-second liveness job would stop all
   * health reporting until someone noticed the pod restarting.
   */
  it("swallows a throw rather than letting it escape", async () => {
    const boom = job({
      run: async () => {
        throw new Error("boom");
      },
    });
    await expect(runJobNow(boom)).resolves.toBeUndefined();
  });

  it("keeps running after a failure", async () => {
    let calls = 0;
    const flaky = job({
      run: async () => {
        calls++;
        if (calls === 1) throw new Error("first one fails");
      },
    });
    await runJobNow(flaky);
    await runJobNow(flaky);
    expect(calls).toBe(2);
  });

  it("never overlaps itself", async () => {
    // A projection run slower than its own 5-minute interval must not start a
    // second copy: two would double-advance the watermark.
    let concurrent = 0;
    let maxConcurrent = 0;
    let release: (() => void) | undefined;
    const slow = job({
      run: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        concurrent--;
      },
    });

    const first = runJobNow(slow);
    await new Promise((r) => setTimeout(r, 5));
    const second = runJobNow(slow); // should be skipped, not queued
    release?.();
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
  });
});

describe("startScheduler", () => {
  it("fires on the interval", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    startScheduler([job({ everyMs: 1000, run })]);

    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3100);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("can run once at startup", async () => {
    const run = vi.fn(async () => {});
    startScheduler([job({ everyMs: 60_000, run, runOnStart: true })]);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("is idempotent per name — a double call cannot double-schedule", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const j = job({ name: "same", everyMs: 1000, run });
    startScheduler([j]);
    startScheduler([j]);

    await vi.advanceTimersByTimeAsync(1100);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops everything on stopScheduler", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    startScheduler([job({ everyMs: 1000, run })]);
    stopScheduler();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
  });
});
