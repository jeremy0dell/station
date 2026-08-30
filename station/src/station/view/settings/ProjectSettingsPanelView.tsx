import { TextAttributes } from "@opentui/core";
import type { ProviderId } from "@station/contracts";
import {
  selectNewSessionHarnessChoices,
  selectProjectDefaultHarness,
} from "@station/dashboard-core/selectors";
import { clipCells } from "@station/dashboard-core/text";
import {
  isRemoveProjectArmed,
  PROJECT_SETTINGS_AGENT_LIST_ID,
  PROJECT_SETTINGS_ITEMS,
  removeProjectConfirmPhrase,
} from "@station/dashboard-core/state";
import type {
  DashboardScreenView,
  DashboardSnapshotView,
  DashboardStateView,
} from "@station/dashboard-core/state";
import { toOpenTuiColor, useStationTheme } from "../../../theme/index.js";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { semanticItemRenderableId } from "../layout/scroll/scrollViewport.js";
import { AgentChoiceListView } from "../sheets/AgentChoiceListView.js";
import { fit } from "../sheets/parts.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "../stationMouseContext.js";
import { SettingsPanelDetailView, SettingsPanelView } from "./SettingsPanelView.js";

type ProjectSettingsScreen = Extract<DashboardScreenView, { name: "projectSettings" }>;
type DashboardLocalRowsView = DashboardStateView["localRows"];

export type ProjectSettingsPanelViewProps = {
  snapshot: DashboardSnapshotView;
  screen: ProjectSettingsScreen;
  selection: DashboardStateView["selection"];
  columns: number;
  rows: number;
  localRows: DashboardLocalRowsView;
};

export function ProjectSettingsPanelView({
  snapshot,
  screen,
  selection,
  columns,
  rows,
  localRows,
}: ProjectSettingsPanelViewProps) {
  const project = snapshot.projects.find((candidate) => candidate.id === screen.projectId);
  const selectedAgentId = selection.get(PROJECT_SETTINGS_AGENT_LIST_ID) as ProviderId | undefined;
  const projectLabel = project?.label ?? "Project";
  const activeLabel =
    PROJECT_SETTINGS_ITEMS.find((item) => item.id === screen.activeId)?.label ?? projectLabel;
  const footer =
    screen.focus === "list"
      ? "↑↓ move   →/enter edit   esc close"
      : screen.activeId === "agent"
        ? "↑↓ move   ↵ choose   ←/esc back"
        : "←/esc back";

  return (
    <SettingsPanelView
      columns={columns}
      rows={rows}
      focus={screen.focus}
      title="Project settings"
      compactDetailTitle={`${activeLabel} · ${projectLabel}`}
      footer={footer}
      listHeader={projectLabel}
      items={PROJECT_SETTINGS_ITEMS.map((item) => ({
        id: item.id,
        label: item.label,
        active: item.id === screen.activeId,
        mouseTarget: { kind: "projectSettingsItem", itemId: item.id },
      }))}
      renderDetail={({ width, focused, showHeader }) => (
        <DetailPane
          snapshot={snapshot}
          screen={screen}
          width={width}
          focused={focused}
          showHeader={showHeader}
          localRows={localRows}
          selectedAgentId={selectedAgentId}
        />
      )}
    />
  );
}

function DetailPane({
  snapshot,
  screen,
  width,
  focused,
  showHeader,
  localRows,
  selectedAgentId,
}: {
  snapshot: DashboardSnapshotView;
  screen: ProjectSettingsScreen;
  width: number;
  focused: boolean;
  showHeader: boolean;
  localRows: DashboardLocalRowsView;
  selectedAgentId?: ProviderId;
}) {
  if (screen.activeId === "remove") {
    return (
      <RemoveDetail screen={screen} width={width} focused={focused} showHeader={showHeader} />
    );
  }
  return (
    <AgentDetail
      snapshot={snapshot}
      screen={screen}
      width={width}
      focused={focused}
      showHeader={showHeader}
      localRows={localRows}
      selectedAgentId={selectedAgentId}
    />
  );
}

