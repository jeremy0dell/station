import type { MouseEvent as OpenTuiMouseEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  isPrimaryMouseEvent,
  isRightMouseEvent,
  normalizeStationMouseEvent,
  type StationMouseEvent,
} from "../input/mouse.js";
import { useHoverPointer } from "../useHoverPointer.js";
import { STATION_COLORS } from "../station/view/theme.js";
import { Throbber } from "../station/view/Throbber.js";
import { lerpColor, type StationButtonStateColors, stationButtonColors } from "./colors.js";
import type { ProjectRollupEntry, ProjectRollupStatus } from "./status.js";
import {
  ANIM_MS,
  ATTENTION_MARK,
  attentionLines,
  celebrationText,
  clampSessionName,
  COLLAPSED_ATTENTION_COLS,
  COLLAPSED_BASE_COLS,
  CONTENT_INDENT,
  type Dims,
  easeInOutCubic,
  FRAME_MS,
  GRADIENT_EDGE,
  ICON_COLS,
  ICON_PAD,
  type IslandCelebration,
  type IslandDisplay,
  islandDisplay,
  type IslandDisplayInput,
  lerp,
  paintedCount,
  ROLLUP_MAX_LINES,
  sessionSummary,
  STATION_BUTTON_Z_INDEX,
  STATION_ICON,
  targetDims,
} from "./layout.js";

export type DynamicStationButtonProps = {
  /** Everything the display ladder needs; islandDisplay decides what paints. */
  input: IslandDisplayInput;
  /** Force-expand from external hover state; internal mouse hover also expands. */
  hovered?: boolean | undefined;
  focused?: boolean | undefined;
  /** Reports mouse-over so the app can scope island keyboard actions to hover. */
  onHoverChange?: ((hovered: boolean) => void) | undefined;
  /** Left-click in a base state (no attention) — opens/closes the STATION overlay. */
  onToggleStation?: ((event: StationMouseEvent) => void) | undefined;
  /** Left-click in an attention state — focus the flagged session. */
  onFocusSession?: ((event: StationMouseEvent) => void) | undefined;
  /** Right-click in any state. */
  onContextMenu?: ((event: StationMouseEvent) => void) | undefined;
};

export function DynamicStationButton(props: DynamicStationButtonProps): ReactNode {
  const { input, onHoverChange } = props;
  const attention = input.status.attention;
  const [internalHover, setInternalHover] = useState(false);
  const expanded = (props.hovered ?? false) || (props.focused ?? false) || internalHover;
  const handleHoverChange = (hovering: boolean): void => {
    setInternalHover(hovering);
    onHoverChange?.(hovering);
  };
  const pointerProps = useHoverPointer({ onHoverChange: handleHoverChange });

  const open = useOpenAmount(expanded ? 1 : 0);
  const collapsed = targetDims(islandDisplay(input, false));
  const opened = targetDims(islandDisplay(input, true));
  const dims: Dims = {
    width: Math.round(lerp(collapsed.width, opened.width, open)),
    height: Math.round(lerp(collapsed.height, opened.height, open)),
  };
  const display = islandDisplay(input, expanded);

  // Border/icon morph between the two state colors; expanded text fades up from
  // the background while collapsed marks/icon stay fully visible.
  const from = stationButtonColors(attention, false);
  const to = stationButtonColors(attention, true);
  const border = lerpColor(from.border, to.border, open);
  const icon = lerpColor(from.icon, to.icon, open);
  // Held invisible until the box has opened enough to hold it; expanded text
  // then reveals per-character (GradientText), collapsed marks just morph color.
  const textReveal = Math.min(1, Math.max(0, (open - 0.35) / 0.65));
  const color: StationButtonStateColors = expanded
    ? { border, icon, text: to.text }
    : { border, icon, text: lerpColor(from.text, to.text, open) };

  // The icon rests at its collapsed spot (base: centered; alert: the "!" frame's
  // center, mid-row) and glides to the top-left (0,0) as the card opens — a
  // diagonal move out of the frame for the alert.
  const collapsedCols = attention ? COLLAPSED_ATTENTION_COLS : COLLAPSED_BASE_COLS;
  const iconPadX = Math.round(lerp(Math.floor((collapsedCols - 2 - ICON_COLS) / 2), 0, open));
  const iconPadY = Math.round(lerp(attention ? 1 : 0, 0, open));

  const handleMouseDown = (event: OpenTuiMouseEvent): void => {
    // Outer box and the full-cover overlay child both bind this handler; stop the down bubbling
    // child->parent so one click toggles once (otherwise open+close net to a no-op).
    event.stopPropagation();
    const normalized = normalizeStationMouseEvent(event);
    if (isRightMouseEvent(normalized)) {
      props.onContextMenu?.(normalized);
      return;
    }
    if (!isPrimaryMouseEvent(normalized)) {
      return;
    }
    if (attention) {
      props.onFocusSession?.(normalized);
    } else {
      props.onToggleStation?.(normalized);
    }
  };
  return (
    <box
      position="absolute"
      top={0}
      right={0}
      zIndex={STATION_BUTTON_Z_INDEX}
      width={dims.width}
      height={dims.height}
      border
      borderStyle="rounded"
      borderColor={color.border}
      flexDirection="column"
      // Opaque in every state so the resize transition never flashes panes through it.
      backgroundColor={STATION_COLORS.background}
      {...pointerProps}
      onMouseDown={handleMouseDown}
    >
      <StationButtonContent
        display={display}
        color={color}
        iconPadX={iconPadX}
        iconPadY={iconPadY}
        reveal={textReveal}
      />
      {/* Keeps one stable hit target above morphing text/icon children during expand/collapse. */}
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        {...pointerProps}
        onMouseDown={handleMouseDown}
      />
    </box>
  );
}

