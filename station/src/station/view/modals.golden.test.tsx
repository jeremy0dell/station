// Golden frames for the modal flows: every overlay/prompt/sheet view from
// the parity checklist, reached by driving the real machine with real keys,
// rendered over the dashboard at 80x24. Snapshots live in __snapshots__.
import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { StoreApi } from "zustand/vanilla";
import { attentionAndFailuresSnapshot, manyProjectsSnapshot } from "../fixtures/scenarios.js";
import type { TuiKey } from "@station/dashboard-core";
import type { TuiStore } from "@station/dashboard-core";
import {
  addPendingProjectDefaultHarness,
  openProjectDefaultAgentPicker,
  openProjectSettings,
} from "@station/dashboard-core";
import { makeStationTestStore } from "../test/support/makeStationTestStore.js";
import { DashboardRoot } from "./DashboardRoot.js";

const SIZE = { width: 80, height: 24 };

type ModalCase = {
  name: string;
  keys: TuiKey[];
  snapshot?: () => ReturnType<typeof manyProjectsSnapshot>;
  prepare?: (store: StoreApi<TuiStore>) => void;
  trimSnapshotTrailingWhitespace?: true;
  expect: string[];
};

const CASES: ModalCase[] = [
  {
    name: "help overlay",
    keys: [{ input: "H" }],
    expect: ["station help", "Ctrl-\\", "split pane right", "1-9/a-z", "start or focus row", "╭", "╰"],
  },
  {
    name: "search prompt",
    keys: [{ input: "/" }, { input: "api" }],
    expect: ["search: api"],
  },
  {
    name: "collapse prompt",
    keys: [{ input: "C" }],
    expect: ["collapse project:"],
  },
  {
    name: "project settings picker prompt",
    keys: [{ input: "P" }],
    expect: ["settings for project:"],
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
    expect: ["Select session to delete", "Click a row or press slot key", "Esc:cancel"],
  },
  {
    name: "remove confirm sheet",
    keys: [{ input: "X" }, { input: "1" }],
    expect: ["Delete session?", "Session", "cli-help-man", "Yes (y)", "No (n)"],
  },
  {
    name: "rename slot prompt",
    keys: [{ input: "R" }],
    expect: ["Choose the slot to rename: 1-9/a-z"],
  },
  {
    name: "rename sheet",
    keys: [{ input: "R" }, { input: "1" }],
    snapshot: attentionAndFailuresSnapshot,
    expect: ["Rename Session", "Name", "Enter:rename   Esc:back"],
  },
  {
    name: "fork slot sheet",
    keys: [{ input: "F" }],
    expect: ["Select session to fork", "Click a row or press slot key", "Esc:cancel"],
  },
  {
    name: "fork details sheet",
    keys: [{ input: "F" }, { input: "1" }],
    expect: ["Fork Session", "Source", "uncommitted changes", "Fork (enter)", "enter:fork"],
  },
  {
    name: "new session review",
    keys: [{ input: "N" }],
    expect: ["Create Session", "Project", "Agent", "Enter:create N:name P:project A:agent Esc:cancel"],
  },
  {
    name: "new session edit name",
    keys: [{ input: "N" }, { input: "N" }],
    expect: ["Set Session Name", "Enter:save   Esc:back"],
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
    expect: ["Add Project", "Start location", "Enter:open Right:open Esc:cancel"],
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
      const setup = await testRender(
        <DashboardRoot store={store} columns={SIZE.width} rows={SIZE.height} />,
        SIZE,
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
      expect(frame).toMatchSnapshot();
    });
  }
});
