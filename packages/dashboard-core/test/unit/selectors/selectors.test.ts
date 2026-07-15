import type { ProviderId } from "@station/contracts";
import type { TuiViewState } from "@station/dashboard-core";
import {
  choiceValueByKey,
  createInitialTuiState,
  isSelectionKey,
  keyChoices,
  SELECTION_KEYS,
  selectNewSessionHarnessChoices,
  selectNewSessionHarnessOptions,
  selectNewSessionProjectChoices,
  selectProjectChoices,
  selectProjectGroups,
  selectVisibleRows,
  sessionForWorktreeRow,
  worktreeRowDisplayTitle,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot, createExternalAgentSnapshot } from "../../fixtures/snapshots.js";

describe("TUI selectors", () => {
  it("assigns selection keys in order without 0 or uppercase keys and caps at 35", () => {
    const choices = keyChoices(Array.from({ length: 36 }, (_, index) => index + 1));

    expect(SELECTION_KEYS).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "p",
      "q",
      "r",
      "s",
      "t",
      "u",
      "v",
      "w",
      "x",
      "y",
      "z",
    ]);
    expect(choices).toHaveLength(35);
    expect(choices.at(8)).toEqual({ key: "9", value: 9 });
    expect(choices.at(9)).toEqual({ key: "a", value: 10 });
    expect(choices.at(-1)).toEqual({ key: "z", value: 35 });
    expect(isSelectionKey("0")).toBe(false);
    expect(isSelectionKey("A")).toBe(false);
    expect(choiceValueByKey(choices, "0")).toBeUndefined();
    expect(choiceValueByKey(choices, "a")).toBe(10);
  });

  it("groups rows project-first and keeps zero-worktree projects visible", () => {
    const snapshot = createDashboardSnapshot();
    const groups = selectProjectGroups(snapshot, createInitialTuiState());

    expect(groups.map((group) => [group.project.id, group.rows.length])).toEqual([
      ["web", 7],
      ["api", 1],
    ]);
  });

  it("sorts rows inside project groups by resolved display title, not live status", () => {
    const snapshot = createDashboardSnapshot();
    const web = selectProjectGroups(snapshot, createInitialTuiState()).find(
      (group) => group.project.id === "web",
    );

    expect(web?.rows.map((candidate) => candidate.branch)).toEqual([
      "cache-refactor",
      "checkout-copy",
      "done-run",
      "feature-auth",
      "fix-nav-mobile",
      "ghost-signal",
      "slow-tests",
    ]);
    expect(web?.rows.map((candidate) => candidate.display.statusLabel)).toEqual([
      "working",
      "needs attention",
      "exited",
      "no agent",
      "idle",
      "unknown",
      "stuck",
    ]);
  });

  it("keeps a titled row in place when its branch metadata changes", () => {
    const snapshot = createDashboardSnapshot();
    const titled = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.id === "ses_wt_web_idle" ? { ...session, title: "middle stable session" } : session,
      ),
    };
    const branchChanged = {
      ...titled,
      rows: titled.rows.map((candidate) =>
        candidate.id === "wt_web_idle" ? { ...candidate, branch: "aaa-agent-branch" } : candidate,
      ),
    };

    const before = selectProjectGroups(titled, createInitialTuiState()).find(
      (group) => group.project.id === "web",
    );
    const after = selectProjectGroups(branchChanged, createInitialTuiState()).find(
      (group) => group.project.id === "web",
    );

    expect(after?.rows.map((candidate) => candidate.id)).toEqual(
      before?.rows.map((candidate) => candidate.id),
    );
    expect(after?.rows.map((candidate) => candidate.id)).toContain("wt_web_idle");
  });

  it("keeps the same row position when status priority changes", () => {
    const snapshot = createDashboardSnapshot();
    const changed = {
      ...snapshot,
      rows: snapshot.rows.map((candidate) =>
        candidate.id === "wt_web_no_agent"
          ? {
              ...candidate,
              display: {
                statusLabel: "needs attention" as const,
                sortPriority: 10,
                alert: true,
              },
            }
          : candidate,
      ),
    };

    const before = selectProjectGroups(snapshot, createInitialTuiState()).find(
      (group) => group.project.id === "web",
    );
    const after = selectProjectGroups(changed, createInitialTuiState()).find(
      (group) => group.project.id === "web",
    );

    expect(after?.rows.map((candidate) => candidate.id)).toEqual(
      before?.rows.map((candidate) => candidate.id),
    );
  });

  it("resolves row labels from session titles with branch fallback and pending overrides", () => {
    const snapshot = createDashboardSnapshot();
    const row = snapshot.rows.find((candidate) => candidate.id === "wt_web_idle");
    if (row === undefined) throw new Error("missing fixture row");
    const titled = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.id === "ses_wt_web_idle" ? { ...session, title: "Readable feature task" } : session,
      ),
    };

    expect(worktreeRowDisplayTitle(row, titled.sessions, createInitialTuiState().localRows)).toBe(
      "Readable feature task",
    );
    expect(
      worktreeRowDisplayTitle(row, titled.sessions, {
        pendingCreate: [],
        failedCreate: [],
        pendingRemove: [],
        pendingStart: [],
        pendingRenameTitles: {
          ses_wt_web_idle: {
            sessionId: "ses_wt_web_idle",
            title: "Optimistic readable title",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        },
      }),
    ).toBe("Optimistic readable title");
    expect(
      worktreeRowDisplayTitle({ ...row, agent: undefined }, [], createInitialTuiState().localRows),
    ).toBe(row.branch);
  });

  it("resolves an external row by run identity before retained Station membership", () => {
    const external = createExternalAgentSnapshot();
    const station = createDashboardSnapshot();
    const row = external.rows.find((candidate) => candidate.id === "wt_web_idle");
    const retained = station.sessions.find((session) => session.worktreeId === row?.id);
    if (row === undefined || retained === undefined) throw new Error("missing fixture membership");

    expect(sessionForWorktreeRow(row, [retained, ...external.sessions])).toMatchObject({
      origin: "external",
      id: row.agent?.runId,
    });
  });

  it("filters by search and collapses project groups without changing snapshot truth", () => {
    const snapshot = createDashboardSnapshot();
    const searched: TuiViewState = {
      searchQuery: "nav",
      collapsedProjectIds: new Set(),
      scrollOffset: 0,
      terminalRows: 24,
      localRows: { pendingCreate: [], failedCreate: [], pendingRemove: [], pendingStart: [] },
      selection: new Map(),
    };
    expect(selectVisibleRows(snapshot, searched).map((candidate) => candidate.id)).toEqual([
      "wt_web_idle",
    ]);

    const collapsed: TuiViewState = {
      searchQuery: "",
      collapsedProjectIds: new Set(["web"]),
      scrollOffset: 0,
      terminalRows: 24,
      localRows: { pendingCreate: [], failedCreate: [], pendingRemove: [], pendingStart: [] },
      selection: new Map(),
    };
    const groups = selectProjectGroups(snapshot, collapsed);
    expect(groups.find((group) => group.project.id === "web")?.collapsed).toBe(true);
    expect(selectVisibleRows(snapshot, collapsed).map((candidate) => candidate.projectId)).toEqual([
      "api",
    ]);
  });

  it("searches by resolved session title while sorting uses resolved titles", () => {
    const snapshot = createDashboardSnapshot();
    const titled = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.id === "ses_wt_web_stuck"
          ? { ...session, title: "aaa readable feature task" }
          : session,
      ),
    };
    const searched: TuiViewState = {
      searchQuery: "readable",
      collapsedProjectIds: new Set(),
      scrollOffset: 0,
      terminalRows: 24,
      localRows: { pendingCreate: [], failedCreate: [], pendingRemove: [], pendingStart: [] },
      selection: new Map(),
    };

    expect(selectVisibleRows(titled, searched).map((candidate) => candidate.id)).toEqual([
      "wt_web_stuck",
    ]);

    const web = selectProjectGroups(titled, createInitialTuiState()).find(
      (group) => group.project.id === "web",
    );
    expect(web?.rows.map((candidate) => candidate.id)[0]).toBe("wt_web_stuck");
  });

  it("assigns project choices from rendered project headers", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({ collapsedProjectIds: ["web"] });
    const choices = selectProjectChoices(snapshot, state);

    expect(choices.map((choice) => [choice.key, choice.value.id])).toEqual([
      ["1", "web"],
      ["2", "api"],
    ]);
  });

  it("keys new-session project and harness choices from the same selection grammar", () => {
    const snapshot = {
      ...createDashboardSnapshot(),
      harnesses: [
        { id: "codex", label: "codex" },
        { id: "opencode", label: "opencode" },
        { id: "scripted", label: "scripted" },
      ],
    };
    const api = snapshot.projects.find((project) => project.id === "api");
    if (api === undefined) throw new Error("missing api project");

    expect(
      selectNewSessionProjectChoices(snapshot).map((choice) => [choice.key, choice.value.id]),
    ).toEqual([
      ["1", "web"],
      ["2", "api"],
    ]);
    expect(
      selectNewSessionHarnessChoices(snapshot, api).map((choice) => [choice.key, choice.value.id]),
    ).toEqual([
      ["1", "codex"],
      ["2", "opencode"],
      ["3", "scripted"],
    ]);
  });
});

describe("selectNewSessionHarnessOptions update badge", () => {
  it("carries the update pair only when the snapshot knows both versions differ", () => {
    const base = createDashboardSnapshot();
    const snapshot = {
      ...base,
      harnesses: [
        {
          id: "codex" as ProviderId,
          label: "codex",
          installedVersion: "0.3.0",
          latestVersion: "0.4.0",
          updateAvailable: true,
        },
        { id: "opencode" as ProviderId, label: "opencode", installedVersion: "1.0.0" },
      ],
    };
    const project = snapshot.projects[0];
    if (project === undefined) {
      throw new Error("fixture is expected to contain a project");
    }
    const options = selectNewSessionHarnessOptions(snapshot, project);
    expect(options.find((option) => option.id === "codex")?.update).toEqual({
      installed: "0.3.0",
      latest: "0.4.0",
    });
    expect(options.find((option) => option.id === "opencode")?.update).toBeUndefined();
  });
});
