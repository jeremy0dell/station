// Renderer-owned overlay: OpenTUI centers and clips the semantic help entries,
// while the structural panel owns its border, padding, and continuation cue.
import { useMemo, useSyncExternalStore } from "react";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../theme/index.js";
import {
  STATION_HELP_ENTRIES,
  STATION_HELP_ENTRY_IDS,
  type StationHelpEntry,
} from "../helpEntries.js";
import { helpScrollChrome } from "./helpScrollChrome.js";
import { SemanticScrollRegion } from "./layout/scroll/SemanticScrollViewport.js";
import {
  createScrollViewportController,
  semanticItemRenderableId,
} from "./layout/scroll/scrollViewport.js";
import {
  HELP_PANEL_MAX_WIDTH,
  helpPanelFrame,
} from "./layout/helpPanelFrame.js";
import { useStationMouse, stationMouseProps } from "./stationMouseContext.js";

export function HelpOverlayView({
  columns,
  rows,
  focusedEntryId,
}: {
  columns: number;
  rows: number;
  focusedEntryId?: string;
}) {
  const theme = useStationTheme();
  const helpBackground = toOpenTuiOpaqueColor(theme.surfaces.help);
  const dispatch = useStationMouse();
  const frame = helpPanelFrame(columns, rows);
  const controller = useMemo(() => createScrollViewportController<string>(), []);
  const visibleEntryIds = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const continuation = helpScrollChrome({
    allIds: STATION_HELP_ENTRY_IDS,
    visibleIds: visibleEntryIds,
    panelWidth: frame.effectiveWidth,
  });

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={frame.overlayWidth}
      height={frame.overlayHeight}
      zIndex={10}
      alignItems="center"
      justifyContent="center"
      {...stationMouseProps(dispatch, { kind: "screenBackdrop" })}
    >
      <box
        id="station-help-surface"
        width={frame.width}
        height={frame.height}
        maxWidth={HELP_PANEL_MAX_WIDTH}
        flexDirection="column"
        flexShrink={1}
        border
        borderStyle="rounded"
        borderColor={toOpenTuiColor(theme.interaction.hairline)}
        backgroundColor={helpBackground}
        overflow="hidden"
        {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
      >
        <SemanticScrollRegion
          itemIds={STATION_HELP_ENTRY_IDS}
          followedItemId={focusedEntryId}
          viewportId="station-help-content"
          controller={controller}
          scrollbar="inside"
        >
          <box width="100%" flexDirection="column" paddingLeft={2} paddingRight={2}>
            {STATION_HELP_ENTRIES.map((entry) => (
              <HelpEntryView
                key={entry.id}
                entry={entry}
                focused={entry.id === focusedEntryId}
              />
            ))}
          </box>
        </SemanticScrollRegion>
        <text
          flexShrink={0}
          fg={toOpenTuiColor(theme.text.muted)}
          selectable={false}
          wrapMode="none"
        >
          {` ${continuation} · ↑↓ · PgUp/PgDn · Esc`}
        </text>
      </box>
    </box>
  );
}

function HelpEntryView({ entry, focused }: { entry: StationHelpEntry; focused: boolean }) {
  const theme = useStationTheme();
  const foreground = toOpenTuiColor(theme.text.primary);
  if ("text" in entry) {
    return (
      <box id={semanticItemRenderableId(entry.id)} width="100%" flexDirection="row">
        <text width={2} fg={toOpenTuiColor(theme.action.primary)} selectable={false}>
          {focused ? "▸ " : "  "}
        </text>
        <box flexGrow={1} justifyContent="center">
          <text fg={foreground} selectable={false}>
            {entry.text}
          </text>
        </box>
      </box>
    );
  }
  return (
    <box
      id={semanticItemRenderableId(entry.id)}
      width="100%"
      flexDirection="row"
      columnGap={2}
    >
      <text width={2} fg={toOpenTuiColor(theme.action.primary)} selectable={false}>
        {focused ? "▸ " : "  "}
      </text>
      <text width={11} flexShrink={1} fg={foreground} selectable={false}>
        {entry.key}
      </text>
      <text
        minWidth={1}
        flexGrow={1}
        flexShrink={1}
        fg={foreground}
        wrapMode="word"
        selectable={false}
      >
        {entry.description}
      </text>
    </box>
  );
}
