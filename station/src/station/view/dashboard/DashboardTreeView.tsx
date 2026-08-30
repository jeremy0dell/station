import type {
  DashboardTreeBranch,
  RowGridLayout,
} from "@station/dashboard-core/selectors";
import { GroupFrameView, groupFrameContentColumns } from "../GroupFrameView.js";
import { GroupHeaderView } from "../GroupHeaderView.js";
import { ProjectHeaderView } from "../ProjectHeaderView.js";
import { semanticItemRenderableId } from "../layout/scroll/scrollViewport.js";
import { DashboardLeafView } from "./DashboardLeafView.js";

export function DashboardTreeView({
  columns,
  roots,
  layoutByItem,
  keyByRow,
}: {
  columns: number;
  roots: readonly DashboardTreeBranch[];
  layoutByItem: ReadonlyMap<string, RowGridLayout>;
  keyByRow: ReadonlyMap<string, string>;
}) {
  return (
    <box flexDirection="column" width="100%" gap={1}>
      {roots.map((branch) => (
        <DashboardBranchView
          key={branch.row.id}
          columns={columns}
          branch={branch}
          layoutByItem={layoutByItem}
          keyByRow={keyByRow}
        />
      ))}
    </box>
  );
}

function DashboardBranchView({
  columns,
  branch,
  layoutByItem,
  keyByRow,
}: {
  columns: number;
  branch: DashboardTreeBranch;
  layoutByItem: ReadonlyMap<string, RowGridLayout>;
  keyByRow: ReadonlyMap<string, string>;
}) {
  const row = branch.row;
  if (row.payload.type === "projectHeader") {
    return (
      <ProjectBranchView
        columns={columns}
        branch={branch}
        layoutByItem={layoutByItem}
        keyByRow={keyByRow}
      />
    );
  }
  if (row.payload.type === "groupHeader") {
    return (
      <GroupBranchView
        columns={columns}
        branch={branch}
        layoutByItem={layoutByItem}
        keyByRow={keyByRow}
      />
    );
  }
  return (
    <DashboardLeafView row={row} layout={layoutByItem.get(row.id)} keyByRow={keyByRow} />
  );
}

function ProjectBranchView({
  columns,
  branch,
  layoutByItem,
  keyByRow,
}: {
  columns: number;
  branch: DashboardTreeBranch;
  layoutByItem: ReadonlyMap<string, RowGridLayout>;
  keyByRow: ReadonlyMap<string, string>;
}) {
  const row = branch.row;
  if (row.payload.type !== "projectHeader") return null;
  return (
    <box id={`station-dashboard-project:${row.id}`} flexDirection="column" width="100%">
      <ProjectHeaderView
        renderableId={semanticItemRenderableId(row.id)}
        columns={columns}
        rowId={row.id}
        project={row.payload.project}
        collapsed={row.payload.collapsed}
        groupCount={row.payload.groupCount}
        persistentFilterMatch={row.payload.persistentFilterMatch}
        focusedCellId={row.focusedCellId}
      />
      {branch.children.map((child) => (
        <DashboardBranchView
          key={child.row.id}
          columns={columns}
          branch={child}
          layoutByItem={layoutByItem}
          keyByRow={keyByRow}
        />
      ))}
    </box>
  );
}

function GroupBranchView({
  columns,
  branch,
  layoutByItem,
  keyByRow,
}: {
  columns: number;
  branch: DashboardTreeBranch;
  layoutByItem: ReadonlyMap<string, RowGridLayout>;
  keyByRow: ReadonlyMap<string, string>;
}) {
  const row = branch.row;
  if (row.payload.type !== "groupHeader") return null;
  const renderableId = `station-dashboard-group:${row.id}`;
  const header = (
    <GroupHeaderView
      renderableId={semanticItemRenderableId(row.id)}
      columns={row.payload.collapsed ? columns : groupFrameContentColumns(columns)}
      rowId={row.id}
      payload={row.payload}
      cells={row.cells}
      focusedCellId={row.focusedCellId}
    />
  );
  if (row.payload.collapsed) {
    return (
      <box id={renderableId} flexDirection="column" width="100%">
        {header}
      </box>
    );
  }
  return (
    <GroupFrameView
      renderableId={renderableId}
      focus={{
        focusedHeader: row.focusedCellId !== undefined,
        containsFocusedRow: row.containsFocusedRow === true,
      }}
    >
      {header}
      {branch.children.map((child) => (
        <DashboardBranchView
          key={child.row.id}
          columns={columns}
          branch={child}
          layoutByItem={layoutByItem}
          keyByRow={keyByRow}
        />
      ))}
    </GroupFrameView>
  );
}
