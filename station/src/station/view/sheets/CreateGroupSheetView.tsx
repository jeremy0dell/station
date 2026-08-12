import { bottomSheetContentWidth, createGroupSheetContent } from "@station/dashboard-core/selectors";
import type { DashboardScreenView } from "@station/dashboard-core/state";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import { SheetButtonRow, SheetControlRow, SheetFooter } from "./parts.js";

export type CreateGroupSheetViewProps = {
  screen: Extract<DashboardScreenView, { name: "createGroup" }>;
  columns: number;
  rows: number;
};

export function CreateGroupSheetView({ screen, columns, rows }: CreateGroupSheetViewProps) {
  const content = createGroupSheetContent(screen);
  const width = bottomSheetContentWidth(columns);
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      title="Create Group"
      contentRows={4}
    >
      <SheetControlRow
        width={width}
        label={content.name.label}
        shortcut={content.name.accelerator}
        value={
          <EditableTextInputView
            value={screen.draftName.value}
            cursor={screen.draftName.cursor}
            placeholder="Group name"
            active={content.name.focused && content.name.enabled}
          />
        }
        valueCells={Math.max(screen.draftName.value.length, "Group name".length) + Number(content.name.focused)}
        focused={content.name.focused}
        disabled={!content.name.enabled}
        mouseTarget={{ kind: "createGroupAction", actionId: content.name.actionId }}
      />
      <SheetControlRow
        width={width}
        label={content.quickSession.label}
        shortcut={content.quickSession.accelerator}
        value={content.quickSession.value}
        focused={content.quickSession.focused}
        disabled={!content.quickSession.enabled}
        mouseTarget={{ kind: "createGroupAction", actionId: content.quickSession.actionId }}
      />
      <SheetButtonRow
        width={width}
        buttons={[
          {
            id: content.create.actionId,
            label: content.create.label,
            compactLabel: "Create",
            shortcut: content.create.accelerator ?? "C",
            tone: "primary",
            focused: content.create.focused,
            disabled: !content.create.enabled,
            mouseTarget: { kind: "createGroupAction", actionId: content.create.actionId },
          },
          {
            id: content.cancel.actionId,
            label: content.cancel.label,
            shortcut: content.cancel.accelerator ?? "Esc",
            tone: "neutral",
            focused: content.cancel.focused,
            disabled: !content.cancel.enabled,
            mouseTarget: { kind: "createGroupAction", actionId: content.cancel.actionId },
          },
        ]}
      />
      <SheetFooter width={width}>{content.helper}</SheetFooter>
    </BottomSheetFrameView>
  );
}
