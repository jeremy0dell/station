// Golden frames for the modal flows: every overlay/prompt/sheet view from
// the parity checklist, reached by driving the real machine with real keys,
// rendered over the dashboard at 80x24. Snapshots live in __snapshots__.
import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex, TextRenderable, type BaseRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import {
  nativeStationTheme,
  stationColorSnapshotValue,
  StationThemeProvider,
  type StationColor,
} from "../../theme/index.js";
import { parseStationTerminalPaletteObservation } from "../../theme/terminalPalette/observation.js";
import { lightTerminalColors } from "../../theme/terminalPalette/test/fixtures.js";
import { createTerminalPaletteTheme } from "../../theme/terminalPalette/theme.js";
import { spanAtFrameCell } from "../../terminal/testing/frameProbe.js";
import {
  attentionAndFailuresSnapshot,
  externalAgentSnapshot,
  groupedManyProjectsSnapshot,
  manyProjectsSnapshot,
  noProjectsSnapshot,
} from "../fixtures/scenarios.js";
import type { DashboardRuntime, DashboardStateSource } from "@station/dashboard-core/runtime";
import type { TuiKey } from "@station/dashboard-core/state";
import {
  addPendingProjectDefaultHarness,
  applyAddProjectFolderLoaded,
  applyAddProjectFolderReviewFailed,
  applyAddProjectFolderReviewed,
  applyAddProjectSubmitted,
  createInitialTuiState,
  handleTuiKey,
  openRemoveWorktreeConfirmForRow,
  openProjectDefaultAgentPicker,
  openCreateGroup,
  openGroupMenu,
  openGroupSettings,
  openMoveToGroupForRow,
  openProjectMenu,
  openProjectSettings,
 } from "@station/dashboard-core/state";

/** Pure-reducer state threaded through the golden cases; named through the public factory. */
type GoldenDashboardState = ReturnType<typeof createInitialTuiState>;
import { makeStationTestRuntime } from "../test/support/makeStationTestRuntime.js";
import { DashboardRoot } from "./DashboardRoot.js";
import { StationMouseProvider } from "./stationMouseContext.js";
import { WidgetSettingsPanelView } from "./settings/WidgetSettingsPanelView.js";

const SIZE = { width: 80, height: 24 };
const lightObservation = parseStationTerminalPaletteObservation(lightTerminalColors);
if (lightObservation === null) {
  throw new Error("Expected a complete light terminal palette fixture.");
}
const LIGHT_TERMINAL_THEME = createTerminalPaletteTheme(lightObservation);

