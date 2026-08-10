import type { ProviderId } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  sessionForWorktreeRow,
  sessionRowDisplayTitle,
} from "../../../src/selectors/dashboardSessionRows.js";
import {
  choiceValueByKey,
  isSelectionKey,
  keyChoices,
  SELECTION_KEYS,
  selectNewSessionHarnessChoices,
  selectNewSessionHarnessOptions,
  selectNewSessionProjectChoices,
  selectProjectChooserChoices,
} from "../../../src/selectors/selectors.js";
import { createInitialTuiState } from "../../../src/state/screen.js";
import { createDashboardSnapshot, createExternalAgentSnapshot } from "../../fixtures/snapshots.js";

describe("TUI selectors", () => {
  it("assigns selection keys in order without 0 or uppercase keys and caps at 35", () => {
    const choices = keyChoices(Array.from({ length: 36 }, (_, index) => index + 1));

    expect(SELECTION_KEYS).toHaveLength(35);
    expect(choices.at(8)).toEqual({ key: "9", value: 9 });
    expect(choices.at(9)).toEqual({ key: "a", value: 10 });
    expect(choices.at(-1)).toEqual({ key: "z", value: 35 });
    expect(isSelectionKey("0")).toBe(false);
    expect(isSelectionKey("A")).toBe(false);
    expect(choiceValueByKey(choices, "0")).toBeUndefined();
    expect(choiceValueByKey(choices, "a")).toBe(10);
  });

  it("resolves session labels with pending overrides", () => {
    const snapshot = createDashboardSnapshot();
    const session = snapshot.sessions.find((candidate) => candidate.id === "ses_wt_web_idle");
    const worktree = snapshot.rows.find((candidate) => candidate.id === "wt_web_idle");
    if (session === undefined || worktree === undefined) throw new Error("missing fixture session");
    const titledWorktree = { ...worktree, title: "Readable feature task" };

    expect(
      sessionRowDisplayTitle(
        { session, worktree: titledWorktree },
        createInitialTuiState().localRows,
      ),
    ).toBe("Readable feature task");
    expect(
      sessionRowDisplayTitle(
        { session, worktree: titledWorktree },
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
    const worktree = snapshot.rows.find((candidate) => candidate.id === "wt_web_no_agent");
    const sourceSession = snapshot.sessions[0];
    if (worktree === undefined || sourceSession === undefined) {
      throw new Error("missing retained no-agent fixture inputs");
    }
    const session = { ...sourceSession, id: "ses_retained_no_agent", worktreeId: worktree.id };
    expect(
      sessionRowDisplayTitle(
        { session, worktree: { ...worktree, title: "Durable no-agent workspace" } },
        {
          pendingCreate: [],
          failedCreate: [],
          pendingRemove: [],
          pendingStart: [
            {
              localId: "start-retained",
              operation: "resumeAgent",
              projectId: worktree.projectId,
              worktreeId: worktree.id,
              branch: worktree.branch,
              createdAt: "2026-05-31T12:00:00.000Z",
            },
          ],
        },
      ),
    ).toBe("Durable no-agent workspace");
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

  it("assigns project choices from snapshot order", () => {
    const choices = selectProjectChooserChoices(createDashboardSnapshot());
    expect(choices.map((choice) => [choice.key, choice.value.id])).toEqual([
      ["1", "web"],
      ["2", "api"],
    ]);
  });

  it("keys new-session project and harness choices from the same grammar", () => {
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
    if (project === undefined) throw new Error("fixture requires a project");

    const options = selectNewSessionHarnessOptions(snapshot, project);
    expect(options.find((option) => option.id === "codex")?.update).toEqual({
      installed: "0.3.0",
      latest: "0.4.0",
    });
    expect(options.find((option) => option.id === "opencode")?.update).toBeUndefined();
  });
});
