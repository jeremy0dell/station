import { CliRenderEvents } from "@opentui/core";
import type { StationTerminalTheme, StationTheme } from "../types.js";
import {
  parseStationTerminalPaletteObservation,
  stationTerminalPaletteObservationSignature,
} from "./observation.js";
import { resolveEmbeddedStationTheme } from "./theme.js";

const PALETTE_SIZE = 16 as const;
type ThemeRendererEvent = CliRenderEvents.PALETTE | CliRenderEvents.THEME_MODE;
type ThemeRendererListener = (payload: unknown) => void;

/** The narrow OpenTUI palette surface owned by the embedded appearance controller. */
export type StationThemeRenderer = Readonly<{
  getPalette(options: { size: typeof PALETTE_SIZE }): Promise<unknown>;
  clearPaletteCache(): void;
  on(event: ThemeRendererEvent, listener: ThemeRendererListener): unknown;
  off(event: ThemeRendererEvent, listener: ThemeRendererListener): unknown;
}>;

/** Race-safe external store that owns embedded palette observation and complete theme publication. */
export type StationThemeController = Readonly<{
  getSnapshot(): StationTheme;
  subscribe(listener: () => void): () => void;
  /** Attaches renderer listeners and starts the initial non-blocking-safe observation. */
  start(): Promise<void>;
  /** Permanently detaches listeners and invalidates every pending asynchronous publication. */
  dispose(): void;
}>;

/** Creates the embedded renderer's palette lifecycle and external theme store. */
export function createStationThemeController(
  renderer: StationThemeRenderer,
): StationThemeController {
  let snapshot: StationTheme = resolveEmbeddedStationTheme(null);
  let observationSignature: string | null = null;
  let generation = 0;
  let started = false;
  let disposed = false;
  let activeQuery = false;
  let pendingDrain = false;
  let pendingObservation = false;
  let pendingClear = false;
  let worker: Promise<void> | null = null;
  let startPromise: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const publish = (observation: StationTerminalTheme | null): void => {
    if (disposed) {
      return;
    }
    const nextSignature =
      observation === null ? null : stationTerminalPaletteObservationSignature(observation);
    if (nextSignature === observationSignature) {
      return;
    }
    observationSignature = nextSignature;
    snapshot = resolveEmbeddedStationTheme(observation);
    for (const listener of listeners) {
      listener();
    }
  };

  const queryPalette = async (
    queryGeneration: number,
    publishResult: boolean,
  ): Promise<void> => {
    activeQuery = true;
    try {
      const value = await renderer.getPalette({ size: PALETTE_SIZE });
      if (publishResult && !disposed && queryGeneration === generation) {
        publish(parseStationTerminalPaletteObservation(value));
      }
    } catch {
      if (publishResult && !disposed && queryGeneration === generation) {
        publish(null);
      }
    } finally {
      activeQuery = false;
    }
  };

  const clearRendererCache = (): void => {
    try {
      renderer.clearPaletteCache();
    } catch {
      // A renderer teardown racing disposal cannot make the safe fallback incomplete.
    }
  };

  const runWorker = async (): Promise<void> => {
    while (!disposed && (pendingDrain || pendingObservation)) {
      if (pendingDrain) {
        pendingDrain = false;
        await queryPalette(generation, false);
        if (disposed) {
          return;
        }
        // A stale OpenTUI query may repopulate its cache after invalidation, so clear only after it settles.
        pendingClear = true;
        pendingObservation = true;
        continue;
      }

      pendingObservation = false;
      if (pendingClear) {
        pendingClear = false;
        clearRendererCache();
      }
      const queryGeneration = generation;
      await queryPalette(queryGeneration, true);
    }
  };

  const ensureWorker = (): Promise<void> => {
    if (disposed) {
      return Promise.resolve();
    }
    if (worker !== null) {
      return worker;
    }
    const nextWorker = runWorker().finally(() => {
      if (worker === nextWorker) {
        worker = null;
      }
      if (!disposed && (pendingDrain || pendingObservation)) {
        void ensureWorker();
      }
    });
    worker = nextWorker;
    return nextWorker;
  };

  const requestObservation = (clearCache: boolean): Promise<void> => {
    if (disposed) {
      return Promise.resolve();
    }
    generation += 1;
    pendingObservation = true;
    pendingClear ||= clearCache;
    return ensureWorker();
  };

  const onPalette: ThemeRendererListener = (value) => {
    if (disposed) {
      return;
    }
    generation += 1;
    publish(parseStationTerminalPaletteObservation(value));
  };

  const onThemeMode: ThemeRendererListener = () => {
    if (disposed) {
      return;
    }
    generation += 1;
    pendingObservation = true;
    pendingClear = true;
    // Theme mode is only invalidation; the replacement palette remains authoritative.
    if (!activeQuery) {
      pendingDrain = true;
    }
    void ensureWorker();
  };

  const start = (): Promise<void> => {
    if (disposed) {
      return Promise.resolve();
    }
    if (started) {
      return startPromise ?? worker ?? Promise.resolve();
    }
    started = true;
    renderer.on(CliRenderEvents.PALETTE, onPalette);
    renderer.on(CliRenderEvents.THEME_MODE, onThemeMode);
    startPromise = requestObservation(false).finally(() => {
      startPromise = null;
    });
    return startPromise;
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    // Disposal advances the generation so late async work can never publish into a replacement tree.
    generation += 1;
    pendingDrain = false;
    pendingObservation = false;
    pendingClear = false;
    if (started) {
      renderer.off(CliRenderEvents.PALETTE, onPalette);
      renderer.off(CliRenderEvents.THEME_MODE, onThemeMode);
    }
    listeners.clear();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (disposed) {
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    dispose,
  };
}
