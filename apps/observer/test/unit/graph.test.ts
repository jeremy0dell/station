import type {
  HarnessRunObservation,
  ProviderHealth,
  ProviderProjectConfig,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import { StationSnapshotSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { buildStationSnapshot, type ObserverTurnReadiness } from "../../src/reconcile/graph";
import {
  type ObserverHarnessRun,
  observerHarnessRunFromRun,
} from "../../src/reconcile/harnessEventStatus";

const generatedAt = "2026-05-20T12:00:00.000Z";
const observerStartedAt = "2026-05-20T11:55:00.000Z";

const observer = {
  pid: 4242,
  startedAt: observerStartedAt,
  version: "0.0.0",
};

const worktreeProviderHealth: ProviderHealth = {
  providerId: "fake-worktree",
  providerType: "worktree",
  status: "healthy",
  lastCheckedAt: generatedAt,
  capabilities: {
    canList: true,
    canCreate: true,
    canRemove: true,
  },
};

const projects: ProviderProjectConfig[] = [
  {
    id: "web",
    label: "web",
    root: "/tmp/station/web",
    defaults: {
      harness: "fake-harness",
      terminal: "fake-terminal",
      layout: "agent-shell",
    },
    worktrunk: {
      enabled: true,
    },
  },
  {
    id: "api",
    label: "api",
    root: "/tmp/station/api",
    defaults: {
      harness: "fake-harness",
      terminal: "fake-terminal",
      layout: "agent-shell",
    },
    worktrunk: {
      enabled: true,
    },
  },
];

function worktree(
  id: string,
  projectId: string,
  branch: string,
  providerData?: unknown,
): WorktreeObservation {
  return {
    id,
    provider: "fake-worktree",
    projectId,
    branch,
    path: `/tmp/station/${projectId}/${branch.replaceAll("/", "-")}`,
    state: "exists",
    source: "worktrunk",
    dirty: false,
    confidence: "high",
    reason: "Fixture worktree.",
    observedAt: generatedAt,
    ...(providerData === undefined ? {} : { providerData }),
  };
}

function terminal(
  id: string,
  worktreeId: string,
  harnessRunId: string,
  state: TerminalTargetObservation["state"] = "open",
): TerminalTargetObservation {
  return {
    id,
    provider: "fake-terminal",
    projectId: worktreeId.startsWith("wt_api") ? "api" : "web",
    worktreeId,
    sessionId: `ses_${worktreeId}`,
    harnessRunId,
    state,
    confidence: state === "unknown" ? "low" : "high",
    reason: state === "unknown" ? "Terminal identity was uncertain." : "Fixture terminal.",
    observedAt: generatedAt,
    providerData: {
      paneId: `%${id}`,
    },
  };
}

function harness(
  id: string,
  worktreeId: string,
  state: HarnessRunObservation["state"],
  reason = `Harness is ${state}.`,
): ObserverHarnessRun {
  return observerHarnessRunFromRun(harnessRun(id, worktreeId, state, reason));
}

function harnessRun(
  id: string,
  worktreeId: string,
  state: HarnessRunObservation["state"],
  reason = `Harness is ${state}.`,
): HarnessRunObservation {
  return {
    id,
    provider: "fake-harness",
    projectId: worktreeId.startsWith("wt_api") ? "api" : "web",
    worktreeId,
    sessionId: `ses_${worktreeId}`,
    pid: state === "exited" ? undefined : 5000,
    state,
    confidence: state === "unknown" ? "low" : "high",
    reason,
    observedAt: generatedAt,
    providerData: {
      rawStatus: state,
    },
  };
}

function build(overrides: {
  projects?: ProviderProjectConfig[];
  worktrees?: WorktreeObservation[];
  terminals?: TerminalTargetObservation[];
  harnessRuns?: ObserverHarnessRun[];
  turnReadiness?: ObserverTurnReadiness[];
  providerHealth?: Record<string, ProviderHealth>;
}) {
  return buildStationSnapshot({
    generatedAt,
    observer,
    projects: overrides.projects ?? projects,
    worktreeProviderId: "fake-worktree",
    providerHealth: overrides.providerHealth ?? {
      "fake-worktree": worktreeProviderHealth,
    },
    worktrees: overrides.worktrees ?? [],
    terminalTargets: overrides.terminals ?? [],
    harnessRuns: overrides.harnessRuns ?? [],
    turnReadiness: overrides.turnReadiness ?? [],
  });
}

describe("observer graph derivation", () => {
  it("keeps configured projects visible even when a project has zero worktrees", () => {
    const snapshot = build({
      projects,
      worktrees: [worktree("wt_web_main", "web", "main")],
    });

    expect(snapshot.projects.map((project) => project.id)).toEqual(["web", "api"]);
    expect(snapshot.projects.find((project) => project.id === "api")?.counts.worktrees).toBe(0);
    expect(snapshot.counts).toMatchObject({
      projects: 2,
      worktrees: 1,
      agents: 0,
    });
    expect(StationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("honors target-level focus and close overrides", () => {
    const target = terminal("term_idle", "wt_web_idle", "run_idle");
    target.focusable = false;
    target.closeable = false;

    const snapshot = build({
      worktrees: [worktree("wt_web_idle", "web", "idle")],
      terminals: [target],
      harnessRuns: [harness("run_idle", "wt_web_idle", "idle")],
    });

    const terminalAttachment = snapshot.rows.find((row) => row.id === "wt_web_idle")?.terminal;
    expect(terminalAttachment?.provider).toBe("fake-terminal");
    expect(terminalAttachment?.focusable).toBeUndefined();
    expect(terminalAttachment?.closeable).toBeUndefined();
    expect(StationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("derives row status, project counts, and sort order for all visible states", () => {
    const rows = [
      worktree("wt_web_none", "web", "no-agent", { raw: "worktree-only" }),
      worktree("wt_web_idle", "web", "idle"),
      worktree("wt_web_working", "web", "working"),
      worktree("wt_web_attention", "web", "attention"),
      worktree("wt_api_stuck", "api", "stuck"),
      worktree("wt_api_exited", "api", "exited"),
      worktree("wt_api_unknown", "api", "unknown"),
    ];
    const runs = [
      harness("run_idle", "wt_web_idle", "idle"),
      harness("run_working", "wt_web_working", "working"),
      harness("run_attention", "wt_web_attention", "needs_attention", "Approval requested."),
      harness("run_stuck", "wt_api_stuck", "stuck", "No activity has been observed recently."),
      harness("run_exited", "wt_api_exited", "exited"),
      harness("run_unknown", "wt_api_unknown", "unknown", "Conflicting provider observations."),
    ];
    const terminals = [
      terminal("term_idle", "wt_web_idle", "run_idle"),
      terminal("term_working", "wt_web_working", "run_working"),
      terminal("term_attention", "wt_web_attention", "run_attention"),
      terminal("term_stuck", "wt_api_stuck", "run_stuck"),
      terminal("term_exited", "wt_api_exited", "run_exited", "stale"),
      terminal("term_unknown", "wt_api_unknown", "run_unknown", "unknown"),
    ];

    const snapshot = build({
      worktrees: rows,
      terminals,
      harnessRuns: runs,
    });

    expect(snapshot.rows.map((row) => row.display.statusLabel)).toEqual([
      "needs attention",
      "working",
      "idle",
      "no agent",
      "stuck",
      "unknown",
      "exited",
    ]);
    expect(
      snapshot.rows.filter((row) => row.projectId === "api").map((row) => row.display.statusLabel),
    ).toEqual(["stuck", "unknown", "exited"]);
    expect(snapshot.projects.find((project) => project.id === "web")?.counts).toMatchObject({
      worktrees: 4,
      agents: 3,
      working: 1,
      idle: 1,
      attention: 1,
      unknown: 0,
    });
    expect(snapshot.projects.find((project) => project.id === "api")?.counts).toMatchObject({
      worktrees: 3,
      agents: 3,
      working: 0,
      idle: 0,
      attention: 0,
      unknown: 1,
    });
    expect(snapshot.counts).toMatchObject({
      projects: 2,
      worktrees: 7,
      agents: 6,
      working: 1,
      idle: 1,
      attention: 1,
      unknown: 1,
    });
    expect(snapshot.rows.find((row) => row.id === "wt_api_unknown")?.display).toMatchObject({
      statusLabel: "unknown",
      sortPriority: 50,
      alert: false,
      warning: true,
      reason: "Conflicting provider observations.",
    });
    expect(snapshot.rows.find((row) => row.id === "wt_web_attention")?.display.alert).toBe(true);
    expect(JSON.stringify(snapshot.rows)).not.toContain("rawStatus");
    expect(JSON.stringify(snapshot.rows)).not.toContain("paneId");
    expect(JSON.stringify(snapshot.rows)).not.toContain("worktree-only");
    expect(StationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("attaches pending turn readiness only to the matching idle agent", () => {
    const snapshot = build({
      worktrees: [
        worktree("wt_web_idle", "web", "idle"),
        worktree("wt_web_working", "web", "working"),
      ],
      terminals: [
        terminal("term_idle", "wt_web_idle", "run_idle"),
        terminal("term_working", "wt_web_working", "run_working"),
      ],
      harnessRuns: [
        harness("run_idle", "wt_web_idle", "idle"),
        harness("run_working", "wt_web_working", "working"),
      ],
      turnReadiness: [
        {
          sessionId: "ses_wt_web_idle",
          projectId: "web",
          worktreeId: "wt_web_idle",
          token: "report_idle",
          completedAt: "2026-05-20T12:00:01.000Z",
        },
        {
          sessionId: "ses_wt_web_working",
          projectId: "web",
          worktreeId: "wt_web_working",
          token: "report_working",
          completedAt: "2026-05-20T12:00:02.000Z",
        },
      ],
    });

    expect(snapshot.rows.find((row) => row.id === "wt_web_idle")?.agent).toMatchObject({
      state: "idle",
      turnReadiness: {
        state: "ready_to_read",
        token: "report_idle",
        completedAt: "2026-05-20T12:00:01.000Z",
      },
    });
    expect(snapshot.rows.find((row) => row.id === "wt_web_working")?.agent).not.toHaveProperty(
      "turnReadiness",
    );
    expect(snapshot.counts.idle).toBe(1);
    expect(StationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("copies normalized branch metadata into worktree rows and omits unknown metadata", () => {
    const observed = worktree("wt_web_metadata", "web", "metadata");
    observed.pr = {
      number: 17,
      url: "https://github.com/example/web/pull/17",
      host: "github",
      state: "open",
      baseRef: "main",
      headRef: "metadata",
      checkedAt: generatedAt,
    };
    observed.changeSummary = {
      kind: "branch_diff",
      additions: 14,
      deletions: 2,
      filesChanged: 3,
      baseRef: "main",
      headRef: "metadata",
      source: "local_git",
      checkedAt: generatedAt,
    };
    observed.checks = {
      state: "running",
      total: 4,
      passed: 2,
      pending: 2,
      source: "github",
      checkedAt: generatedAt,
    };

    const snapshot = build({
      worktrees: [observed, worktree("wt_web_plain", "web", "plain")],
    });

    expect(snapshot.rows.find((row) => row.id === "wt_web_metadata")?.worktree).toMatchObject({
      pr: {
        number: 17,
        host: "github",
      },
      changeSummary: {
        kind: "branch_diff",
        additions: 14,
        deletions: 2,
      },
      checks: {
        state: "running",
        total: 4,
      },
    });
    const plainWorktree = snapshot.rows.find((row) => row.id === "wt_web_plain")?.worktree;
    expect(plainWorktree).not.toHaveProperty("pr");
    expect(plainWorktree).not.toHaveProperty("changeSummary");
    expect(plainWorktree).not.toHaveProperty("checks");
    expect(StationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("reports orphaned terminal targets without forcing them into worktree rows", () => {
    const snapshot = build({
      worktrees: [],
      terminals: [
        {
          id: "term_orphan",
          provider: "fake-terminal",
          state: "open",
          confidence: "low",
          reason: "No matching configured project.",
          observedAt: generatedAt,
          providerData: {
            rawTarget: "snapshot-secret-terminal",
          },
        },
      ],
      harnessRuns: [
        observerHarnessRunFromRun({
          ...harnessRun("run_orphan", "wt_missing", "working"),
          providerData: {
            rawRun: "snapshot-secret-harness",
          },
        }),
      ],
    });

    expect(snapshot.rows).toEqual([]);
    expect(snapshot.orphans).toEqual([
      expect.objectContaining({
        kind: "terminal_target",
        provider: "fake-terminal",
        terminalTargetId: "term_orphan",
        reason: "Terminal target has no matching configured project or worktree.",
      }),
      expect.objectContaining({
        kind: "harness_run",
        provider: "fake-harness",
        harnessRunId: "run_orphan",
        reason: "Harness run has no matching configured project or worktree.",
      }),
    ]);
    expect(snapshot.orphans?.[0]).not.toHaveProperty("providerData");
    expect(snapshot.orphans?.[1]).not.toHaveProperty("providerData");
    expect(JSON.stringify(snapshot)).not.toContain("snapshot-secret-terminal");
    expect(JSON.stringify(snapshot)).not.toContain("snapshot-secret-harness");
    expect(StationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("does not attach a terminal whose cwd is outside the claimed worktree", () => {
    const snapshot = build({
      worktrees: [worktree("wt_web_feature", "web", "feature")],
      terminals: [
        {
          ...terminal("term_wrong_path", "wt_web_feature", "run_feature"),
          cwd: "/tmp/station/web",
          reason: "tmux pane has station identity binding but its cwd does not match.",
        },
      ],
      harnessRuns: [harness("run_feature", "wt_web_feature", "unknown")],
    });

    expect(snapshot.rows[0]?.terminal).toBeUndefined();
    expect(snapshot.orphans).toEqual([
      expect.objectContaining({
        kind: "terminal_target",
        terminalTargetId: "term_wrong_path",
        reason: "Terminal target path does not match the configured worktree.",
        worktreeId: "wt_web_feature",
      }),
    ]);
    expect(StationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("uses harness status provenance and timestamp for rows and sessions", () => {
    const statusUpdatedAt = "2026-05-20T12:00:04.000Z";
    const snapshot = build({
      worktrees: [worktree("wt_web_feature", "web", "feature")],
      terminals: [terminal("term_feature", "wt_web_feature", "run_feature")],
      harnessRuns: [
        {
          run: harnessRun("run_feature", "wt_web_feature", "unknown"),
          status: {
            value: "working",
            confidence: "medium",
            reason: "Codex is about to use Bash.",
            source: "harness_event",
            updatedAt: statusUpdatedAt,
          },
        },
      ],
    });

    expect(snapshot.rows[0]?.agent).toMatchObject({
      state: "working",
      confidence: "medium",
      reason: "Codex is about to use Bash.",
      updatedAt: statusUpdatedAt,
    });
    expect(snapshot.sessions[0]).toMatchObject({
      updatedAt: statusUpdatedAt,
      status: {
        value: "working",
        source: "harness_event",
        updatedAt: statusUpdatedAt,
      },
    });
    expect(StationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });
});
