import type {
  DashboardScreenView,
  ProjectMenuActionId,
} from "@station/dashboard-core/state";
import {
  DashboardMenuView,
  type DashboardMenuItemView,
  type DashboardMenuModel,
  type DashboardMenuViewport,
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
  viewport: DashboardMenuViewport;
};

export function ProjectMenuView({ screen, viewport }: ProjectMenuViewProps) {
  const menu: DashboardMenuModel = {
    items: projectMenuItems(screen),
    width: 24,
  };
  return <DashboardMenuView menu={menu} viewport={viewport} />;
}

function projectMenuItems(screen: ProjectMenuScreen): readonly DashboardMenuItemView[] {
  return PROJECT_MENU_ITEMS.map((item) => ({
    ...item,
    focused: screen.focus === item.id,
    target: { kind: "projectMenuAction", actionId: item.id },
  }));
}