function AgentDetail({
  snapshot,
  screen,
  width,
  focused,
  showHeader,
  localRows,
  selectedAgentId,
}: {
  snapshot: DashboardSnapshotView;
  screen: ProjectSettingsScreen;
  width: number;
  focused: boolean;
  showHeader: boolean;
  localRows: DashboardLocalRowsView;
  selectedAgentId?: ProviderId;
}) {
  const theme = useStationTheme();
  const project = snapshot.projects.find((candidate) => candidate.id === screen.projectId);
  const choices = project === undefined ? [] : selectNewSessionHarnessChoices(snapshot, project);
  const currentDefault =
    project === undefined ? undefined : selectProjectDefaultHarness(localRows, project);
  return (
    <SettingsPanelDetailView
      width={width}
      title="Default agent"
      showHeader={showHeader}
      focused={focused}
      bodyItemIds={choices.map((choice) => choice.value.id)}
      followedBodyItemId={focused ? selectedAgentId : undefined}
      footer={
        choices.length === 0 ? undefined : (
          <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.DIM}>
            {fit(" ✓ current · ↑↓ ↵ · 1-9/a-z", width)}
          </text>
        )
      }
    >
      {choices.length === 0 ? (
        <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.DIM}>
          {fit(" No agents available", width)}
        </text>
      ) : (
        <AgentChoiceListView
          choices={choices}
          width={width}
          currentId={currentDefault?.harness}
          selectedId={focused ? selectedAgentId : undefined}
          pending={currentDefault?.pending ?? false}
        />
      )}
    </SettingsPanelDetailView>
  );
}

function RemoveDetail({
  screen,
  width,
  focused,
  showHeader,
}: {
  screen: ProjectSettingsScreen;
  width: number;
  focused: boolean;
  showHeader: boolean;
}) {
  const theme = useStationTheme();
  const armed = isRemoveProjectArmed(screen);
  const phrase = removeProjectConfirmPhrase(screen.projectId);
  return (
    <SettingsPanelDetailView
      width={width}
      title="Remove project"
      showHeader={showHeader}
      focused={focused}
      danger
      bodyItemIds={["project-settings:remove-input"]}
      followedBodyItemId="project-settings:remove-input"
      actions={<RemoveButton armed={armed} width={width} />}
    >
      {showHeader ? (
        <>
          <text fg={toOpenTuiColor(theme.text.primary)}>
            {fit(" Removes it from Station.", width)}
          </text>
          <text fg={toOpenTuiColor(theme.text.primary)}>
            {fit(" Worktrees & files stay on disk.", width)}
          </text>
        </>
      ) : (
        <text fg={toOpenTuiColor(theme.text.primary)}>
          {fit(" Files stay; removed from Station.", width)}
        </text>
      )}
      <box
        flexDirection="column"
        marginTop={showHeader ? 1 : 0}
        marginBottom={showHeader ? 1 : 0}
      >
        <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.DIM}>
          {fit(showHeader ? ` Type "${phrase}" to confirm` : ` Confirm: ${phrase}`, width)}
        </text>
        <text
          id={semanticItemRenderableId("project-settings:remove-input")}
          width={width}
          wrapMode="none"
          fg={toOpenTuiColor(theme.text.primary)}
        >
          {" ▸ "}
          <EditableTextInputView {...screen.removeDraft} placeholder={phrase} />
        </text>
      </box>
    </SettingsPanelDetailView>
  );
}

// The highlight hugs the button label; disabled hover cannot imply that removal is available.
function RemoveButton({ armed, width }: { armed: boolean; width: number }) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const hot = armed && hover;
  const label = clipCells("[ Remove project (R) ]", Math.max(0, width - 1));
  return (
    <box flexDirection="row">
      <text
        marginLeft={1}
        fg={toOpenTuiColor(
          hot ? theme.text.inverse : armed ? theme.status.danger : theme.text.muted,
        )}
        attributes={armed ? TextAttributes.BOLD : TextAttributes.DIM}
        {...(hot ? { bg: toOpenTuiColor(theme.status.danger) } : {})}
        {...stationMouseProps(dispatch, { kind: "projectSettingsConfirmRemove" })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        {label}
      </text>
    </box>
  );
}
