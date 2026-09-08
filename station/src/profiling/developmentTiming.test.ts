import { afterEach, describe, expect, it } from "bun:test";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { startDevelopmentTimingCleanup } from "./developmentTiming.js";

afterEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
});

describe("development timing cleanup", () => {
  it("releases delivered measures without removing marks or hiding observed entries", async () => {
    const names: string[] = [];
    const consumer = new PerformanceObserver((entries) => {
      names.push(...entries.getEntries().map((entry) => entry.name));
    });
    consumer.observe({ entryTypes: ["measure"] });
    const stop = startDevelopmentTimingCleanup();
    try {
      performance.mark("active-span");
      for (let batch = 0; batch < 3; batch++) {
        for (let index = 0; index < 100; index++) {
          performance.measure("render", "active-span");
        }
        await setImmediate();
        expect(performance.getEntriesByType("measure")).toHaveLength(0);
      }
      expect(names).toHaveLength(300);
      expect(performance.getEntriesByName("active-span", "mark")).toHaveLength(1);
    } finally {
      stop();
      consumer.disconnect();
    }
  });

  it("disconnects on disposal and supports repeated renderer replacement", async () => {
    for (let replacement = 0; replacement < 3; replacement++) {
      const stop = startDevelopmentTimingCleanup();
      performance.measure("render", { start: 0, end: 1 });
      stop();
      stop();
      expect(performance.getEntriesByType("measure")).toHaveLength(0);
      performance.measure("after-disposal", { start: 0, end: 1 });
      await setImmediate();
      expect(performance.getEntriesByName("after-disposal", "measure")).toHaveLength(1);
      performance.clearMeasures();
    }
  });
});
