import type { MouseEvent } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useState } from "react";
import { normalizeStationMouseEvent, type StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import { tweenStationColor } from "../stationButton/colors.js";
import {
  toOpenTuiColor,
  useStationTheme,
} from "../theme/index.js";
import { useHoverPointer } from "../useHoverPointer.js";

export type WelcomeScreenProps = {
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
  focused?: boolean;
  /** Restored sessions exist underneath, so offer a "Continue" CTA to dismiss into them. */
  canContinue?: boolean;
};

const OPEN_LABEL = "Open project view";
const CONTINUE_LABEL = "Continue →";
const SHIMMER_WIDTH = 6;
const SHIMMER_INTERVAL_MS = 80;
const FULL_WORDMARK_COLUMNS = 32;
const FULL_WORDMARK = [
  "     _        _   _             ",
  " ___| |_ __ _| |_(_) ___  _ __  ",
  "/ __| __/ _` | __| |/ _ \\| '_ \\ ",
  "\\__ \\ || (_| | |_| | (_) | | | |",
  "|___/\\__\\__,_|\\__|_|\\___/|_| |_|",
] as const;
export function WelcomeScreen({
  dispatchMouse,
  focused = true,
  canContinue = false,
}: WelcomeScreenProps) {
  const { width, height } = useTerminalDimensions();
  // Only the decorative wordmark swaps variants; actions keep the same semantic boxes.
  const fullWordmark = width >= FULL_WORDMARK_COLUMNS + 4 && height >= 13;

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      overflow="hidden"
    >
      <box
        width="100%"
        maxWidth={42}
        maxHeight="100%"
        minHeight={0}
        flexShrink={1}
        flexDirection="column"
        alignItems="center"
        overflow="hidden"
      >
        <WelcomeIdentity full={fullWordmark} />
        <box height={1} flexShrink={1} />
        <WelcomeActions
          canContinue={canContinue}
          dispatchMouse={dispatchMouse}
          focused={focused}
        />
      </box>
    </box>
  );
}

function WelcomeButton({
  id,
  label,
  target,
  dispatchMouse,
  focused,
  shimmer,
}: {
  id: string;
  label: string;
  target: MouseTargetRef;
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
  focused: boolean;
  shimmer: boolean;
}) {
  const theme = useStationTheme();
  const [hovered, setHovered] = useState(false);
  const shimmerFrame = useShimmerFrame(shimmer && hovered);
  const pointerProps = useHoverPointer({ onHoverChange: setHovered });
  const active = focused || hovered;
  const borderFg = active ? theme.welcome.borderActive : theme.welcome.border;
  const buttonBackground = focused ? theme.welcome.button : theme.welcome.buttonMuted;
  const onMouseDown = (event: MouseEvent): void => {
    event.stopPropagation();
    dispatchMouse(target, normalizeStationMouseEvent(event));
  };

  return (
    <box
      id={id}
      width="100%"
      flexShrink={0}
      flexDirection="column"
      border
      borderColor={toOpenTuiColor(borderFg)}
      backgroundColor={toOpenTuiColor(buttonBackground)}
      {...pointerProps}
      onMouseDown={onMouseDown}
      overflow="hidden"
    >
      <box
        width="100%"
        flexDirection="row"
        justifyContent="center"
        backgroundColor={toOpenTuiColor(buttonBackground)}
      >
        <ShimmerLabel
          text={label}
          focused={focused}
          hovered={shimmer && hovered}
          shimmerFrame={shimmerFrame}
        />
      </box>
    </box>
  );
}

