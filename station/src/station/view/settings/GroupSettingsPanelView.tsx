import { TextAttributes } from "@opentui/core";
import {
  groupSettingsPanelModel,
} from "@station/dashboard-core/selectors";
import { cellWidth, truncateCells } from "@station/dashboard-core/text";
import type {
  DashboardScreenView,
  DashboardSnapshotView,
  GroupSettingsDetailFocus,
} from "@station/dashboard-core/state";
import { GROUP_SETTINGS_ITEMS } from "@station/dashboard-core/state";
import { toOpenTuiColor, useStationTheme } from "../../../theme/index.js";
import { SheetButtonRow } from "../controls/sheetButtons.js";
import { fit } from "../controls/sheetText.js";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { semanticItemRenderableId } from "../layout/scroll/scrollViewport.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "../stationMouseContext.js";
import { SettingsPanelDetailView, SettingsPanelView } from "./SettingsPanelView.js";

type GroupSettingsScreen = Extract<DashboardScreenView, { name: "groupSettings" }>;

export type GroupSettingsPanelViewProps = {
  snapshot: DashboardSnapshotView;
  screen: GroupSettingsScreen;
  columns: number;
  rows: number;
};

export function GroupSettingsPanelView({
  snapshot,
  screen,
  columns,
  rows,
}: GroupSettingsPanelViewProps) {
  const model = groupSettingsPanelModel(snapshot, screen);
  if (model === undefined) return null;
  const footer = model.pending
    ? "Saving…"
    : screen.focus === "list"
      ? "↑↓ or G/S/R select · →/enter edit · esc back"
      : "↑↓ focus · enter activate · esc sections";

  return (
    <SettingsPanelView
      columns={columns}
      rows={rows}
      focus={screen.focus}
      title={`Group settings · ${model.group.name}`}
      compactDetailTitle={`${sectionLabel(screen.section)} · ${model.group.name}`}
      footer={footer}
      listHeader={model.group.name}
      items={GROUP_SETTINGS_ITEMS.map((item) => ({
        id: item.id,
        label: item.label,
        active: item.id === screen.section,
        danger: item.id === "remove",
        disabled: model.pending,
        mouseTarget: { kind: "groupSettingsSection", section: item.id },
      }))}
      renderDetail={({ width, showHeader }) => (
        <DetailPane model={model} screen={screen} width={width} showHeader={showHeader} />
      )}
    />
  );
}

function DetailPane({
  model,
  screen,
  width,
  showHeader,
}: {
  model: NonNullable<ReturnType<typeof groupSettingsPanelModel>>;
  screen: GroupSettingsScreen;
  width: number;
  showHeader: boolean;
}) {
  switch (screen.section) {
    case "general":
      return <GeneralDetail model={model} screen={screen} width={width} showHeader={showHeader} />;
    case "sessions":
      return <SessionsDetail model={model} screen={screen} width={width} showHeader={showHeader} />;
    case "remove":
      return <RemoveDetail model={model} screen={screen} width={width} showHeader={showHeader} />;
  }
}

function GeneralDetail({ model, screen, width, showHeader }: DetailProps) {
  const theme = useStationTheme();
  const saveEnabled =
    screen.pending === undefined &&
    screen.nameDraft.value.trim().length > 0 &&
    screen.nameDraft.value.trim() !== screen.baselineName;
  return (
    <SettingsPanelDetailView
      width={width}
      title="General"
      showHeader={showHeader}
      focused={screen.focus === "detail"}
      bodyItemIds={["group-settings:general-name"]}
      followedBodyItemId={screen.detailFocus === "name" ? "group-settings:general-name" : undefined}
      actions={
        <SheetButtonRow
          width={width}
          buttons={[
            {
              id: "save",
              label: screen.pending === "rename" ? "Saving…" : "Save",
              shortcut: "Enter",
              tone: "primary",
              mouseTarget: { kind: "groupSettingsAction", actionId: "save" },
              focused: screen.detailFocus === "generalSave",
              disabled: !saveEnabled,
            },
            {
              id: "cancel",
              label: "Cancel",
              shortcut: "Esc",
              tone: "neutral",
              mouseTarget: { kind: "groupSettingsAction", actionId: "back" },
              focused: screen.detailFocus === "generalCancel",
              disabled: screen.pending !== undefined,
            },
          ]}
        />
      }
    >
      <ControlInputLine
        screen={screen}
        control="name"
        width={width}
        label="Name"
        input={screen.nameDraft}
        itemId="group-settings:general-name"
      />
      <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.DIM}>
        {fit(" Save renames; sessions stay attached.", width)}
      </text>
      <box flexDirection="column" marginTop={1} marginBottom={1}>
        <text fg={toOpenTuiColor(theme.text.primary)}>
          {fit(` Project ${model.project.label} (read-only)`, width)}
        </text>
        <text fg={toOpenTuiColor(theme.text.muted)} attributes={TextAttributes.DIM}>
          {fit(` ${model.project.root}`, width)}
        </text>
      </box>
    </SettingsPanelDetailView>
  );
}

