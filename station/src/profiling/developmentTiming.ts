import { PerformanceObserver } from "node:perf_hooks";

/** Releases development React measures after delivery; marks remain available for active spans. */
export function startDevelopmentTimingCleanup(): () => void {
  if (process.env.NODE_ENV === "production") return () => {};
  const observer = new PerformanceObserver(() => performance.clearMeasures());
  observer.observe({ entryTypes: ["measure"] });
  return () => {
    observer.disconnect();
    performance.clearMeasures();
  };
}
