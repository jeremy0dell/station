import {
  createInitialTuiState,
  handleTuiKey,
  persistentFilterExperience,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../../fixtures/snapshots.js";

const KEY_CONTEXT = { cwd: "/Users/example/Developer/station", homeDir: "/Users/example" };
const RETURN = { input: "\r", return: true } as const;

function handle(
  state: ReturnType<typeof createInitialTuiState>,
  key: Parameters<typeof handleTuiKey>[1],
) {
  return handleTuiKey(state, key, KEY_CONTEXT, persistentFilterExperience).state;
}

describe("persistent-filter screen", () => {
  it("opens a cursor-aware draft seeded from the applied dashboard filter", () => {
    const base = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      persistentFilter: { query: "working" },
    });

    const opened = handle(base, { input: "/" });

    expect(opened.screen).toEqual({
      name: "persistentFilter",
      draft: { value: "working", cursor: 7 },
    });
    expect(opened.persistentFilter).toEqual({ query: "working" });
    expect(opened.searchQuery).toBe("");
  });

  it("uses the shared text editor for insertion, movement, deletion, and Ctrl-U", () => {
    const base = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    const opened = handle(base, { input: "/" });
    const typed = handle(opened, { input: "abc" });
    const moved = handle(typed, { input: "", leftArrow: true });
    const inserted = handle(moved, { input: "X" });
    const deleted = handle(inserted, { input: "", delete: true });
    const backspaced = handle(deleted, { input: "", backspace: true });
    const clearedBeforeCursor = handle(backspaced, { input: "u", ctrl: true });

    expect(typed.screen).toEqual({
      name: "persistentFilter",
      draft: { value: "abc", cursor: 3 },
    });
    expect(moved.screen).toMatchObject({ draft: { value: "abc", cursor: 2 } });
    expect(inserted.screen).toMatchObject({ draft: { value: "abXc", cursor: 3 } });
    expect(deleted.screen).toMatchObject({ draft: { value: "abX", cursor: 3 } });
    expect(backspaced.screen).toMatchObject({ draft: { value: "ab", cursor: 2 } });
    expect(clearedBeforeCursor.screen).toMatchObject({ draft: { value: "", cursor: 0 } });
  });

  it("applies a nonblank draft without changing legacy search, focus, order, or scroll", () => {
    const base = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      searchQuery: "",
      scrollOffset: 3,
      terminalRows: 10,
      dashboardFocus: { kind: "session", sessionId: "ses_wt_web_idle" },
    });
    const opened = handle(base, { input: "/" });
    const typed = handle(opened, { input: "  NaV  " });

    const applied = handle(typed, RETURN);

    expect(applied.screen).toEqual({ name: "dashboard" });
    expect(applied.persistentFilter).toEqual({ query: "NaV" });
    expect(applied.searchQuery).toBe("");
    expect(applied.scrollOffset).toBe(3);
    expect(applied.dashboardFocus).toEqual(base.dashboardFocus);
  });

  it("cancels editing without changing the applied filter", () => {
    const base = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      persistentFilter: { query: "working" },
    });
    const opened = handle(base, { input: "/" });
    const edited = handle(opened, { input: " now" });

    const cancelled = handle(edited, { input: "", escape: true });

    expect(cancelled.screen).toEqual({ name: "dashboard" });
    expect(cancelled.persistentFilter).toEqual({ query: "working" });
  });

  it("removes the optional applied state instead of assigning undefined when blank is applied", () => {
    const base = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      persistentFilter: { query: "working" },
    });
    const opened = handle(base, { input: "/" });
    const cleared = handle(opened, { input: "u", ctrl: true });

    const applied = handle(cleared, RETURN);

    expect(applied.screen).toEqual({ name: "dashboard" });
    expect("persistentFilter" in applied).toBe(false);
  });
});
