import {
  createInitialTuiState,
  rowGridInputForViewportItem,
  selectDashboardItems,
  selectDashboardViewport,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createCommandSnapshot, createDashboardSnapshot } from "../../fixtures/snapshots.js";

describe("dashboard viewport selector", () => {
  it("does not flatten bare worktrees into dashboard session items", () => {
    const snapshot = createDashboardSnapshot();
    const items = selectDashboardItems(snapshot, createInitialTuiState());

    expect(items.map((item) => item.id)).not.toContain("session:ses_wt_web_no_agent");
  });

  it("renders a project empty when its only remaining checkout is bare", () => {
    const base = createDashboardSnapshot();
    const snapshot = {
      ...base,
      sessions: base.sessions.filter((session) => session.projectId !== "web"),
    };
    const items = selectDashboardItems(snapshot, createInitialTuiState());

    expect(items.map((item) => item.id)).toContain("empty:web");
    expect(
      items.some((item) => item.type === "session" && item.row.worktree.id === "wt_web_no_agent"),
    ).toBe(false);
  });

  it("flattens projects into dashboard render items", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState();

    expect(
      selectDashboardItems(snapshot, state).map((item) =>
        item.type === "session" ? `${item.type}:${item.row.id}` : item.id,
      ),
    ).toEqual([
      "project:web",
      "session:ses_wt_web_working",
      "session:ses_wt_web_attention",
      "session:ses_wt_web_exited",
      "session:ses_wt_web_idle",
      "session:ses_wt_web_unknown",
      "session:ses_wt_web_stuck",
      "gap:api",
      "project:api",
      "session:ses_wt_api_working",
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
    expect(viewport.hiddenBelow).toBe(6);
    expect(
      viewport.visibleItems.map((item) =>
        item.type === "session" ? item.row.id : `${item.type}:${item.id}`,
      ),
    ).toEqual(["ses_wt_web_working", "ses_wt_web_attention", "ses_wt_web_exited"]);
  });

  it("reports session-row overflow independently of project chrome", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(snapshot, createInitialTuiState({ terminalRows: 10 }));

    expect(viewport.sessionOverflow).toEqual({
      above: 0,
      below: 5,
      visible: 2,
      total: 7,
    });
  });

  it("uses only viewport-visible sessions for row choices", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      scrollOffset: 4,
      terminalRows: 10,
    });
    const viewport = selectDashboardViewport(snapshot, state);

    expect(viewport.rowChoices.map((choice) => [choice.key, choice.value.id])).toEqual([
      ["1", "ses_wt_web_idle"],
      ["2", "ses_wt_web_unknown"],
      ["3", "ses_wt_web_stuck"],
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

    expect(viewport.clampedScrollOffset).toBe(7);
    expect(viewport.hiddenAbove).toBe(7);
    expect(viewport.hiddenBelow).toBe(0);
    expect(viewport.visibleItems.at(-1)?.id).toBe("session:ses_wt_api_working");
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
              title: "Hexagonal PT 12",
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
        item.type === "createLocalRow" ? `${item.type}:${item.row.title}` : item.id,
      ),
    ).toContain("createLocalRow:Hexagonal PT 12");
    expect(viewport.rowChoices.map((choice) => choice.value.worktree.branch)).not.toContain(
      "feature/pending",
    );
    const localItem = viewport.items.find((item) => item.type === "createLocalRow");
    if (localItem === undefined) throw new Error("expected optimistic row");
    expect(rowGridInputForViewportItem(localItem, new Map())).toMatchObject({
      cells: {
        title: { segments: [{ kind: "text", text: "Hexagonal PT 12" }] },
      },
    });
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
              title: "Hexagonal PT 12",
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

  it("shows a failed create row when only the retained bare worktree exists", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({
        initialSnapshot: snapshot,
        localRows: {
          pendingCreate: [],
          failedCreate: [
            {
              localId: "local_create_failed",
              projectId: "web",
              title: "Failed launch",
              branch: "feature-auth",
              error: {
                tag: "ClientObserverError",
                code: "PREPARE_FAILED",
                message: "Harness preparation failed.",
              },
              expiresAt: Date.now() + 4_000,
            },
          ],
          pendingRemove: [],
          pendingStart: [],
        },
      }),
    );

    const failed = viewport.items.find(
      (item) => item.type === "createLocalRow" && item.row.localId === "local_create_failed",
    );
    expect(failed).toMatchObject({ type: "createLocalRow", row: { status: "failed" } });
    expect(viewport.rowChoices.map((choice) => choice.value.worktree.branch)).not.toContain(
      "feature-auth",
    );
  });

  it("orders mixed local and real rows by resolved display title", () => {
    const snapshot = createDashboardSnapshot();
    const titled = {
      ...snapshot,
      rows: snapshot.rows.map((row) =>
        row.id === "wt_web_stuck" ? { ...row, title: "aaa stable task" } : row,
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
              title: "bbb pending task",
              branch: "station-pending-1",
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
        .filter((item) => item.type === "session" || item.type === "createLocalRow")
        .slice(0, 3)
        .map((item) =>
          item.type === "session" ? `session:${item.row.id}` : `create:${item.row.title}`,
        ),
    ).toEqual([
      "session:ses_wt_web_stuck",
      "create:bbb pending task",
      "session:ses_wt_web_working",
    ]);
  });

  it("searches optimistic rows by both title and hidden branch", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      localRows: {
        pendingCreate: [
          {
            localId: "local_create_search",
            projectId: "web",
            title: "Hexagonal PT 12",
            branch: "station-e91f2b",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
        failedCreate: [],
        pendingRemove: [],
        pendingStart: [],
      },
    });

    for (const searchQuery of ["hexagonal", "e91f2b"]) {
      const items = selectDashboardItems(snapshot, { ...state, searchQuery });
      expect(items.some((item) => item.type === "createLocalRow")).toBe(true);
    }
  });

  it("searches only pending optimistic rows by their harness", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      searchQuery: "  CoDeX  ",
      localRows: {
        pendingCreate: [
          {
            localId: "local_create_pending_harness",
            projectId: "web",
            title: "Pending launch",
            branch: "station-pending-harness",
            harnessProvider: "codex",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
        failedCreate: [
          {
            localId: "local_create_failed_harness",
            projectId: "web",
            title: "Failed launch",
            branch: "station-failed-harness",
            error: {
              tag: "ClientObserverError",
              code: "PREPARE_FAILED",
              message: "Harness preparation failed.",
            },
            expiresAt: Date.now() + 4_000,
          },
        ],
        pendingRemove: [],
        pendingStart: [],
      },
    });

    expect(
      selectDashboardItems(snapshot, state).flatMap((item) =>
        item.type === "createLocalRow" ? [item.row.localId] : [],
      ),
    ).toEqual(["local_create_pending_harness"]);
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
      (item) => item.type === "session" && item.displayTitle === "fix-nav-mobile",
    );

    expect(titledItems).toEqual([
      expect.objectContaining({
        type: "session",
        row: expect.objectContaining({
          id: "ses_wt_web_idle",
          worktree: expect.objectContaining({ branch: "agent-created-branch" }),
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
        persistentFilter: { query: "removing session..." },
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
      (candidate) => candidate.type === "session" && candidate.row.id === "ses_wt_web_idle",
    );
    expect(item).toMatchObject({
      type: "session",
      presentation: { activity: "removing session..." },
      pendingRemove: {
        localId: "remove:wt_web_idle",
      },
      persistentFilterMatch: {
        matched: true,
        ranges: { activity: [{ start: 0, end: 19 }] },
      },
    });
    if (item === undefined) throw new Error("expected pending remove item");
    const rowInput = rowGridInputForViewportItem(item, new Map());
    expect(
      rowInput?.cells.activity?.segments
        .filter((segment) => segment.kind === "text")
        .map((segment) => (segment.kind === "text" ? segment.text : ""))
        .join(""),
    ).toBe("removing session...");
    expect(viewport.rowChoices.map((choice) => choice.value.id)).not.toContain("ses_wt_web_idle");
  });

  it("keeps pending start rows slotted for display but removes them from actions", () => {
    const snapshot = createCommandSnapshot("none");
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
      (candidate) => candidate.type === "session" && candidate.row.id === "ses_wt_web_no_agent",
    );
    expect(item).toMatchObject({
      type: "session",
      pendingStart: {
        localId: "start:wt_web_no_agent",
      },
    });
    expect(
      viewport.displayRowChoices.map((choice) => [choice.key, choice.value.id]),
    ).toContainEqual(["1", "ses_wt_web_no_agent"]);
    expect(viewport.rowChoices.map((choice) => [choice.key, choice.value.id])).not.toContainEqual([
      "1",
      "ses_wt_web_no_agent",
    ]);
  });

  it("carries resolved titles for dashboard session rendering", () => {
    const snapshot = createDashboardSnapshot();
    const titled = {
      ...snapshot,
      rows: snapshot.rows.map((row) =>
        row.id === "wt_web_idle" ? { ...row, title: "Readable feature task" } : row,
      ),
    };
    const viewport = selectDashboardViewport(titled, createInitialTuiState());

    const item = viewport.items.find(
      (candidate) => candidate.type === "session" && candidate.row.id === "ses_wt_web_idle",
    );
    expect(item).toMatchObject({
      type: "session",
      displayTitle: "Readable feature task",
    });
  });

  it("carries soft-preview metadata without changing order, visibility, slots, or overflow", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot, terminalRows: 10 });
    const resting = selectDashboardViewport(snapshot, state);
    const editing = selectDashboardViewport(snapshot, state, {
      name: "persistentFilter",
      draft: { value: "QUEUE", cursor: 5 },
    });

    expect(editing.items.map((item) => item.id)).toEqual(resting.items.map((item) => item.id));
    expect(editing.visibleItems.map((item) => item.id)).toEqual(
      resting.visibleItems.map((item) => item.id),
    );
    expect(editing.displayRowChoices).toEqual(resting.displayRowChoices);
    expect(editing.sessionOverflow).toEqual(resting.sessionOverflow);
    expect(editing.persistentFilter).toMatchObject({
      source: "draft",
      matchCount: 1,
      totalCount: 7,
    });
    expect(editing.items.find((item) => item.id === "session:ses_wt_api_working")).toMatchObject({
      persistentFilterMatch: { matched: true, dimmed: false },
    });
    expect(editing.items.find((item) => item.id === "session:ses_wt_web_idle")).toMatchObject({
      persistentFilterMatch: { matched: false, dimmed: true },
    });
  });

  it("counts collapsed rows globally while keeping draft preview collapse visibility soft", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      collapsedProjectIds: ["api"],
    });
    const preview = selectDashboardViewport(snapshot, state, {
      name: "persistentFilter",
      draft: { value: "queue-worker", cursor: 12 },
    });

    expect(preview.persistentFilter).toMatchObject({
      source: "draft",
      matchCount: 1,
      totalCount: 7,
    });
    expect(preview.items.map((item) => item.id)).not.toContain("session:ses_wt_api_working");
    expect(preview.items.find((item) => item.id === "project:api")).toMatchObject({
      collapsed: true,
      persistentFilterMatch: { matched: true },
    });
  });

  it("hard-projects applied row matches and rebuilds gaps only between retained projects", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({
        initialSnapshot: snapshot,
        persistentFilter: { query: "queue-worker" },
      }),
    );

    expect(viewport.items.map((item) => item.id)).toEqual([
      "project:api",
      "session:ses_wt_api_working",
    ]);
    expect(viewport.displayRowChoices.map((choice) => choice.value.id)).toEqual([
      "ses_wt_api_working",
    ]);
    expect(viewport.sessionOverflow).toEqual({ above: 0, below: 0, visible: 1, total: 1 });
  });

  it("retains every child when an applied filter matches the project label", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({
        initialSnapshot: snapshot,
        persistentFilter: { query: "web" },
      }),
    );

    expect(viewport.items.map((item) => item.id)).toEqual([
      "project:web",
      "session:ses_wt_web_working",
      "session:ses_wt_web_attention",
      "session:ses_wt_web_exited",
      "session:ses_wt_web_idle",
      "session:ses_wt_web_unknown",
      "session:ses_wt_web_stuck",
    ]);
  });

  it("temporarily reveals collapsed hidden-field matches with one inert explanation row", () => {
    const base = createDashboardSnapshot();
    const snapshot = {
      ...base,
      rows: base.rows.map((row) =>
        row.id === "wt_web_idle" ? { ...row, title: "Readable task" } : row,
      ),
    };
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({
        initialSnapshot: snapshot,
        collapsedProjectIds: ["web"],
        persistentFilter: { query: "fix-nav" },
        terminalRows: 20,
      }),
    );

    expect(viewport.items.map((item) => item.id)).toEqual([
      "project:web",
      "session:ses_wt_web_idle",
      "reason:session:ses_wt_web_idle",
    ]);
    expect(viewport.items[0]).toMatchObject({ type: "projectHeader", collapsed: true });
    expect(viewport.items[2]).toMatchObject({
      type: "matchReason",
      reason: {
        field: "branch",
        value: "fix-nav-mobile",
        ranges: [{ start: 0, end: 7 }],
      },
    });
    expect(viewport.displayRowChoices.map((choice) => choice.value.id)).toEqual([
      "ses_wt_web_idle",
    ]);
    expect(viewport.sessionOverflow.total).toBe(1);
  });

  it("attaches filter state to expanded, collapsed, and empty project headers during drafts", () => {
    const base = createDashboardSnapshot();
    const snapshot = {
      ...base,
      sessions: base.sessions.filter((session) => session.projectId !== "web"),
    };
    const state = createInitialTuiState({ collapsedProjectIds: ["api"] });
    const unmatched = selectDashboardViewport(snapshot, state, {
      name: "persistentFilter",
      draft: { value: "missing", cursor: 7 },
    });

    expect(unmatched.items).toContainEqual(
      expect.objectContaining({ type: "emptyProject", id: "empty:web" }),
    );
    expect(unmatched.items.find((item) => item.id === "project:web")).toMatchObject({
      type: "projectHeader",
      collapsed: false,
      persistentFilterMatch: { matched: false, labelRanges: [] },
    });
    expect(unmatched.items.find((item) => item.id === "project:api")).toMatchObject({
      type: "projectHeader",
      collapsed: true,
      persistentFilterMatch: { matched: false, labelRanges: [] },
    });

    const matchedCollapsed = selectDashboardViewport(snapshot, state, {
      name: "persistentFilter",
      draft: { value: "api", cursor: 3 },
    });
    expect(matchedCollapsed.items.find((item) => item.id === "project:api")).toMatchObject({
      persistentFilterMatch: { matched: true, labelRanges: [{ start: 0, end: 3 }] },
    });
  });

  it("hard-projects an optimistic row retained only by its hidden branch", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({
        initialSnapshot: snapshot,
        persistentFilter: { query: "e91f2b" },
        localRows: {
          pendingCreate: [
            {
              localId: "local_hidden_branch",
              projectId: "web",
              title: "Readable pending task",
              branch: "station-e91f2b",
              createdAt: "2026-05-31T12:00:00.000Z",
            },
          ],
          failedCreate: [],
          pendingRemove: [],
          pendingStart: [],
        },
      }),
    );

    expect(viewport.items.map((item) => item.id)).toEqual([
      "project:web",
      "create:local_hidden_branch",
      "reason:create:local_hidden_branch",
    ]);
    expect(viewport.items[2]).toMatchObject({
      type: "matchReason",
      reason: { field: "branch", value: "station-e91f2b" },
    });
    expect(viewport.sessionOverflow.total).toBe(1);
    expect(viewport.rowChoices).toEqual([]);
  });

  it("includes optimistic rows in persistent-preview counts and metadata", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      persistentFilter: { query: "pending launch" },
      localRows: {
        pendingCreate: [
          {
            localId: "local_filter_pending",
            projectId: "web",
            title: "Pending launch",
            branch: "station-pending-filter",
            harnessProvider: "codex",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
        failedCreate: [],
        pendingRemove: [],
        pendingStart: [],
      },
    });

    const viewport = selectDashboardViewport(snapshot, state, { name: "dashboard" });

    expect(viewport.persistentFilter).toMatchObject({ matchCount: 1, totalCount: 8 });
    expect(viewport.items.find((item) => item.id === "create:local_filter_pending")).toMatchObject({
      persistentFilterMatch: { matched: true, dimmed: false },
    });
  });
});
