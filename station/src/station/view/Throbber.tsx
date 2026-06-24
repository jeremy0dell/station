// OpenTUI port of apps/tui's Throbber: one shared module-level animation
// clock (120ms) drives every throbber via useSyncExternalStore, so all
// markers tick in lockstep and the interval stops when the last throbber
// unmounts. Frame families and the attention style cycle match upstream.
import { memo, useCallback, useSyncExternalStore } from "react";
import { TextAttributes } from "@opentui/core";
import { STATION_COLORS } from "./theme.js";

export type ThrobberVariant = "circle" | "braille" | "attention" | "dots";

const DEFAULT_INTERVAL_MS = 120;

const CIRCLE_FRAMES = ["◜", "◠", "◝", "◞", "◡", "◟"] as const satisfies NonEmptyList<string>;
const BRAILLE_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const satisfies NonEmptyList<string>;
const DOT_FRAMES = [".  ", ".. ", "..."] as const satisfies NonEmptyList<string>;

export const Throbber = memo(function Throbber({ variant }: { variant: ThrobberVariant }) {
  const frameTick = useAnimationTick(variant === "attention" ? 2 : 1);

  if (variant === "attention") {
    // Style pulse on a stable "!": dim -> normal -> bold -> normal.
    const phase = positiveModulo(frameTick, 4);
    const attributes =
      phase === 0 ? TextAttributes.DIM : phase === 2 ? TextAttributes.BOLD : TextAttributes.NONE;
    return (
      <span fg={STATION_COLORS.red} attributes={attributes}>
        !
      </span>
    );
  }

  const frames =
    variant === "dots" ? DOT_FRAMES : variant === "circle" ? CIRCLE_FRAMES : BRAILLE_FRAMES;
  return <span>{cycle(frames, frameTick)}</span>;
});

type NonEmptyList<T> = readonly [T, ...T[]];

const animationClock = createAnimationClock();

type AnimationClock = {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
};

function createAnimationClock(): AnimationClock {
  let tick = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) {
      listener();
    }
  }

  function start() {
    if (interval !== undefined) return;
    interval = setInterval(() => {
      tick += 1;
      emit();
    }, DEFAULT_INTERVAL_MS);
  }

  function stop() {
    if (interval === undefined) return;
    clearInterval(interval);
    interval = undefined;
    tick = 0;
  }

  return {
    getSnapshot: () => tick,
    subscribe: (listener) => {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop();
        }
      };
    },
  };
}

function useAnimationTick(divisor: number): number {
  const getSnapshot = useCallback(
    () => Math.floor(animationClock.getSnapshot() / divisor),
    [divisor],
  );
  return useSyncExternalStore(animationClock.subscribe, getSnapshot, getSnapshot);
}

function cycle<T>(values: NonEmptyList<T>, tick: number): T {
  const index = positiveModulo(tick, values.length);
  return values[index] ?? values[0];
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
