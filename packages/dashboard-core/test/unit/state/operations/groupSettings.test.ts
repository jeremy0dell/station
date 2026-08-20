import type { SafeError } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { createEditableTextInputState } from "../../../../src/components/EditableTextInput/editing.js";
import {
  runDeleteSessionGroupOperation,
  runRenameSessionGroupOperation,
  runUpdateSessionGroupMembershipOperation,
} from "../../../../src/state/operations/groupSettings.js";
import type {
  DeleteSessionGroupOperation,
  RenameSessionGroupOperation,
  UpdateSessionGroupMembershipOperation,
} from "../../../../src/state/operations/types.js";
import { createDashboardRuntimeEffectScope } from "../../../../src/state/runtimeEffectScope.js";
import { createInitialTuiState, replaceSnapshot } from "../../../../src/state/screen.js";
import {
  openGroupSettings,
  selectGroupSettingsSection,
  submitGroupSettings,
  toggleGroupSettingsSession,
} from "../../../../src/state/screens/groupSettings.js";
import type { DashboardState } from "../../../../src/state/types.js";
import { createGroupedDashboardSnapshot } from "../../../fixtures/snapshots.js";
import { FakeTuiObserverService } from "../../../support/fakeObserverService.js";

const failure: SafeError = {
  tag: "CommandConflictError",
  code: "SESSION_GROUP_VERSION_CONFLICT",
  message: "The Group changed.",
};

