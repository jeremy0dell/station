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
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../../theme/index.js";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { fit, SheetButtonRow, SheetLine } from "../sheets/parts.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "../stationMouseContext.js";

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
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const layout = settingsPanelLayout(columns, rows);
  const compact = layout.innerWidth < 54;
  const showList = !compact || screen.focus === "list";
  const showDetail = !compact || screen.focus === "detail";
  const detailWidth = compact ? layout.innerWidth : layout.rightWidth;
  const model = groupSettingsPanelModel(
    snapshot,
    screen,
    Math.max(0, layout.contentHeight - 4),
  );
  if (model === undefined) return null;
  const title = compact && showDetail
    ? `${sectionLabel(screen.section)} · ${model.group.name}`
    : `Group settings · ${model.group.name}`;
  const footer = model.pending
    ? "Saving…"
    : screen.focus === "list"
      ? "↑↓ or G/S/R select · →/enter edit · esc back"
      : "↑↓ focus · enter activate · esc sections";

  return (
    <box
      position="absolute"
      top={layout.top}
      left={layout.left}
      width={layout.width}
      height={layout.height}
      zIndex={10}
      border
      borderColor={toOpenTuiColor(theme.interaction.hairline)}
      backgroundColor={toOpenTuiOpaqueColor(theme.surfaces.settings)}
      flexDirection="column"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.BOLD}>
        {fit(` ${title}`, layout.innerWidth)}
      </text>
      <box flexDirection="row" width={layout.innerWidth} height={layout.contentHeight}>
        {showList ? (
          <box
            flexDirection="column"
            width={compact ? layout.innerWidth : layout.leftWidth}
          >
            <SectionList
              screen={screen}
              width={compact ? layout.innerWidth : layout.leftWidth}
              groupName={model.group.name}
            />
          </box>
        ) : null}
        {!compact ? <VerticalDivider height={layout.contentHeight} /> : null}
        {showDetail ? (
          <box flexDirection="column" width={detailWidth}>
            <DetailPane model={model} screen={screen} width={detailWidth} />
          </box>
        ) : null}
      </box>
      <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.DIM}>
        {fit(` ${footer}`, layout.innerWidth)}
      </text>
    </box>
  );
}

function SectionList({
  screen,
  width,
  groupName,
}: {
  screen: GroupSettingsScreen;
  width: number;
  groupName: string;
}) {
  return (
    <>
      <PaneHeader label={groupName} width={width} focused={screen.focus === "list"} />
      {GROUP_SETTINGS_ITEMS.map((item) => (
        <SectionRow key={item.id} screen={screen} item={item} width={width} />
      ))}
    </>
  );
}

function SectionRow({
  screen,
  item,
  width,
}: {
  screen: GroupSettingsScreen;
  item: (typeof GROUP_SETTINGS_ITEMS)[number];
  width: number;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const active = item.id === screen.section;
  const danger = item.id === "remove";
  return (
    <text
      fg={toOpenTuiColor(
        danger ? theme.status.danger : active ? theme.action.primary : theme.text.primary,
      )}
      {...(hover && screen.pending === undefined
        ? { bg: toOpenTuiColor(theme.interaction.hover) }
        : {})}
      {...stationMouseProps(dispatch, { kind: "groupSettingsSection", section: item.id })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {fit(`${active ? "▸ " : "  "}${item.label}`, width)}
    </text>
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

function GeneralDetail({
  model,
  screen,
  width,
}: DetailProps) {
  const theme = useStationTheme();
  const saveEnabled =
    screen.pending === undefined &&
    screen.nameDraft.value.trim().length > 0 &&
    screen.nameDraft.value.trim() !== screen.baselineName;
  return (
    <>
      <PaneHeader label="General" width={width} focused={screen.focus === "detail"} />
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

function SessionsDetail({
  model,
  screen,
  width,
}: DetailProps) {
  const theme = useStationTheme();
  return (
    <>
      <PaneHeader label="Sessions" width={width} focused={screen.focus === "detail"} />
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
      <span
        fg={toOpenTuiColor(theme.text.muted)}
        attributes={TextAttributes.DIM}
      >
        {suffix}
      </span>
    </text>
  );
}

function RemoveDetail({
  model,
  screen,
  width,
}: DetailProps) {
  const theme = useStationTheme();
  const sessionWord = model.group.memberCount === 1 ? "session" : "sessions";
  return (
    <>
      <PaneHeader label="Remove Group" width={width} focused={screen.focus === "detail"} danger />
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
  const theme = useStationTheme();
  const accent = danger ? theme.status.danger : theme.action.primary;
  return focused ? (
    <text
      fg={toOpenTuiColor(theme.text.inverse)}
      bg={toOpenTuiColor(accent)}
      attributes={TextAttributes.BOLD}
    >
      {fit(` ${label}`, width)}
    </text>
  ) : (
    <text
      fg={toOpenTuiColor(danger ? theme.status.danger : theme.text.primary)}
      attributes={TextAttributes.BOLD}
    >
      {fit(` ${label}`, width)}
    </text>
  );
}

function VerticalDivider({ height }: { height: number }) {
  const theme = useStationTheme();
  return (
    <box flexDirection="column" width={1}>
      {Array.from({ length: height }, (_, row) => (
        <text key={row} fg={toOpenTuiColor(theme.text.muted)}>
          │
        </text>
      ))}
    </box>
  );
}

function sectionLabel(section: GroupSettingsScreen["section"]): string {
  if (section === "general") return "General";
  if (section === "sessions") return "Sessions";
  return "Remove Group";
}
