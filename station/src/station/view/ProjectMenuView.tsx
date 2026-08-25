import type {
  DashboardScreenView,
  ProjectMenuActionId,
} from "@station/dashboard-core/state";
import {
  DashboardMenuView,
  type DashboardMenuItemView,
  type DashboardMenuModel,
} from "./DashboardMenuView.js";

const PROJECT_MENU_ITEMS: readonly {
  id: ProjectMenuActionId;
  label: string;
  shortcut?: string;
}[] = [
  { id: "quickGroup", label: "Quick Group", shortcut: "G" },
  { id: "newGroup", label: "New Group…" },
  { id: "defaultAgent", label: "Set default agent" },
  { id: "settings", label: "Project settings…" },
];

type ProjectMenuScreen = Extract<DashboardScreenView, { name: "projectMenu" }>;

export type ProjectMenuViewProps = {
  screen: ProjectMenuScreen;
  boundaryId: string;
  anchorRenderableId: string;
};

export function ProjectMenuView({ screen, boundaryId, anchorRenderableId }: ProjectMenuViewProps) {
  const menu: DashboardMenuModel = {
    items: projectMenuItems(screen),
    preferredWidth: 24,
  };
  return (
    <DashboardMenuView
      menu={menu}
      boundaryId={boundaryId}
      anchorRenderableId={anchorRenderableId}
    />
  );
}

function projectMenuItems(screen: ProjectMenuScreen): readonly DashboardMenuItemView[] {
  return PROJECT_MENU_ITEMS.map((item) => ({
    ...item,
    focused: screen.focus === item.id,
    target: { kind: "projectMenuAction", actionId: item.id },
  }));
}