function StationButtonContent(props: {
  display: IslandDisplay;
  color: StationButtonStateColors;
  iconPadX: number;
  iconPadY: number;
  reveal: number;
}): ReactNode {
  const { display, color, iconPadX, iconPadY, reveal } = props;
  switch (display.kind) {
    case "mark":
      return <CollapsedBase color={color} iconPadX={iconPadX} iconPadY={iconPadY} />;
    case "alertMark":
      return <CollapsedAttention color={color} />;
    case "counts":
      return (
        <CollapsedCounts
          iconColor={color.icon}
          working={display.working}
          ready={display.ready}
        />
      );
    case "celebration":
      return <CollapsedCelebration celebration={display.celebration} />;
    case "alertCard":
      return (
        <ExpandedAttention
          color={color}
          iconPadX={iconPadX}
          iconPadY={iconPadY}
          reveal={reveal}
          needsYouCount={display.needsYouCount}
          sessionName={display.sessionName}
        />
      );
    case "rollup":
      return (
        <ExpandedRollup
          color={color}
          iconPadX={iconPadX}
          iconPadY={iconPadY}
          reveal={reveal}
          entries={display.entries}
        />
      );
    case "summary":
      return (
        <ExpandedBase
          color={color}
          iconPadX={iconPadX}
          iconPadY={iconPadY}
          reveal={reveal}
          working={display.working}
          idle={display.idle}
        />
      );
  }
}

function IconGlyph({ color }: { color: string }): ReactNode {
  return (
    <box width={ICON_COLS}>
      <text fg={color}>{STATION_ICON}</text>
    </box>
  );
}

function IconRow({
  color,
  padX,
  padY,
}: {
  color: string;
  padX: number;
  padY: number;
}): ReactNode {
  return (
    <box paddingLeft={padX} paddingTop={padY}>
      <IconGlyph color={color} />
    </box>
  );
}

function GradientText({
  text,
  reveal,
  color,
}: {
  text: string;
  reveal: number;
  color: string;
}): ReactNode {
  if (reveal >= 1) {
    return <text fg={color}>{text}</text>;
  }
  const front = reveal * (text.length + GRADIENT_EDGE);
  return (
    <box flexDirection="row">
      {Array.from(text, (char, i) => {
        const local = Math.min(1, Math.max(0, (front - i) / GRADIENT_EDGE));
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static string
          <text key={i} fg={lerpColor(STATION_COLORS.background, color, local)}>
            {char}
          </text>
        );
      })}
    </box>
  );
}

function CollapsedBase({
  color,
  iconPadX,
  iconPadY,
}: {
  color: StationButtonStateColors;
  iconPadX: number;
  iconPadY: number;
}): ReactNode {
  return <IconRow color={color.icon} padX={iconPadX} padY={iconPadY} />;
}

function CollapsedAttention({ color }: { color: StationButtonStateColors }): ReactNode {
  // Symmetric "!" frame around the centered icon.
  const markRow = ATTENTION_MARK.repeat(COLLAPSED_ATTENTION_COLS - 2);
  return (
    <box flexDirection="column">
      <text fg={color.text}>{markRow}</text>
      <box flexDirection="row">
        <text fg={color.text}>{ATTENTION_MARK}</text>
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <IconGlyph color={color.icon} />
        </box>
        <text fg={color.text}>{ATTENTION_MARK}</text>
      </box>
      <text fg={color.text}>{markRow}</text>
    </box>
  );
}

// Collapsed fleet counts show only active lanes: braille working and ● ready.
function CollapsedCounts(props: {
  iconColor: string;
  working: number;
  ready: number;
}): ReactNode {
  return (
    <box flexDirection="row" paddingLeft={ICON_PAD}>
      <IconGlyph color={props.iconColor} />
      <text>
        <span> </span>
        {props.working > 0 ? (
          <>
            <Throbber variant="braille" fg={STATION_COLORS.blue} />
            <span fg={STATION_COLORS.blue}>{paintedCount(props.working)}</span>
          </>
        ) : null}
        {props.working > 0 && props.ready > 0 ? <span> </span> : null}
        {props.ready > 0 ? (
          <span fg={STATION_COLORS.green}>{`●${paintedCount(props.ready)}`}</span>
        ) : null}
      </text>
    </box>
  );
}

