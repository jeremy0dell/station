import {
  GROUP_MENU_ITEMS,
  type DashboardSnapshotView,
  type GroupMenuScreenView,
} from "@station/dashboard-core/state";
import {
  DashboardMenuView,
  type DashboardMenuItemView,
  type DashboardMenuModel,
  type DashboardMenuViewport,
} from "./DashboardMenuView.js";

export type GroupMenuViewProps = {
  snapshot: DashboardSnapshotView;
  screen: GroupMenuScreenView;
  viewport: DashboardMenuViewport;
};

export function GroupMenuView({ snapshot, screen, viewport }: GroupMenuViewProps) {
  const group = snapshot.sessionGroups.find((candidate) => candidate.id === screen.groupId);
  if (group === undefined || group.projectId !== screen.projectId) return null;

  const menu: DashboardMenuModel = {
    items: groupMenuItems(screen),
    width: 28,
    title: group.name,
  };
  return <DashboardMenuView menu={menu} viewport={viewport} />;
}

function groupMenuItems(screen: GroupMenuScreenView): readonly DashboardMenuItemView[] {
  return GROUP_MENU_ITEMS.map((item) => ({
    ...item,
    focused: screen.focus === item.id,
    target: { kind: "groupMenuAction", actionId: item.id },
  }));
}
