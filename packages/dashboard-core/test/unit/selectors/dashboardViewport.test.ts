import {
  createInitialTuiState,
  selectDashboardItems,
  selectDashboardViewport,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

describe("dashboard viewport selector", () => {
  it("flattens projects into dashboard render items", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState();

    expect(
      selectDashboardItems(snapshot, state).map((item) =>
        item.type === "worktree" ? `${item.type}:${item.row.id}` : item.id,
      ),
    ).toEqual([
      "project:web",
      "worktree:wt_web_working",
      "worktree:wt_web_attention",
      "worktree:wt_web_exited",
      "worktree:wt_web_no_agent",
      "worktree:wt_web_idle",
      "worktree:wt_web_unknown",
      "worktree:wt_web_stuck",
      "gap:api",
      "project:api",
      "worktree:wt_api_working",
    ]);
  });

  it("slices visible items, clamps offset, and reports hidden counts", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      scrollOffset: 1,
      terminalRows: 10,
    });
    const viewport = selectDashboardViewport(snapshot, state);

    expect(viewport.bodyRows).toBe(3);
    expect(viewport.clampedScrollOffset).toBe(1);
    expect(viewport.hiddenAbove).toBe(1);
    expect(viewport.hiddenBelow).toBe(7);
    expect(
      viewport.visibleItems.map((item) =>
        item.type === "worktree" ? item.row.id : `${item.type}:${item.id}`,
      ),
    ).toEqual(["wt_web_working", "wt_web_attention", "wt_web_exited"]);
  });

  it("uses only viewport-visible worktrees for row choices", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      scrollOffset: 4,
      terminalRows: 10,
    });
    const viewport = selectDashboardViewport(snapshot, state);

    expect(viewport.rowChoices.map((choice) => [choice.key, choice.value.id])).toEqual([
      ["1", "wt_web_no_agent"],
      ["2", "wt_web_idle"],
      ["3", "wt_web_unknown"],
    ]);
  });

  it("clamps an offset beyond the available flattened rows", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({
        scrollOffset: 100,
        terminalRows: 10,
      }),
    );

    expect(viewport.clampedScrollOffset).toBe(8);
    expect(viewport.hiddenAbove).toBe(8);
    expect(viewport.hiddenBelow).toBe(0);
    expect(viewport.visibleItems.at(-1)?.id).toBe("worktree:wt_api_working");
  });

  it("keeps empty project rows in the flattened body when no worktrees match", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({
        searchQuery: "missing-row",
      }),
    );

    expect(viewport.items.map((item) => item.id)).toEqual([
      "project:web",
      "empty:web",
      "gap:api",
      "project:api",
      "empty:api",
    ]);
  });

  it("renders pending create local rows under the matching project without key choices", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({
        terminalRows: 20,
        initialSnapshot: snapshot,
        localRows: {
          pendingCreate: [
            {
              localId: "local_create_1",
              projectId: "web",
              branch: "feature/pending",
              harnessProvider: "codex",
              createdAt: "2026-05-31T12:00:00.000Z",
            },
          ],
          failedCreate: [],
          pendingRemove: [],
          pendingStart: [],
        },
      }),
    );

    expect(
      viewport.items.map((item) =>
        item.type === "createLocalRow" ? `${item.type}:${item.row.branch}` : item.id,
      ),
    ).toContain("createLocalRow:feature/pending");
    expect(viewport.rowChoices.map((choice) => choice.value.branch)).not.toContain(
      "feature/pending",
    );
  });

  it("suppresses matching pending create local rows when observer truth has the row", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({
        initialSnapshot: snapshot,
        localRows: {
          pendingCreate: [
            {
              localId: "local_create_1",
              projectId: "web",
              branch: "fix-nav-mobile",
              harnessProvider: "codex",
              createdAt: "2026-05-31T12:00:00.000Z",
            },
          ],
          failedCreate: [],
          pendingRemove: [],
          pendingStart: [],
        },
      }),
    );

    expect(viewport.items.filter((item) => item.type === "createLocalRow")).toEqual([]);
  });

  it("orders mixed local and real rows by resolved display title", () => {
    const snapshot = createDashboardSnapshot();
    const titled = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.id === "ses_wt_web_stuck" ? { ...session, title: "aaa stable task" } : session,
      ),
    };
    const viewport = selectDashboardViewport(
      titled,
      createInitialTuiState({
        terminalRows: 20,
        initialSnapshot: titled,
        localRows: {
          pendingCreate: [
            {
              localId: "local_create_1",
              projectId: "web",
              branch: "bbb pending task",
              harnessProvider: "codex",
              createdAt: "2026-05-31T12:00:00.000Z",
            },
          ],
          failedCreate: [],
          pendingRemove: [],
          pendingStart: [],
        },
      }),
    );

    expect(
      viewport.items
        .filter((item) => item.type === "worktree" || item.type === "createLocalRow")
        .slice(0, 3)
        .map((item) =>
          item.type === "worktree" ? `worktree:${item.row.id}` : `create:${item.row.branch}`,
        ),
    ).toEqual(["worktree:wt_web_stuck", "create:bbb pending task", "worktree:wt_web_working"]);
  });

  it("renders one observer row when branch metadata changes but the session title stays stable", () => {
    const snapshot = createDashboardSnapshot();
    const changed = {
      ...snapshot,
      rows: snapshot.rows.map((candidate) =>
        candidate.id === "wt_web_idle"
          ? { ...candidate, branch: "agent-created-branch" }
          : candidate,
      ),
      sessions: snapshot.sessions.map((session) =>
        session.id === "ses_wt_web_idle" ? { ...session, title: "fix-nav-mobile" } : session,
      ),
    };
    const viewport = selectDashboardViewport(changed, createInitialTuiState());
    const titledItems = viewport.items.filter(
      (item) => item.type === "worktree" && item.displayTitle === "fix-nav-mobile",
    );

    expect(titledItems).toEqual([
      expect.objectContaining({
        type: "worktree",
        row: expect.objectContaining({
          id: "wt_web_idle",
          branch: "agent-created-branch",
        }),
      }),
    ]);
    expect(viewport.items.filter((item) => item.type === "createLocalRow")).toEqual([]);
  });

  it("renders pending remove rows in place without key choices", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({
        initialSnapshot: snapshot,
        localRows: {
          pendingCreate: [],
          failedCreate: [],
          pendingRemove: [
            {
              localId: "remove:wt_web_idle",
              projectId: "web",
              worktreeId: "wt_web_idle",
              branch: "fix-nav-mobile",
              createdAt: "2026-05-31T12:00:00.000Z",
            },
          ],
          pendingStart: [],
        },
      }),
    );

    const item = viewport.items.find(
      (candidate) => candidate.type === "worktree" && candidate.row.id === "wt_web_idle",
    );
    expect(item).toMatchObject({
      type: "worktree",
      pendingRemove: {
        localId: "remove:wt_web_idle",
      },
    });
    expect(viewport.rowChoices.map((choice) => choice.value.id)).not.toContain("wt_web_idle");
  });

  it("keeps pending start rows slotted for display but removes them from actions", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({
        initialSnapshot: snapshot,
        localRows: {
          pendingCreate: [],
          failedCreate: [],
          pendingRemove: [],
          pendingStart: [
            {
              localId: "start:wt_web_no_agent",
              projectId: "web",
              worktreeId: "wt_web_no_agent",
              branch: "feature-auth",
              createdAt: "2026-05-31T12:00:00.000Z",
            },
          ],
        },
      }),
    );

    const item = viewport.items.find(
      (candidate) => candidate.type === "worktree" && candidate.row.id === "wt_web_no_agent",
    );
    expect(item).toMatchObject({
      type: "worktree",
      pendingStart: {
        localId: "start:wt_web_no_agent",
      },
    });
    expect(
      viewport.displayRowChoices.map((choice) => [choice.key, choice.value.id]),
    ).toContainEqual(["4", "wt_web_no_agent"]);
    expect(viewport.rowChoices.map((choice) => [choice.key, choice.value.id])).not.toContainEqual([
      "4",
      "wt_web_no_agent",
    ]);
    expect(viewport.rowChoices.map((choice) => [choice.key, choice.value.id])).toContainEqual([
      "5",
      "wt_web_idle",
    ]);
  });

  it("carries resolved titles for dashboard worktree rendering", () => {
    const snapshot = createDashboardSnapshot();
    const titled = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.id === "ses_wt_web_idle" ? { ...session, title: "Readable feature task" } : session,
      ),
    };
    const viewport = selectDashboardViewport(titled, createInitialTuiState());

    const item = viewport.items.find(
      (candidate) => candidate.type === "worktree" && candidate.row.id === "wt_web_idle",
    );
    expect(item).toMatchObject({
      type: "worktree",
      displayTitle: "Readable feature task",
    });
  });
});
