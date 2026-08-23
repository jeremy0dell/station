import {
  cellWidth,
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
import { bottomSheetContentWidth, BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  SheetButtonRow,
  SheetChoiceLine,
  SheetControlRow,
  SheetFooter,
  SheetLabelValue,
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
      <BottomSheetFrameView
        columns={columns}
        rows={rows}
        title="Create Group"
        bodyPaddingBottom={1}
        actions={
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
        }
        footer={
          screen.submitting ? (
            <SheetProgressFooter width={width}>Creating Group…</SheetProgressFooter>
          ) : (
            <SheetFooter width={width}>Enter create and move · Esc back</SheetFooter>
          )
        }
      >
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
          valueCells={Math.max(cellWidth(screen.draftName.value), cellWidth("Group name")) + 1}
          focused
          disabled={screen.submitting}
          mouseTarget={{ kind: "sheetBackdrop" }}
        />
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
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      title="Move to Group"
      bodyItemIds={[
        MOVE_TO_GROUP_UNGROUPED_CHOICE_ID,
        ...choices.map((choice) => moveToGroupExistingChoiceId(choice.value.id)),
        MOVE_TO_GROUP_CREATE_CHOICE_ID,
      ]}
      followedBodyItemId={selectedId}
      bodyPaddingBottom={1}
      footer={
        screen.submitting ? (
          <SheetProgressFooter width={width}>Moving session…</SheetProgressFooter>
        ) : (
          <SheetFooter width={width}>
            ↑↓ move   ↵ select   U ungrouped   N create   Esc cancel
          </SheetFooter>
        )
      }
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
        itemId={MOVE_TO_GROUP_UNGROUPED_CHOICE_ID}
      />
      {choices.map((choice) => (
        <SheetChoiceLine
          key={choice.value.id}
          choiceKey={choice.key}
          label={choice.value.name}
          detail=""
          width={width}
          current={currentGroupId === choice.value.id}
          selected={selectedId === moveToGroupExistingChoiceId(choice.value.id)}
          itemId={moveToGroupExistingChoiceId(choice.value.id)}
        />
      ))}
      <SheetChoiceLine
        choiceKey="N"
        label="Create new Group…"
        detail=""
        width={width}
        selected={selectedId === MOVE_TO_GROUP_CREATE_CHOICE_ID}
        itemId={MOVE_TO_GROUP_CREATE_CHOICE_ID}
      />
    </BottomSheetFrameView>
  );
}
