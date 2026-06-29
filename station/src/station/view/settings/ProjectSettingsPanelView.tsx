// The two-pane Project Settings panel: a left list of items and a right detail
// pane that hosts the item's editor (reusing existing components — the agent
// selector renders here verbatim). Centered absolute overlay above the
// dashboard, like HelpOverlayView. Keyboard/focus live in the dashboard-core
// machine; this layer is render + mouse targets only.
import { TextAttributes } from "@opentui/core";
import type { StationSnapshot } from "@station/contracts";
import {
  isRemoveProjectArmed,
  PROJECT_SETTINGS_ITEMS,
  projectSettingsPanelLayout,
  removeProjectConfirmPhrase,
  selectNewSessionHarnessChoices,
  selectProjectDefaultHarness,
  type TuiLocalRows,
  type TuiScreen,
} from "@station/dashboard-core";
import { useState } from "react";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { AgentChoiceListView } from "../sheets/AgentChoiceListView.js";
import { fit, SheetLine } from "../sheets/parts.js";
import { useStationMouse, stationMouseProps } from "../stationMouseContext.js";
import { STATION_COLORS } from "../theme.js";

type ProjectSettingsScreen = Extract<TuiScreen, { name: "projectSettings" }>;

export type ProjectSettingsPanelViewProps = {
  snapshot: StationSnapshot;
  screen: ProjectSettingsScreen;
  columns: number;
  rows: number;
  localRows: TuiLocalRows;
};

export function ProjectSettingsPanelView({
  snapshot,
  screen,
  columns,
  rows,
  localRows,
}: ProjectSettingsPanelViewProps) {
  const dispatch = useStationMouse();
  const project = snapshot.projects.find((candidate) => candidate.id === screen.projectId);

  const { top, left, width, height, innerWidth, contentHeight, leftWidth, rightWidth } =
    projectSettingsPanelLayout(columns, rows);

  const projectLabel = project?.label ?? "Project";
  const title = "Project settings";
  const footer =
    screen.focus === "list" ? "↑↓ move   →/enter edit   esc close" : "←/esc back";

  return (
    <box
      position="absolute"
      top={top}
      left={left}
      width={width}
      height={height}
      zIndex={10}
      border
      borderColor={STATION_COLORS.gray}
      backgroundColor={STATION_COLORS.background}
      flexDirection="column"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      <text fg={STATION_COLORS.foreground} attributes={TextAttributes.BOLD}>{fit(` ${title}`, innerWidth)}</text>
      <box flexDirection="row" width={innerWidth} height={contentHeight}>
        <box flexDirection="column" width={leftWidth}>
          <ItemList
            screen={screen}
            width={leftWidth}
            headerLabel={projectLabel}
            focused={screen.focus === "list"}
          />
        </box>
        <VerticalDivider height={contentHeight} />
        <box flexDirection="column" width={rightWidth}>
          <DetailPane
            snapshot={snapshot}
            screen={screen}
            width={rightWidth}
            focused={screen.focus === "detail"}
            localRows={localRows}
          />
        </box>
      </box>
      <text fg={STATION_COLORS.foreground} attributes={TextAttributes.DIM}>{fit(` ${footer}`, innerWidth)}</text>
    </box>
  );
}

function ItemList({
  screen,
  width,
  headerLabel,
  focused,
}: {
  screen: ProjectSettingsScreen;
  width: number;
  headerLabel: string;
  focused: boolean;
}) {
  return (
    <>
      <PaneHeader label={headerLabel} width={width} focused={focused} />
      {PROJECT_SETTINGS_ITEMS.map((item) => (
        <SettingsItemRow
          key={item.id}
          item={item}
          active={item.id === screen.activeId}
          width={width}
        />
      ))}
    </>
  );
}