type ModalCase = {
  name: string;
  keys: TuiKey[];
  snapshot?: () => ReturnType<typeof manyProjectsSnapshot>;
  prepare?: (state: GoldenDashboardState) => GoldenDashboardState;
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

function openAddProjectReview(state: GoldenDashboardState, gitRoot: boolean): GoldenDashboardState {
  const opened = handleTuiKey(state, { input: "A" }).state;
  return applyAddProjectFolderReviewed(opened, {
    selectedPath: "/Users/example/Developer/station",
    ...(gitRoot ? { gitRoot: "/Users/example/Developer/station" } : {}),
    id: "station",
    label: "Station",
  });
}

function markNewSessionSubmitting(state: GoldenDashboardState): GoldenDashboardState {
  if (state.screen.name !== "newSession" || state.screen.flow.mode !== "review") return state;
  return {
    ...state,
    screen: {
      name: "newSession",
      flow: { ...state.screen.flow, submissionLocalId: "create:station:golden" },
    },
  };
}

const CASES: ModalCase[] = [
  {
    name: "help overlay",
    keys: [{ input: "H" }],
    expect: [
      "station help",
      "Ctrl-\\",
      "split pane right",
      "1-9/a-z",
      "open visible session",
      "G",
      "quick group",
      "M",
      "move to group",
      "edit/apply/cancel-clear/retain-close filter",
      "╭",
      "╰",
    ],
  },
  {
    name: "project menu",
    keys: [],
    prepare: (state) => openProjectMenu(state, "station"),
    expect: ["Quick Group", "New Group…", "Set default agent", "Project settings…"],
  },
  {
    name: "project menu above a short viewport",
    keys: [],
    size: { width: 30, height: 8 },
    prepare: (state) => openProjectMenu(state, "station"),
    expect: ["Quick Group", "New Group…", "Set default agent", "Project settings…"],
  },
  {
    name: "Group menu",
    keys: [],
    snapshot: groupedManyProjectsSnapshot,
    prepare: (state) => openGroupMenu(state, "group_design_refresh"),
    expect: [
      "Design refresh",
      "Quick session",
      "New session…",
      "Group settings…",
      "Remove Group…",
    ],
  },
  {
    name: "Group menu above a short viewport",
    keys: [],
    size: { width: 30, height: 9 },
    snapshot: groupedManyProjectsSnapshot,
    prepare: (state) => openGroupMenu(state, "group_design_refresh"),
    expect: ["Quick session", "New session…", "Group settings…", "Remove Group…"],
  },
  {
    name: "create group sheet",
    keys: [],
    prepare: (state) => {
      let opened = openCreateGroup(state, "station", "projectMenu");
      opened = handleTuiKey(opened, { input: "Release work" }).state;
      opened = handleTuiKey(opened, { input: "", downArrow: true }).state;
      return handleTuiKey(opened, { input: "Q" }).state;
    },
    expect: [
      "Create Group",
      "Name (N)",
      "Release work",
      "▸ Quick session (Q) On",
      "Create Group (C)",
      "Cancel (Esc)",
    ],
  },
  {
    name: "move to group destination sheet",
    keys: [],
    snapshot: groupedManyProjectsSnapshot,
    prepare: (state) => openMoveToGroupForRow(state, "ses_wt_group_contracts"),
    expect: [
      "Move to Group",
      "Session    group-contracts",
      "Current    Design refresh",
      "U Ungrouped",
      "1 Design refresh",
      "N Create new Group…",
    ],
  },
  {
    name: "move to group create sheet",
    keys: [],
    snapshot: groupedManyProjectsSnapshot,
    prepare: (state) => {
      const opened = openMoveToGroupForRow(state, "ses_wt_group_contracts");
      const creating = handleTuiKey(opened, { input: "N" }).state;
      return handleTuiKey(creating, { input: "Release" }).state;
    },
    expect: ["Create Group", "Session    group-contracts", "Group", "Release", "Create and Move"],
  },
  {
    name: "persistent filter header editor",
    keys: [{ input: "/" }, { input: "api" }],
    expect: ["FILTER /api▏", "FILTER", "Enter apply", "api-cache"],
  },
  {
    name: "persistent filter condition field chooser",
    keys: [{ input: "/" }, { input: "i", ctrl: true }],
    expect: [
      "FILTER CONDITIONS",
      "[×]",
      "S Status",
      "P Project",
      "Any ›",
      "Apply filter (F)",
      "F apply filter",
    ],
  },
  {
    name: "persistent filter status condition values",
    keys: [{ input: "/" }, { input: "i", ctrl: true }, { input: "S" }, { input: "3" }],
    expect: [
      "STATUS CONDITION",
      "3 [✓] Working",
      "[←]",
      "[×]",
      "Done (Enter)",
      "CONDITION",
      "Enter done",
      "Esc close",
    ],
  },
  {
    name: "persistent filter condition values at minimum size",
    keys: [
      { input: "/" },
      { input: "i", ctrl: true },
      { input: "S" },
      { input: "", downArrow: true },
      { input: "", downArrow: true },
      { input: "", downArrow: true },
      { input: "", downArrow: true },
      { input: "", downArrow: true },
      { input: "", downArrow: true },
    ],
    size: { width: 40, height: 12 },
    expect: [
      "STATUS CONDITION ↑5",
      "▸ 7 [ ] No agent",
      "[←]",
      "[×]",
      "Done (Enter)",
      "CONDITION",
      "← fields",
      "Esc clo",
    ],
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
    name: "group settings general",
    keys: [{ input: "", rightArrow: true }],
    snapshot: groupedManyProjectsSnapshot,
    prepare: (state) => openGroupSettings(state, "group_design_refresh", "general"),
    expect: [
      "Group settings · Design refresh",
      "General",
      "Sessions",
      "Remove Group",
      "Project station (read-only)",
      "Save",
      "Cancel",
    ],
  },
  {
    name: "group settings sessions compact",
    keys: [],
    snapshot: groupedManyProjectsSnapshot,
    size: { width: 40, height: 12 },
    prepare: (state) =>
      handleTuiKey(
        openGroupSettings(state, "group_design_refresh", "sessions"),
        { input: "", rightArrow: true },
      ).state,
    expect: ["Sessions · Design refresh", "[✓]", "Save", "Back"],
  },
  {
    name: "group settings remove short",
    keys: [],
    snapshot: groupedManyProjectsSnapshot,
    size: { width: 40, height: 12 },
    prepare: (state) =>
      handleTuiKey(
        openGroupSettings(state, "group_design_refresh", "remove"),
        { input: "", rightArrow: true },
      ).state,
    expect: ["Remove Group", "remain open", "delete Design refresh", "Remove", "Back"],
  },
  {
    name: "project settings panel",
    keys: [{ input: "P" }, { input: "1" }],
    expect: ["Project settings", "Default agent", "Remove project", "✓ current"],
  },
  {
    name: "project settings compact list",
    keys: [],
    size: { width: 40, height: 12 },
    prepare: (state) => openProjectSettings(state, "station"),
    expect: ["Project settings", "Default agent", "Remove project"],
    reject: ["✓ current"],
  },
  {
    name: "project settings compact detail",
    keys: [],
    size: { width: 40, height: 12 },
    prepare: (state) =>
      handleTuiKey(openProjectSettings(state, "station"), {
        input: "",
        rightArrow: true,
      }).state,
    expect: ["Default agent · station", "✓ current"],
    reject: ["Remove project"],
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
    prepare: (state) =>
      // Optimistic state the picker sets the moment a new agent is chosen,
      // before the observer round-trip lands (station's real default is codex).
      addPendingProjectDefaultHarness(openProjectSettings(state, "station"), {
        projectId: "station",
        harness: "opencode",
        createdAt: "2026-06-28T00:00:00.000Z",
      }),
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
    expect: [
      "Delete session?",
      "Session",
      "cli-help-man",
      "Delete (Y)",
      "▸ Keep session (N)",
      "←→ choose · Enter activate · Esc cancel",
    ],
  },
  {
    name: "remove confirm delete focus",
    keys: [{ input: "X" }, { input: "1" }, { input: "", leftArrow: true }],
    expect: ["Delete session?", "▸ Delete (Y)", "Keep session (N)"],
  },
  {
    name: "remove confirm narrow",
    keys: [{ input: "X" }, { input: "1" }],
    size: { width: 40, height: 16 },
    expect: ["Delete (Y)", "▸ Keep session (N)", "←→ · Enter activate · Esc cancel"],
  },
  {
    name: "external agent removal information",
    keys: [],
    snapshot: externalAgentSnapshot,
    trimSnapshotTrailingWhitespace: true,
    prepare: (state) => openRemoveWorktreeConfirmForRow(state, "run_wt_station_idle"),
    expect: [
      "Cannot delete worktree",
      "Station cannot stop the active agent.",
      "Stop it in its terminal before deleting the worktree.",
      "Esc/Enter:close",
    ],
    reject: ["Delete (Y)", "Keep session (N)"],
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
    expect: [
      "Rename Session",
      "Name       |hook-scope",
      "Rename (enter)",
      "Enter:rename   Esc:back",
    ],
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
      "↑↓ focus · Enter fork · Esc back",
    ],
    reject: ["Branch"],
  },
  {
    name: "fork details grouped source",
    keys: [{ input: "F" }, { input: "1" }, { input: "", downArrow: true }],
    snapshot: groupedManyProjectsSnapshot,
    expect: [
      "Fork Session",
      "▸ Group",
      "[x] create in Design refresh",
      "Space/Enter toggle · ↑↓ focus · Esc back",
    ],
  },
  {
    name: "fork details copy focus",
    keys: [{ input: "F" }, { input: "1" }, { input: "", downArrow: true }],
    expect: ["Fork Session", "▸ Copy", "Space/Enter toggle · ↑↓ focus · Esc back"],
  },
  {
    name: "fork details submit focus",
    keys: [
      { input: "F" },
      { input: "1" },
      { input: "", downArrow: true },
      { input: "", downArrow: true },
    ],
    expect: ["Fork Session", "▸ Fork (enter)", "↑↓ focus · Enter fork · Esc back"],
  },
  {
    name: "fork details narrow copy focus",
    keys: [{ input: "F" }, { input: "1" }, { input: "", downArrow: true }],
    size: { width: 40, height: 16 },
    expect: [
      "Name",
      "▸ Copy",
      "Fork (enter)",
      "Source running; copy is read-only.",
      "Space/↵ toggle · ↑↓ · Esc back",
    ],
  },
  {
    name: "new session review",
    keys: [{ input: "N" }],
    expect: [
      "Create Session",
      "Project (P)",
      "Name (N)",
      "Agent (A)",
      "Group (G)",
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
    keys: [{ input: "N" }, { input: "", downArrow: true }, { input: "", downArrow: true }],
    expect: ["▸ Name (N)", "Enter edit name"],
  },
  {
    name: "new session review agent focus",
    keys: [{ input: "N" }, { input: "", upArrow: true }, { input: "", upArrow: true }],
    expect: ["▸ Agent (A)", "Enter choose agent"],
  },
  {
    name: "new session review Group focus",
    keys: [{ input: "N" }, { input: "", upArrow: true }],
    expect: ["▸ Group (G)", "Enter choose Group"],
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
    expect: [
      "Project (P)",
      "Name (N)",
      "Agent (A)",
      "● degraded",
      "Group (G)",
      "Create session (C)",
    ],
  },
  {
    name: "new session pick project",
    keys: [{ input: "N" }, { input: "P" }],
    expect: [
      "Choose Project",
      "↑↓ move   ↵ select   1-9/a-z jump   Esc back",
      "station",
      "observer",
    ],
  },
  {
    name: "new session pick agent",
    keys: [{ input: "N" }, { input: "A" }],
    expect: ["Choose Agent", "↑↓ move   ↵ select   1-9/a-z jump   Esc back", "codex"],
  },
  {
    name: "new session pick Group",
    keys: [{ input: "N" }, { input: "G" }],
    snapshot: groupedManyProjectsSnapshot,
    expect: ["Choose Group", "U Ungrouped", "1 Design refresh", "N Create new Group"],
  },
  {
    name: "new session edit inline Group",
    keys: [{ input: "N" }, { input: "G" }, { input: "N" }, { input: "Release" }],
    snapshot: groupedManyProjectsSnapshot,
    expect: ["Create Group", "Group", "Release|", "Enter save · Esc discard"],
  },
  {
    name: "new session creating progress",
    keys: [{ input: "N" }],
    prepare: markNewSessionSubmitting,
    expect: ["Creating…", "Creating session…", "Group (G)"],
    reject: ["Esc cancel"],
  },
  {
    name: "project default agent picker",
    keys: [],
    prepare: (state) => openProjectDefaultAgentPicker(state, "station"),
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
    prepare: (state) =>
      applyAddProjectFolderLoaded(state, {
        path: "/Users/example/Developer",
        entries: [
          {
            name: "station",
            path: "/Users/example/Developer/station",
            kind: "directory",
          },
        ],
      }),
    expect: ["Choose Project Folder", "Choose (↵)", "Open (→)", "Parent (←)", "Search (/)"],
  },
  {
    name: "add project review actions",
    keys: [],
    prepare: (state) => openAddProjectReview(state, true),
    expect: ["Add Project: Review", "▸ Add project (A)", "Edit id (N)", "Choose folder (B)"],
  },
  {
    name: "add project Git recovery",
    keys: [],
    prepare: (state) => openAddProjectReview(state, false),
    expect: [
      "Git root",
      "not detected",
      "Choose a folder inside an existing Git repository",
      "▸ Choose folder (B)",
    ],
  },
  {
    name: "add project id editor actions",
    keys: [],
    prepare: (state) => handleTuiKey(openAddProjectReview(state, true), { input: "N" }).state,
    expect: ["Project id", "▸ Save id (Ctrl-S)", "Back (Esc)"],
  },
  {
    name: "add project success action",
    keys: [],
    prepare: (state) =>
      applyAddProjectSubmitted(openAddProjectReview(state, true), {
        label: "Station",
        root: "/Users/example/Developer/station",
      }),
    expect: ["Project Added", "Reconciled successfully", "▸ Dashboard (D)"],
  },
  {
    name: "add project failure actions",
    keys: [],
    prepare: (state) =>
      applyAddProjectFolderReviewFailed(
        openAddProjectReview(state, true),
        "/Users/example/Developer/station",
        new Error("Git review failed"),
      ),
    expect: [
      "Add Project Failed",
      "Could not add this project",
      "▸ Retry (R)",
      "Choose folder (B)",
    ],
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
    prepare: (state) => ({
      ...state,
      widgets: [
        { type: "time" },
        { type: "weather", city: "New York, NY", label: "NYC", enabled: false },
        { type: "moon" },
      ],
    }),
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
    expect: [
      "add widget",
      "weather and tz require config.toml",
      "time",
      "fleet",
      "open PRs",
      "moon",
      "↵ add   esc back",
    ],
  },
];

describe("modal flow golden frames", () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  });

  function makeStore(snapshot = manyProjectsSnapshot()): DashboardRuntime {
    return makeStationTestRuntime({
      snapshot,
      folderService: {
        cwd: () => "/Users/example/Developer/station",
        homeDir: () => "/Users/example",
        parent: (path) => path.split("/").slice(0, -1).join("/") || "/",
        readDirectory: async (path) => ({ path, entries: [] }),
        searchDirectories: async (query) => ({ query, truncated: false, entries: [] }),
        reviewFolder: async (path) => ({ selectedPath: path, id: "p", label: "p" }),
      },
    }).runtime;
  }

  function prepareModalState(
    modal: ModalCase,
    snapshot: ReturnType<typeof manyProjectsSnapshot>,
  ): GoldenDashboardState | undefined {
    if (modal.prepare === undefined) {
      return undefined;
    }
    let state = createInitialTuiState({ initialSnapshot: snapshot });
    for (const key of modal.keys) {
      const context = { cwd: "/Users/example/Developer/station", homeDir: "/Users/example" };
      state = handleTuiKey(state, key, context).state;
    }
    return modal.prepare(state);
  }

  for (const modal of CASES) {
    it(`renders the ${modal.name}`, async () => {
      const snapshot = modal.snapshot?.() ?? manyProjectsSnapshot();
      const store = makeStore(snapshot);
      for (const key of modal.keys) {
        store.actions.handleKey(key);
      }
      const prepared = prepareModalState(modal, snapshot);
      const state = prepared === undefined ? store.state : staticDashboardState(prepared);
      const size = modal.size ?? SIZE;
      const setup = await testRender(
        <StationThemeProvider theme={nativeStationTheme}>
          <DashboardRoot
            state={state}
            actions={store.actions}
            columns={size.width}
            rows={size.height}
            onCopyNotice={() => {}}
          />
        </StationThemeProvider>,
        size,
      );
      teardowns.push(() => {
        setup.renderer.destroy();
      });
      await setup.renderOnce();
      // The generated session name is uuid-seeded (stableNameHash over a
      // random token); scrub it so the goldens stay deterministic.
      const capturedFrame = setup
        .captureCharFrame()
        .replace(/station-[0-9a-z]{6}/g, "station-XXXXXX");
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

  it("renders Help, sheets, settings, and prompts with opaque adaptive light roles", async () => {
    const representatives: ReadonlyArray<{
      name: string;
      needle: string;
      foreground: StationColor;
      border: boolean;
    }> = [
      {
        name: "help overlay",
        needle: "station help",
        foreground: LIGHT_TERMINAL_THEME.text.primary,
        border: false,
      },
      {
        name: "collapse project sheet",
        needle: "Collapse Project",
        foreground: LIGHT_TERMINAL_THEME.text.primary,
        border: true,
      },
      {
        name: "widget settings panel",
        needle: "widgets",
        foreground: LIGHT_TERMINAL_THEME.text.primary,
        border: true,
      },
    ];

    for (const representative of representatives) {
      const modal = CASES.find((candidate) => candidate.name === representative.name);
      if (modal === undefined) {
        throw new Error(`Missing modal fixture ${representative.name}.`);
      }
      const snapshot = modal.snapshot?.() ?? manyProjectsSnapshot();
      const store = makeStore(snapshot);
      for (const key of modal.keys) {
        store.actions.handleKey(key);
      }
      const prepared = prepareModalState(modal, snapshot);
      const state = prepared === undefined ? store.state : staticDashboardState(prepared);
      const size = modal.size ?? SIZE;
      const setup = await testRender(
        <StationThemeProvider theme={LIGHT_TERMINAL_THEME}>
          <DashboardRoot
            state={state}
            actions={store.actions}
            columns={size.width}
            rows={size.height}
            onCopyNotice={() => {}}
          />
        </StationThemeProvider>,
        size,
      );
      teardowns.push(() => setup.renderer.destroy());
      await setup.renderOnce();

      const lines = setup.captureCharFrame().split("\n");
      const row = lines.findIndex((line) => line.includes(representative.needle));
      const col = lines[row]?.indexOf(representative.needle) ?? -1;
      const span = spanAtFrameCell(setup.captureSpans(), row, col);
      expect(span?.bg.intent).toBe("default");
      expect(span?.bg.toInts()[3]).toBe(255);
      expect(span?.fg === undefined ? undefined : rgbToHex(span.fg)).toBe(
        stationColorSnapshotValue(representative.foreground),
      );

      if (representative.border) {
        const borderChars = ["╭", "┌", "┏"] as const;
        const borderRow = lines.findIndex((line) => borderChars.some((char) => line.includes(char)));
        const borderLine = lines[borderRow] ?? "";
        const borderCol = borderChars
          .map((char) => borderLine.indexOf(char))
          .find((column) => column >= 0) ?? -1;
        const borderSpan = spanAtFrameCell(setup.captureSpans(), borderRow, borderCol);
        expect(borderSpan?.fg === undefined ? undefined : rgbToHex(borderSpan.fg)).toBe(
          stationColorSnapshotValue(LIGHT_TERMINAL_THEME.interaction.hairline),
        );
      }
    }
  });

  function staticDashboardState(state: GoldenDashboardState): DashboardStateSource {
    return {
      getState: () => state,
      getInitialState: () => state,
      subscribe: () => () => {},
    };
  }

  it("keeps condition controls undimmed beneath the modal backdrop", async () => {
    const store = makeStore(manyProjectsSnapshot());
    for (const key of [
      { input: "/" },
      { input: "i", ctrl: true },
      { input: "S" },
    ]) {
      store.actions.handleKey(key);
    }
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <DashboardRoot
          state={store.state}
          actions={store.actions}
          columns={SIZE.width}
          rows={SIZE.height}
          onCopyNotice={() => {}}
        />
      </StationThemeProvider>,
      SIZE,
    );
    teardowns.push(() => {
      setup.renderer.destroy();
    });
    await setup.renderOnce();

    const footerRow = setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("Esc close"));
    const closeHelp = setup
      .captureSpans()
      .lines[footerRow]?.spans.find((span) => span.text.includes(" close"));

    expect(closeHelp).toBeDefined();
    expect(closeHelp === undefined ? undefined : rgbToHex(closeHelp.bg)).toBe(
      stationColorSnapshotValue(nativeStationTheme.filter.conditionSurface),
    );
  });

  it("keeps widget settings text out of OpenTUI selection", async () => {
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationMouseProvider value={() => {}}>
          <WidgetSettingsPanelView
            screen={{ name: "widgetSettings", focus: "list", cursor: 0, pickerCursor: 0 }}
            widgets={[{ type: "time" }, { type: "moon", enabled: false }]}
            widgetsPersisted
            columns={SIZE.width}
            rows={SIZE.height}
          />
        </StationMouseProvider>
      </StationThemeProvider>,
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
