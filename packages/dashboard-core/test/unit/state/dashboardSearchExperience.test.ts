import {
  createInitialTuiState,
  createTuiStore,
  type DashboardSearchExperience,
  handleTuiKey,
  legacySearchExperience,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";
import { FakeTuiObserverService } from "../../support/fakeObserverService.js";

const KEY_CONTEXT = { cwd: "/Users/example/Developer/station", homeDir: "/Users/example" };
const RETURN = { input: "\r", return: true } as const;

describe("legacy dashboard search experience", () => {
  it("opens an empty search screen from the dashboard", () => {
    const state = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      searchQuery: "existing",
    });

    const transition = handleTuiKey(state, { input: "/" }, KEY_CONTEXT, legacySearchExperience);

    expect(transition.state.screen).toEqual({ name: "search", value: "" });
    expect(transition.state.searchQuery).toBe("existing");
  });

  it("types, deletes, and cancels without applying the draft", () => {
    const base = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      searchQuery: "existing",
      scrollOffset: 2,
      terminalRows: 10,
    });
    const opened = handleTuiKey(base, { input: "/" }, KEY_CONTEXT, legacySearchExperience).state;
    const typed = handleTuiKey(opened, { input: "NaV" }, KEY_CONTEXT, legacySearchExperience).state;
    const backspaced = handleTuiKey(
      typed,
      { input: "", backspace: true },
      KEY_CONTEXT,
      legacySearchExperience,
    ).state;
    const deleted = handleTuiKey(
      backspaced,
      { input: "", delete: true },
      KEY_CONTEXT,
      legacySearchExperience,
    ).state;
    const cancelled = handleTuiKey(
      deleted,
      { input: "", escape: true },
      KEY_CONTEXT,
      legacySearchExperience,
    ).state;

    expect(typed.screen).toEqual({ name: "search", value: "NaV" });
    expect(backspaced.screen).toEqual({ name: "search", value: "Na" });
    expect(deleted.screen).toEqual({ name: "search", value: "N" });
    expect(cancelled.screen).toEqual({ name: "dashboard" });
    expect(cancelled.searchQuery).toBe("existing");
    expect(cancelled.scrollOffset).toBe(2);
  });

  it("applies the draft, resets scroll, and reconciles dashboard focus", () => {
    const base = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      dashboardFocus: { kind: "session", sessionId: "ses_wt_web_idle" },
      scrollOffset: 4,
      terminalRows: 40,
    });
    const opened = handleTuiKey(base, { input: "/" }, KEY_CONTEXT, legacySearchExperience).state;
    const typed = handleTuiKey(
      opened,
      { input: "queue-worker" },
      KEY_CONTEXT,
      legacySearchExperience,
    ).state;

    const applied = handleTuiKey(typed, RETURN, KEY_CONTEXT, legacySearchExperience).state;

    expect(applied.screen).toEqual({ name: "dashboard" });
    expect(applied.searchQuery).toBe("queue-worker");
    expect(applied.scrollOffset).toBe(0);
    expect(applied.dashboardFocus).toEqual({
      kind: "session",
      sessionId: "ses_wt_api_working",
    });
  });
});

describe("dashboard search experience selection", () => {
  it("uses the experience selected by the store for entry and active-screen keys", () => {
    const snapshot = createDashboardSnapshot();
    const selectedExperience: DashboardSearchExperience = {
      open: (state) => ({
        state: { ...state, screen: { name: "search", value: "selected:" } },
      }),
      handleKey: (state, key) => {
        if (state.screen.name !== "search") return { state };
        return {
          state: {
            ...state,
            screen: { name: "search", value: `${state.screen.value}${key.input}` },
          },
        };
      },
    };
    const store = createTuiStore({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      dashboardSearchExperience: selectedExperience,
    });

    store.getState().handleKey({ input: "/" });
    store.getState().handleKey({ input: "owned" });

    expect(store.getState().screen).toEqual({ name: "search", value: "selected:owned" });
  });
});