function SettingsItemRow({
  item,
  active,
  width,
}: {
  item: (typeof PROJECT_SETTINGS_ITEMS)[number];
  active: boolean;
  width: number;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useState(false);
  return (
    <text
      fg={active ? STATION_COLORS.cyan : STATION_COLORS.foreground}
      {...(hover ? { bg: STATION_COLORS.hoverBackground } : {})}
      {...stationMouseProps(dispatch, { kind: "projectSettingsItem", itemId: item.id })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {fit(`${active ? "▸ " : "  "}${item.label}`, width)}
    </text>
  );
}

function DetailPane({
  snapshot,
  screen,
  width,
  focused,
  localRows,
}: {
  snapshot: StationSnapshot;
  screen: ProjectSettingsScreen;
  width: number;
  focused: boolean;
  localRows: TuiLocalRows;
}) {
  if (screen.activeId === "remove") {
    return <RemoveDetail screen={screen} width={width} focused={focused} />;
  }
  return (
    <AgentDetail
      snapshot={snapshot}
      screen={screen}
      width={width}
      focused={focused}
      localRows={localRows}
    />
  );
}

function AgentDetail({
  snapshot,
  screen,
  width,
  focused,
  localRows,
}: {
  snapshot: StationSnapshot;
  screen: ProjectSettingsScreen;
  width: number;
  focused: boolean;
  localRows: TuiLocalRows;
}) {
  const project = snapshot.projects.find((candidate) => candidate.id === screen.projectId);
  const choices = project === undefined ? [] : selectNewSessionHarnessChoices(snapshot, project);
  const currentDefault =
    project === undefined ? undefined : selectProjectDefaultHarness(localRows, project);
  return (
    <>
      <PaneHeader label="Default agent" width={width} focused={focused} />
      {choices.length === 0 ? (
        <text fg={STATION_COLORS.foreground} attributes={TextAttributes.DIM}>{fit(" No agents available", width)}</text>
      ) : (
        <>
          <AgentChoiceListView
            choices={choices}
            width={width}
            currentId={currentDefault?.harness}
            pending={currentDefault?.pending ?? false}
          />
          <SheetLine width={width}> </SheetLine>
          <text fg={STATION_COLORS.foreground} attributes={TextAttributes.DIM}>{fit(" ✓ current · 1-9/a-z select", width)}</text>
        </>
      )}
    </>
  );
}

function RemoveDetail({
  screen,
  width,
  focused,
}: {
  screen: ProjectSettingsScreen;
  width: number;
  focused: boolean;
}) {
  const armed = isRemoveProjectArmed(screen);
  const phrase = removeProjectConfirmPhrase(screen.projectId);
  return (
    <>
      <PaneHeader label="Remove project" width={width} focused={focused} danger />
      <text fg={STATION_COLORS.foreground}>{fit(" Removes it from Station.", width)}</text>
      <text fg={STATION_COLORS.foreground}>{fit(" Worktrees & files stay on disk.", width)}</text>
      <SheetLine width={width}> </SheetLine>
      <text fg={STATION_COLORS.foreground} attributes={TextAttributes.DIM}>{fit(` Type "${phrase}" to confirm`, width)}</text>
      <text fg={STATION_COLORS.foreground}>
        {" ▸ "}
        <EditableTextInputView {...screen.removeDraft} placeholder={phrase} />
      </text>
      <SheetLine width={width}> </SheetLine>
      <RemoveButton armed={armed} width={width} />
    </>
  );
}

// The highlight hugs the button label (not the full row), so the indent space
// sits outside the colored span. Hover only lights up while armed (enabled); a
// disarmed button stays dim so hover never implies it can be clicked. The label
// is truncated (never padded) to width minus the indent so it cannot overflow a
// narrow pane while the highlight still hugs the visible text.
function RemoveButton({ armed, width }: { armed: boolean; width: number }) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useState(false);
  const hot = armed && hover;
  const label = "[ Remove project (R) ]".slice(0, Math.max(0, width - 1));
  return (
    <box flexDirection="row">
      <text>{" "}</text>
      <text
        fg={hot ? STATION_COLORS.background : armed ? STATION_COLORS.red : STATION_COLORS.gray}
        attributes={armed ? TextAttributes.BOLD : TextAttributes.DIM}
        {...(hot ? { bg: STATION_COLORS.red } : {})}
        {...stationMouseProps(dispatch, { kind: "projectSettingsConfirmRemove" })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        {label}
      </text>
    </box>
  );
}

// The focused pane's header renders as a filled accent bar (fit() pads to full
// width, so bg fills the row); the unfocused pane keeps a plain bold label. The
// remove section stays red either way so the header keeps its danger cue.
function PaneHeader({
  label,
  width,
  focused,
  danger = false,
}: {
  label: string;
  width: number;
  focused: boolean;
  danger?: boolean;
}) {
  const accent = danger ? STATION_COLORS.red : STATION_COLORS.cyan;
  if (focused) {
    return (
      <text fg={STATION_COLORS.background} bg={accent} attributes={TextAttributes.BOLD}>
        {fit(` ${label}`, width)}
      </text>
    );
  }
  return (
    <text
      fg={danger ? STATION_COLORS.red : STATION_COLORS.foreground}
      attributes={TextAttributes.BOLD}
    >
      {fit(` ${label}`, width)}
    </text>
  );
}

// One-column gray rule between the two panes. Stays width 1 so the layout's
// reserved spacer column (rightWidth = innerWidth - leftWidth - 1) is unchanged.
function VerticalDivider({ height }: { height: number }) {
  return (
    <box flexDirection="column" width={1}>
      {Array.from({ length: height }, (_, row) => (
        <text key={row} fg={STATION_COLORS.gray}>
          │
        </text>
      ))}
    </box>
  );
}
