import { describe, expect, it } from "vitest";
import { groupSettingsPanelModel } from "../../../../src/components/GroupSettingsPanel/content.js";
import { createInitialTuiState } from "../../../../src/state/screen.js";
import {
  openGroupSettings,
  selectGroupSettingsSection,
  toggleGroupSettingsSession,
} from "../../../../src/state/screens/groupSettings.js";
import { createGroupedDashboardSnapshot } from "../../../fixtures/snapshots.js";

function sessionsState() {
  const snapshot = createGroupedDashboardSnapshot();
  const state = selectGroupSettingsSection(
    openGroupSettings(createInitialTuiState({ initialSnapshot: snapshot }), "group_active"),
    "sessions",
  );
  if (state.screen.name !== "groupSettings") throw new Error("expected Group Settings");
  return { snapshot, state, screen: state.screen };
}

describe("Group Settings panel content", () => {
  it("projects canonical titles, activity, checked state, and move-on-save context", () => {
    const setup = sessionsState();
    const staged = toggleGroupSettingsSession(setup.state, "ses_wt_web_working");
    if (staged.screen.name !== "groupSettings") throw new Error("expected Group Settings");
    const model = groupSettingsPanelModel(setup.snapshot, staged.screen);
    const moving = model?.sessions.find((session) => session.sessionId === "ses_wt_web_working");
    expect(moving).toMatchObject({
      title: "cache-refactor",
      activity: "working",
      checked: true,
      currentGroupName: "Build",
      membershipLabel: "move from Build",
    });
    expect(model?.membershipChanged).toBe(true);
  });

  it("labels an unchecked member as staged to ungroup without coupling membership to focus", () => {
    const setup = sessionsState();
    const staged = toggleGroupSettingsSession(setup.state, "ses_wt_web_attention");
    if (staged.screen.name !== "groupSettings") throw new Error("expected Group Settings");
    const model = groupSettingsPanelModel(setup.snapshot, staged.screen);
    const member = model?.sessions.find((session) => session.sessionId === "ses_wt_web_attention");

    expect(member).toMatchObject({
      checked: false,
      focused: true,
      membershipLabel: "ungroup on Save",
    });
    expect(
      model?.sessions.find((session) => session.sessionId === "ses_wt_web_idle"),
    ).toMatchObject({ checked: true, membershipLabel: "in this Group" });
  });

  it("projects every canonical Project session independently of the stable cursor", () => {
    const setup = sessionsState();
    const lastSession = setup.snapshot.sessions
      .filter((session) => session.projectId === "web")
      .at(-1);
    if (lastSession === undefined) throw new Error("expected sessions");
    const screen = { ...setup.screen, sessionCursor: lastSession.id };
    const model = groupSettingsPanelModel(setup.snapshot, screen);
    expect(model?.sessions).toHaveLength(
      setup.snapshot.sessions.filter((session) => session.projectId === "web").length,
    );
    expect(model?.sessions.at(-1)?.sessionId).toBe(lastSession.id);
    expect(model?.sessions.at(-1)?.focused).toBe(true);
  });

  it("keeps an empty Project usable and supplies bounded confirmation copy", () => {
    const setup = sessionsState();
    const emptySnapshot = {
      ...setup.snapshot,
      sessions: setup.snapshot.sessions.filter((session) => session.projectId !== "web"),
      sessionGroups: setup.snapshot.sessionGroups.map((group) =>
        group.projectId === "web" ? { ...group, sessionIds: [] } : group,
      ),
    };
    const model = groupSettingsPanelModel(emptySnapshot, setup.screen);
    expect(model?.sessions).toEqual([]);
    expect(model?.sessionCount).toBe(0);
    expect(model?.removePhrase).toBe("delete Active work");
    expect(model?.group.memberCount).toBe(0);
  });
});
