// Renderer-owned overlay: OpenTUI centers and clips the semantic help entries,
// while the structural panel owns its border, padding, and continuation cue.
import { useMemo, useSyncExternalStore } from "react";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../theme/index.js";
import {
  STATION_HELP_ENTRIES,
  STATION_HELP_ENTRY_IDS,
  type StationHelpEntry,
} from "../helpEntries.js";
import { SemanticScrollRegion } from "./layout/SemanticScrollViewport.js";
import {
  createScrollViewportController,
  semanticItemRenderableId,
} from "./layout/scrollViewport.js";
import { helpPanelFrame } from "./layout/helpPanelFrame.js";
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
  const continuation = helpContinuation(visibleEntryIds, columns);

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={Math.max(1, columns)}
      height={Math.max(1, rows)}
      zIndex={10}
      alignItems="center"
      justifyContent="center"
      {...stationMouseProps(dispatch, { kind: "screenBackdrop" })}
    >
      <box
        id="station-help-surface"
        width={frame.width}
        height={frame.height}
        maxWidth={64}
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

function helpContinuation(
  visibleEntryIds: readonly string[] | undefined,
  panelWidth: number,
): string {
  const first = visibleEntryIds?.[0];
  const last = visibleEntryIds?.at(-1);
  const above = first === undefined ? 0 : Math.max(0, STATION_HELP_ENTRY_IDS.indexOf(first));
  const below = last === undefined
    ? 0
    : Math.max(0, STATION_HELP_ENTRY_IDS.length - STATION_HELP_ENTRY_IDS.indexOf(last) - 1);
  if (panelWidth < 48) {
    if (above > 0 && below > 0) return `↑${above}/↓${below}`;
    if (above > 0) return `↑${above}`;
    if (below > 0) return `↓${below}`;
    return "all";
  }
  if (above > 0 && below > 0) return `↑ ${above} above · ↓ ${below} below`;
  if (above > 0) return `↑ ${above} above`;
  if (below > 0) return `↓ ${below} below`;
  return "all visible";
}
