import {
  GROUP_MENU_ITEMS,
  type GroupMenuScreenView,
} from "@station/dashboard-core/state";
import {
  DashboardMenuView,
  type DashboardMenuItemView,
  type DashboardMenuModel,
} from "./DashboardMenuView.js";

export type GroupMenuViewProps = {
  screen: GroupMenuScreenView;
  groupName: string;
  boundaryId: string;
  anchorRenderableId: string;
};

export function GroupMenuView({
  screen,
  groupName,
  boundaryId,
  anchorRenderableId,
}: GroupMenuViewProps) {
  const menu: DashboardMenuModel = {
    items: groupMenuItems(screen),
    preferredWidth: 28,
    title: groupName,
  };
  return (
    <DashboardMenuView
      menu={menu}
      boundaryId={boundaryId}
      anchorRenderableId={anchorRenderableId}
    />
  );
}

function groupMenuItems(screen: GroupMenuScreenView): readonly DashboardMenuItemView[] {
  return GROUP_MENU_ITEMS.map((item) => ({
    ...item,
    focused: screen.focus === item.id,
    target: { kind: "groupMenuAction", actionId: item.id },
  }));
}