function SessionsDetail({ model, screen, width, showHeader }: DetailProps) {
  const theme = useStationTheme();
  return (
    <SettingsPanelDetailView
      width={width}
      title="Sessions"
      showHeader={showHeader}
      focused={screen.focus === "detail"}
      bodyItemIds={model.sessions.map((session) => session.sessionId)}
      followedBodyItemId={screen.detailFocus === "sessionList" ? screen.sessionCursor : undefined}
      actions={
        <SheetButtonRow
          width={width}
          buttons={[
            {
              id: "save",
              label: screen.pending === "membership" ? "Saving…" : "Save membership",
              compactLabel: "Save",
              shortcut: "Enter",
              tone: "primary",
              mouseTarget: { kind: "groupSettingsAction", actionId: "save" },
              focused: screen.detailFocus === "membershipSave",
              disabled: model.pending || !model.membershipChanged,
            },
            {
              id: "back",
              label: "Back",
              shortcut: "Esc",
              tone: "neutral",
              mouseTarget: { kind: "groupSettingsAction", actionId: "back" },
              focused: screen.detailFocus === "sessionsBack",
              disabled: model.pending,
            },
          ]}
        />
      }
      footer={
        <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.DIM}>
          {fit(" Uncheck = ungroup on Save. Space/Enter toggles.", width)}
        </text>
      }
    >
      {model.sessions.length === 0 ? (
        <text fg={toOpenTuiColor(theme.text.muted)} attributes={TextAttributes.DIM}>
          {fit(" No sessions in this Project.", width)}
        </text>
      ) : (
        model.sessions.map((session) => (
          <SessionItem
            key={session.sessionId}
            session={session}
            width={width}
            pending={model.pending}
          />
        ))
      )}
    </SettingsPanelDetailView>
  );
}