function CollapsedCelebration({ celebration }: { celebration: IslandCelebration }): ReactNode {
  return (
    <box flexDirection="row" paddingLeft={ICON_PAD}>
      <IconGlyph color={STATION_COLORS.green} />
      <text fg={STATION_COLORS.green}>{` ${celebrationText(celebration)}`}</text>
    </box>
  );
}

function ExpandedBase(props: {
  color: StationButtonStateColors;
  iconPadX: number;
  iconPadY: number;
  reveal: number;
  working: number;
  idle: number;
}): ReactNode {
  const { color, reveal } = props;
  return (
    <box flexDirection="column">
      <IconRow color={color.icon} padX={props.iconPadX} padY={props.iconPadY} />
      <box flexDirection="column" paddingLeft={CONTENT_INDENT}>
        <GradientText
          text={sessionSummary(props.working, "working")}
          reveal={reveal}
          color={color.text}
        />
        <GradientText
          text={sessionSummary(props.idle, "idle")}
          reveal={reveal}
          color={color.text}
        />
      </box>
    </box>
  );
}

const ROLLUP_MARKS: Record<Exclude<ProjectRollupStatus, "working">, { glyph: string; color: string }> = {
  needsYou: { glyph: "!", color: STATION_COLORS.red },
  ready: { glyph: "●", color: STATION_COLORS.green },
  idle: { glyph: "○", color: STATION_COLORS.gray },
};

function RollupGlyph({ status }: { status: ProjectRollupStatus }): ReactNode {
  if (status === "working") {
    return (
      <text>
        <Throbber variant="braille" fg={STATION_COLORS.blue} />
        <span> </span>
      </text>
    );
  }
  const mark = ROLLUP_MARKS[status];
  return <text fg={mark.color}>{`${mark.glyph} `}</text>;
}

function ExpandedRollup(props: {
  color: StationButtonStateColors;
  iconPadX: number;
  iconPadY: number;
  reveal: number;
  entries: readonly ProjectRollupEntry[];
}): ReactNode {
  const { color, reveal, entries } = props;
  const shown = entries.slice(0, ROLLUP_MAX_LINES);
  const folded = entries.length - shown.length;
  return (
    <box flexDirection="column">
      <IconRow color={color.icon} padX={props.iconPadX} padY={props.iconPadY} />
      <box flexDirection="column" paddingLeft={CONTENT_INDENT}>
        {shown.map((entry) => (
          <box key={entry.projectId} flexDirection="row">
            <RollupGlyph status={entry.status} />
            <GradientText text={clampSessionName(entry.name)} reveal={reveal} color={color.text} />
          </box>
        ))}
        {folded > 0 ? (
          <GradientText text={`+${folded} more`} reveal={reveal} color={color.text} />
        ) : null}
      </box>
    </box>
  );
}

function ExpandedAttention(props: {
  color: StationButtonStateColors;
  iconPadX: number;
  iconPadY: number;
  reveal: number;
  needsYouCount: number;
  sessionName: string;
}): ReactNode {
  const { color, reveal } = props;
  return (
    <box flexDirection="column">
      <IconRow color={color.icon} padX={props.iconPadX} padY={props.iconPadY} />
      <box flexDirection="column" paddingLeft={CONTENT_INDENT}>
        <GradientText
          text={clampSessionName(props.sessionName)}
          reveal={reveal}
          color={color.text}
        />
        {attentionLines(props.needsYouCount).map((line) => (
          <GradientText
            key={line}
            text={line}
            reveal={reveal}
            color={color.text}
          />
        ))}
      </box>
    </box>
  );
}

// Manual interval tween, not OpenTUI's Timeline: nothing in Station attaches the Timeline engine
// to the renderer, so useTimeline would never advance a frame here.
function useOpenAmount(target: number): number {
  const renderer = useRenderer();
  const [open, setOpen] = useState(target);
  const fromRef = useRef(target);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true; // first paint sits at the target, no animation
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    // OpenTUI is on-demand; without requesting "live" it won't paint the
    // in-between frames of this timer-driven tween (it would snap to the end).
    renderer.requestLive();
    let live = true;
    const dropLive = (): void => {
      if (live) {
        live = false;
        renderer.dropLive();
      }
    };
    let elapsed = 0;
    const id = setInterval(() => {
      elapsed += FRAME_MS;
      const t = Math.min(1, elapsed / ANIM_MS);
      if (t >= 1) {
        clearInterval(id);
        fromRef.current = target;
        setOpen(target);
        dropLive();
        return;
      }
      const value = from + (target - from) * easeInOutCubic(t);
      fromRef.current = value;
      setOpen(value);
    }, FRAME_MS);
    return () => {
      clearInterval(id);
      dropLive();
    };
  }, [target, renderer]);

  return open;
}