function WelcomeIdentity({ full }: { full: boolean }) {
  const theme = useStationTheme();
  if (!full) {
    return (
      <box
        width={16}
        maxWidth="100%"
        minHeight={0}
        flexShrink={1}
        flexDirection="column"
        alignItems="center"
        overflow="hidden"
        border={["bottom"]}
        borderColor={toOpenTuiColor(theme.welcome.borderActive)}
      >
        <text fg={toOpenTuiColor(theme.welcome.muted)}>Welcome to</text>
        <text fg={toOpenTuiColor(theme.welcome.wordmark)}>station</text>
      </box>
    );
  }
  return (
    <box
      width={FULL_WORDMARK_COLUMNS}
      maxWidth="100%"
      minHeight={0}
      flexShrink={1}
      flexDirection="column"
      alignItems="center"
      overflow="hidden"
      border={["top"]}
      borderColor={toOpenTuiColor(theme.welcome.border)}
    >
      <text fg={toOpenTuiColor(theme.welcome.muted)}>Welcome to</text>
      {FULL_WORDMARK.map((text) => (
        <text key={text} fg={toOpenTuiColor(theme.welcome.wordmark)}>
          {text}
        </text>
      ))}
    </box>
  );
}

function WelcomeActions({
  canContinue,
  dispatchMouse,
  focused,
}: {
  canContinue: boolean;
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
  focused: boolean;
}) {
  return (
    <box
      width="100%"
      flexShrink={canContinue ? 1 : 0}
      flexDirection="column"
      overflow="hidden"
    >
      {canContinue ? (
        <>
          <WelcomeButton
            id="station-welcome-continue"
            label={CONTINUE_LABEL}
            target={{ kind: "welcomeContinue" }}
            dispatchMouse={dispatchMouse}
            focused={focused}
            shimmer
          />
          <box height={1} flexShrink={1} />
        </>
      ) : null}
      <WelcomeButton
        id="station-welcome-open"
        label={OPEN_LABEL}
        target={{ kind: "welcomeOpenProjectView" }}
        dispatchMouse={dispatchMouse}
        focused={!canContinue && focused}
        shimmer={!canContinue}
      />
    </box>
  );
}

function ShimmerLabel({
  text,
  focused,
  hovered,
  shimmerFrame,
}: {
  text: string;
  focused: boolean;
  hovered: boolean;
  shimmerFrame: number;
}): ReactNode {
  const theme = useStationTheme();
  const characters = Array.from(text);
  const shimmerCenter = shimmerFrame % Math.max(1, characters.length);
  return (
    <box flexDirection="row">
      {characters.map((char, index) => {
        const intensity = hovered ? shimmerIntensity(index, shimmerCenter) : 0;
        const baseBg = focused ? theme.welcome.button : theme.welcome.buttonMuted;
        const bg =
          intensity > 0
            ? tweenStationColor(theme.welcome.buttonHover, theme.welcome.shimmer, intensity)
            : baseBg;
        const fg =
          intensity > 0
            ? tweenStationColor(theme.welcome.wordmark, theme.welcome.shimmerPeak, intensity)
            : focused
              ? theme.welcome.wordmark
              : theme.welcome.muted;
        return (
          <text key={index} fg={toOpenTuiColor(fg)} bg={toOpenTuiColor(bg)}>
            {char}
          </text>
        );
      })}
    </box>
  );
}

function useShimmerFrame(active: boolean): number {
  const renderer = useRenderer();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) {
      setFrame(0); // restart the sweep from the left on the next hover
      return;
    }
    renderer.requestLive();
    const id = setInterval(() => {
      setFrame((value) => (value + 1) % 1_000);
    }, SHIMMER_INTERVAL_MS);
    return () => {
      clearInterval(id);
      renderer.dropLive();
    };
  }, [active, renderer]);
  return frame;
}

// Smoothstep falloff so the band's edges fade gently instead of a hard ramp;
// the center (distance 0) still peaks at 1 so it lands on the full shimmer color.
function shimmerIntensity(index: number, center: number): number {
  const distance = Math.abs(index - center);
  if (distance > SHIMMER_WIDTH) {
    return 0;
  }
  const t = 1 - distance / SHIMMER_WIDTH;
  return t * t * (3 - 2 * t);
}
