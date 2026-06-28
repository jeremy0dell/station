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
  type TuiScreen,
} from "@station/dashboard-core";
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
};

export function ProjectSettingsPanelView({
  snapshot,
  screen,
  columns,
  rows,
}: ProjectSettingsPanelViewProps) {
  const dispatch = useStationMouse();
  const project = snapshot.projects.find((candidate) => candidate.id === screen.projectId);

  const { top, left, width, height, innerWidth, contentHeight, leftWidth, rightWidth } =
    projectSettingsPanelLayout(columns, rows);

  const title = project === undefined ? "Project settings" : `Project settings · ${project.label}`;
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
      <text fg={STATION_COLORS.foreground} attributes={TextAttributes.BOLD}>{` ${title}`}</text>
      <box flexDirection="row" width={innerWidth} height={contentHeight}>
        <box flexDirection="column" width={leftWidth}>
          <ItemList screen={screen} width={leftWidth} />
        </box>
        <box width={1} />
        <box flexDirection="column" width={rightWidth}>
          <DetailPane snapshot={snapshot} screen={screen} width={rightWidth} />
        </box>
      </box>
      <text fg={STATION_COLORS.foreground} attributes={TextAttributes.DIM}>{fit(` ${footer}`, innerWidth)}</text>
    </box>
  );
}

function ItemList({ screen, width }: { screen: ProjectSettingsScreen; width: number }) {
  const dispatch = useStationMouse();
  return (
    <>
      {PROJECT_SETTINGS_ITEMS.map((item) => {
        const active = item.id === screen.activeId;
        return (
          <text
            key={item.id}
            fg={active ? STATION_COLORS.cyan : STATION_COLORS.foreground}
            {...stationMouseProps(dispatch, { kind: "projectSettingsItem", itemId: item.id })}
          >
            {fit(`${active ? "▸ " : "  "}${item.label}`, width)}
          </text>
        );
      })}
    </>
  );
}

function DetailPane({
  snapshot,
  screen,
  width,
}: {
  snapshot: StationSnapshot;
  screen: ProjectSettingsScreen;
  width: number;
}) {
  if (screen.activeId === "remove") {
    return <RemoveDetail screen={screen} width={width} />;
  }
  return <AgentDetail snapshot={snapshot} screen={screen} width={width} />;
}

function AgentDetail({
  snapshot,
  screen,
  width,
}: {
  snapshot: StationSnapshot;
  screen: ProjectSettingsScreen;
  width: number;
}) {
  const project = snapshot.projects.find((candidate) => candidate.id === screen.projectId);
  const choices = project === undefined ? [] : selectNewSessionHarnessChoices(snapshot, project);
  return (
    <>
      <text fg={STATION_COLORS.foreground} attributes={TextAttributes.BOLD}>{fit(" Default agent", width)}</text>
      <SheetLine width={width}> </SheetLine>
      <AgentChoiceListView choices={choices} width={width} />
      <SheetLine width={width}> </SheetLine>
      <text fg={STATION_COLORS.foreground} attributes={TextAttributes.DIM}>{fit(" 1-9/a-z select", width)}</text>
    </>
  );
}

function RemoveDetail({ screen, width }: { screen: ProjectSettingsScreen; width: number }) {
  const dispatch = useStationMouse();
  const armed = isRemoveProjectArmed(screen);
  const phrase = removeProjectConfirmPhrase(screen.projectId);
  return (
    <>
      <text fg={STATION_COLORS.red} attributes={TextAttributes.BOLD}>{fit(" Remove project", width)}</text>
      <text fg={STATION_COLORS.foreground}>{fit(" Removes it from Station.", width)}</text>
      <text fg={STATION_COLORS.foreground}>{fit(" Worktrees & files stay on disk.", width)}</text>
      <SheetLine width={width}> </SheetLine>
      <text fg={STATION_COLORS.foreground} attributes={TextAttributes.DIM}>{fit(` Type "${phrase}" to confirm`, width)}</text>
      <text fg={STATION_COLORS.foreground}>
        {" ▸ "}
        <EditableTextInputView {...screen.removeDraft} placeholder={phrase} />
      </text>
      <SheetLine width={width}> </SheetLine>
      <text
        fg={armed ? STATION_COLORS.red : STATION_COLORS.gray}
        attributes={armed ? TextAttributes.BOLD : TextAttributes.DIM}
        {...stationMouseProps(dispatch, { kind: "projectSettingsConfirmRemove" })}
      >
        {fit(" [ Remove project (R) ]", width)}
      </text>
    </>
  );
}
