import { TextAttributes } from "@opentui/core";
import {
  groupSettingsPanelModel,
  settingsPanelLayout,
  truncateCells,
} from "@station/dashboard-core/selectors";
import type {
  DashboardScreenView,
  DashboardSnapshotView,
  GroupSettingsDetailFocus,
} from "@station/dashboard-core/state";
import { GROUP_SETTINGS_ITEMS } from "@station/dashboard-core/state";
import { toOpenTuiColor, useStationTheme } from "../../../theme/index.js";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { fit, SheetButtonRow, SheetLine } from "../sheets/parts.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "../stationMouseContext.js";
import { SettingsPanelView, SettingsPaneHeader } from "./SettingsPanelView.js";

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
  const layout = settingsPanelLayout(columns, rows);
  const model = groupSettingsPanelModel(
    snapshot,
    screen,
    Math.max(0, layout.contentHeight - 4),
  );
  if (model === undefined) return null;
  const footer = model.pending
    ? "Saving…"
    : screen.focus === "list"
      ? "↑↓ or G/S/R select · →/enter edit · esc back"
      : "↑↓ focus · enter activate · esc sections";

  return (
    <SettingsPanelView
      layout={layout}
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
      renderDetail={({ width }) => <DetailPane model={model} screen={screen} width={width} />}
    />
  );
}

function DetailPane({
  model,
  screen,
  width,
}: {
  model: NonNullable<ReturnType<typeof groupSettingsPanelModel>>;
  screen: GroupSettingsScreen;
  width: number;
}) {
  switch (screen.section) {
    case "general":
      return <GeneralDetail model={model} screen={screen} width={width} />;
    case "sessions":
      return <SessionsDetail model={model} screen={screen} width={width} />;
    case "remove":
      return <RemoveDetail model={model} screen={screen} width={width} />;
  }
}

function GeneralDetail({ model, screen, width }: DetailProps) {
  const theme = useStationTheme();
  const saveEnabled =
    screen.pending === undefined &&
    screen.nameDraft.value.trim().length > 0 &&
    screen.nameDraft.value.trim() !== screen.baselineName;
  return (
    <>
      <SettingsPaneHeader label="General" width={width} focused={screen.focus === "detail"} />
      <ControlInputLine
        screen={screen}
        control="name"
        width={width}
        label="Name"
        input={screen.nameDraft}
      />
      <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.DIM}>
        {fit(" Save renames; sessions stay attached.", width)}
      </text>
      <SheetLine width={width}> </SheetLine>
      <text fg={toOpenTuiColor(theme.text.primary)}>
        {fit(` Project ${model.project.label} (read-only)`, width)}
      </text>
      <text fg={toOpenTuiColor(theme.text.muted)} attributes={TextAttributes.DIM}>
        {fit(` ${model.project.root}`, width)}
      </text>
      <SheetLine width={width}> </SheetLine>
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
    </>
  );
}

function SessionsDetail({ model, screen, width }: DetailProps) {
  const theme = useStationTheme();
  return (
    <>
      <SettingsPaneHeader label="Sessions" width={width} focused={screen.focus === "detail"} />
      {model.hiddenAbove > 0 ? (
        <text fg={toOpenTuiColor(theme.text.muted)}>{fit(` ↑ ${model.hiddenAbove} more`, width)}</text>
      ) : null}
      {model.sessions.length === 0 ? (
        <text fg={toOpenTuiColor(theme.text.muted)} attributes={TextAttributes.DIM}>
          {fit(" No sessions in this Project.", width)}
        </text>
      ) : (
        model.sessions.map((session) => (
          <SessionRow key={session.sessionId} session={session} width={width} pending={model.pending} />
        ))
      )}
      {model.hiddenBelow > 0 ? (
        <text fg={toOpenTuiColor(theme.text.muted)}>{fit(` ↓ ${model.hiddenBelow} more`, width)}</text>
      ) : null}
      <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.DIM}>
        {fit(" Uncheck = ungroup on Save. Space/Enter toggles.", width)}
      </text>
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
    </>
  );
}

function SessionRow({
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
  const suffix = membership.length === 0 ? "" : ` ${membership}`;
  const titleWidth = Math.max(0, width - prefix.length - suffix.length);
  const title = fit(session.title, titleWidth);
  return (
    <text
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

function RemoveDetail({ model, screen, width }: DetailProps) {
  const theme = useStationTheme();
  const sessionWord = model.group.memberCount === 1 ? "session" : "sessions";
  return (
    <>
      <SettingsPaneHeader
        label="Remove Group"
        width={width}
        focused={screen.focus === "detail"}
        danger
      />
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
      <ControlInputLine
        screen={screen}
        control="removeConfirm"
        width={width}
        input={screen.removeDraft}
        placeholder={model.removePhrase}
      />
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
    </>
  );
}

type DetailProps = {
  model: NonNullable<ReturnType<typeof groupSettingsPanelModel>>;
  screen: GroupSettingsScreen;
  width: number;
};

function ControlInputLine({
  screen,
  control,
  width,
  label,
  input,
  placeholder,
}: {
  screen: GroupSettingsScreen;
  control: Extract<GroupSettingsDetailFocus, "name" | "removeConfirm">;
  width: number;
  label?: string;
  input: GroupSettingsScreen["nameDraft"];
  placeholder?: string;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const focused = screen.focus === "detail" && screen.detailFocus === control;
  const prefix = `${focused ? "▸" : " "}${label === undefined ? "" : ` ${label}`} `;
  return (
    <text
      fg={toOpenTuiColor(theme.text.primary)}
      {...(focused ? { bg: toOpenTuiColor(theme.interaction.keyboardFocus) } : {})}
      {...(screen.pending === undefined
        ? stationMouseProps(dispatch, { kind: "groupSettingsControl", control })
        : {})}
    >
      {fit(prefix, Math.min(prefix.length, width))}
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
