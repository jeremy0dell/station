// Golden frames for the modal flows: every overlay/prompt/sheet view from
// the parity checklist, reached by driving the real machine with real keys,
// rendered over the dashboard at 80x24. Snapshots live in __snapshots__.
import { afterEach, describe, expect, it } from "bun:test";
import { TextRenderable, type BaseRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { StoreApi } from "zustand/vanilla";
import {
  attentionAndFailuresSnapshot,
  externalAgentSnapshot,
  manyProjectsSnapshot,
  noProjectsSnapshot,
} from "../fixtures/scenarios.js";
import type { TuiKey } from "@station/dashboard-core";
import type { TuiStore } from "@station/dashboard-core";
import {
  addPendingProjectDefaultHarness,
  applyAddProjectFolderLoaded,
  applyAddProjectFolderReviewFailed,
  applyAddProjectFolderReviewed,
  applyAddProjectSubmitted,
  openRemoveWorktreeConfirmForRow,
  openProjectDefaultAgentPicker,
  openProjectSettings,
} from "@station/dashboard-core";
import { makeStationTestStore } from "../test/support/makeStationTestStore.js";
import { DashboardRoot } from "./DashboardRoot.js";
import { StationMouseProvider } from "./stationMouseContext.js";
import { WidgetSettingsPanelView } from "./settings/WidgetSettingsPanelView.js";

const SIZE = { width: 80, height: 24 };

type ModalCase = {
  name: string;
  keys: TuiKey[];
  snapshot?: () => ReturnType<typeof manyProjectsSnapshot>;
  prepare?: (store: StoreApi<TuiStore>) => void;
  size?: { width: number; height: number };
  trimSnapshotTrailingWhitespace?: true;
  expect: string[];
  reject?: string[];
};

function snapshotWithCodexHealth(
  status: "healthy" | "degraded" | "unavailable",
): ReturnType<typeof manyProjectsSnapshot> {
  const snapshot = manyProjectsSnapshot();
  return {
    ...snapshot,
    providerHealth: {
      ...snapshot.providerHealth,
      codex: {
        providerId: "codex",
        providerType: "harness",
        status,
        lastCheckedAt: snapshot.generatedAt,
      },
    },
  };
}

function openAddProjectReview(store: StoreApi<TuiStore>, gitRoot: boolean): void {
  store.getState().handleKey({ input: "A" });
  store.setState(
    applyAddProjectFolderReviewed(store.getState(), {
      selectedPath: "/Users/example/Developer/station",
      ...(gitRoot ? { gitRoot: "/Users/example/Developer/station" } : {}),
      id: "station",
      label: "Station",
    }),
  );
}

const CASES: ModalCase[] = [
  {
    name: "help overlay",
    keys: [{ input: "H" }],
    expect: ["station help", "Ctrl-\\", "split pane right", "1-9/a-z", "open visible session", "╭", "╰"],
  },
  {
    name: "search prompt",
    keys: [{ input: "/" }, { input: "api" }],
    expect: ["search: api"],
  },
  {
    name: "collapse project sheet",
    keys: [{ input: "C" }],
    trimSnapshotTrailingWhitespace: true,
    expect: ["Collapse Project", "↑↓ move   ↵ select   1-9/a-z jump   Esc cancel", "station"],
  },
  {
    name: "collapse project sheet windows a long list",
    keys: [{ input: "C" }],
    snapshot: () => {
      const base = manyProjectsSnapshot();
      const station = base.projects[0];
      if (station === undefined) throw new Error("fixture has no projects");
      const extras = Array.from({ length: 21 }, (_, index) => ({
        ...station,
        id: `filler-${index}` as typeof station.id,
        label: `filler-${index}`,
      }));
      return { ...base, projects: [...base.projects, ...extras] };
    },
    trimSnapshotTrailingWhitespace: true,
    // 25 projects at 24 rows: the list windows to 18 with a range footer instead
    // of clipping rows the cursor could still reach.
    expect: ["Collapse Project", "↑↓ move   ↵ select   1-18 of 25   Esc cancel", "station"],
  },
  {
    name: "project settings picker sheet",
    keys: [{ input: "P" }],
    trimSnapshotTrailingWhitespace: true,
    expect: ["Project Settings", "↑↓ move   ↵ select   1-9/a-z jump   Esc cancel", "station"],
  },
  {
    name: "project settings panel",
    keys: [{ input: "P" }, { input: "1" }],
    expect: ["Project settings", "Default agent", "Remove project", "✓ current"],
  },
  {
    name: "project settings remove pane",
    keys: [
      { input: "P" },
      { input: "1" },
      { input: "", downArrow: true },
      { input: "\r", return: true },
    ],
    expect: ["Remove project", "Worktrees & files stay on disk.", "[ Remove project (R) ]"],
  },
  {
    name: "project settings optimistic default",
    keys: [],
    prepare: (store) => {
      store.setState(openProjectSettings(store.getState(), "station"));
      // Optimistic state the picker sets the moment a new agent is chosen,
      // before the observer round-trip lands (station's real default is codex).
      store.setState(
        addPendingProjectDefaultHarness(store.getState(), {
          projectId: "station",
          harness: "opencode",
          createdAt: "2026-06-28T00:00:00.000Z",
        }),
      );
    },
    expect: ["Default agent", "updating…"],
  },
  {
    name: "remove slot sheet",
    keys: [{ input: "X" }],
    expect: ["Select session to delete", "↑↓ move · ↵ choose · slot or click", "Esc:cancel"],
  },
  {
    name: "remove confirm sheet",
    keys: [{ input: "X" }, { input: "1" }],
    expect: ["Delete session?", "Session", "cli-help-man", "Yes (y)", "No (n)"],
  },
  {
    name: "external agent removal information",
    keys: [],
    snapshot: externalAgentSnapshot,
    trimSnapshotTrailingWhitespace: true,
    prepare: (store) => {
      store.setState(openRemoveWorktreeConfirmForRow(store.getState(), "run_wt_station_idle"));
    },
    expect: [
      "Cannot delete worktree",
      "This agent was started outside Station.",
      "Station can see its status, but cannot stop it.",
      "Stop or remove it from its original terminal or external tooling.",
      "Esc/Enter:close",
    ],
    reject: ["Yes (y)", "No (n)"],
  },
  {
    name: "rename slot prompt",
    keys: [{ input: "R" }],
    expect: ["Rename: ↑↓ move · ↵ choose · 1-9/a-z or click"],
  },
  {
    name: "rename sheet",
    keys: [{ input: "R" }, { input: "1" }],
    snapshot: attentionAndFailuresSnapshot,
    expect: ["Rename Session", "Name       |hook-scope", "Enter:rename   Esc:back"],
  },
  {
    name: "fork slot sheet",
    keys: [{ input: "F" }],
    expect: ["Select session to fork", "↑↓ move · ↵ choose · slot or click", "Esc:cancel"],
  },
  {
    name: "fork details sheet",
    keys: [
      { input: "F" },
      { input: "1" },
      { input: "u", ctrl: true },
      { input: "Hexagonal PT 12" },
    ],
    expect: [
      "Fork Session",
      "Source",
      "Name",
      "Hexagonal PT 12",
      "uncommitted changes",
      "Fork (enter)",
      "enter:fork",
    ],
    reject: ["Branch"],
  },
  {
    name: "fork details submit focus",
    keys: [
      { input: "F" },
      { input: "1" },
      { input: "", downArrow: true },
      { input: "", downArrow: true },
    ],
    expect: ["Fork Session", "▸ Fork (enter)"],
  },
  {
    name: "new session review",
    keys: [{ input: "N" }],
    expect: [
      "Create Session",
      "Project (P)",
      "Name (N)",
      "Agent (A)",
      "Create session (C)",
      "Enter create session",
    ],
  },
  {
    name: "new session review project focus",
    keys: [{ input: "N" }, { input: "", downArrow: true }],
    expect: ["▸ Project (P)", "Enter choose project"],
  },
  {
    name: "new session review name focus",
    keys: [
      { input: "N" },
      { input: "", downArrow: true },
      { input: "", downArrow: true },
    ],
    expect: ["▸ Name (N)", "Enter edit name"],
  },
  {
    name: "new session review agent focus",
    keys: [{ input: "N" }, { input: "", upArrow: true }],
    expect: ["▸ Agent (A)", "Enter choose agent"],
  },
  {
    name: "new session healthy agent",
    keys: [{ input: "N" }],
    snapshot: () => snapshotWithCodexHealth("healthy"),
    expect: ["codex ● healthy", "Create session (C)"],
  },
  {
    name: "new session degraded agent",
    keys: [{ input: "N" }],
    snapshot: () => snapshotWithCodexHealth("degraded"),
    expect: ["codex ● degraded", "Create session (C)"],
  },
  {
    name: "new session unavailable agent",
    keys: [{ input: "N" }],
    snapshot: () => snapshotWithCodexHealth("unavailable"),
    expect: ["codex ● unavailable", "Create session (C)"],
  },
  {
    name: "new session edit name",
    keys: [{ input: "N" }, { input: "N" }],
    expect: ["Set Session Name", "Name", "Save (Ctrl-S)", "Back (Esc)", "Enter save"],
  },
  {
    name: "new session edit name save focus",
    keys: [{ input: "N" }, { input: "N" }, { input: "", downArrow: true }],
    expect: ["▸ Save (Ctrl-S)", "↑ name · Enter save"],
    reject: ["|station-"],
  },
  {
    name: "new session edit name back focus",
    keys: [
      { input: "N" },
      { input: "N" },
      { input: "", downArrow: true },
      { input: "", rightArrow: true },
    ],
    expect: ["▸ Back (Esc)", "Enter back without saving"],
    reject: ["|station-"],
  },
  {
    name: "new session narrow review",
    keys: [{ input: "N" }],
    snapshot: () => snapshotWithCodexHealth("degraded"),
    size: { width: 40, height: 16 },
    expect: ["Project (P)", "Name (N)", "Agent (A)", "● degraded", "Create session (C)"],
  },
  {
    name: "new session pick project",
    keys: [{ input: "N" }, { input: "P" }],
    expect: ["Choose Project", "↑↓ move   ↵ select   1-9/a-z jump   Esc back", "station", "observer"],
  },
  {
    name: "new session pick agent",
    keys: [{ input: "N" }, { input: "A" }],
    expect: ["Choose Agent", "↑↓ move   ↵ select   1-9/a-z jump   Esc back", "codex"],
  },
  {
    name: "project default agent picker",
    keys: [],
    prepare: (store) => {
      store.setState(openProjectDefaultAgentPicker(store.getState(), "station"));
    },
    trimSnapshotTrailingWhitespace: true,
    expect: [
      "Select default agent for station",
      "↑↓ move   ↵ select   1-9/a-z jump   Esc cancel",
      "codex ● update v0.3.0 → v0.4.0",
    ],
  },
  {
    name: "add project sheet",
    keys: [{ input: "A" }],
    expect: ["Add Project", "Start location", "Open (→/↵)", "Cancel (Esc)"],
  },
  {
    name: "first project sheet",
    keys: [{ input: "\r", return: true }],
    snapshot: noProjectsSnapshot,
    expect: ["Add Your First Project", "Start location", "Open (→/↵)", "Cancel (Esc)"],
  },
  {
    name: "add project folder actions",
    keys: [{ input: "A" }],
    prepare: (store) => {
      store.setState(
        applyAddProjectFolderLoaded(store.getState(), {
          path: "/Users/example/Developer",
          entries: [
            {
              name: "station",
              path: "/Users/example/Developer/station",
              kind: "directory",
            },
          ],
        }),
      );
    },
    expect: ["Choose Project Folder", "Choose (↵)", "Open (→)", "Parent (←)", "Search (/)"],
  },
  {
    name: "add project review actions",
    keys: [],
    prepare: (store) => openAddProjectReview(store, true),
    expect: ["Add Project: Review", "▸ Add project (A)", "Edit id (N)", "Choose folder (B)"],
  },
  {
    name: "add project Git recovery",
    keys: [],
    prepare: (store) => openAddProjectReview(store, false),
    expect: ["Git root", "not detected", "Choose a folder inside an existing Git repository", "▸ Choose folder (B)"],
  },
  {
    name: "add project id editor actions",
    keys: [],
    prepare: (store) => {
      openAddProjectReview(store, true);
      store.getState().handleKey({ input: "N" });
    },
    expect: ["Project id", "▸ Save id (Ctrl-S)", "Back (Esc)"],
  },
  {
    name: "add project success action",
    keys: [],
    prepare: (store) => {
      openAddProjectReview(store, true);
      store.setState(
        applyAddProjectSubmitted(store.getState(), {
          label: "Station",
          root: "/Users/example/Developer/station",
        }),
      );
    },
    expect: ["Project Added", "Reconciled successfully", "▸ Dashboard (D)"],
  },
  {
    name: "add project failure actions",
    keys: [],
    prepare: (store) => {
      openAddProjectReview(store, true);
      store.setState(
        applyAddProjectFolderReviewFailed(
          store.getState(),
          "/Users/example/Developer/station",
          new Error("Git review failed"),
        ),
      );
    },
    expect: ["Add Project Failed", "Could not add this project", "▸ Retry (R)", "Choose folder (B)"],
  },
  {
    name: "add project narrow actions",
    keys: [{ input: "A" }],
    size: { width: 40, height: 16 },
    expect: ["Add Project", "Open (→/↵)", "Cancel (Esc)"],
  },
  {
    name: "widget settings panel",
    keys: [{ input: "W" }],
    trimSnapshotTrailingWhitespace: true,
    prepare: (store) => {
      store.setState({
        widgets: [
          { type: "time" },
          { type: "weather", city: "New York, NY", label: "NYC", enabled: false },
          { type: "moon" },
        ],
      });
    },
    expect: [
      "widgets",
      "saved to config.toml",
      "[on ] time",
      "[off] weather NYC",
      "[on ] moon",
      "[ + add widget ]",
      "↵ toggle   [ ] reorder   x remove   a add",
    ],
  },
  {
    name: "widget settings picker",
    keys: [{ input: "W" }, { input: "a" }],
    trimSnapshotTrailingWhitespace: true,
    expect: ["add widget", "weather and tz require config.toml", "time", "fleet", "open PRs", "moon", "↵ add   esc back"],
  },
];

describe("modal flow golden frames", () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  });

  function makeStore(snapshot = manyProjectsSnapshot()): StoreApi<TuiStore> {
    return makeStationTestStore({
      snapshot,
      folderService: {
        cwd: () => "/Users/example/Developer/station",
        homeDir: () => "/Users/example",
        parent: (path) => path.split("/").slice(0, -1).join("/") || "/",
        readDirectory: async (path) => ({ path, entries: [] }),
        searchDirectories: async (query) => ({ query, truncated: false, entries: [] }),
        reviewFolder: async (path) => ({ selectedPath: path, id: "p", label: "p" }),
      },
    }).store;
  }

  for (const modal of CASES) {
    it(`renders the ${modal.name}`, async () => {
      const store = makeStore(modal.snapshot?.());
      for (const key of modal.keys) {
        store.getState().handleKey(key);
      }
      modal.prepare?.(store);
      const size = modal.size ?? SIZE;
      const setup = await testRender(
        <DashboardRoot
          store={store}
          columns={size.width}
          rows={size.height}
          onCopyNotice={() => {}}
        />,
        size,
      );
      teardowns.push(() => {
        setup.renderer.destroy();
      });
      await setup.renderOnce();
      // The generated session name is uuid-seeded (stableNameHash over a
      // random token); scrub it so the goldens stay deterministic.
      const capturedFrame = setup.captureCharFrame().replace(/station-[0-9a-z]{6}/g, "station-XXXXXX");
      const frame =
        modal.trimSnapshotTrailingWhitespace === true
          ? capturedFrame.replace(/[ \t]+$/gm, "")
          : capturedFrame;
      for (const expected of modal.expect) {
        expect(frame).toContain(expected);
      }
      for (const rejected of modal.reject ?? []) {
        expect(frame).not.toContain(rejected);
      }
      expect(frame).toMatchSnapshot();
    });
  }

  it("keeps widget settings text out of OpenTUI selection", async () => {
    const setup = await testRender(
      <StationMouseProvider value={() => {}}>
        <WidgetSettingsPanelView
          screen={{ name: "widgetSettings", focus: "list", cursor: 0, pickerCursor: 0 }}
          widgets={[{ type: "time" }, { type: "moon", enabled: false }]}
          widgetsPersisted
          columns={SIZE.width}
          rows={SIZE.height}
        />
      </StationMouseProvider>,
      SIZE,
    );
    teardowns.push(() => {
      setup.renderer.destroy();
    });
    await setup.renderOnce();

    const textRenderables = collectTextRenderables(setup.renderer.root);
    expect(textRenderables.length).toBeGreaterThan(0);
    expect(textRenderables.every((renderable) => renderable.selectable === false)).toBe(true);
  });
});

function collectTextRenderables(renderable: BaseRenderable): TextRenderable[] {
  const collected = renderable instanceof TextRenderable ? [renderable] : [];
  for (const child of renderable.getChildren()) {
    collected.push(...collectTextRenderables(child));
  }
  return collected;
}
