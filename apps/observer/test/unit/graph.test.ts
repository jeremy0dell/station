import type {
  ClientFeatureFlags,
  HarnessCapabilities,
  HarnessRunObservation,
  ProviderHealth,
  ProviderProjectConfig,
  SessionGroupView,
  SessionRecoveryHandle,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import { StationSnapshotSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  buildStationSnapshot,
  type ObserverSessionMetadata,
  type ObserverTurnReadiness,
  type ObserverWorktreeDisplayTitle,
  projectProviderHealthOntoSnapshot,
} from "../../src/reconcile/graph";
import { projectSessionGroups } from "../../src/reconcile/sessionGroups";

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
  state: HarnessRunObservation["status"]["value"],
  reason = `Harness is ${state}.`,
): HarnessRunObservation {
  return harnessRun(id, worktreeId, state, reason);
}

function harnessRun(
  id: string,
  worktreeId: string,
  state: HarnessRunObservation["status"]["value"],
  reason = `Harness is ${state}.`,
): HarnessRunObservation {
  return {
    id,
    provider: "fake-harness",
    projectId: worktreeId.startsWith("wt_api") ? "api" : "web",
    worktreeId,
    sessionId: `ses_${worktreeId}`,
    pid: state === "exited" ? undefined : 5000,
    status: {
      value: state,
      confidence: state === "unknown" ? "low" : "high",
      reason,
      source: "harness_process",
      updatedAt: generatedAt,
    },
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
  harnessRuns?: HarnessRunObservation[];
  sessionMetadata?: ObserverSessionMetadata[];
  worktreeDisplayTitles?: ObserverWorktreeDisplayTitle[];
  turnReadiness?: ObserverTurnReadiness[];
  providerHealth?: Record<string, ProviderHealth>;
  recoveryHandles?: SessionRecoveryHandle[];
  harnessCapabilities?: Record<string, HarnessCapabilities>;
  featureFlags?: ClientFeatureFlags;
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
    sessionMetadata: overrides.sessionMetadata ?? [],
    worktreeDisplayTitles: overrides.worktreeDisplayTitles ?? [],
    turnReadiness: overrides.turnReadiness ?? [],
    recoveryHandles: overrides.recoveryHandles ?? [],
    harnessCapabilities: overrides.harnessCapabilities ?? {},
    ...(overrides.featureFlags === undefined ? {} : { featureFlags: overrides.featureFlags }),
  });
}

const resumableHarnessCapabilities: HarnessCapabilities = {
  canLaunch: true,
  canDiscoverRuns: true,
  canEmitEvents: true,
  canReceivePrompt: false,
  canResume: true,
  canStop: true,
  canRunNonInteractive: true,
  canExposeApprovalState: false,
  supportsModifiedEnterSoftNewline: false,
};

const recoveryFeatureFlags: ClientFeatureFlags = {
  revision: "recovery-enabled",
  flags: { sessionResumeAgent: true },
};

function recoveryHandle(
  worktree: WorktreeObservation,
  overrides: Partial<SessionRecoveryHandle> = {},
): SessionRecoveryHandle {
  return {
    id: "rec_graph",
    provider: "fake-harness",
    projectId: worktree.projectId,
    worktreeId: worktree.id,
    sessionId: `ses_${worktree.id}`,
    target: { kind: "native-session", id: "native_graph" },
    cwd: worktree.path,
    observedAt: generatedAt,
    lastSeenAt: generatedAt,
    ...overrides,
  };
}

function recoverySession(
  worktree: WorktreeObservation,
  overrides: Partial<ObserverSessionMetadata> = {},
): ObserverSessionMetadata {
  return {
    id: `ses_${worktree.id}`,
    projectId: worktree.projectId,
    worktreeId: worktree.id,
    lifecycle: "open",
    harness: "fake-harness",
    createdAt: generatedAt,
    lastSeenAt: generatedAt,
    ...overrides,
  };
}

