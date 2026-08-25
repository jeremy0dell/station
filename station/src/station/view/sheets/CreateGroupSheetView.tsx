import { createGroupSheetContent } from "@station/dashboard-core/selectors";
import { cellWidth } from "@station/dashboard-core/text";
import type { DashboardScreenView } from "@station/dashboard-core/state";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { bottomSheetContentWidth } from "../layout/bottomSheetFrame.js";
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
      actions={
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
      }
      footer={<SheetFooter width={width}>{content.helper}</SheetFooter>}
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
        valueCells={
          Math.max(cellWidth(screen.draftName.value), cellWidth("Group name")) +
          Number(content.name.focused)
        }
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
    </BottomSheetFrameView>
  );
}
