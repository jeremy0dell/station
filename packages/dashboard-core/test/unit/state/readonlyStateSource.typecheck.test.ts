import type { ObserverService, StationClientStateSource } from "@station/client";
import type { ProjectId } from "@station/contracts";
import { expect, it } from "vitest";
import type { DashboardCapabilities } from "../../../src/state/capabilities/execution.js";
import type { ReadonlyDeep } from "../../../src/state/readonly.js";
import type { DashboardRuntimeOptions } from "../../../src/state/runtime.js";
import type { DashboardSnapshotView, DashboardStateView } from "../../../src/state/types.js";

function verifyReadonlyStateSource(
  state: DashboardStateView,
  snapshot: DashboardSnapshotView,
  snapshotRow: DashboardSnapshotView["rows"][number],
  pendingCreateRow: DashboardStateView["localRows"]["pendingCreate"][number],
  projectId: ReadonlyDeep<ProjectId>,
  callback: ReadonlyDeep<(value: string) => number>,
  readonlyMap: ReadonlyDeep<Map<string, { values: string[] }>>,
): void {
  // @ts-expect-error Public dashboard state cannot replace the active screen.
  state.screen = { name: "dashboard" };
  // @ts-expect-error Snapshot row collections do not expose array mutation.
  snapshot.rows.push(snapshotRow);
  // @ts-expect-error Snapshot row fields remain readonly recursively.
  snapshotRow.display.statusLabel = "working";
  // @ts-expect-error Local optimistic row collections do not expose array mutation.
  state.localRows.pendingCreate.push(pendingCreateRow);
  // @ts-expect-error Readonly sets do not expose mutation methods.
  state.collapsedProjectIds.add("project");
  // @ts-expect-error Readonly maps do not expose mutation methods.
  readonlyMap.set("project", { values: [] });
  // @ts-expect-error Values nested inside readonly maps remain readonly.
  readonlyMap.get("project")?.values.push("value");
  // @ts-expect-error Widget collections do not expose array mutation.
  state.widgets.push({ type: "time" });

  if (state.screen.name === "newSession") {
    // @ts-expect-error Nested flow history remains readonly.
    state.screen.flow.stepHistory.push("review");
  }

  const timezoneWidget = state.widgets.find((widget) => widget.type === "tz");
  if (timezoneWidget !== undefined) {
    // @ts-expect-error Nested timezone collections remain readonly.
    timezoneWidget.zones.push({ label: "UTC", timeZone: "UTC" });
  }

  const preservedProjectId: ProjectId = projectId;
  const preservedCallback: (value: string) => number = callback;
  const preservedSnapshotProjectId: ProjectId = snapshot.projects[0]?.id ?? projectId;
  void preservedProjectId;
  void preservedCallback;
  void preservedSnapshotProjectId;
}

function verifyDashboardRuntimeOptions(
  service: ObserverService,
  source: StationClientStateSource,
  capabilities: DashboardCapabilities,
): void {
  const valid: DashboardRuntimeOptions = { service, source, capabilities };
  // @ts-expect-error Dashboard composition must supply canonical client state.
  const missingSource: DashboardRuntimeOptions = { service, capabilities };
  // @ts-expect-error Dashboard composition must supply every semantic capability group.
  const missingCapabilities: DashboardRuntimeOptions = { service, source };
  const independentSnapshot: DashboardRuntimeOptions = {
    service,
    source,
    capabilities,
    // @ts-expect-error Runtime snapshots come only from the canonical source.
    initialSnapshot: source.getState().snapshot,
  };
  void valid;
  void missingSource;
  void missingCapabilities;
  void independentSnapshot;
}

it("compiles the deep-readonly dashboard state boundary", () => {
  expect(verifyReadonlyStateSource).toBeTypeOf("function");
  expect(verifyDashboardRuntimeOptions).toBeTypeOf("function");
});