describe("observer graph derivation", () => {
  it("projects the newest exact eligible open-session recovery handle", () => {
    const recoverable = worktree("wt_web_recoverable", "web", "recoverable");
    const older = recoveryHandle(recoverable, {
      id: "rec_older",
      target: { kind: "native-session", id: "native_older" },
      observedAt: "2026-05-20T10:00:00.000Z",
      lastSeenAt: "2026-05-20T11:00:00.000Z",
    });
    const selected = recoveryHandle(recoverable, {
      id: "rec_selected",
      target: { kind: "native-session", id: "native_selected" },
      observedAt: "2026-05-20T11:30:00.000Z",
      lastSeenAt: "2026-05-20T11:59:00.000Z",
    });
    const wrongSessionNewer = recoveryHandle(recoverable, {
      id: "rec_wrong_session_newer",
      sessionId: "ses_other",
      target: { kind: "native-session", id: "native_wrong_session" },
      observedAt: "2026-05-20T12:30:00.000Z",
      lastSeenAt: "2026-05-20T13:00:00.000Z",
    });
    const snapshot = build({
      worktrees: [recoverable],
      recoveryHandles: [wrongSessionNewer, older, selected],
      sessionMetadata: [recoverySession(recoverable)],
      harnessCapabilities: { "fake-harness": resumableHarnessCapabilities },
      featureFlags: recoveryFeatureFlags,
    });

    expect(snapshot.rows[0]?.recovery).toEqual({
      kind: "agent-resume",
      handleId: selected.id,
      provider: "fake-harness",
      targetKind: "native-session",
      sessionId: selected.sessionId,
      lastSeenAt: selected.lastSeenAt,
    });
  });

  it.each([
    [
      "ended lifecycle",
      (worktree: WorktreeObservation) => ({
        sessionMetadata: [recoverySession(worktree, { lifecycle: "ended", endedAt: generatedAt })],
        recoveryHandles: [recoveryHandle(worktree)],
        harnessCapabilities: { "fake-harness": resumableHarnessCapabilities },
      }),
    ],
    [
      "mismatched session identity",
      (worktree: WorktreeObservation) => ({
        sessionMetadata: [recoverySession(worktree)],
        recoveryHandles: [recoveryHandle(worktree, { sessionId: "ses_other" })],
        harnessCapabilities: { "fake-harness": resumableHarnessCapabilities },
      }),
    ],
    [
      "unsupported harness",
      (worktree: WorktreeObservation) => ({
        sessionMetadata: [recoverySession(worktree)],
        recoveryHandles: [recoveryHandle(worktree)],
        harnessCapabilities: {
          "fake-harness": { ...resumableHarnessCapabilities, canResume: false },
        },
      }),
    ],
    [
      "outside cwd",
      (worktree: WorktreeObservation) => ({
        sessionMetadata: [recoverySession(worktree)],
        recoveryHandles: [recoveryHandle(worktree, { cwd: "/tmp/station/other" })],
        harnessCapabilities: { "fake-harness": resumableHarnessCapabilities },
      }),
    ],
  ] as const)("does not project recovery for %s", (_name, scenario) => {
    const candidate = worktree("wt_web_ineligible", "web", "ineligible");
    const snapshot = build({
      worktrees: [candidate],
      ...scenario(candidate),
      featureFlags: recoveryFeatureFlags,
    });

    expect(snapshot.rows[0]).not.toHaveProperty("recovery");
  });

  it("projects an imported handle when no local lifecycle row exists", () => {
    const imported = worktree("wt_web_imported", "web", "imported");
    const handle = recoveryHandle(imported, { sessionId: "ses_imported" });
    const snapshot = build({
      worktrees: [imported],
      recoveryHandles: [handle],
      harnessCapabilities: { "fake-harness": resumableHarnessCapabilities },
      featureFlags: recoveryFeatureFlags,
    });

    expect(snapshot.rows[0]?.recovery).toMatchObject({
      handleId: handle.id,
      sessionId: "ses_imported",
    });
  });

  it("projects configured Groups in deterministic parent-first order from canonical sessions", () => {
    const web = worktree("wt_web_group", "web", "group");
    const api = worktree("wt_api_group", "api", "group");
    const snapshot = build({
      worktrees: [web, api],
      terminals: [
        terminal("term_web_group", web.id, "run_web_group"),
        terminal("term_api_group", api.id, "run_api_group"),
      ],
      harnessRuns: [
        harness("run_web_group", web.id, "idle"),
        harness("run_api_group", api.id, "idle"),
      ],
    });
    const group = (
      input: Partial<SessionGroupView> & Pick<SessionGroupView, "id" | "projectId">,
    ) => ({
      name: input.id,
      sessionIds: [],
      version: 1,
      createdAt: generatedAt,
      updatedAt: generatedAt,
      ...input,
    });

    const projected = projectSessionGroups({
      projects,
      sessions: snapshot.sessions,
      groups: [
        group({
          id: "grp_web_grandchild",
          projectId: "web",
          parentGroupId: "grp_web_child",
        }),
        group({
          id: "grp_web_child",
          projectId: "web",
          parentGroupId: "grp_web_parent",
          sessionIds: ["ses_wt_web_group", "ses_missing"],
        }),
        group({ id: "grp_removed_project", projectId: "removed" }),
        group({ id: "grp_api_empty", projectId: "api" }),
        group({ id: "grp_web_parent", projectId: "web" }),
      ],
    });

    expect(projected).toEqual([
      expect.objectContaining({ id: "grp_api_empty", sessionIds: [] }),
      expect.objectContaining({ id: "grp_web_parent", sessionIds: [] }),
      expect.objectContaining({
        id: "grp_web_child",
        parentGroupId: "grp_web_parent",
        sessionIds: ["ses_wt_web_group"],
      }),
      expect.objectContaining({
        id: "grp_web_grandchild",
        parentGroupId: "grp_web_child",
        sessionIds: [],
      }),
    ]);
    expect(projected.every((item) => !("children" in item))).toBe(true);
    expect(projected.flatMap((item) => item.sessionIds)).toEqual(["ses_wt_web_group"]);
  });

  it("projects one provider health result without rebuilding unrelated alerts", () => {
    const worktreeHealth: ProviderHealth = {
      ...worktreeProviderHealth,
      status: "unavailable",
    };
    const harnessHealth: ProviderHealth = {
      providerId: "fake-harness",
      providerType: "harness",
      status: "unavailable",
      lastCheckedAt: generatedAt,
    };
    const snapshot = build({
      projects: projects.slice(0, 1),
      providerHealth: {
        "fake-worktree": worktreeHealth,
        "fake-harness": harnessHealth,
      },
    });
    const harnessAlert = snapshot.alerts.find((alert) => alert.provider === "fake-harness");
    if (harnessAlert === undefined) {
      throw new Error("Expected a harness health alert.");
    }
    const unrelatedAlert = {
      id: "alert_unrelated",
      severity: "warn" as const,
      message: "Unrelated warning.",
      createdAt: observerStartedAt,
    };
    snapshot.alerts.push(unrelatedAlert);
    const projectedAt = "2026-05-20T12:01:00.000Z";

    const projected = projectProviderHealthOntoSnapshot({
      snapshot,
      health: { ...worktreeProviderHealth, lastCheckedAt: projectedAt },
      projectedAt,
    });

    expect(projected.generatedAt).toBe(projectedAt);
    expect(projected.providerHealth["fake-worktree"]?.status).toBe("healthy");
    expect(projected.projects[0]?.health.status).toBe("healthy");
    expect(projected.alerts).toEqual([harnessAlert, unrelatedAlert]);
    expect(projected.alerts[0]).toBe(harnessAlert);
    expect(projected.alerts[1]).toBe(unrelatedAlert);
    expect(projected.observer.healthy).toBe(false);
    expect(snapshot.providerHealth["fake-worktree"]?.status).toBe("unavailable");
  });

  it("counts one canonical session alongside ten unattached worktrees", () => {
    const attached = worktree("wt_web_session", "web", "session");
    const unattached = Array.from({ length: 10 }, (_, index) =>
      worktree(`wt_web_bare_${index}`, "web", `bare-${index}`),
    );

    const snapshot = build({
      projects: projects.slice(0, 1),
      worktrees: [attached, ...unattached],
      terminals: [terminal("term_session", attached.id, "run_session")],
      harnessRuns: [harness("run_session", attached.id, "idle")],
    });

    expect(snapshot.rows).toHaveLength(11);
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      id: "ses_wt_web_session",
      worktreeId: attached.id,
      origin: "station",
    });
    expect(snapshot.projects[0]?.counts).toMatchObject({
      sessions: 1,
      worktrees: 11,
      agents: 1,
      idle: 1,
    });
    expect(snapshot.counts).toMatchObject({
      sessions: 1,
      worktrees: 11,
      agents: 1,
      idle: 1,
    });
  });

  it("retains the newest unended Station session without a live agent", () => {
    const retainedAt = "2026-05-20T11:58:00.000Z";
    const retained = worktree("wt_web_retained", "web", "retained");
    const snapshot = build({
      projects: projects.slice(0, 1),
      worktrees: [retained],
      worktreeDisplayTitles: [
        { projectId: "web", worktreeId: retained.id, title: "retained title" },
      ],
      sessionMetadata: [
        {
          id: "ses_older",
          projectId: "web",
          worktreeId: retained.id,
          lifecycle: "open",
          harness: "fake-harness",
          createdAt: "2026-05-20T11:45:00.000Z",
          lastSeenAt: "2026-05-20T11:50:00.000Z",
        },
        {
          id: "ses_retained",
          projectId: "web",
          worktreeId: retained.id,
          lifecycle: "open",
          title: "retained title",
          harness: "fake-harness",
          createdAt: retainedAt,
          lastSeenAt: retainedAt,
        },
      ],
    });

    expect(snapshot.rows[0]?.title).toBe("retained title");
    expect(snapshot.rows[0]).not.toHaveProperty("agent");
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        id: "ses_retained",
        worktreeId: retained.id,
        origin: "station",
        title: "retained title",
        status: expect.objectContaining({ value: "none", source: "reconcile" }),
      }),
    ]);
    expect(snapshot.sessions[0]).not.toHaveProperty("terminal");
    expect(snapshot.counts.sessions).toBe(1);
    expect(snapshot.counts.agents).toBe(0);
  });

  it("does not resurrect a durably ended Station session from terminal or run evidence", () => {
    const ended = worktree("wt_web_ended", "web", "ended");
    const endedMetadata: ObserverSessionMetadata = {
      id: "ses_wt_web_ended",
      projectId: "web",
      worktreeId: ended.id,
      lifecycle: "ended",
      title: "ended",
      harness: "fake-harness",
      createdAt: "2026-05-20T11:57:00.000Z",
      endedAt: "2026-05-20T11:59:00.000Z",
      lastSeenAt: "2026-05-20T11:59:00.000Z",
    };
    const observedTerminal = terminal("term_ended", ended.id, "run_ended");

    const terminalOnly = build({
      projects: projects.slice(0, 1),
      worktrees: [ended],
      terminals: [observedTerminal],
      sessionMetadata: [endedMetadata],
    });
    const runPresent = build({
      projects: projects.slice(0, 1),
      worktrees: [ended],
      terminals: [observedTerminal],
      harnessRuns: [harness("run_ended", ended.id, "working")],
      sessionMetadata: [endedMetadata],
    });

    expect(terminalOnly.sessions).toEqual([]);
    expect(runPresent.sessions).toEqual([]);
    expect(terminalOnly.counts.sessions).toBe(0);
    expect(runPresent.counts.sessions).toBe(0);
  });

  it("retains Station membership independently from qualifying external run evidence", () => {
    const mixed = worktree("wt_web_mixed", "web", "mixed");
    const retained: ObserverSessionMetadata = {
      id: "ses_wt_web_mixed",
      projectId: "web",
      worktreeId: mixed.id,
      lifecycle: "open",
      title: "retained",
      harness: "fake-harness",
      createdAt: "2026-05-20T11:50:00.000Z",
      lastSeenAt: "2026-05-20T11:55:00.000Z",
    };
    const externalRun: HarnessRunObservation = {
      id: "codex:external:native_mixed",
      provider: "codex",
      projectId: "web",
      worktreeId: mixed.id,
      status: {
        value: "working",
        confidence: "high",
        reason: "External Codex run is active.",
        source: "harness_event",
        updatedAt: generatedAt,
      },
      observedAt: generatedAt,
    };
    const observedTerminal = terminal("term_mixed", mixed.id, externalRun.id);
    const worktreeDisplayTitles = [
      { projectId: "web", worktreeId: mixed.id, title: "Canonical mixed workspace" },
    ];

    const active = build({
      projects: projects.slice(0, 1),
      worktrees: [mixed],
      terminals: [observedTerminal],
      harnessRuns: [externalRun],
      sessionMetadata: [retained],
      worktreeDisplayTitles,
    });
    const inactive = build({
      projects: projects.slice(0, 1),
      worktrees: [mixed],
      terminals: [observedTerminal],
      harnessRuns: [
        {
          ...externalRun,
          status: { ...externalRun.status, value: "exited" },
        },
      ],
      sessionMetadata: [retained],
      worktreeDisplayTitles,
    });

    expect(active.rows[0]?.title).toBe("Canonical mixed workspace");
    expect(active.sessions.every((session) => session.title === active.rows[0]?.title)).toBe(true);
    expect(active.sessions).toEqual([
      expect.objectContaining({ id: retained.id, origin: "station" }),
      expect.objectContaining({ id: externalRun.id, origin: "external" }),
    ]);
    expect(active.sessions.every((session) => session.terminal === undefined)).toBe(true);
    expect(active.counts).toMatchObject({ sessions: 2, agents: 1, working: 1 });
    expect(inactive.sessions).toEqual([
      expect.objectContaining({ id: retained.id, origin: "station" }),
    ]);
    expect(inactive.counts).toMatchObject({ sessions: 1, agents: 0, working: 0 });
  });

  it("does not activate legacy Station membership from a terminal bound to an external run", () => {
    const legacy = worktree("wt_web_external_conflict", "web", "external-conflict");
    const externalRun: HarnessRunObservation = {
      id: "codex:external:native_conflict",
      provider: "codex",
      projectId: "web",
      worktreeId: legacy.id,
      status: {
        value: "working",
        confidence: "high",
        reason: "External Codex run is active.",
        source: "harness_event",
        updatedAt: generatedAt,
      },
      observedAt: generatedAt,
    };
    const observedTerminal = terminal("term_external_conflict", legacy.id, externalRun.id);

    const snapshot = build({
      projects: projects.slice(0, 1),
      worktrees: [legacy],
      terminals: [observedTerminal],
      harnessRuns: [externalRun],
      sessionMetadata: [
        {
          id: observedTerminal.sessionId as string,
          projectId: "web",
          worktreeId: legacy.id,
          lifecycle: "legacy",
          harness: "fake-harness",
          createdAt: "2026-05-20T11:50:00.000Z",
          lastSeenAt: "2026-05-20T11:55:00.000Z",
        },
      ],
    });

    expect(snapshot.sessions).toEqual([
      expect.objectContaining({ id: externalRun.id, origin: "external" }),
    ]);
  });

  it("uses current evidence to activate legacy identity without retaining legacy-only rows", () => {
    const legacy = worktree("wt_web_legacy", "web", "legacy");
    const metadata: ObserverSessionMetadata = {
      id: "ses_wt_web_legacy",
      projectId: "web",
      worktreeId: legacy.id,
      lifecycle: "legacy",
      harness: "fake-harness",
      createdAt: "2026-05-20T11:50:00.000Z",
      lastSeenAt: "2026-05-20T11:55:00.000Z",
    };

    const withoutEvidence = build({
      projects: projects.slice(0, 1),
      worktrees: [legacy],
      sessionMetadata: [metadata],
    });
    const withEvidence = build({
      projects: projects.slice(0, 1),
      worktrees: [legacy],
      harnessRuns: [harness("run_legacy", legacy.id, "working")],
      sessionMetadata: [metadata],
    });

    expect(withoutEvidence.sessions).toEqual([]);
    expect(withEvidence.sessions).toEqual([
      expect.objectContaining({ id: metadata.id, origin: "station" }),
    ]);
  });

  it("requires strong current evidence before activating legacy membership", () => {
    const legacy = worktree("wt_web_legacy_evidence", "web", "legacy-evidence");
    const metadata: ObserverSessionMetadata = {
      id: `ses_${legacy.id}`,
      projectId: "web",
      worktreeId: legacy.id,
      lifecycle: "legacy",
      harness: "fake-harness",
      createdAt: "2026-05-20T11:50:00.000Z",
      lastSeenAt: "2026-05-20T11:55:00.000Z",
    };

    for (const state of ["none", "exited", "unknown"] as const) {
      const snapshot = build({
        projects: projects.slice(0, 1),
        worktrees: [legacy],
        harnessRuns: [harness(`run_legacy_${state}`, legacy.id, state)],
        sessionMetadata: [metadata],
      });
      expect(snapshot.sessions, `${state} run`).toEqual([]);
    }

    for (const state of ["none", "stale", "unknown"] as const) {
      const snapshot = build({
        projects: projects.slice(0, 1),
        worktrees: [legacy],
        terminals: [terminal(`term_legacy_${state}`, legacy.id, "run_missing", state)],
        sessionMetadata: [metadata],
      });
      expect(snapshot.sessions, `${state} terminal`).toEqual([]);
    }

    const staleSessionCorrelatedTerminal = terminal(
      "term_legacy_bound_stale",
      legacy.id,
      "run_legacy_bound_idle",
      "stale",
    );
    delete staleSessionCorrelatedTerminal.harnessRunId;
    const staleBoundActiveRun = build({
      projects: projects.slice(0, 1),
      worktrees: [legacy],
      terminals: [staleSessionCorrelatedTerminal],
      harnessRuns: [harness("run_legacy_bound_idle", legacy.id, "idle")],
      sessionMetadata: [metadata],
    });
    expect(staleBoundActiveRun.sessions).toEqual([]);

    const corroboratedUnknown = build({
      projects: projects.slice(0, 1),
      worktrees: [legacy],
      terminals: [terminal("term_legacy_open", legacy.id, "run_legacy_unknown")],
      harnessRuns: [harness("run_legacy_unknown", legacy.id, "unknown")],
      sessionMetadata: [metadata],
    });
    expect(corroboratedUnknown.sessions).toEqual([
      expect.objectContaining({
        id: metadata.id,
        origin: "station",
        status: expect.objectContaining({ value: "unknown" }),
      }),
    ]);

    const explicitlyOpen = build({
      projects: projects.slice(0, 1),
      worktrees: [legacy],
      harnessRuns: [harness("run_legacy_exited", legacy.id, "exited")],
      sessionMetadata: [{ ...metadata, lifecycle: "open" }],
    });
    expect(explicitlyOpen.sessions).toEqual([
      expect.objectContaining({
        id: metadata.id,
        origin: "station",
        status: expect.objectContaining({ value: "exited" }),
      }),
    ]);
  });

  it("falls back to the newest open Station session when terminal identity is unknown or ended", () => {
    const retainedWorktree = worktree("wt_web_terminal_fallback", "web", "fallback");
    const retained: ObserverSessionMetadata = {
      id: "ses_retained_fallback",
      projectId: "web",
      worktreeId: retainedWorktree.id,
      lifecycle: "open",
      harness: "fake-harness",
      createdAt: "2026-05-20T11:55:00.000Z",
      lastSeenAt: "2026-05-20T11:58:00.000Z",
    };
    const ended: ObserverSessionMetadata = {
      id: "ses_ended_fallback",
      projectId: "web",
      worktreeId: retainedWorktree.id,
      lifecycle: "ended",
      harness: "fake-harness",
      createdAt: "2026-05-20T11:56:00.000Z",
      endedAt: "2026-05-20T11:59:00.000Z",
      lastSeenAt: "2026-05-20T11:59:00.000Z",
    };
    const unknownTerminal = terminal("term_unknown_session", retainedWorktree.id, "run_unknown");
    unknownTerminal.sessionId = "ses_unknown_fallback";
    const endedTerminal = terminal("term_ended_session", retainedWorktree.id, "run_ended");
    endedTerminal.sessionId = ended.id;

    for (const observedTerminal of [unknownTerminal, endedTerminal]) {
      const snapshot = build({
        projects: projects.slice(0, 1),
        worktrees: [retainedWorktree],
        terminals: [observedTerminal],
        sessionMetadata: [retained, ended],
      });
      expect(snapshot.sessions).toEqual([
        expect.objectContaining({ id: retained.id, origin: "station" }),
      ]);
      expect(snapshot.sessions[0]).not.toHaveProperty("terminal");
    }
  });

  it("attaches terminals only through matching session or run identity", () => {
    const attached = worktree("wt_web_terminal_identity", "web", "terminal-identity");
    const run = harness("run_terminal_identity", attached.id, "idle");
    const sessionBound = terminal("term_session_bound", attached.id, run.id);
    delete sessionBound.harnessRunId;
    const runBound = terminal("term_run_bound", attached.id, run.id);
    delete runBound.sessionId;
    const unbound = terminal("term_unbound", attached.id, run.id);
    delete unbound.sessionId;
    delete unbound.harnessRunId;

    const attachment = (observedTerminal: TerminalTargetObservation) =>
      build({
        projects: projects.slice(0, 1),
        worktrees: [attached],
        terminals: [observedTerminal],
        harnessRuns: [run],
      }).sessions[0]?.terminal;

    expect(attachment(sessionBound)).toBeDefined();
    expect(attachment(runBound)).toBeDefined();
    expect(attachment(unbound)).toBeUndefined();
  });

  it("does not attach an unbound terminal to a retained Station session", () => {
    const retainedWorktree = worktree("wt_web_unbound_terminal", "web", "unbound-terminal");
    const retained: ObserverSessionMetadata = {
      id: "ses_unbound_terminal",
      projectId: "web",
      worktreeId: retainedWorktree.id,
      lifecycle: "open",
      harness: "fake-harness",
      createdAt: "2026-05-20T11:50:00.000Z",
      lastSeenAt: "2026-05-20T11:55:00.000Z",
    };
    const unbound = terminal("term_unbound_retained", retainedWorktree.id, "run_unbound");
    delete unbound.sessionId;
    delete unbound.harnessRunId;

    const snapshot = build({
      projects: projects.slice(0, 1),
      worktrees: [retainedWorktree],
      terminals: [unbound],
      sessionMetadata: [retained],
    });

    expect(snapshot.sessions).toEqual([
      expect.objectContaining({ id: retained.id, origin: "station" }),
    ]);
    expect(snapshot.sessions[0]).not.toHaveProperty("terminal");
  });

  it("surfaces active external run evidence without fabricating terminal or Station identity", () => {
    const external = worktree("wt_web_external", "web", "external");
    const externalRun: HarnessRunObservation = {
      id: "codex:external:native_1",
      provider: "codex",
      projectId: "web",
      worktreeId: external.id,
      status: {
        value: "working",
        confidence: "high",
        reason: "External Codex run is active.",
        source: "harness_event",
        updatedAt: generatedAt,
      },
      observedAt: generatedAt,
    };

    const active = build({
      projects: projects.slice(0, 1),
      worktrees: [external],
      harnessRuns: [externalRun],
    });
    const runBoundTerminal = terminal("term_external", external.id, externalRun.id);
    delete runBoundTerminal.sessionId;
    const attached = build({
      projects: projects.slice(0, 1),
      worktrees: [external],
      terminals: [runBoundTerminal],
      harnessRuns: [externalRun],
    });
    const inactiveSnapshots = (["none", "unknown", "exited"] as const).map((state) =>
      build({
        projects: projects.slice(0, 1),
        worktrees: [external],
        harnessRuns: [
          {
            ...externalRun,
            status: { ...externalRun.status, value: state },
          },
        ],
      }),
    );

    expect(active.sessions).toEqual([
      expect.objectContaining({
        id: externalRun.id,
        worktreeId: external.id,
        origin: "external",
      }),
    ]);
    expect(active.sessions[0]).not.toHaveProperty("terminal");
    expect(attached.sessions[0]?.terminal).toBeDefined();
    expect(active.counts.sessions).toBe(1);
    expect(active.counts).toMatchObject({ agents: 1, working: 1 });
    expect(
      inactiveSnapshots.map((snapshot) => ({
        sessions: snapshot.sessions,
        sessionCount: snapshot.counts.sessions,
        agentCount: snapshot.counts.agents,
      })),
    ).toEqual([
      { sessions: [], sessionCount: 0, agentCount: 0 },
      { sessions: [], sessionCount: 0, agentCount: 0 },
      { sessions: [], sessionCount: 0, agentCount: 0 },
    ]);
  });

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

  it("keeps missing and orphaned worktree evidence out of actionable sessions", () => {
    const existing = worktree("wt_web_exists", "web", "exists");
    const missing = worktree("wt_web_missing", "web", "missing");
    missing.state = "missing";
    const orphaned = worktree("wt_web_orphaned", "web", "orphaned");
    orphaned.state = "orphaned";
    const staleTerminal = terminal("term_missing", missing.id, "run_missing");
    const staleRun = harness("run_missing", missing.id, "working");

    const snapshot = build({
      worktrees: [existing, missing, orphaned],
      terminals: [staleTerminal],
      harnessRuns: [staleRun],
    });

    expect(snapshot.rows.map((row) => row.id)).toEqual([existing.id]);
    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.counts.worktrees).toBe(1);
    expect(snapshot.orphans?.map((orphan) => orphan.kind).sort()).toEqual([
      "harness_run",
      "terminal_target",
    ]);
  });

  it("honors target-level focus and close overrides", () => {
    const target = terminal("term_idle", "wt_web_idle", "run_idle");
    target.focusable = false;
    target.closeable = false;
    target.hasManagedAttachment = true;

    const snapshot = build({
      worktrees: [worktree("wt_web_idle", "web", "idle")],
      terminals: [target],
      harnessRuns: [harness("run_idle", "wt_web_idle", "idle")],
    });

    const terminalAttachment = snapshot.rows.find((row) => row.id === "wt_web_idle")?.terminal;
    expect(terminalAttachment?.provider).toBe("fake-terminal");
    expect(terminalAttachment?.focusable).toBe(false);
    expect(terminalAttachment?.closeable).toBe(false);
    expect(terminalAttachment).not.toHaveProperty("hasManagedAttachment");
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
      agents: 1,
      working: 0,
      idle: 0,
      attention: 0,
      unknown: 0,
    });
    expect(snapshot.counts).toMatchObject({
      projects: 2,
      worktrees: 7,
      agents: 4,
      working: 1,
      idle: 1,
      attention: 1,
      unknown: 0,
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
        {
          ...harnessRun("run_orphan", "wt_missing", "working"),
          providerData: {
            rawRun: "snapshot-secret-harness",
          },
        },
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
          ...harnessRun("run_feature", "wt_web_feature", "unknown"),
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