describe("Group Settings operations", () => {
  it("records one rename and reseeds General from canonical client state", async () => {
    const setup = renameSetup();
    const canonical = {
      ...setup.snapshot,
      sessionGroups: setup.snapshot.sessionGroups.map((group) =>
        group.id === "group_active" ? { ...group, name: "Renamed Group", version: 2 } : group,
      ),
    };
    setup.store.setState(replaceSnapshot(setup.store.getState(), canonical));

    await runRenameSessionGroupOperation({
      ...setup.common,
      operation: setup.operation,
    });

    expect(setup.service.dispatched).toEqual([setup.operation.command]);
    expect(setup.store.getState().screen).toMatchObject({
      name: "groupSettings",
      section: "general",
      baselineName: "Renamed Group",
      expectedVersion: 2,
      detailFocus: "generalSave",
    });
    await setup.scope.dispose();
  });

  it("retains the General draft and initiating Save focus on failure", async () => {
    const setup = renameSetup();
    setup.service.nextCompletion = { status: "failed", commandId: "cmd_tui_1", error: failure };

    await runRenameSessionGroupOperation({ ...setup.common, operation: setup.operation });

    expect(setup.store.getState().screen).toMatchObject({
      name: "groupSettings",
      nameDraft: { value: "Renamed Group" },
      detailFocus: "generalSave",
    });
    expect(setup.store.getState().toasts.at(-1)?.toast.message).toBe(failure.message);
    await setup.scope.dispose();
  });

  it("records one atomic membership command and retains staged intent on conflict", async () => {
    const snapshot = createGroupedDashboardSnapshot();
    let state = selectGroupSettingsSection(
      openGroupSettings(createInitialTuiState({ initialSnapshot: snapshot }), "group_active"),
      "sessions",
    );
    state = toggleGroupSettingsSession(state, "ses_wt_web_working");
    const transition = submitGroupSettings(state);
    const operation = transition.operations?.[0] as UpdateSessionGroupMembershipOperation;
    const store = createStore<DashboardState>(() => transition.state);
    const service = new FakeTuiObserverService(snapshot);
    service.nextCompletion = { status: "failed", commandId: "cmd_tui_1", error: failure };
    const scope = createDashboardRuntimeEffectScope();

    await runUpdateSessionGroupMembershipOperation({
      store,
      service,
      operation,
      clientLabel: "test",
      scope,
    });

    expect(service.dispatched).toEqual([operation.command]);
    const screen = store.getState().screen;
    expect(screen).toMatchObject({
      name: "groupSettings",
      detailFocus: "membershipSave",
    });
    expect(
      screen.name === "groupSettings" && screen.desiredSessionIds.has("ses_wt_web_working"),
    ).toBe(true);
    await scope.dispose();
  });

  it("deletes only Group organization, leaves sessions intact, and focuses the Project header", async () => {
    const snapshot = createGroupedDashboardSnapshot();
    const base = selectGroupSettingsSection(
      openGroupSettings(
        createInitialTuiState({ initialSnapshot: snapshot }),
        "group_active",
        "remove",
      ),
      "remove",
    );
    if (base.screen.name !== "groupSettings") throw new Error("expected Group Settings");
    const armed: DashboardState = {
      ...base,
      screen: {
        ...base.screen,
        removeDraft: createEditableTextInputState("delete Active work"),
      },
    };
    const transition = submitGroupSettings(armed);
    const operation = transition.operations?.[0] as DeleteSessionGroupOperation;
    const store = createStore<DashboardState>(() => transition.state);
    const service = new FakeTuiObserverService(snapshot);
    const scope = createDashboardRuntimeEffectScope();
    const sessionIds = snapshot.sessions.map((session) => session.id);

    await runDeleteSessionGroupOperation({
      store,
      service,
      operation,
      clientLabel: "test",
      scope,
    });

    expect(service.dispatched).toEqual([operation.command]);
    expect(service.dispatched).toHaveLength(1);
    expect(store.getState().snapshot?.sessions.map((session) => session.id)).toEqual(sessionIds);
    expect(store.getState()).toMatchObject({
      screen: { name: "dashboard" },
      dashboardFocus: { rowId: "project:web", cellId: "identity" },
    });
    await scope.dispose();
  });

  it("retains the typed delete phrase and Remove focus on failure", async () => {
    const snapshot = createGroupedDashboardSnapshot();
    const opened = openGroupSettings(
      createInitialTuiState({ initialSnapshot: snapshot }),
      "group_active",
      "remove",
    );
    if (opened.screen.name !== "groupSettings") throw new Error("expected Group Settings");
    const armed: DashboardState = {
      ...opened,
      screen: {
        ...opened.screen,
        focus: "detail",
        detailFocus: "removeSubmit",
        removeDraft: createEditableTextInputState("delete Active work"),
      },
    };
    const transition = submitGroupSettings(armed);
    const operation = transition.operations?.[0] as DeleteSessionGroupOperation;
    const store = createStore<DashboardState>(() => transition.state);
    const service = new FakeTuiObserverService(snapshot);
    service.nextCompletion = { status: "failed", commandId: "cmd_tui_1", error: failure };
    const scope = createDashboardRuntimeEffectScope();

    await runDeleteSessionGroupOperation({
      store,
      service,
      operation,
      clientLabel: "test",
      scope,
    });

    expect(store.getState().screen).toMatchObject({
      name: "groupSettings",
      removeDraft: { value: "delete Active work" },
      detailFocus: "removeSubmit",
    });
    await scope.dispose();
  });
});

function renameSetup() {
  const snapshot = createGroupedDashboardSnapshot();
  const opened = selectGroupSettingsSection(
    openGroupSettings(createInitialTuiState({ initialSnapshot: snapshot }), "group_active"),
    "general",
  );
  if (opened.screen.name !== "groupSettings") throw new Error("expected Group Settings");
  const edited: DashboardState = {
    ...opened,
    screen: {
      ...opened.screen,
      nameDraft: createEditableTextInputState("Renamed Group"),
      detailFocus: "generalSave",
    },
  };
  const transition = submitGroupSettings(edited);
  const operation = transition.operations?.[0] as RenameSessionGroupOperation;
  const store = createStore<DashboardState>(() => transition.state);
  const service = new FakeTuiObserverService(snapshot);
  const scope = createDashboardRuntimeEffectScope();
  return {
    snapshot,
    store,
    service,
    scope,
    operation,
    common: { store, service, clientLabel: "test", scope },
  };
}
