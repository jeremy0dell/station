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
  selectProjectChooserChoices,
  selectProjectGroups,
  sessionForWorktreeRow,
  sessionRowDisplayTitle,
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
      ["web", 6],
      ["api", 1],
    ]);
  });

  it("uses canonical session membership, including concurrent Station and external sessions", () => {
    const external = createExternalAgentSnapshot();
    const retained = createDashboardSnapshot().sessions.find(
      (session) => session.worktreeId === "wt_web_idle",
    );
    const externalSession = external.sessions.find(
      (session) => session.worktreeId === "wt_web_idle",
    );
    if (retained === undefined || externalSession === undefined) {
      throw new Error("missing mixed-membership fixture sessions");
    }
    const snapshot = {
      ...external,
      sessions: [retained, ...external.sessions],
    };
    const web = selectProjectGroups(snapshot, createInitialTuiState()).find(
      (group) => group.project.id === "web",
    );

    expect(web?.rows.map((candidate) => candidate.id)).toContain(retained.id);
    expect(web?.rows.map((candidate) => candidate.id)).toContain(externalSession.id);
    expect(web?.rows.map((candidate) => candidate.id)).not.toContain("wt_web_no_agent");
  });

  it("sorts rows inside project groups by resolved display title, not live status", () => {
    const snapshot = createDashboardSnapshot();
    const web = selectProjectGroups(snapshot, createInitialTuiState()).find(
      (group) => group.project.id === "web",
    );

    expect(web?.rows.map((candidate) => candidate.worktree.branch)).toEqual([
      "cache-refactor",
      "checkout-copy",
      "done-run",
      "fix-nav-mobile",
      "ghost-signal",
      "slow-tests",
    ]);
    expect(web?.rows.map((candidate) => candidate.presentation.display.statusLabel)).toEqual([
      "working",
      "needs attention",
      "exited",
      "idle",
      "unknown",
      "stuck",
    ]);
  });

  it("keeps a titled row in place when its branch metadata changes", () => {
    const snapshot = createDashboardSnapshot();
    const titled = {
      ...snapshot,
      rows: snapshot.rows.map((candidate) =>
        candidate.id === "wt_web_idle"
          ? { ...candidate, title: "middle stable session" }
          : candidate,
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
    expect(after?.rows.map((candidate) => candidate.id)).toContain("ses_wt_web_idle");
  });

  it("keeps the same row position when status priority changes", () => {
    const snapshot = createDashboardSnapshot();
    const changed = {
      ...snapshot,
      sessions: snapshot.sessions.map((candidate) =>
        candidate.id === "ses_wt_web_exited"
          ? {
              ...candidate,
              status: { ...candidate.status, value: "needs_attention" as const },
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

  it("resolves session labels with pending overrides", () => {
    const snapshot = createDashboardSnapshot();
    const session = snapshot.sessions.find((candidate) => candidate.id === "ses_wt_web_idle");
    const worktree = snapshot.rows.find((candidate) => candidate.id === "wt_web_idle");
    if (session === undefined || worktree === undefined) throw new Error("missing fixture session");
    const titledWorktree = { ...worktree, title: "Readable feature task" };
    const staleSession = { ...session, title: "Stale session projection" };

    expect(
      sessionRowDisplayTitle(
        { session: staleSession, worktree: titledWorktree },
        createInitialTuiState().localRows,
      ),
    ).toBe("Readable feature task");
    expect(
      sessionRowDisplayTitle(
        { session: staleSession, worktree: titledWorktree },
        {
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
        },
      ),
    ).toBe("Optimistic readable title");
  });

  it("renders a retained no-agent session from canonical row title through pending launch state", () => {
    const snapshot = createDashboardSnapshot();
    const bareWorktree = snapshot.rows.find((candidate) => candidate.id === "wt_web_no_agent");
    const sourceSession = snapshot.sessions[0];
    if (bareWorktree === undefined || sourceSession === undefined) {
      throw new Error("missing retained no-agent fixture inputs");
    }
    const worktree = { ...bareWorktree, title: "Durable no-agent workspace" };
    const session = {
      ...sourceSession,
      id: "ses_retained_no_agent",
      worktreeId: worktree.id,
      title: "Stale branch-derived projection",
    };
    const localRows = {
      pendingCreate: [],
      failedCreate: [],
      pendingRemove: [],
      pendingStart: [
        {
          localId: "start-retained",
          operation: "resumeAgent" as const,
          projectId: worktree.projectId,
          worktreeId: worktree.id,
          branch: worktree.branch,
          createdAt: "2026-05-31T12:00:00.000Z",
        },
      ],
    };

    expect(sessionRowDisplayTitle({ session, worktree }, localRows)).toBe(
      "Durable no-agent workspace",
    );
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

  it("collapses project groups without changing snapshot truth", () => {
    const snapshot = createDashboardSnapshot();
    const collapsed: TuiViewState = {
      collapsedProjectIds: new Set(["web"]),
      scrollOffset: 0,
      terminalRows: 24,
      localRows: { pendingCreate: [], failedCreate: [], pendingRemove: [], pendingStart: [] },
      selection: new Map(),
    };
    const groups = selectProjectGroups(snapshot, collapsed);
    expect(groups.find((group) => group.project.id === "web")?.collapsed).toBe(true);
    expect(
      selectProjectGroups(snapshot, collapsed)
        .flatMap((group) => group.rows)
        .map((candidate) => candidate.worktree.projectId),
    ).toEqual(["api"]);
  });

  it("can expose complete canonical children without changing stored collapse state", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      collapsedProjectIds: ["web"],
    });
    const groups = selectProjectGroups(snapshot, state, {
      includeCollapsedRows: true,
    });

    expect(groups.find((group) => group.project.id === "web")).toMatchObject({
      collapsed: true,
      rows: expect.arrayContaining([expect.objectContaining({ id: "ses_wt_web_idle" })]),
    });
    expect(state.collapsedProjectIds).toEqual(new Set(["web"]));
  });

  it("sorts by resolved session title while leaving hidden branch metadata unused", () => {
    const snapshot = createDashboardSnapshot();
    const titled = {
      ...snapshot,
      rows: snapshot.rows.map((candidate) =>
        candidate.id === "wt_web_stuck"
          ? { ...candidate, title: "aaa readable feature task" }
          : candidate,
      ),
    };

    const web = selectProjectGroups(titled, createInitialTuiState()).find(
      (group) => group.project.id === "web",
    );
    expect(web?.rows.map((candidate) => candidate.id)[0]).toBe("ses_wt_web_stuck");
  });

  it("assigns project choices from rendered project headers", () => {
    const snapshot = createDashboardSnapshot();
    const choices = selectProjectChooserChoices(snapshot);

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
        { id: "pi", label: "pi" },
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
      ["2", "pi"],
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
