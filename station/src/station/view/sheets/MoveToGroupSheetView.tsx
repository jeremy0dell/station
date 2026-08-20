import {
  bottomSheetContentWidth,
  selectMoveToGroupChoices,
  selectMoveToGroupSessionContext,
} from "@station/dashboard-core/selectors";
import {
  MOVE_TO_GROUP_CREATE_CHOICE_ID,
  MOVE_TO_GROUP_LIST_ID,
  MOVE_TO_GROUP_UNGROUPED_CHOICE_ID,
  moveToGroupExistingChoiceId,
} from "@station/dashboard-core/state";
import type {
  DashboardScreenView,
  DashboardSnapshotView,
  DashboardStateView,
} from "@station/dashboard-core/state";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  SheetButtonRow,
  SheetChoiceLine,
  SheetControlRow,
  SheetFooter,
  SheetLabelValue,
  SheetLine,
  SheetProgressFooter,
} from "./parts.js";

type MoveToGroupScreen = Exclude<
  Extract<DashboardScreenView, { name: "moveToGroup" }>,
  { step: "chooseSlot" }
>;

export type MoveToGroupSheetViewProps = {
  snapshot: DashboardSnapshotView;
  screen: MoveToGroupScreen;
  selection: DashboardStateView["selection"];
  columns: number;
  rows: number;
};

export function MoveToGroupSheetView({
  snapshot,
  screen,
  selection,
  columns,
  rows,
}: MoveToGroupSheetViewProps) {
  const width = bottomSheetContentWidth(columns);
  if (screen.step === "createGroup") {
    return (
      <BottomSheetFrameView columns={columns} rows={rows} title="Create Group" contentRows={6}>
        <SheetLabelValue width={width} label="Session" labelWidth={10} value={screen.sessionTitle} />
        <SheetControlRow
          width={width}
          label="Group"
          value={
            <EditableTextInputView
              value={screen.draftName.value}
              cursor={screen.draftName.cursor}
              placeholder="Group name"
              active={!screen.submitting}
            />
          }
          valueCells={Math.max(screen.draftName.value.length, "Group name".length) + 1}
          focused
          disabled={screen.submitting}
          mouseTarget={{ kind: "sheetBackdrop" }}
        />
        <SheetButtonRow
          width={width}
          buttons={[
            {
              id: "moveToGroup.create.submit",
              label: "Create and Move",
              compactLabel: "Create",
              shortcut: "Enter",
              tone: "primary",
              focused: false,
              disabled: screen.submitting || screen.draftName.value.trim().length === 0,
              mouseTarget: { kind: "moveToGroupCreateSubmit" },
            },
          ]}
        />
        <SheetLine width={width}> </SheetLine>
        {screen.submitting ? (
          <SheetProgressFooter width={width}>Creating Group…</SheetProgressFooter>
        ) : (
          <SheetFooter width={width}>Enter create and move · Esc back</SheetFooter>
        )}
      </BottomSheetFrameView>
    );
  }

  const context = selectMoveToGroupSessionContext(snapshot, screen.sessionId);
  const choices = selectMoveToGroupChoices(snapshot, screen.sessionId);
  const currentGroupId = context?.currentGroup?.id;
  const currentLabel =
    context?.currentGroup === undefined
      ? "Ungrouped"
      : context.currentGroup.parentGroupId === undefined
        ? context.currentGroup.name
        : `${context.currentGroup.name} (nested, read-only)`;
  const selectedId = selection.get(MOVE_TO_GROUP_LIST_ID);
  const listHeight = Math.max(1, Math.min(choices.length, rows - 9));
  const selectedIndex = Math.max(
    0,
    choices.findIndex((choice) => moveToGroupExistingChoiceId(choice.value.id) === selectedId),
  );
  const start = Math.max(0, Math.min(selectedIndex, choices.length - listHeight));
  const visibleChoices = choices.slice(start, start + listHeight);
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      title="Move to Group"
      contentRows={visibleChoices.length + 7}
    >
      <SheetLabelValue width={width} label="Session" labelWidth={10} value={screen.sessionTitle} />
      <SheetLabelValue width={width} label="Current" labelWidth={10} value={currentLabel} />
      <SheetChoiceLine
        choiceKey="U"
        label="Ungrouped"
        detail=""
        width={width}
        current={currentGroupId === undefined}
        selected={selectedId === MOVE_TO_GROUP_UNGROUPED_CHOICE_ID}
      />
      {visibleChoices.map((choice) => (
        <SheetChoiceLine
          key={choice.value.id}
          choiceKey={choice.key}
          label={choice.value.name}
          detail=""
          width={width}
          current={currentGroupId === choice.value.id}
          selected={selectedId === moveToGroupExistingChoiceId(choice.value.id)}
        />
      ))}
      <SheetChoiceLine
        choiceKey="N"
        label="Create new Group…"
        detail=""
        width={width}
        selected={selectedId === MOVE_TO_GROUP_CREATE_CHOICE_ID}
      />
      <SheetLine width={width}> </SheetLine>
      {screen.submitting ? (
        <SheetProgressFooter width={width}>Moving session…</SheetProgressFooter>
      ) : (
        <SheetFooter width={width}>
          {visibleChoices.length < choices.length
            ? `↑↓ move   ↵ select   ${start + 1}-${start + visibleChoices.length} of ${choices.length}   U/N   Esc cancel`
            : "↑↓ move   ↵ select   U ungrouped   N create   Esc cancel"}
        </SheetFooter>
      )}
    </BottomSheetFrameView>
  );
}
