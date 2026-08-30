import { describe, expect, it } from "bun:test";
import { DEFAULT_SCROLLBACK_LINES } from "../../config/stationConfig.js";
import { waitFor } from "../testing/waitFor.js";
import { createStationVtScreen } from "./screen.js";

describe("vt screen throughput", () => {
  it("coalesces a sustained burst into bounded version bumps", async () => {
    const screen = createStationVtScreen({
      size: { cols: 40, rows: 10 },
      flushIntervalMs: 150,
    });
    try {
      for (let index = 0; index < 500; index++) {
        screen.feed(`burst-line-${index}\r\n`);
      }
      await screen.whenIdle();
      await waitFor(() => screen.getVersion() >= 1);
      // Versions scale with elapsed time / interval, never with chunk count.
      expect(screen.getVersion()).toBeLessThanOrEqual(4);
    } finally {
      screen.dispose();
    }
  });

  it("normalizes direct consumers to the workspace scrollback bounds", () => {
    const aboveMaximum = createStationVtScreen({
      size: { cols: 20, rows: 5 },
      scrollback: Number.MAX_SAFE_INTEGER,
    });
    const belowMinimum = createStationVtScreen({
      size: { cols: 20, rows: 5 },
      scrollback: -1,
    });
    const fractional = createStationVtScreen({
      size: { cols: 20, rows: 5 },
      scrollback: 2.9,
    });
    const nonFinite = createStationVtScreen({
      size: { cols: 20, rows: 5 },
      scrollback: Number.NaN,
    });
    try {
      expect(aboveMaximum.unsafeEngine.options.scrollback).toBe(DEFAULT_SCROLLBACK_LINES);
      expect(belowMinimum.unsafeEngine.options.scrollback).toBe(0);
      expect(fractional.unsafeEngine.options.scrollback).toBe(2);
      expect(nonFinite.unsafeEngine.options.scrollback).toBe(DEFAULT_SCROLLBACK_LINES);
    } finally {
      aboveMaximum.dispose();
      belowMinimum.dispose();
      fractional.dispose();
      nonFinite.dispose();
    }
  });

  it("keeps default scrollback bounded across wide-screen reflow", async () => {
    const screen = createStationVtScreen({ size: { cols: 120, rows: 24 } });
    try {
      for (let start = 0; start < DEFAULT_SCROLLBACK_LINES + 100; start += 100) {
        screen.feed(
          Array.from(
            { length: 100 },
            (_, offset) => `${String(start + offset).padStart(5, "0")} ${"x".repeat(100)}\r\n`,
          ).join(""),
        );
      }
      await screen.whenIdle();
      expect(screen.bufferStats().baseY).toBe(DEFAULT_SCROLLBACK_LINES);
      expect(screen.bufferStats().length).toBeLessThanOrEqual(DEFAULT_SCROLLBACK_LINES + 24);

      screen.resize({ cols: 60, rows: 24 });
      await screen.whenIdle();
      expect(screen.bufferStats().baseY).toBeLessThanOrEqual(DEFAULT_SCROLLBACK_LINES);
      expect(screen.bufferStats().length).toBeLessThanOrEqual(DEFAULT_SCROLLBACK_LINES + 24);

      screen.resize({ cols: 120, rows: 24 });
      await screen.whenIdle();
      expect(screen.bufferStats().baseY).toBeLessThanOrEqual(DEFAULT_SCROLLBACK_LINES);
      expect(screen.bufferStats().length).toBeLessThanOrEqual(DEFAULT_SCROLLBACK_LINES + 24);
    } finally {
      screen.dispose();
    }
  });

  it("scrollback stays capped under sustained output", async () => {
    const screen = createStationVtScreen({
      size: { cols: 20, rows: 5 },
      scrollback: 100,
    });
    try {
      for (let index = 0; index < 5_000; index++) {
        screen.feed(`line-${index}\r\n`);
      }
      await screen.whenIdle();
      expect(screen.bufferStats().length).toBeLessThanOrEqual(105);
    } finally {
      screen.dispose();
    }
  });

  it("parses multi-megabyte output without unbounded growth", async () => {
    if (Bun.env.STATION_VT_STRESS !== "1") {
      expect(true).toEqual(true);
      return;
    }
    const screen = createStationVtScreen({
      size: { cols: 80, rows: 24 },
      scrollback: 1000,
      flushIntervalMs: 33,
    });
    try {
      const line = `${"y".repeat(78)}\r\n`;
      const chunk = line.repeat(820); // ~64KB
      const chunks = 64; // ~4MB total
      for (let index = 0; index < chunks; index++) {
        screen.feed(chunk);
      }
      await screen.whenIdle();
      expect(screen.bufferStats().length).toBeLessThanOrEqual(1024);
      expect(screen.getVersion()).toBeLessThan(chunks);
    } finally {
      screen.dispose();
    }
  });

  it("rebuilds a 200x50 styled grid within budget", async () => {
    if (Bun.env.STATION_VT_STRESS !== "1") {
      expect(true).toEqual(true);
      return;
    }
    const screen = createStationVtScreen({ size: { cols: 200, rows: 50 } });
    try {
      const styledLine = Array.from({ length: 25 }, (_, index) =>
        `\x1b[3${index % 8}m${"ab".repeat(4)}`,
      ).join("");
      screen.feed(Array.from({ length: 50 }, () => styledLine).join("\r\n"));
      await screen.whenIdle();

      const durations: number[] = [];
      for (let run = 0; run < 100; run++) {
        const start = performance.now();
        screen.buildRows({ cursorVisible: true });
        durations.push(performance.now() - start);
      }
      durations.sort((a, b) => a - b);
      const median = durations[Math.floor(durations.length / 2)] ?? 0;
      console.error(`buildVisibleRows 200x50 median: ${median.toFixed(3)}ms`);
      // Soft budget: ~3x headroom inside the 33ms flush interval.
      expect(median).toBeLessThan(10);
    } finally {
      screen.dispose();
    }
  });
});