function SessionItem({
  session,
  width,
  pending,
}: {
  session: NonNullable<ReturnType<typeof groupSettingsPanelModel>>["sessions"][number];
  width: number;
  pending: boolean;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const marker = session.focused ? "▸" : " ";
  const checkbox = session.checked ? "[✓]" : "[ ]";
  const prefix = `${marker} ${session.slot} ${checkbox} `;
  const membership = truncateCells(
    session.membershipLabel,
    Math.max(0, Math.floor(width / 2)),
  );
  const suffix = cellWidth(membership) === 0 ? "" : ` ${membership}`;
  const titleWidth = Math.max(0, width - cellWidth(prefix) - cellWidth(suffix));
  const title = fit(session.title, titleWidth);
  return (
    <text
      id={semanticItemRenderableId(session.sessionId)}
      fg={toOpenTuiColor(theme.text.primary)}
      {...(session.focused ? { bg: toOpenTuiColor(theme.interaction.keyboardFocus) } : {})}
      {...(hover && !pending ? { bg: toOpenTuiColor(theme.interaction.hover) } : {})}
      {...stationMouseProps(dispatch, {
        kind: "groupSettingsSession",
        sessionId: session.sessionId,
      })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {prefix}
      {title}
      <span fg={toOpenTuiColor(theme.text.muted)} attributes={TextAttributes.DIM}>
        {suffix}
      </span>
    </text>
  );
}

function RemoveDetail({ model, screen, width, showHeader }: DetailProps) {
  const theme = useStationTheme();
  const sessionWord = model.group.memberCount === 1 ? "session" : "sessions";
  return (
    <SettingsPanelDetailView
      width={width}
      title="Remove Group"
      showHeader={showHeader}
      focused={screen.focus === "detail"}
      danger
      bodyItemIds={["group-settings:remove-confirm"]}
      followedBodyItemId="group-settings:remove-confirm"
      actions={
        <SheetButtonRow
          width={width}
          buttons={[
            {
              id: "remove",
              label: screen.pending === "delete" ? "Removing…" : "Remove Group",
              compactLabel: "Remove",
              shortcut: "Enter",
              tone: "danger",
              mouseTarget: { kind: "groupSettingsAction", actionId: "save" },
              focused: screen.detailFocus === "removeSubmit",
              disabled: model.pending || !model.removeArmed,
            },
            {
              id: "back",
              label: "Back",
              shortcut: "Esc",
              tone: "neutral",
              mouseTarget: { kind: "groupSettingsAction", actionId: "back" },
              focused: screen.detailFocus === "removeBack",
              disabled: model.pending,
            },
          ]}
        />
      }
    >
      {showHeader ? (
        <>
          <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.BOLD}>
            {fit(` Its ${model.group.memberCount} ${sessionWord} remain open`, width)}
          </text>
          <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.BOLD}>
            {fit(" and become ungrouped.", width)}
          </text>
          <text fg={toOpenTuiColor(theme.text.muted)} attributes={TextAttributes.DIM}>
            {fit(` Type "${model.removePhrase}"`, width)}
          </text>
          <text fg={toOpenTuiColor(theme.text.muted)} attributes={TextAttributes.DIM}>
            {fit(" to confirm.", width)}
          </text>
        </>
      ) : (
        <>
          <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.BOLD}>
            {fit(" Sessions stay open; become ungrouped.", width)}
          </text>
          <text fg={toOpenTuiColor(theme.text.muted)} attributes={TextAttributes.DIM}>
            {fit(` Confirm: ${model.removePhrase}`, width)}
          </text>
        </>
      )}
      <ControlInputLine
        screen={screen}
        control="removeConfirm"
        width={width}
        input={screen.removeDraft}
        placeholder={model.removePhrase}
        itemId="group-settings:remove-confirm"
      />
    </SettingsPanelDetailView>
  );
}

type DetailProps = {
  model: NonNullable<ReturnType<typeof groupSettingsPanelModel>>;
  screen: GroupSettingsScreen;
  width: number;
  showHeader: boolean;
};

function ControlInputLine({
  screen,
  control,
  width,
  label,
  input,
  placeholder,
  itemId,
}: {
  screen: GroupSettingsScreen;
  control: Extract<GroupSettingsDetailFocus, "name" | "removeConfirm">;
  width: number;
  label?: string;
  input: GroupSettingsScreen["nameDraft"];
  placeholder?: string;
  itemId: string;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const focused = screen.focus === "detail" && screen.detailFocus === control;
  const prefix = `${focused ? "▸" : " "}${label === undefined ? "" : ` ${label}`} `;
  return (
    <text
      id={semanticItemRenderableId(itemId)}
      width={width}
      wrapMode="none"
      fg={toOpenTuiColor(theme.text.primary)}
      {...(focused ? { bg: toOpenTuiColor(theme.interaction.keyboardFocus) } : {})}
      {...(screen.pending === undefined
        ? stationMouseProps(dispatch, { kind: "groupSettingsControl", control })
        : {})}
    >
      {fit(prefix, Math.min(cellWidth(prefix), width))}
      <EditableTextInputView
        {...input}
        active={focused && screen.pending === undefined}
        {...(placeholder === undefined ? {} : { placeholder })}
      />
    </text>
  );
}

function sectionLabel(section: GroupSettingsScreen["section"]): string {
  if (section === "general") return "General";
  if (section === "sessions") return "Sessions";
  return "Remove Group";
}
