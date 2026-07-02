import type { MouseEvent } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useState } from "react";
import { normalizeStationMouseEvent, type StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import { STATION_COLORS } from "../station/view/theme.js";
import { lerpColor } from "../stationButton/colors.js";
import { useHoverPointer } from "../useHoverPointer.js";

export type WelcomeScreenProps = {
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
  focused?: boolean;
  /** Restored sessions exist underneath, so offer a "Continue" CTA to dismiss into them. */
  canContinue?: boolean;
};

const OPEN_LABEL = "Open project view";
const CONTINUE_LABEL = "Continue →";
// Width fits the longest label so both stacked CTAs align.
const MIN_BUTTON_WIDTH = OPEN_LABEL.length + 8;
const BUTTON_BG = STATION_COLORS.chrome.welcomeButton.background;
const BUTTON_BG_MUTED = STATION_COLORS.chrome.welcomeButton.mutedBackground;
const BUTTON_BG_HOVER = STATION_COLORS.chrome.welcomeButton.hoverBackground;
// Soft, desaturated peak so the looping shimmer reads as a gentle light pass
// rather than a saturated cyan band sweeping the label.
export const WELCOME_BUTTON_SHIMMER_BG = STATION_COLORS.chrome.welcomeButton.shimmerBackground;
const SHIMMER_WIDTH = 6;
const SHIMMER_INTERVAL_MS = 80;
const FULL_WORDMARK = [
  "     _        _   _             ",
  " ___| |_ __ _| |_(_) ___  _ __  ",
  "/ __| __/ _` | __| |/ _ \\| '_ \\ ",
  "\\__ \\ || (_| | |_| | (_) | | | |",
  "|___/\\__\\__,_|\\__|_|\\___/|_| |_|",
] as const;
const COMPACT_WORDMARK = ["station"] as const;

type WelcomeLine = {
  text: string;
  fg: string;
};

export function WelcomeScreen({
  dispatchMouse,
  focused = true,
  canContinue = false,
}: WelcomeScreenProps) {
  const { width, height } = useTerminalDimensions();
  const workspaceRows = Math.max(1, height);
  const content = welcomeLines(width, workspaceRows);
  // Two stacked CTAs (with a gap) when continuing is possible, else one.
  const ctaRows = canContinue ? 7 : 3;
  const gapRows = content.length > 0 && workspaceRows - content.length - ctaRows >= 1 ? 1 : 0;
  const usedRows = content.length + gapRows + ctaRows;
  const topPad = Math.max(0, Math.floor((workspaceRows - usedRows) / 2));
  const buttonWidth = Math.max(MIN_BUTTON_WIDTH, Math.min(42, width - 4));

  return (
    <box width="100%" height="100%" flexDirection="column" alignItems="center" overflow="hidden">
      {topPad > 0 ? <box height={topPad} /> : null}
      {content.map((line, index) => (
        <text key={`${index}:${line.text}`} fg={line.fg}>
          {line.text}
        </text>
      ))}
      {gapRows > 0 ? <box height={gapRows} /> : null}
      {canContinue ? (
        <>
          <WelcomeButton
            width={buttonWidth}
            label={CONTINUE_LABEL}
            target={{ kind: "welcomeContinue" }}
            dispatchMouse={dispatchMouse}
            focused={focused}
            shimmer
          />
          <box height={1} />
          <WelcomeButton
            width={buttonWidth}
            label={OPEN_LABEL}
            target={{ kind: "welcomeOpenProjectView" }}
            dispatchMouse={dispatchMouse}
            focused={false}
            shimmer={false}
          />
        </>
      ) : (
        <WelcomeButton
          width={buttonWidth}
          label={OPEN_LABEL}
          target={{ kind: "welcomeOpenProjectView" }}
          dispatchMouse={dispatchMouse}
          focused={focused}
          shimmer
        />
      )}
    </box>
  );
}

function WelcomeButton({
  width,
  label,
  target,
  dispatchMouse,
  focused,
  shimmer,
}: {
  width: number;
  label: string;
  target: MouseTargetRef;
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
  focused: boolean;
  shimmer: boolean;
}) {
  const innerWidth = Math.max(label.length, width - 2);
  const line = `+${"-".repeat(innerWidth)}+`;
  const [hovered, setHovered] = useState(false);
  const shimmerFrame = useShimmerFrame(shimmer && hovered);
  const pointerProps = useHoverPointer({ onHoverChange: setHovered });
  const active = focused || hovered;
  const borderFg = active ? STATION_COLORS.blue : STATION_COLORS.chrome.mutedBorder;
  const onMouseDown = (event: MouseEvent): void => {
    event.stopPropagation();
    dispatchMouse(target, normalizeStationMouseEvent(event));
  };

  return (
    <box
      width={innerWidth + 2}
      height={3}
      flexDirection="column"
      {...pointerProps}
      onMouseDown={onMouseDown}
      overflow="hidden"
    >
      <text fg={borderFg} onMouseDown={onMouseDown}>
        {line}
      </text>
      <ShimmerLabel
        text={`|${center(label, innerWidth)}|`}
        focused={focused}
        hovered={shimmer && hovered}
        shimmerFrame={shimmerFrame}
        onMouseDown={onMouseDown}
      />
      <text fg={borderFg} onMouseDown={onMouseDown}>
        {line}
      </text>
    </box>
  );
}

function welcomeLines(columns: number, rows: number): readonly WelcomeLine[] {
  const canRenderFull = columns >= FULL_WORDMARK[0].length + 4 && rows >= 13;
  if (canRenderFull) {
    return [
      { text: "+------------------------------+", fg: STATION_COLORS.chrome.mutedBorder },
      { text: "Welcome to", fg: STATION_COLORS.gray },
      ...FULL_WORDMARK.map((text) => ({ text, fg: STATION_COLORS.foreground })),
    ];
  }
  if (rows >= 7) {
    return [
      { text: "Welcome to", fg: STATION_COLORS.gray },
      ...COMPACT_WORDMARK.map((text) => ({ text, fg: STATION_COLORS.foreground })),
      { text: "----------------", fg: STATION_COLORS.blue },
    ];
  }
  if (rows >= 5) {
    return [
      { text: "Welcome to", fg: STATION_COLORS.gray },
      ...COMPACT_WORDMARK.map((text) => ({ text, fg: STATION_COLORS.foreground })),
    ];
  }
  if (rows >= 4) {
    return COMPACT_WORDMARK.map((text) => ({ text, fg: STATION_COLORS.foreground }));
  }
  return [];
}

function ShimmerLabel({
  text,
  focused,
  hovered,
  shimmerFrame,
  onMouseDown,
}: {
  text: string;
  focused: boolean;
  hovered: boolean;
  shimmerFrame: number;
  onMouseDown: (event: MouseEvent) => void;
}): ReactNode {
  const shimmerCenter = 1 + (shimmerFrame % Math.max(1, text.length - 2));
  return (
    <box flexDirection="row" height={1}>
      {Array.from(text, (char, index) => {
        const border = index === 0 || index === text.length - 1;
        const intensity = hovered && !border ? shimmerIntensity(index, shimmerCenter) : 0;
        const baseBg = focused ? BUTTON_BG : BUTTON_BG_MUTED;
        const bg =
          intensity > 0
            ? lerpColor(BUTTON_BG_HOVER, WELCOME_BUTTON_SHIMMER_BG, intensity)
            : baseBg;
        const fg =
          intensity > 0
            ? lerpColor(
                STATION_COLORS.foreground,
                STATION_COLORS.chrome.welcomeButton.shimmerForeground,
                intensity,
              )
            : focused
              ? STATION_COLORS.foreground
              : STATION_COLORS.gray;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-width static button label
          <text key={index} fg={fg} bg={bg} onMouseDown={onMouseDown}>
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

function center(text: string, width: number): string {
  const available = Math.max(0, width - text.length);
  const left = Math.floor(available / 2);
  const right = available - left;
  return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}
