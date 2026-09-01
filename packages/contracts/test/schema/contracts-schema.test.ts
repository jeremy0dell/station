import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AgentPrepareExternalLaunchParamsSchema,
  AgentPrepareExternalLaunchResultSchema,
  AgentReportExternalExitParamsSchema,
  AgentReportExternalExitResultSchema,
  ClientFeatureFlagsSchema,
  CommandExecutionOutcomeSchema,
  CommandReceiptSchema,
  CommandRecordSchema,
  createClientFeatureFlagsSchema,
  createEvaluatedFeatureFlagsSchema,
  createFeatureFlagConfigSchema,
  ErrorEnvelopeSchema,
  EventFilterSchema,
  FeatureFlagConfigSchema,
  type FeatureFlagDefinitionsMap,
  HarnessCapabilitiesSchema,
  HarnessEventObservationSchema,
  HarnessEventReportReceiptSchema,
  HarnessEventReportSchema,
  HarnessEventReportSpoolRecordSchema,
  HarnessLaunchPlanSchema,
  HarnessResumeTargetSchema,
  HarnessRunObservationSchema,
  ManagedTerminalAttachmentSchema,
  ObservedStatusSchema,
  type ObserverApi,
  ObserverEventHookConfigSchema,
  ObserverEventHookInvocationSchema,
  ObserverHealthSchema,
  ObserverLifecycleFailureSchema,
  type ObserverProcessIdentity,
  ObserverProcessIdentitySchema,
  ObserverRestartCommandResultSchema,
  ObserverStartupEvidenceSchema,
  ObserverStartupFailureReportSchema,
  ObserverStopReceiptSchema,
  type ProjectId,
  ProjectIdSchema,
  ProviderHealthSchema,
  ProviderHookArtifactOwnershipSchema,
  ProviderHookEventSchema,
  ProviderHookKindSchema,
  ProviderHookReceiptSchema,
  ProviderHookSpoolRecordSchema,
  ProviderProjectConfigSchema,
  ProviderTypeSchema,
  PublicCommandRecordSchema,
  parseStationHookIdentityPayload,
  ReconcileReceiptSchema,
  RecoveryBreadcrumbSchema,
  RepositoryCapabilitiesSchema,
  RepositoryChecksRequestSchema,
  RepositoryPullRequestRequestSchema,
  RepositoryRemoteSchema,
  SafeErrorSchema,
  SessionCreateCommandResultSchema,
  SessionForkCommandResultSchema,
  SessionGroupRepairSummarySchema,
  SessionGroupViewSchema,
  SessionMigrationJournalEntrySchema,
  SessionMigrationLockSchema,
  SessionMigrationSealSchema,
  SessionRecoveryReadinessSchema,
  SessionRescueManifestSchema,
  SnapshotTerminalDebugSchema,
  STATION_SCHEMA_VERSION,
  StationBuildIdentitySchema,
  StationCommandResultSchema,
  StationCommandSchema,
  StationCommandTypeSchema,
  StationEventSchema,
  StationHookIdentityPayloadSchema,
  StationSnapshotDebugSchema,
  StationSnapshotSchema,
  stationEventCommandId,
  stationEventTimestamp,
  stationEventTraceId,
  TerminalAttachmentSchema,
  TerminalCapabilitiesSchema,
  TerminalHarnessBindingSchema,
  TerminalIdentityBindingSchema,
  TerminalTargetObservationSchema,
  WorktreeAgentSchema,
  WorktreeCapabilitiesSchema,
  WorktreeChecksStateSchema,
  type WorktreeId,
  WorktreeObservationSchema,
  WorktreeRowSchema,
} from "@station/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ZodType } from "zod";

const fixtureUrl = (path: string) =>
  new URL(`../../../../tests/contract-fixtures/${path}`, import.meta.url);

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(fixtureUrl(path), "utf8"));
}

function expectParses(schema: ZodType, value: unknown, label: string) {
  const result = schema.safeParse(value);
  expect(result.success, `${label}: ${result.success ? "" : result.error.message}`).toBe(true);
}

function expectFails(schema: ZodType, value: unknown, label: string) {
  const result = schema.safeParse(value);
  expect(result.success, `${label} unexpectedly parsed`).toBe(false);
}

describe("contract schemas", () => {
  it("accepts only the shared lowercase 64-hex Station build identity", () => {
    expectParses(StationBuildIdentitySchema, "a".repeat(64), "lowercase build identity");
    expectFails(StationBuildIdentitySchema, "A".repeat(64), "uppercase build identity");
    expectFails(StationBuildIdentitySchema, "a".repeat(63), "short build identity");
  });

  it("strictly parses provider hook artifact ownership", () => {
    const requested = {
      schemaVersion: 1,
      launcher: "/source/bin/stn-ingress",
      runtimeKind: "source",
      version: "0.0.0-pre-alpha.11",
      buildIdentity: "a".repeat(64),
    } as const;
    const current = {
      schemaVersion: 1,
      launcher: "/installed/stn-ingress",
      runtimeKind: "compiled",
      version: "0.7.1",
      buildIdentity: "b".repeat(64),
    } as const;

    expect(
      ProviderHookArtifactOwnershipSchema.parse({
        status: "different-owner",
        requested,
        currentLauncher: current.launcher,
        current,
      }),
    ).toMatchObject({ status: "different-owner", requested, current });
    expectFails(
      ProviderHookArtifactOwnershipSchema,
      { status: "same-owner", requested, currentLauncher: "relative/stn-ingress" },
      "ownership with a relative current launcher",
    );
    expectFails(
      ProviderHookArtifactOwnershipSchema,
      { status: "different-owner", requested, currentLauncher: current.launcher },
      "different ownership without current owner provenance",
    );
    expectFails(
      ProviderHookArtifactOwnershipSchema,
      { status: "absent", requested, extra: true },
      "ownership with an unknown field",
    );
    expect(
      ProviderHookArtifactOwnershipSchema.parse({ status: "unknown-owner", requested }),
    ).toEqual({ status: "unknown-owner", requested });
  });

  it("keeps provider-native execution identity on harness run observations", () => {
    expect(
      HarnessRunObservationSchema.parse({
        id: "run_codex_1",
        provider: "codex",
        sessionId: "ses_station_1",
        nativeSessionId: "native_codex_1",
        state: "working",
        confidence: "high",
        reason: "Codex is active.",
        observedAt: "2026-07-14T12:00:00.000Z",
      }),
    ).toMatchObject({ nativeSessionId: "native_codex_1" });
  });

  it("keeps id aliases distinct while preserving string wire values", () => {
    const projectId: ProjectId = "project_api";

    expect(ProjectIdSchema.parse("project_api")).toBe("project_api");
    expectTypeOf<ProjectId>().not.toEqualTypeOf<WorktreeId>();
    expectTypeOf(projectId).toEqualTypeOf<ProjectId>();
  });

  it("exports the shared schema version used by snapshot fixtures", async () => {
    expect(STATION_SCHEMA_VERSION).toBe("0.12.0");

    const snapshots = (await loadJson("snapshots/snapshot-scenarios.json")) as Record<
      string,
      { schemaVersion?: unknown }
    >;

    for (const [name, snapshot] of Object.entries(snapshots)) {
      expect(snapshot.schemaVersion, name).toBe(STATION_SCHEMA_VERSION);
    }
  });

  it("strictly validates Session Groups and snapshot graph relationships", async () => {
    const group = {
      id: "group_active",
      projectId: "web",
      name: "  Active work  ",
      sessionIds: ["ses_web_idle"],
      version: 1,
      createdAt: "2026-05-20T11:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
    };
    expect(SessionGroupViewSchema.parse(group)).toMatchObject({ name: "Active work" });

    const invalidGroups = [
      { ...group, id: "   " },
      { ...group, name: "   " },
      { ...group, sessionIds: ["ses_web_idle", "ses_web_idle"] },
      { ...group, version: 0 },
      { ...group, createdAt: "invalid" },
      {
        ...group,
        createdAt: "2026-05-20T13:00:00.000Z",
        updatedAt: "2026-05-20T12:00:00.000Z",
      },
      { ...group, parentGroupId: "   " },
      { ...group, extra: true },
    ];
    for (const [index, invalid] of invalidGroups.entries()) {
      expectFails(SessionGroupViewSchema, invalid, `invalid Group ${index}`);
    }

    const scenarios = (await loadJson("snapshots/snapshot-scenarios.json")) as Record<
      string,
      Record<string, unknown>
    >;
    const base = scenarios.idleAgent;
    if (base === undefined) throw new Error("idleAgent fixture is required.");
    const snapshot = { ...base, sessionGroups: [group] };
    expectParses(StationSnapshotSchema, snapshot, "snapshot with a membered Group");
    expectParses(
      StationSnapshotSchema,
      {
        ...base,
        sessionGroups: [
          { ...group, sessionIds: [] },
          { ...group, id: "group_child", sessionIds: [], parentGroupId: group.id },
        ],
      },
      "snapshot with empty and parented Groups",
    );

    const invalidGraphs = [
      { ...base, sessionGroups: undefined },
      { ...base, sessionGroups: [group, { ...group }] },
      { ...base, sessionGroups: [{ ...group, projectId: "missing" }] },
      { ...base, sessionGroups: [{ ...group, sessionIds: ["missing"] }] },
      {
        ...base,
        sessionGroups: [group, { ...group, id: "group_other", sessionIds: group.sessionIds }],
      },
      { ...base, sessionGroups: [{ ...group, parentGroupId: "missing" }] },
      { ...base, sessionGroups: [{ ...group, parentGroupId: group.id }] },
      {
        ...base,
        sessionGroups: [
          { ...group, id: "group_a", sessionIds: [], parentGroupId: "group_b" },
          { ...group, id: "group_b", sessionIds: [], parentGroupId: "group_a" },
        ],
      },
      { ...base, schemaVersion: "0.9.0", sessionGroups: [] },
    ];
    for (const [index, invalid] of invalidGraphs.entries()) {
      expectFails(StationSnapshotSchema, invalid, `invalid Group graph ${index}`);
    }
  });

  it("requires a strict observer process identity", () => {
    const processToken = ["a47ac10b", "58cc", "4372", "a567", "0e02b2c3d479"].join("-");
    const nonV4ProcessToken = ["a47ac10b", "58cc", "1372", "a567", "0e02b2c3d479"].join("-");
    const identity: ObserverProcessIdentity = {
      pid: 1234,
      osStartTime: "Sat Jul 11 12:34:56 2026",
      processToken,
      version: "0.1.1-dev",
      socketPath: "/tmp/station/observer.sock",
    };

    expect(ObserverProcessIdentitySchema.parse(identity)).toEqual(identity);

    for (const field of ["pid", "osStartTime", "processToken", "version", "socketPath"] as const) {
      const incompleteIdentity: Partial<ObserverProcessIdentity> = { ...identity };
      delete incompleteIdentity[field];
      expectFails(
        ObserverProcessIdentitySchema,
        incompleteIdentity,
        `observer process identity without ${field}`,
      );
    }

    expectFails(
      ObserverProcessIdentitySchema,
      { ...identity, stateDir: "/tmp/station/state" },
      "observer process identity with unknown field",
    );
    expectFails(
      ObserverProcessIdentitySchema,
      { ...identity, processToken: nonV4ProcessToken },
      "observer process identity with a non-v4 token",
    );
  });

  it("owns the observer application port and external-launch contracts", () => {
    expectTypeOf<ObserverApi>().toHaveProperty("prepareExternalLaunch");
    expectTypeOf<ObserverApi>().toHaveProperty("reportExternalExit");

    expect(
      AgentPrepareExternalLaunchParamsSchema.parse({
        projectId: "project_api",
        worktreeId: "wt_api",
        harness: "codex",
        title: "  Hexagonal PT 12!  ",
        group: { kind: "create", name: "  Active work  " },
        freshStart: { expectedSessionId: "ses_interrupted" },
      }),
    ).toEqual({
      projectId: "project_api",
      worktreeId: "wt_api",
      harness: "codex",
      title: "Hexagonal PT 12!",
      group: { kind: "create", name: "Active work" },
      freshStart: { expectedSessionId: "ses_interrupted" },
    });
    expectFails(
      AgentPrepareExternalLaunchParamsSchema,
      { projectId: "project_api", worktreeId: "wt_api", title: "   " },
      "external launch params with blank title",
    );
    expectFails(
      AgentPrepareExternalLaunchParamsSchema,
      {
        projectId: "project_api",
        worktreeId: "wt_api",
        freshStart: { expectedSessionId: "" },
      },
      "external fresh-start params with a blank expected session id",
    );
    expectFails(
      AgentPrepareExternalLaunchParamsSchema,
      {
        projectId: "project_api",
        worktreeId: "wt_api",
        freshStart: { expectedSessionId: "ses_interrupted", force: true },
      },
      "external fresh-start params with an unknown nested field",
    );
    expectParses(
      AgentPrepareExternalLaunchParamsSchema,
      {
        projectId: "project_api",
        worktreeId: "wt_api",
        group: { kind: "existing", groupId: "grp_active" },
      },
      "external launch params without optional title",
    );
    expectParses(
      AgentPrepareExternalLaunchParamsSchema,
      {
        projectId: "project_api",
        worktreeId: "wt_api_fork",
        group: {
          kind: "source",
          sourceSessionId: "ses_api_source",
          groupId: "grp_active",
        },
      },
      "external fork launch params with source Group inheritance",
    );
    expectFails(
      AgentPrepareExternalLaunchParamsSchema,
      {
        projectId: "project_api",
        worktreeId: "wt_api_fork",
        group: { kind: "source", sourceSessionId: "ses_api_source", name: "Active" },
      },
      "external source Group inheritance without a stable Group id",
    );
    expectFails(
      AgentPrepareExternalLaunchParamsSchema,
      {
        projectId: "project_api",
        worktreeId: "wt_api",
        transport: "ndjson",
      },
      "external launch params with transport detail",
    );

    const attachment = {
      kind: "managed-terminal",
      terminalTargetId: "native:wt_api",
    } as const;
    expectParses(ManagedTerminalAttachmentSchema, attachment, "managed terminal attachment");
    expectFails(
      ManagedTerminalAttachmentSchema,
      {
        ...attachment,
        ptyId: "pty_api",
        hostSocketPath: "/tmp/station-host.sock",
      },
      "managed terminal attachment with host fields",
    );
    expectParses(
      AgentPrepareExternalLaunchResultSchema,
      {
        kind: "prepared",
        sessionId: "ses_api",
        terminalTargetId: "native:wt_api",
        terminalBindingToken: "binding_1",
        launchPlan: {
          provider: "codex",
          command: "codex",
          args: ["--resume"],
          cwd: "/tmp/worktree",
          env: { STATION_SESSION_ID: "ses_api" },
          mode: "interactive",
        },
        attachment,
      },
      "prepared external launch result",
    );
    expectParses(
      AgentPrepareExternalLaunchResultSchema,
      {
        kind: "prepared",
        sessionId: "ses_api",
        terminalTargetId: "native:wt_api",
        launchPlan: {
          provider: "codex",
          command: "codex",
          args: ["--resume"],
          mode: "interactive",
        },
        outputCompatibility: "top-region-scrollback",
      },
      "prepared external launch result with local output compatibility",
    );
    expectFails(
      AgentPrepareExternalLaunchResultSchema,
      {
        kind: "prepared",
        sessionId: "ses_api",
        terminalTargetId: "native:wt_api",
        launchPlan: {
          provider: "codex",
          command: "codex",
          args: [],
          mode: "interactive",
        },
        outputCompatibility: "provider-specific-workaround",
      },
      "prepared external launch result with unknown output compatibility",
    );
    expectFails(
      AgentPrepareExternalLaunchResultSchema,
      {
        kind: "prepared",
        sessionId: "ses_api",
        terminalTargetId: "native:wt_api",
        launchPlan: {
          provider: "codex",
          command: "codex",
          args: [],
          mode: "interactive",
        },
        attachment,
        outputCompatibility: "top-region-scrollback",
      },
      "prepared external launch result with attachment and local output compatibility",
    );
    expectFails(
      AgentPrepareExternalLaunchResultSchema,
      {
        kind: "prepared",
        sessionId: "ses_api",
        terminalTargetId: "native:wt_api",
        launchPlan: {
          provider: "codex",
          command: "codex",
          args: ["--resume"],
          cwd: "/tmp/worktree",
          env: { STATION_SESSION_ID: "ses_api" },
          mode: "interactive",
        },
        reattachHandle: {
          ptyId: "pty_api",
          terminalTargetId: "native:wt_api",
          hostSocketPath: "/tmp/station-host.sock",
        },
      },
      "prepared external launch result with legacy reattach handle",
    );
    expectParses(
      AgentPrepareExternalLaunchResultSchema,
      {
        kind: "existing-session",
        sessionId: "ses_api",
        harnessProvider: "codex",
      },
      "existing external launch result without reattachment",
    );

    expectParses(
      AgentReportExternalExitParamsSchema,
      {
        terminalTargetId: "native:wt_api",
        expectedSessionId: "ses_api",
        expectedBindingToken: "binding_1",
      },
      "session-qualified external exit params",
    );
    expectParses(
      AgentReportExternalExitParamsSchema,
      { terminalTargetId: "native:wt_api" },
      "legacy external exit params without release authority",
    );
    expectParses(
      AgentReportExternalExitResultSchema,
      { acknowledged: true, terminalTargetId: "native:wt_api" },
      "external exit result",
    );
  });

  it("parses valid snapshot scenarios and rejects invalid snapshots", async () => {
    const snapshots = (await loadJson("snapshots/snapshot-scenarios.json")) as Record<
      string,
      unknown
    >;

    expect(Object.keys(snapshots).sort()).toEqual([
      "exitedAgent",
      "idleAgent",
      "multipleProjects",
      "needsAttentionAgent",
      "noAgentWorktree",
      "noProjects",
      "orphanedTerminalTarget",
      "providerFailure",
      "stuckAgent",
      "unknownLowConfidence",
      "workingAgent",
      "zeroWorktreeProject",
    ]);

    for (const [name, snapshot] of Object.entries(snapshots)) {
      expectParses(StationSnapshotSchema, snapshot, `snapshot fixture ${name}`);
    }

    expectParses(
      StationSnapshotSchema,
      {
        ...(snapshots.multipleProjects as Record<string, unknown>),
        harnesses: [
          { id: "codex", label: "codex" },
          { id: "opencode", label: "opencode" },
        ],
      },
      "snapshot with configured harness options",
    );

    const providerNeutralTerminalSnapshot = structuredClone(snapshots.idleAgent) as {
      rows: Array<{ terminal?: unknown }>;
      sessions: Array<{ terminal?: unknown }>;
    };
    const terminal = {
      provider: "tmux",
      state: "open",
      focusable: true,
      closeable: true,
      hasWorkspace: true,
      hasPrimaryAgentEndpoint: true,
      confidence: "high",
      reason: "Terminal is attached to the worktree.",
      observedAt: "2026-05-20T12:00:00.000Z",
    };
    if (providerNeutralTerminalSnapshot.rows[0] === undefined) {
      throw new Error("idleAgent fixture must include a row.");
    }
    if (providerNeutralTerminalSnapshot.sessions[0] === undefined) {
      throw new Error("idleAgent fixture must include a session.");
    }
    providerNeutralTerminalSnapshot.rows[0].terminal = terminal;
    providerNeutralTerminalSnapshot.sessions[0].terminal = terminal;
    expectParses(
      StationSnapshotSchema,
      providerNeutralTerminalSnapshot,
      "snapshot with provider-neutral terminal attachment",
    );

    const externalSessionSnapshot = structuredClone(snapshots.idleAgent) as {
      sessions: Array<{ id: string; origin?: string; terminal?: unknown }>;
    };
    const externalSession = externalSessionSnapshot.sessions[0];
    if (externalSession === undefined) {
      throw new Error("idleAgent fixture must include a session.");
    }
    externalSession.id = "codex:external:native_1";
    externalSession.origin = "external";
    delete externalSession.terminal;
    expectParses(
      StationSnapshotSchema,
      externalSessionSnapshot,
      "external session without fabricated terminal attachment",
    );

    const missingOriginSnapshot = structuredClone(snapshots.idleAgent) as {
      sessions: Array<{ origin?: string }>;
    };
    const missingOriginSession = missingOriginSnapshot.sessions[0];
    if (missingOriginSession === undefined) {
      throw new Error("idleAgent fixture must include a session.");
    }
    delete missingOriginSession.origin;
    expectFails(StationSnapshotSchema, missingOriginSnapshot, "session without explicit origin");

    expectFails(
      StationSnapshotSchema,
      await loadJson("snapshots/invalid-snapshot.json"),
      "invalid snapshot fixture",
    );
    expectFails(
      StationSnapshotSchema,
      {
        ...(snapshots.orphanedTerminalTarget as Record<string, unknown>),
        orphans: [
          {
            id: "orphan_term_secret",
            kind: "terminal_target",
            provider: "tmux",
            terminalTargetId: "term_orphan_agent",
            reason: "Terminal target has no matching configured project or worktree.",
            observedAt: "2026-05-20T12:00:00.000Z",
            providerData: {
              secret: "do-not-expose",
            },
          },
        ],
      },
      "orphan provider data boundary",
    );
  });

  it("uses provider-neutral terminal attachments in snapshots", async () => {
    const attachment = {
      provider: "tmux",
      state: "open",
      focusable: true,
      closeable: true,
      hasWorkspace: true,
      hasPrimaryAgentEndpoint: true,
      confidence: "high",
      reason: "Terminal is attached to the worktree.",
      observedAt: "2026-05-20T12:00:00.000Z",
    };
    expectParses(TerminalAttachmentSchema, attachment, "terminal attachment");

    const removedFields: Record<string, unknown> = {
      workspaceTargetId: "term_workspace",
      primaryAgentTargetId: "term_agent",
      sessionName: "station",
      sessionId: "ses_topology",
      windowId: "@1",
      agentEndpointId: "%2",
      attached: true,
      lastOutputAt: "2026-05-20T12:00:00.000Z",
    };
    for (const [field, value] of Object.entries(removedFields)) {
      expectFails(
        TerminalAttachmentSchema,
        { ...attachment, [field]: value },
        `terminal attachment with ${field}`,
      );
    }

    const snapshots = (await loadJson("snapshots/snapshot-scenarios.json")) as Record<
      string,
      unknown
    >;
    const snapshot = structuredClone(snapshots.idleAgent) as {
      rows: Array<{ terminal?: Record<string, unknown> }>;
    };
    const row = snapshot.rows[0];
    if (row === undefined || row.terminal === undefined) {
      throw new Error("idleAgent fixture must include a terminal row.");
    }
    row.terminal.primaryAgentTargetId = "term_agent";
    expectFails(StationSnapshotSchema, snapshot, "snapshot row terminal with target id");
  });

  it("preserves exact optional managed terminal attachment evidence", () => {
    const observation = {
      id: "native:wt_terminal_evidence",
      provider: "native",
      projectId: "web",
      worktreeId: "wt_terminal_evidence",
      sessionId: "ses_terminal_evidence",
      state: "open",
      focusable: false,
      closeable: true,
      confidence: "high",
      reason: "Station listed the managed terminal target.",
      observedAt: "2026-05-20T12:00:00.000Z",
    };
    const attachment = {
      provider: "native",
      state: "open",
      focusable: false,
      closeable: true,
    };

    expect(TerminalTargetObservationSchema.parse(observation)).not.toHaveProperty(
      "hasManagedAttachment",
    );
    expect(
      TerminalTargetObservationSchema.parse({
        ...observation,
        hasManagedAttachment: false,
      }),
    ).toMatchObject({ hasManagedAttachment: false });
    expect(
      TerminalTargetObservationSchema.parse({
        ...observation,
        hasManagedAttachment: true,
      }),
    ).toMatchObject({ hasManagedAttachment: true });
    expectFails(
      TerminalTargetObservationSchema,
      { ...observation, hasManagedAttachment: "unknown" },
      "terminal target with non-boolean managed attachment evidence",
    );

    expect(TerminalAttachmentSchema.parse(attachment)).not.toHaveProperty("hasManagedAttachment");
    expectFails(
      TerminalAttachmentSchema,
      { ...attachment, hasManagedAttachment: false },
      "canonical terminal attachment with provider-only managed attachment evidence",
    );
  });

  it("validates coherent opt-in terminal debug evidence", async () => {
    const target = {
      id: "native:wt_web_idle",
      provider: "native",
      projectId: "web",
      worktreeId: "wt_web_idle",
      sessionId: "ses_web_idle",
      state: "open",
      focusable: false,
      closeable: true,
      hasManagedAttachment: true,
      confidence: "high",
      reason: "Station listed the Host-backed target.",
      observedAt: "2026-05-20T12:00:00.000Z",
    };
    const terminalDebug = {
      reconciledAt: "2026-05-20T12:00:01.000Z",
      providerReads: [
        { provider: "native", status: "complete" },
        {
          provider: "tmux",
          status: "indeterminate",
          failureCode: "TERMINAL_LIST_FAILED",
        },
      ],
      targets: [target],
    };
    const snapshotDebug = { terminal: terminalDebug };

    expectParses(SnapshotTerminalDebugSchema, terminalDebug, "terminal debug evidence");
    expectParses(StationSnapshotDebugSchema, snapshotDebug, "snapshot debug evidence");

    const snapshots = (await loadJson("snapshots/snapshot-scenarios.json")) as Record<
      string,
      Record<string, unknown>
    >;
    const base = snapshots.idleAgent;
    if (base === undefined) throw new Error("idleAgent fixture is required.");
    expectParses(
      StationSnapshotSchema,
      { ...base, debug: snapshotDebug },
      "snapshot with terminal debug evidence",
    );

    const invalidTerminalDebug: Array<{ label: string; value: unknown }> = [
      {
        label: "duplicate provider reads",
        value: {
          ...terminalDebug,
          providerReads: [
            { provider: "native", status: "complete" },
            { provider: "native", status: "complete" },
          ],
        },
      },
      {
        label: "target without a provider read",
        value: { ...terminalDebug, providerReads: [] },
      },
      {
        label: "target from an indeterminate provider read",
        value: {
          ...terminalDebug,
          providerReads: [
            {
              provider: "native",
              status: "indeterminate",
              failureCode: "TERMINAL_LIST_FAILED",
            },
          ],
        },
      },
      {
        label: "complete provider read with a failure code",
        value: {
          ...terminalDebug,
          providerReads: [
            { provider: "native", status: "complete", failureCode: "TERMINAL_LIST_FAILED" },
          ],
        },
      },
      {
        label: "indeterminate provider read without a failure code",
        value: {
          ...terminalDebug,
          providerReads: [{ provider: "native", status: "indeterminate" }],
          targets: [],
        },
      },
      {
        label: "target with provider-private data",
        value: {
          ...terminalDebug,
          targets: [{ ...target, providerData: { ptyId: "private" } }],
        },
      },
      {
        label: "terminal debug with an unknown field",
        value: { ...terminalDebug, current: true },
      },
    ];
    for (const invalid of invalidTerminalDebug) {
      expectFails(SnapshotTerminalDebugSchema, invalid.value, invalid.label);
    }

    expectFails(
      StationSnapshotDebugSchema,
      { terminal: terminalDebug, terminalTargets: [target] },
      "snapshot debug with a legacy flat target list",
    );
  });

  it("accepts production feature flags, rejects unknown flags, and excludes TUI flags from clients", () => {
    expect(FeatureFlagConfigSchema.parse({})).toEqual({});
    expect(
      FeatureFlagConfigSchema.parse({
        sessionResumeAgent: true,
      }),
    ).toEqual({
      sessionResumeAgent: true,
    });
    expect(FeatureFlagConfigSchema.safeParse({ "test.fake": true }).success).toBe(false);
    expect(
      ClientFeatureFlagsSchema.safeParse({
        revision: "test",
        flags: {
          stationPersistentAgents: true,
          sessionResumeAgent: true,
        },
      }).success,
    ).toBe(false);

    expect(
      StationSnapshotSchema.parse({
        schemaVersion: STATION_SCHEMA_VERSION,
        generatedAt: "2026-05-20T12:00:00.000Z",
        observer: {
          pid: 1234,
          startedAt: "2026-05-20T11:59:00.000Z",
          version: "0.0.0",
          healthy: true,
        },
        providerHealth: {},
        projects: [],
        rows: [],
        sessions: [],
        sessionGroups: [],
        counts: {
          projects: 0,
          sessions: 0,
          worktrees: 0,
          agents: 0,
          working: 0,
          idle: 0,
          attention: 0,
          unknown: 0,
        },
        alerts: [],
        featureFlags: {
          revision: "test",
          flags: {
            sessionResumeAgent: true,
          },
        },
      }),
    ).toMatchObject({
      featureFlags: {
        revision: "test",
        flags: {
          sessionResumeAgent: true,
        },
      },
    });
  });

  it("accepts exact resume targets and rejects latest/picker targets", () => {
    expect(
      HarnessResumeTargetSchema.parse({
        kind: "native-session",
        id: "codex_session_123",
      }),
    ).toEqual({
      kind: "native-session",
      id: "codex_session_123",
    });
    expect(
      HarnessResumeTargetSchema.parse({
        kind: "session-file",
        path: "/tmp/pi-session.json",
      }),
    ).toEqual({
      kind: "session-file",
      path: "/tmp/pi-session.json",
    });
    expect(
      HarnessResumeTargetSchema.safeParse({
        kind: "last-for-worktree",
      }).success,
    ).toBe(false);
  });

  it("supports test-local feature flag registries without adding fake production flags", () => {
    const definitions = {
      "test.clientFlag": {
        defaultValue: false,
        exposure: "client",
        owner: "tui",
        surfaces: ["tui"],
        lifecycle: "temporary",
        summary: "Test-only client flag.",
      },
      "test.serverFlag": {
        defaultValue: true,
        exposure: "server",
        owner: "observer",
        surfaces: ["observer"],
        lifecycle: "temporary",
        summary: "Test-only server flag.",
      },
    } as const satisfies FeatureFlagDefinitionsMap;

    expect(
      createFeatureFlagConfigSchema(definitions).parse({
        "test.clientFlag": true,
      }),
    ).toEqual({
      "test.clientFlag": true,
    });
    expect(
      createFeatureFlagConfigSchema(definitions).safeParse({
        "test.unknown": true,
      }).success,
    ).toBe(false);
    expect(
      createEvaluatedFeatureFlagsSchema(definitions).parse({
        revision: "test",
        flags: {
          "test.clientFlag": true,
          "test.serverFlag": false,
        },
      }),
    ).toMatchObject({
      flags: {
        "test.clientFlag": true,
        "test.serverFlag": false,
      },
    });
    expect(
      createEvaluatedFeatureFlagsSchema(definitions).safeParse({
        revision: "test",
        flags: {
          "test.clientFlag": true,
        },
      }).success,
    ).toBe(false);
    expect(
      createClientFeatureFlagsSchema(definitions).safeParse({
        revision: "test",
        flags: {
          "test.serverFlag": false,
        },
      }).success,
    ).toBe(false);
    expect(
      createClientFeatureFlagsSchema(definitions).safeParse({
        revision: "test",
        flags: {},
      }).success,
    ).toBe(false);
  });

  it("parses normalized branch metadata and rejects raw provider metadata shapes", () => {
    const checkedAt = "2026-05-20T12:00:00.000Z";
    const normalizedObservation = {
      id: "wt_web_feature_auth",
      provider: "worktrunk",
      projectId: "web",
      branch: "feature/auth",
      path: "/tmp/station-fixtures/web/worktrees/feature-auth",
      state: "exists",
      source: "worktrunk",
      dirty: false,
      pr: {
        number: 42,
        url: "https://github.com/example/web/pull/42",
        host: "github",
        state: "open",
        baseRef: "main",
        headRef: "feature/auth",
        updatedAt: checkedAt,
        checkedAt,
        stale: false,
      },
      changeSummary: {
        kind: "branch_diff",
        additions: 12,
        deletions: 3,
        filesChanged: 4,
        binaryFiles: 1,
        baseRef: "main",
        baseSha: "1234567890abcdef1234567890abcdef12345678",
        mergeBaseSha: "1111111111111111111111111111111111111111",
        headRef: "feature/auth",
        headSha: "abcdef1234567890abcdef1234567890abcdef12",
        source: "local_git",
        checkedAt,
      },
      checks: {
        state: "pass",
        url: "https://github.com/example/web/actions/runs/1",
        total: 5,
        passed: 5,
        failed: 0,
        pending: 0,
        source: "github",
        checkedAt,
      },
      confidence: "high",
      reason: "Provider listed the worktree.",
      observedAt: checkedAt,
    };

    expectParses(WorktreeObservationSchema, normalizedObservation, "metadata observation");

    const parsedWithoutMetadata = WorktreeObservationSchema.parse({
      id: "wt_web_no_metadata",
      provider: "worktrunk",
      projectId: "web",
      branch: "no-metadata",
      path: "/tmp/station-fixtures/web/worktrees/no-metadata",
      state: "exists",
      source: "worktrunk",
      observedAt: checkedAt,
    });
    expect(parsedWithoutMetadata).not.toHaveProperty("pr");
    expect(parsedWithoutMetadata).not.toHaveProperty("changeSummary");
    expect(parsedWithoutMetadata).not.toHaveProperty("checks");

    const row = {
      id: "wt_web_feature_auth",
      projectId: "web",
      projectLabel: "web",
      title: "Readable feature task",
      branch: "feature/auth",
      path: "/tmp/station-fixtures/web/worktrees/feature-auth",
      worktree: {
        state: "exists",
        source: "worktrunk",
        dirty: false,
        pr: normalizedObservation.pr,
        changeSummary: normalizedObservation.changeSummary,
        checks: normalizedObservation.checks,
      },
      display: {
        statusLabel: "no agent",
        sortPriority: 70,
        alert: false,
      },
    };
    const snapshot = {
      schemaVersion: STATION_SCHEMA_VERSION,
      generatedAt: checkedAt,
      observer: {
        pid: 4242,
        startedAt: "2026-05-20T11:55:00.000Z",
        version: "0.0.0",
        healthy: true,
      },
      providerHealth: {},
      projects: [],
      rows: [row],
      sessions: [],
      sessionGroups: [],
      counts: {
        projects: 0,
        sessions: 0,
        worktrees: 1,
        agents: 0,
        working: 0,
        idle: 0,
        attention: 0,
        unknown: 0,
      },
      alerts: [],
    };

    expectParses(StationSnapshotSchema, snapshot, "snapshot with normalized branch metadata");
    expectFails(
      WorktreeRowSchema,
      { ...row, title: undefined },
      "worktree row without canonical title",
    );
    expectFails(
      StationSnapshotSchema,
      {
        ...snapshot,
        rows: [
          {
            ...row,
            worktree: {
              ...row.worktree,
              pr: {
                number: 42,
                html_url: "https://github.com/example/web/pull/42",
                state: "open",
              },
            },
          },
        ],
      },
      "snapshot with raw GitHub PR payload",
    );
    expectFails(
      StationSnapshotSchema,
      {
        ...snapshot,
        rows: [
          {
            ...row,
            worktree: {
              ...row.worktree,
              checks: {
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/example/web/actions/runs/1",
              },
            },
          },
        ],
      },
      "snapshot with raw CI checks payload",
    );
    expectFails(
      StationSnapshotSchema,
      {
        ...snapshot,
        rows: [
          {
            ...row,
            worktree: {
              ...row.worktree,
              changeSummary: {
                ...normalizedObservation.changeSummary,
                binaryFiles: -1,
              },
            },
          },
        ],
      },
      "snapshot with invalid binary file count",
    );
    expectFails(
      StationSnapshotSchema,
      {
        ...snapshot,
        rows: [
          {
            ...row,
            worktree: {
              ...row.worktree,
              changeSummary: {
                ...normalizedObservation.changeSummary,
                headSha: "",
              },
            },
          },
        ],
      },
      "snapshot with invalid head sha",
    );
    expectFails(
      StationSnapshotSchema,
      {
        ...snapshot,
        rows: [
          {
            ...row,
            worktree: {
              ...row.worktree,
              changeSummary: {
                ...normalizedObservation.changeSummary,
                mergeBaseSha: "not-a-sha",
              },
            },
          },
        ],
      },
      "snapshot with invalid merge-base sha",
    );
  });

  it("parses provider-neutral repository contracts", () => {
    expect(ProviderTypeSchema.parse("repository")).toBe("repository");
    expectFails(ProviderTypeSchema, "code_host", "legacy code host provider type");

    expectParses(
      RepositoryCapabilitiesSchema,
      {
        canDiscoverPullRequests: true,
        canReadChecks: true,
        canUseCliAuth: true,
      },
      "repository capabilities",
    );
    expectParses(
      RepositoryRemoteSchema,
      {
        host: "github.com",
        owner: "example",
        repo: "web",
        url: "git@github.com:example/web.git",
      },
      "repository remote",
    );
    expectParses(
      RepositoryPullRequestRequestSchema,
      {
        remote: {
          host: "github.com",
          owner: "example",
          repo: "web",
        },
        branch: "feature/auth",
        headSha: "abcdef1234567890abcdef1234567890abcdef12",
        projectId: "web",
        worktreeId: "wt_web_feature_auth",
      },
      "repository PR request",
    );
    expectParses(
      RepositoryChecksRequestSchema,
      {
        remote: {
          host: "github.com",
          owner: "example",
          repo: "web",
        },
        pullRequestNumber: 42,
        branch: "feature/auth",
      },
      "repository checks request",
    );
    expect(WorktreeChecksStateSchema.parse("skipped")).toBe("skipped");
    expect(WorktreeChecksStateSchema.parse("cancelled")).toBe("cancelled");
  });

  it("parses one command fixture for each command union member", async () => {
    const commands = (await loadJson("commands/commands.json")) as Record<string, unknown>;

    for (const [name, command] of Object.entries(commands)) {
      expectParses(StationCommandSchema, command, `command fixture ${name}`);
    }

    const commandTypes = Object.values(commands)
      .map((command) => (command as { type: string }).type)
      .sort();

    expect(commandTypes).toEqual([...StationCommandTypeSchema.options].sort());

    expectFails(
      StationCommandSchema,
      {
        type: "session.sendPrompt",
        payload: {
          sessionId: "ses_api_cache",
          prompt: "Summarize current status.",
          delivery: "harness-native",
        },
      },
      "retired session.sendPrompt command",
    );
    expectFails(
      StationCommandSchema,
      {
        type: "hooks.install",
        payload: { provider: "worktrunk" },
      },
      "retired hooks.install command",
    );

    expectFails(
      StationCommandSchema,
      await loadJson("commands/invalid-command.json"),
      "invalid command fixture",
    );

    expectParses(
      StationCommandSchema,
      {
        type: "session.importRecoveryHandle",
        payload: {
          projectId: "web",
          worktreeId: "wt_web_feature",
          expectedPath: "/tmp/station/web/feature",
          title: "  Recovered workspace  ",
          handle: {
            id: "rec_web_feature",
            provider: "codex",
            projectId: "web",
            worktreeId: "wt_web_feature",
            sessionId: "ses_web_feature",
            target: { kind: "native-session", id: "thread-web-feature" },
            cwd: "/tmp/station/web/feature",
            observedAt: "2026-07-29T12:00:00.000Z",
            lastSeenAt: "2026-07-29T12:00:00.000Z",
          },
        },
      },
      "recovery import with canonical title",
    );
    expectFails(
      StationCommandSchema,
      {
        type: "session.importRecoveryHandle",
        payload: {
          projectId: "web",
          worktreeId: "wt_web_feature",
          expectedPath: "/tmp/station/web/feature",
          title: "   ",
          handle: {
            id: "rec_web_feature",
            provider: "codex",
            projectId: "web",
            worktreeId: "wt_web_feature",
            sessionId: "ses_web_feature",
            target: { kind: "native-session", id: "thread-web-feature" },
            cwd: "/tmp/station/web/feature",
            observedAt: "2026-07-29T12:00:00.000Z",
            lastSeenAt: "2026-07-29T12:00:00.000Z",
          },
        },
      },
      "recovery import with blank canonical title",
    );

    expectParses(
      StationCommandSchema,
      {
        type: "worktree.create",
        payload: { projectId: "web", branch: "feature/agent", launchHarness: "codex" },
      },
      "managed worktree create with launch harness",
    );
    expectParses(
      StationCommandSchema,
      {
        type: "worktree.fork",
        payload: {
          projectId: "web",
          sourceWorktreeId: "wt_web_main",
          branch: "feature/fork",
          group: {
            kind: "source",
            sourceSessionId: "ses_web_main",
            groupId: "grp_active",
          },
        },
      },
      "worktree-only fork without launch harness",
    );
    expectFails(
      StationCommandSchema,
      {
        type: "worktree.create",
        payload: { projectId: "web", branch: "feature/agent", launchHarness: "" },
      },
      "managed worktree create with invalid launch harness",
    );
    expectFails(
      StationCommandSchema,
      {
        type: "worktree.fork",
        payload: {
          projectId: "web",
          sourceWorktreeId: "wt_web_main",
          branch: "feature/fork",
          launchHarness: "codex",
          group: {
            kind: "source",
            sourceSessionId: "ses_web_main",
            groupId: "grp_active",
          },
          readiness: true,
        },
      },
      "managed worktree fork with an unknown field",
    );

    expectFails(
      StationCommandSchema,
      {
        type: "worktree.remove",
        payload: { projectId: "web", worktreeId: "wt_web_feature" },
      },
      "worktree removal without selected path, branch, and registration identity",
    );

    expectParses(
      StationCommandSchema,
      {
        type: "terminal.focus",
        payload: {
          sessionId: "ses_web_feature",
          origin: {
            provider: "tmux",
            clientId: "client_1",
          },
        },
      },
      "terminal focus command with popup focus origin",
    );

    expectParses(
      StationCommandSchema,
      {
        type: "session.startAgent",
        payload: {
          projectId: "web",
          worktreeId: "wt_web_feature",
          terminal: {
            focus: true,
            origin: {
              provider: "tmux",
              clientId: "client_1",
            },
          },
        },
      },
      "start agent command with remembered harness and popup focus origin",
    );
    expectParses(
      StationCommandSchema,
      {
        type: "session.startAgent",
        payload: {
          projectId: "web",
          worktreeId: "wt_web_feature",
          freshStart: { expectedSessionId: "ses_web_feature" },
        },
      },
      "identity-bound fresh start command",
    );
    expectFails(
      StationCommandSchema,
      {
        type: "session.startAgent",
        payload: {
          projectId: "web",
          worktreeId: "wt_web_feature",
          freshStart: { expectedSessionId: "" },
        },
      },
      "fresh start command with blank expected session id",
    );
    expectFails(
      StationCommandSchema,
      {
        type: "session.startAgent",
        payload: {
          projectId: "web",
          worktreeId: "wt_web_feature",
          freshStart: { expectedSessionId: "ses_web_feature", force: true },
        },
      },
      "fresh start command with unknown consent fields",
    );

    expectParses(
      StationCommandSchema,
      {
        type: "session.acknowledgeTurn",
        payload: {
          sessionId: "ses_web_feature",
          token: "report_codex_stop_1",
        },
      },
      "acknowledge turn command",
    );

    expectParses(
      StationCommandSchema,
      {
        type: "session.create",
        payload: {
          projectId: "web",
          branch: "feature/popup",
          harness: { provider: "codex" },
          terminal: {
            provider: "tmux",
          },
          placement: { intent: "detached" },
        },
      },
      "create session command with explicit detached placement",
    );

    expectFails(
      StationCommandSchema,
      {
        type: "terminal.focus",
        payload: {
          sessionId: "ses_web_feature",
          origin: {
            provider: "tmux",
            clientId: "client_1",
            tmuxSession: "station",
          },
        },
      },
      "terminal focus origin with provider-specific extra fields",
    );

    expectFails(
      StationCommandSchema,
      {
        type: "terminal.focus",
        payload: {
          targetId: "tmux:station:@1:%2",
        },
      },
      "terminal focus command with target id",
    );

    expectFails(
      StationCommandSchema,
      {
        type: "terminal.close",
        payload: {
          targetId: "tmux:station:@1:%2",
        },
      },
      "terminal close command with target id",
    );

    expectFails(
      StationCommandSchema,
      {
        type: "session.create",
        payload: {
          projectId: "web",
          branch: "feature/popup",
          harness: { provider: "codex" },
          terminal: {
            provider: "tmux",
            focus: true,
            origin: {
              provider: "tmux",
              tmuxSession: "station",
            },
          },
        },
      },
      "session create terminal origin with provider-specific extra fields",
    );
  });

  it("strictly validates recorded Session Group command intent", () => {
    expect(
      StationCommandSchema.parse({
        type: "sessionGroup.create",
        payload: {
          projectId: "web",
          name: "  Active work  ",
          initialSessionIds: ["ses_a", "ses_b"],
        },
      }),
    ).toMatchObject({ payload: { name: "Active work" } });
    expectParses(
      StationCommandSchema,
      { type: "sessionGroup.create", payload: { projectId: "web", name: "Empty" } },
      "empty Group creation",
    );
    expectParses(
      StationCommandSchema,
      {
        type: "sessionGroup.updateMembership",
        payload: { projectId: "web", groupId: "grp_target", expectedVersion: 1 },
      },
      "expectation-validating empty membership delta",
    );
    expectParses(
      StationCommandSchema,
      {
        type: "sessionGroup.updateMembership",
        payload: {
          projectId: "web",
          groupId: "grp_target",
          expectedVersion: 2,
          add: [
            { sessionId: "ses_root", expectedGroupId: null },
            { sessionId: "ses_move", expectedGroupId: "grp_source" },
            { sessionId: "ses_same", expectedGroupId: "grp_target" },
          ],
          remove: [{ sessionId: "ses_remove", expectedGroupId: "grp_target" }],
        },
      },
      "atomic reassignment and ungrouping expectations",
    );
    expectParses(
      StationCommandSchema,
      {
        type: "sessionGroup.reparent",
        payload: {
          projectId: "web",
          groupId: "grp_child",
          expectedVersion: 3,
          parentGroupId: "grp_parent",
        },
      },
      "Group reparenting",
    );
    expectParses(
      StationCommandSchema,
      {
        type: "sessionGroup.reparent",
        payload: { projectId: "web", groupId: "grp_child", expectedVersion: 3 },
      },
      "Group root detachment",
    );

    const invalidCommands = [
      {
        type: "sessionGroup.create",
        payload: { projectId: "web", name: "   " },
      },
      {
        type: "sessionGroup.create",
        payload: { projectId: "web", name: "Duplicate", initialSessionIds: ["ses_a", "ses_a"] },
      },
      {
        type: "sessionGroup.rename",
        payload: { projectId: "web", groupId: "grp_a", expectedVersion: 0, name: "Name" },
      },
      {
        type: "sessionGroup.rename",
        payload: { projectId: "web", groupId: "   ", expectedVersion: 1, name: "Name" },
      },
      {
        type: "sessionGroup.updateMembership",
        payload: {
          projectId: "web",
          groupId: "grp_target",
          expectedVersion: 1,
          add: [
            { sessionId: "ses_duplicate", expectedGroupId: null },
            { sessionId: "ses_duplicate", expectedGroupId: "grp_source" },
          ],
        },
      },
      {
        type: "sessionGroup.updateMembership",
        payload: {
          projectId: "web",
          groupId: "grp_target",
          expectedVersion: 1,
          add: [{ sessionId: "ses_duplicate", expectedGroupId: null }],
          remove: [{ sessionId: "ses_duplicate", expectedGroupId: "grp_target" }],
        },
      },
      {
        type: "sessionGroup.updateMembership",
        payload: {
          projectId: "web",
          groupId: "grp_target",
          expectedVersion: 1,
          remove: [{ sessionId: "ses_remove", expectedGroupId: null }],
        },
      },
      {
        type: "sessionGroup.delete",
        payload: { projectId: "", groupId: "grp_target", expectedVersion: 1 },
      },
      {
        type: "sessionGroup.delete",
        payload: { projectId: "web", groupId: "grp_target", expectedVersion: 1, extra: true },
      },
      {
        type: "sessionGroup.reparent",
        payload: {
          projectId: "web",
          groupId: "grp_target",
          expectedVersion: 1,
          parentGroupId: null,
        },
      },
      {
        type: "sessionGroup.reparent",
        payload: {
          projectId: "web",
          groupId: "grp_target",
          expectedVersion: 1,
          parentGroupId: "   ",
        },
      },
      {
        type: "sessionGroup.reparent",
        payload: {
          projectId: "web",
          groupId: "grp_target",
          expectedVersion: 0,
        },
      },
      {
        type: "sessionGroup.reparent",
        payload: {
          projectId: "web",
          groupId: "grp_target",
          expectedVersion: 1,
          unexpected: true,
        },
      },
      {
        type: "sessionGroup.updateMembership",
        payload: {
          projectId: "web",
          groupId: "grp_target",
          expectedVersion: 1,
          add: [{ sessionId: "", expectedGroupId: null }],
        },
      },
    ];
    for (const [index, command] of invalidCommands.entries()) {
      expectFails(StationCommandSchema, command, `invalid Session Group command ${index}`);
    }
  });

  it("strictly validates atomic New Session Group placement", () => {
    const base = {
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "station-grouped",
        harness: { provider: "codex" },
        terminal: { provider: "tmux" },
        placement: { intent: "detached" },
      },
    } as const;
    expectParses(StationCommandSchema, base, "ungrouped session create");
    expectParses(
      StationCommandSchema,
      { ...base, payload: { ...base.payload, group: { kind: "existing", groupId: "grp_a" } } },
      "existing Group placement",
    );
    expect(
      StationCommandSchema.parse({
        ...base,
        payload: { ...base.payload, group: { kind: "create", name: "  New work  " } },
      }),
    ).toMatchObject({ payload: { group: { kind: "create", name: "New work" } } });

    for (const [index, group] of [
      { kind: "create", name: "   " },
      { kind: "existing", groupId: "   " },
      { kind: "existing", groupId: "grp_a", name: "mixed" },
      { kind: "create", name: "New", groupId: "grp_a" },
      { kind: "unknown", name: "New" },
      { kind: "existing", groupId: "grp_a", extra: true },
    ].entries()) {
      expectFails(
        StationCommandSchema,
        { ...base, payload: { ...base.payload, group } },
        `invalid session Group placement ${index}`,
      );
    }
  });

  it("keeps session titles optional, trimmed, and independent from branches", () => {
    const create = {
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "station-e91f2b",
        title: "  Hexagonal PT 12!  ",
        harness: { provider: "codex" },
        terminal: { provider: "tmux" },
        placement: { intent: "detached" },
      },
    };
    expect(StationCommandSchema.parse(create)).toMatchObject({
      payload: { branch: "station-e91f2b", title: "Hexagonal PT 12!" },
    });
    expectParses(
      StationCommandSchema,
      {
        type: "session.create",
        payload: {
          projectId: "web",
          branch: "station-e91f2b",
          harness: { provider: "codex" },
          terminal: { provider: "tmux" },
          placement: { intent: "detached" },
        },
      },
      "session create without optional title",
    );
    expectParses(
      StationCommandSchema,
      {
        type: "session.fork",
        payload: {
          projectId: "web",
          sourceWorktreeId: "wt_source",
          branch: "station-fork-e91f2b",
          title: "Hexagonal PT 12",
          group: {
            kind: "source",
            sourceSessionId: "ses_source",
            groupId: "grp_active",
          },
          terminal: { provider: "tmux" },
          placement: { intent: "detached" },
        },
      },
      "session fork with title containing spaces",
    );
    for (const command of [
      create,
      {
        type: "session.fork",
        payload: {
          projectId: "web",
          sourceWorktreeId: "wt_source",
          branch: "station-fork-e91f2b",
        },
      },
      { type: "session.rename", payload: { sessionId: "ses_api", title: "old" } },
    ]) {
      expectFails(
        StationCommandSchema,
        { ...command, payload: { ...command.payload, title: "   " } },
        `${command.type} with blank title`,
      );
    }
  });

  it("parses one event fixture for each event union member", async () => {
    const events = (await loadJson("events/events.json")) as Record<string, unknown>;

    for (const [name, event] of Object.entries(events)) {
      expectParses(StationEventSchema, event, `event fixture ${name}`);
    }

    const eventTypes = Object.values(events)
      .map((event) => (event as { type: string }).type)
      .sort();

    expect(eventTypes).toEqual([
      "command.accepted",
      "command.failed",
      "command.started",
      "command.succeeded",
      "harness.eventReported",
      "observer.reconciled",
      "observer.started",
      "project.updated",
      "provider.healthChanged",
      "providerHook.ingested",
      "providerHook.spoolDrained",
      "session.created",
      "session.removed",
      "session.updated",
      "sessionGroup.removed",
      "sessionGroup.updated",
      "worktree.added",
      "worktree.agentStateChanged",
      "worktree.removed",
      "worktree.updated",
    ]);

    expectFails(
      StationEventSchema,
      {
        type: "hook.ingested",
        at: "2026-05-20T12:00:00.000Z",
        hookId: "hook_1",
        provider: "codex",
        event: "PreToolUse",
      },
      "legacy hook event name stays invalid for emitted events",
    );
    expectFails(StationEventSchema, await loadJson("events/invalid-event.json"), "invalid event");
  });

  it("exposes command, trace, and timestamp identity for Session Group events", () => {
    const event = StationEventSchema.parse({
      type: "sessionGroup.updated",
      at: "2026-05-20T12:01:00.000Z",
      commandId: "cmd_group_1",
      traceId: "trc_group_1",
      group: {
        id: "grp_active",
        projectId: "web",
        name: "Active work",
        sessionIds: [],
        version: 1,
        createdAt: "2026-05-20T12:01:00.000Z",
        updatedAt: "2026-05-20T12:01:00.000Z",
      },
    });

    expect(stationEventCommandId(event)).toBe("cmd_group_1");
    expect(stationEventTraceId(event)).toBe("trc_group_1");
    expect(stationEventTimestamp(event)).toBe("2026-05-20T12:01:00.000Z");
    expectFails(
      StationEventSchema,
      { ...event, extra: true },
      "Session Group event with unknown field",
    );
    expectFails(
      StationEventSchema,
      { ...event, at: "invalid" },
      "Session Group event with invalid timestamp",
    );
  });

  it("parses hook, observer, command-record, and event-filter contracts", async () => {
    const hookEvents = (await loadJson("hooks/provider-hook-events.json")) as Record<
      string,
      unknown
    >;
    const firstHookEvent = Object.values(hookEvents)[0];
    const snapshot = (await loadJson("snapshots/snapshot-scenarios.json")) as Record<
      string,
      unknown
    >;

    for (const [name, hookEvent] of Object.entries(hookEvents)) {
      expectParses(ProviderHookEventSchema, hookEvent, `hook event ${name}`);
    }
    expect(ProviderHookKindSchema.options).toEqual(["worktree", "terminal", "harness"]);
    expect(ProviderHookKindSchema.safeParse("provider").success).toBe(false);

    expectFails(
      ProviderHookEventSchema,
      await loadJson("hooks/invalid-provider-hook-event.json"),
      "invalid hook event",
    );

    expectParses(
      StationHookIdentityPayloadSchema,
      {
        station_session_id: "ses_web_task",
        station_worktree_id: "wt_web_task",
        extra_provider_field: "kept",
      },
      "station hook identity payload",
    );
    expect(parseStationHookIdentityPayload(null)).toBeUndefined();

    expectParses(
      ProviderHookReceiptSchema,
      {
        schemaVersion: STATION_SCHEMA_VERSION,
        hookId: "hook_1",
        provider: "worktrunk",
        event: "worktree.created",
        status: "accepted",
        receivedAt: "2026-05-20T12:02:00.000Z",
      },
      "hook receipt",
    );

    expectParses(
      ProviderHookReceiptSchema,
      {
        schemaVersion: STATION_SCHEMA_VERSION,
        hookId: "hook_ignored_1",
        provider: "codex",
        event: "PreToolUse",
        status: "ignored",
        receivedAt: "2026-05-20T12:02:00.000Z",
      },
      "ignored hook receipt",
    );

    expectParses(
      ProviderHookSpoolRecordSchema,
      {
        schemaVersion: STATION_SCHEMA_VERSION,
        spoolId: "spool_1",
        createdAt: "2026-05-20T12:02:01.000Z",
        event: firstHookEvent,
        attempts: 0,
      },
      "hook spool record",
    );

    const harnessReport = {
      schemaVersion: STATION_SCHEMA_VERSION,
      reportId: "report_1",
      provider: "codex",
      kind: "harness",
      eventType: "PreToolUse",
      observedAt: "2026-05-20T12:02:00.000Z",
      coalesceKey: "turn:turn_1:tool:Bash",
      status: {
        value: "working",
        confidence: "medium",
        reason: "Codex is about to use Bash.",
        source: "harness_event",
        updatedAt: "2026-05-20T12:02:00.000Z",
      },
      correlation: {
        sessionId: "ses_web_task",
        worktreeId: "wt_web_task",
        terminalTargetId: "tmux:station:@1:%2",
        projectId: "web",
        cwd: "/tmp/station/web/task",
      },
      diagnostics: {
        rawEventType: "PreToolUse",
        correlationIssue: "station_identity_cwd_mismatch",
        payloadBytes: 400,
        compactedBytes: 180,
        compacted: true,
        truncated: false,
        omittedFieldNames: ["tool_input"],
      },
      providerData: {
        hookEventName: "PreToolUse",
      },
    };

    expectParses(HarnessEventReportSchema, harnessReport, "harness event report");
    expectFails(
      HarnessEventReportSchema,
      {
        ...harnessReport,
        diagnostics: {
          ...(harnessReport.diagnostics as Record<string, unknown>),
          correlationIssue: "unknown_correlation_issue",
        },
      },
      "harness event report rejects unknown correlation issue",
    );
    expectParses(
      HarnessEventReportSchema,
      {
        ...harnessReport,
        eventType: "Stop",
        status: {
          ...(harnessReport.status as Record<string, unknown>),
          value: "idle",
          reason: "Codex turn completed.",
        },
        turn: {
          kind: "turn_completed",
        },
      },
      "harness event report with turn completion hint",
    );
    expectParses(
      HarnessEventObservationSchema,
      {
        provider: "codex",
        reportId: "report_stop",
        eventType: "Stop",
        sessionId: "ses_web_task",
        worktreeId: "wt_web_task",
        status: {
          value: "idle",
          confidence: "high",
          reason: "Codex turn completed.",
          source: "harness_event",
          updatedAt: "2026-05-20T12:02:00.000Z",
        },
        turn: {
          kind: "turn_completed",
        },
        providerData: {},
        observedAt: "2026-05-20T12:02:00.000Z",
      },
      "persisted harness event observation with turn completion hint",
    );
    expectParses(
      WorktreeAgentSchema,
      {
        harness: "codex",
        state: "idle",
        sessionId: "ses_web_task",
        confidence: "high",
        reason: "Codex turn completed.",
        updatedAt: "2026-05-20T12:02:00.000Z",
        turnReadiness: {
          state: "ready_to_read",
          token: "report_stop",
          completedAt: "2026-05-20T12:02:00.000Z",
        },
      },
      "worktree agent with turn readiness",
    );
    expectParses(
      ObservedStatusSchema,
      {
        value: "working",
        confidence: "medium",
        reason: "Harness event source accepted.",
        source: "harness_event",
        updatedAt: "2026-05-20T12:02:00.000Z",
      },
      "harness event status source",
    );
    expectParses(
      TerminalHarnessBindingSchema,
      {
        role: "main-agent",
        harnessProvider: "codex",
        worktreePath: "/tmp/station/web/task",
        currentCommand: "codex",
      },
      "terminal harness binding",
    );
    expectFails(
      TerminalHarnessBindingSchema,
      {
        role: "main-agent",
        harnessProvider: "codex",
        worktreePath: "/tmp/station/web/task",
        currentCommand: "codex",
        providerSpecificLeak: "not allowed",
      },
      "terminal harness binding rejects extra provider data",
    );
    expectFails(
      HarnessEventReportSchema,
      {
        ...harnessReport,
        status: {
          ...(harnessReport.status as Record<string, unknown>),
          reason: undefined,
        },
      },
      "harness event report with explicit undefined",
    );

    expectParses(
      HarnessEventReportReceiptSchema,
      {
        schemaVersion: STATION_SCHEMA_VERSION,
        reportId: "report_1",
        provider: "codex",
        eventType: "PreToolUse",
        accepted: true,
        status: "accepted",
        receivedAt: "2026-05-20T12:02:00.000Z",
      },
      "harness event report receipt",
    );

    const eventHookConfig = {
      id: "notify-agent-state",
      events: ["worktree.agentStateChanged"],
      command: "stn",
      args: ["notify", "agent-state"],
      timeoutMs: 3000,
      filter: {
        agentState: "idle",
        harness: "codex",
        changeSource: "harness_event_report",
        harnessEventType: "Stop",
      },
    };
    expectParses(ObserverEventHookConfigSchema, eventHookConfig, "event hook config");
    expectFails(
      ObserverEventHookConfigSchema,
      { ...eventHookConfig, events: ["hook.ingested", "hook.spoolDrained"] },
      "event hook config rejects retired hook event names",
    );
    expectFails(
      ObserverEventHookConfigSchema,
      {
        ...eventHookConfig,
        events: ["unknown.event"],
      },
      "event hook config rejects unknown event type",
    );
    expectParses(
      ObserverEventHookInvocationSchema,
      {
        schemaVersion: STATION_SCHEMA_VERSION,
        hookId: "notify-agent-state",
        observedAt: "2026-05-20T12:02:00.000Z",
        event: {
          type: "worktree.agentStateChanged",
          worktreeId: "wt_web_task",
          sessionTitle: "Readable web task",
          changeSource: "harness_event_report",
          harnessEventType: "Stop",
          reportId: "report_codex_stop",
          agent: {
            harness: "codex",
            state: "idle",
            confidence: "high",
            reason: "Codex turn completed.",
            updatedAt: "2026-05-20T12:02:00.000Z",
          },
        },
      },
      "event hook invocation",
    );

    expectParses(
      HarnessEventReportSpoolRecordSchema,
      {
        schemaVersion: STATION_SCHEMA_VERSION,
        spoolId: "spool_report_1",
        createdAt: "2026-05-20T12:02:01.000Z",
        report: harnessReport,
        attempts: 0,
      },
      "harness event report spool record",
    );

    const sessionGroupRepair = {
      status: "partially_scoped",
      absenceAuthorityProjectIds: ["web"],
      preservedProjectIds: ["api"],
      blockers: [
        {
          scope: "project",
          providerType: "worktree",
          providerId: "worktrunk",
          projectId: "api",
          code: "PROVIDER_TIMEOUT",
        },
      ],
    } as const;
    expect(SessionGroupRepairSummarySchema.parse(sessionGroupRepair)).toEqual(sessionGroupRepair);
    expectFails(
      SessionGroupRepairSummarySchema,
      { ...sessionGroupRepair, extra: true },
      "Session Group repair summary with an unknown field",
    );
    expectFails(
      SessionGroupRepairSummarySchema,
      {
        ...sessionGroupRepair,
        blockers: [{ ...sessionGroupRepair.blockers[0], extra: true }],
      },
      "Session Group repair blocker with an unknown field",
    );
    const globalSessionGroupRepair = {
      status: "skipped",
      absenceAuthorityProjectIds: [],
      preservedProjectIds: ["web", "api"],
      blockers: [
        {
          scope: "global",
          providerType: "harness",
          providerId: "codex",
          code: "HARNESS_DISCOVER_FAILED",
        },
      ],
    } as const;
    expect(SessionGroupRepairSummarySchema.parse(globalSessionGroupRepair)).toEqual(
      globalSessionGroupRepair,
    );
    expectFails(
      SessionGroupRepairSummarySchema,
      {
        ...globalSessionGroupRepair,
        blockers: [{ ...globalSessionGroupRepair.blockers[0], extra: true }],
      },
      "global Session Group repair blocker with an unknown field",
    );

    expectParses(
      ObserverHealthSchema,
      {
        schemaVersion: STATION_SCHEMA_VERSION,
        status: "healthy",
        pid: 1234,
        startedAt: "2026-05-20T12:00:00.000Z",
        version: "0.0.0",
        socketPath: "/tmp/station/observer.sock",
        stateDir: "/tmp/station/state",
        hookSpoolDepth: 0,
        lastReconcile: {
          reason: "scheduled",
          startedAt: "2026-05-20T12:00:00.000Z",
          finishedAt: "2026-05-20T12:00:01.000Z",
          durationMs: 1_000,
          sessionGroupRepair,
        },
        harnessIngressQueue: {
          depth: 0,
          enqueued: 10,
          processed: 8,
          coalesced: 2,
          dropped: 0,
          failed: 0,
          lastProcessedAt: "2026-05-20T12:00:01.000Z",
          lastDrain: {
            scanned: 2,
            drained: 2,
            failed: 0,
            finishedAt: "2026-05-20T12:00:02.000Z",
          },
        },
      },
      "observer health",
    );

    expectParses(
      ObserverStopReceiptSchema,
      {
        schemaVersion: STATION_SCHEMA_VERSION,
        stopped: true,
        at: "2026-05-20T12:05:00.000Z",
      },
      "observer stop receipt",
    );
    expectParses(
      ObserverStopReceiptSchema,
      {
        schemaVersion: STATION_SCHEMA_VERSION,
        stopped: false,
        at: "2026-05-20T12:05:00.000Z",
        message: "Observer was already stopped; stale lifecycle evidence was reconciled.",
        evidenceRepair: {
          socket: "stale",
          pidfile: "removed",
          reason: "os-start-token-drift",
        },
      },
      "idempotent Observer stop with stale evidence repair",
    );
    expectFails(
      ObserverStopReceiptSchema,
      {
        schemaVersion: STATION_SCHEMA_VERSION,
        stopped: false,
        at: "2026-05-20T12:05:00.000Z",
        evidenceRepair: {
          socket: "stale",
          pidfile: "absent",
          reason: "process-missing",
        },
      },
      "Observer repair summary with fields from another discriminator branch",
    );

    expectParses(
      ReconcileReceiptSchema,
      {
        schemaVersion: STATION_SCHEMA_VERSION,
        reason: "contract-test",
        reconciledAt: "2026-05-20T12:05:00.000Z",
        snapshot: snapshot.noProjects,
      },
      "reconcile receipt",
    );

    expectParses(
      CommandRecordSchema,
      {
        id: "cmd_1",
        type: "observer.reconcile",
        command: {
          type: "observer.reconcile",
          payload: {
            reason: "contract-test",
          },
        },
        status: "succeeded",
        createdAt: "2026-05-20T12:00:00.000Z",
        startedAt: "2026-05-20T12:00:00.100Z",
        finishedAt: "2026-05-20T12:00:00.200Z",
      },
      "command record",
    );

    expectParses(
      EventFilterSchema,
      {
        type: ["command.accepted", "providerHook.ingested"],
        since: "2026-05-20T12:00:00.000Z",
      },
      "event filter",
    );
    expectFails(
      EventFilterSchema,
      { type: "hook.ingested" },
      "event filter rejects retired hook event name",
    );
    expectFails(
      EventFilterSchema,
      { type: ["hook.ingested", "providerHook.ingested", "command.accepted"] },
      "event filter rejects retired hook event name in array",
    );
  });

  it("strictly correlates command receipts, results, records, and outcomes", () => {
    const command = {
      type: "worktree.create",
      payload: {
        projectId: "project_commands",
        branch: "feature/results",
      },
    } as const;
    const result = {
      type: "worktree.create",
      projectId: "project_commands",
      worktreeId: "worktree_created",
    } as const;
    const record = {
      id: "cmd_results",
      type: "worktree.create",
      command,
      status: "succeeded",
      createdAt: "2026-05-20T12:00:00.000Z",
      finishedAt: "2026-05-20T12:00:01.000Z",
      result,
    } as const;
    const receipt = {
      commandId: "cmd_results",
      accepted: true,
      status: "accepted",
    } as const;

    expect(CommandReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(CommandReceiptSchema.safeParse({ ...receipt, accepted: false }).success).toBe(false);
    expect(CommandRecordSchema.safeParse(record).success).toBe(true);
    expect(CommandRecordSchema.safeParse({ ...record, type: "worktree.fork" }).success).toBe(false);
    expect(
      CommandRecordSchema.safeParse({
        ...record,
        result: { ...result, type: "worktree.fork" },
      }).success,
    ).toBe(false);
    expect(CommandRecordSchema.safeParse({ ...record, status: "failed" }).success).toBe(false);
    expect(CommandRecordSchema.safeParse({ ...record, result: undefined }).success).toBe(true);

    const publicRecord = {
      id: record.id,
      type: record.type,
      status: record.status,
      createdAt: record.createdAt,
      finishedAt: record.finishedAt,
      result: record.result,
    } as const;
    expect(PublicCommandRecordSchema.safeParse(publicRecord).success).toBe(true);
    expect(PublicCommandRecordSchema.safeParse({ ...publicRecord, command }).success).toBe(false);
    expect(
      PublicCommandRecordSchema.safeParse({
        ...publicRecord,
        diagnostics: [],
      }).success,
    ).toBe(false);
    expect(
      PublicCommandRecordSchema.safeParse({
        ...publicRecord,
        type: "worktree.fork",
      }).success,
    ).toBe(false);
    expect(
      PublicCommandRecordSchema.safeParse({
        ...publicRecord,
        status: "failed",
      }).success,
    ).toBe(false);

    expect(
      CommandExecutionOutcomeSchema.safeParse({ status: "succeeded", receipt, record }).success,
    ).toBe(true);
    expect(
      CommandExecutionOutcomeSchema.safeParse({
        status: "succeeded",
        receipt: { ...receipt, commandId: "cmd_other" },
        record,
      }).success,
    ).toBe(false);
    expect(
      CommandExecutionOutcomeSchema.safeParse({ status: "failed", receipt, record }).success,
    ).toBe(false);
    expect(
      CommandExecutionOutcomeSchema.safeParse({
        status: "rejected",
        receipt: {
          commandId: "cmd_rejected",
          accepted: false,
          status: "rejected",
        },
        result,
      }).success,
    ).toBe(false);
  });

  it("projects only correlated sibling or detached session placement results", () => {
    const identity = {
      type: "session.create",
      projectId: "project_commands",
      worktreeId: "worktree_created",
      sessionId: "session_created",
    } as const;
    const sibling = {
      ...identity,
      resolvedGroupId: "group_created",
      requestedPlacement: "sibling",
      resolvedPlacement: {
        provider: "tmux",
        targetId: "tmux:station:@1:%2",
        generation: "generation-1",
        presentation: "presented",
      },
    } as const;
    expect(SessionCreateCommandResultSchema.safeParse(sibling).success).toBe(true);
    expect(
      SessionForkCommandResultSchema.safeParse({ ...sibling, type: "session.fork" }).success,
    ).toBe(true);
    expect(
      SessionCreateCommandResultSchema.safeParse({
        ...sibling,
        resolvedPlacement: { ...sibling.resolvedPlacement, presentation: "detached" },
      }).success,
    ).toBe(false);
    expect(
      SessionCreateCommandResultSchema.safeParse({
        ...sibling,
        resolvedPlacement: { ...sibling.resolvedPlacement, containerId: "container-1" },
      }).success,
    ).toBe(false);
    expect(
      SessionCreateCommandResultSchema.safeParse({
        ...sibling,
        resolvedPlacement: { ...sibling.resolvedPlacement, presentation: "new-container" },
      }).success,
    ).toBe(false);
    expect(
      StationCommandResultSchema.safeParse({
        ...sibling,
        requestedPlacement: "native",
      }).success,
    ).toBe(false);
  });

  it("keeps SafeError safe while allowing rich internal ErrorEnvelope diagnostics", async () => {
    const errors = (await loadJson("errors/errors.json")) as Record<string, unknown>;

    expectParses(SafeErrorSchema, errors.safeError, "safe error");
    expectParses(ErrorEnvelopeSchema, errors.errorEnvelope, "error envelope");

    expectFails(
      SafeErrorSchema,
      await loadJson("errors/unsafe-safe-error.json"),
      "unsafe safe error fixture",
    );
    expectFails(
      SafeErrorSchema,
      {
        tag: "ExternalCommandError",
        code: "EXTERNAL_COMMAND_FAILED",
        message: "External command failed.\n    at run (/tmp/internal.ts:10:1)",
      },
      "stack-like SafeError message",
    );
  });

  it("strictly parses Observer lifecycle failures and private startup reports", () => {
    const error = {
      tag: "ObserverStartupError",
      code: "OBSERVER_EXITED_ON_START",
      message: "Observer exited before becoming healthy (exit code 1).",
      traceId: "trc_observer_start",
    };
    const cause = {
      tag: "ObserverProcessEvidenceError",
      code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
      message: "Observer process evidence did not match the exact executable and argv.",
    };
    const startupEvidence = {
      bootLogPath: "/tmp/station/logs/observer-boot.log",
      bootLogTail: "line one\nline two",
    };

    expect(ObserverStartupEvidenceSchema.parse(startupEvidence)).toEqual(startupEvidence);
    expect(ObserverLifecycleFailureSchema.parse({ error, cause, startupEvidence })).toEqual({
      error,
      cause,
      startupEvidence,
    });
    expect(ObserverLifecycleFailureSchema.parse({ error })).toEqual({ error });
    expect(
      ObserverRestartCommandResultSchema.parse({
        status: "unhealthy",
        paths: {
          stateDir: "/tmp/station",
          socketPath: "/tmp/station/run/observer.sock",
          dbPath: "/tmp/station/observer.sqlite",
          logDir: "/tmp/station/logs",
          diagnosticsDir: "/tmp/station/diagnostics",
          hookSpoolDir: "/tmp/station/spool/hooks",
        },
        error,
        cause,
        startupEvidence,
      }),
    ).toMatchObject({ status: "unhealthy", cause, startupEvidence });
    expect(
      ObserverRestartCommandResultSchema.parse({
        status: "running",
        socketPath: "/tmp/station/run/observer.sock",
        health: {
          schemaVersion: "0.11.0",
          status: "healthy",
        },
      }),
    ).toMatchObject({ status: "running", health: { schemaVersion: "0.11.0" } });
    expect(
      ObserverStartupFailureReportSchema.parse({
        kind: "observer-startup-failure",
        version: 1,
        error,
        cause,
      }),
    ).toMatchObject({ version: 1, cause });

    expectFails(
      ObserverStartupEvidenceSchema,
      { ...startupEvidence, bootLogTail: Array.from({ length: 16 }, () => "line").join("\n") },
      "startup evidence over the line bound",
    );
    for (const terminator of ["\r", "\u2028", "\u2029"]) {
      expectFails(
        ObserverStartupEvidenceSchema,
        {
          ...startupEvidence,
          bootLogTail: Array.from({ length: 16 }, () => "line").join(terminator),
        },
        `startup evidence over the line bound with ${JSON.stringify(terminator)}`,
      );
      expectFails(
        ObserverLifecycleFailureSchema,
        {
          error: {
            ...error,
            message: `failed${terminator}    at /private/secret.ts`,
          },
        },
        `lifecycle stack disclosure with ${JSON.stringify(terminator)}`,
      );
    }
    expectFails(
      ObserverStartupEvidenceSchema,
      { ...startupEvidence, extra: true },
      "startup evidence with an extra field",
    );
    expectFails(
      ObserverLifecycleFailureSchema,
      { error, cause: { code: cause.code, message: cause.message } },
      "lifecycle failure with a malformed cause",
    );
    expectFails(
      ObserverStartupFailureReportSchema,
      { kind: "observer-startup-failure", version: 2, error },
      "startup report with an unsupported version",
    );
    expectFails(
      ObserverStartupFailureReportSchema,
      { kind: "observer-startup-failure", version: 1, error, extra: true },
      "startup report with an extra field",
    );
  });

  it("parses strict session recovery artifacts and journal entries", () => {
    expectParses(
      SessionMigrationJournalEntrySchema,
      {
        at: "2026-07-30T12:00:00.000Z",
        phase: "source-sealed",
        status: "complete",
        digest: "a".repeat(64),
        sealedRoot: "/tmp/session-migration/sealed",
        titleEvidence: [
          {
            sessionId: "ses_1",
            sourceTitle: "Recovered workspace",
            targetTitle: "feature/recovery",
          },
        ],
      },
      "session migration journal entry",
    );
    expectParses(
      SessionMigrationLockSchema,
      {
        pid: 1234,
        token: randomUUID(),
        createdAt: "2026-07-30T12:00:00.000Z",
      },
      "session migration lock",
    );
    expectParses(
      SessionMigrationSealSchema,
      {
        sealedAt: "2026-07-30T12:00:00.000Z",
        digest: "a".repeat(64),
        sessions: ["ses_1"],
        files: [
          { path: "providers/codex/session.jsonl", type: "file", size: 10, sha256: "b".repeat(64) },
        ],
      },
      "session migration seal",
    );
    expectFails(
      SessionRescueManifestSchema,
      {
        archiveVersion: 1,
        createdAt: "2026-07-30T12:00:00.000Z",
        status: "complete",
        warnings: [],
        critical: [],
        metadata: {},
        files: [],
      },
      "session rescue manifest without source identity",
    );
  });

  it("parses strict session recovery readiness", () => {
    expectParses(
      SessionRecoveryReadinessSchema,
      {
        resumeEnabled: true,
        canonicalTitleImport: true,
        managedTerminal: {
          provider: "native",
          canLaunchProcessPersistently: true,
        },
        harnesses: [{ provider: "codex", canResume: true }],
      },
      "session recovery readiness",
    );
    expectFails(
      SessionRecoveryReadinessSchema,
      { resumeEnabled: true, harnesses: [], providerData: {} },
      "session recovery readiness with unknown fields",
    );
    expectParses(
      SessionRecoveryReadinessSchema,
      { resumeEnabled: true, harnesses: [] },
      "older session recovery readiness without canonical title import",
    );
    expectFails(
      SessionRecoveryReadinessSchema,
      { resumeEnabled: true, canonicalTitleImport: false, harnesses: [] },
      "session recovery readiness with false canonical title import",
    );
  });

  it("parses provider health, capabilities, observations, and providerData boundaries", async () => {
    const observations = (await loadJson("provider-observations/observations.json")) as Record<
      string,
      unknown
    >;

    expectParses(
      WorktreeCapabilitiesSchema,
      observations.worktreeCapabilities,
      "worktree capabilities",
    );
    expectParses(
      TerminalCapabilitiesSchema,
      observations.terminalCapabilities,
      "terminal capabilities",
    );
    expectParses(
      HarnessCapabilitiesSchema,
      observations.harnessCapabilities,
      "harness capabilities",
    );
    expectParses(ProviderHealthSchema, observations.providerHealth, "provider health");
    expectParses(
      ProviderProjectConfigSchema,
      {
        id: "api",
        label: "API",
        root: "/tmp/api",
        defaults: {
          harness: "scripted",
          terminal: "tmux",
          layout: "agent-shell",
        },
        worktrunk: {
          enabled: true,
          base: "main",
        },
        recoveryBreadcrumbs: {
          location: "worktree",
          path: ".station/recovery-breadcrumb.json",
        },
      },
      "provider project config",
    );
    expectParses(
      RecoveryBreadcrumbSchema,
      {
        schemaVersion: 1,
        projectId: "api",
        worktreeId: "wt_api_task",
        sessionId: "ses_api_task",
        createdBy: "station",
        createdAt: "2026-05-20T12:00:00.000Z",
        provider: "worktrunk",
        note: "created by lifecycle hook",
      },
      "recovery breadcrumb",
    );
    expectFails(
      RecoveryBreadcrumbSchema,
      {
        schemaVersion: 1,
        projectId: "api",
        createdBy: "station",
        createdAt: "2026-05-20T12:00:00.000Z",
        prompt: "unsafe extra data",
      },
      "recovery breadcrumb with unsupported field",
    );
    expectFails(
      ProviderProjectConfigSchema,
      {
        id: "api",
        label: "API",
        root: "/tmp/api",
        defaults: {
          harness: "scripted",
          terminal: "tmux",
          layout: "agent-shell",
        },
        worktrunk: {
          enabled: true,
        },
        providerSpecific: true,
      },
      "provider project config with provider-specific data",
    );
    expectParses(HarnessLaunchPlanSchema, observations.harnessLaunchPlan, "harness launch plan");
    expectParses(
      TerminalTargetObservationSchema,
      {
        id: "tmux:station:@1:%2",
        provider: "tmux",
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        state: "open",
        cwd: "/tmp/station/web/task",
        confidence: "high",
        reason: "tmux pane has station identity binding.",
        observedAt: "2026-05-20T12:00:00.000Z",
        harnessBinding: {
          role: "main-agent",
          harnessProvider: "codex",
          worktreePath: "/tmp/station/web/task",
          currentCommand: "codex",
        },
        providerData: {
          paneId: "%2",
        },
      },
      "terminal target observation with harness binding",
    );
    expectParses(
      TerminalIdentityBindingSchema,
      {
        provider: "tmux",
        targetId: "tmux:station:@1:%2",
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        harnessBinding: {
          role: "main-agent",
          harnessProvider: "codex",
          worktreePath: "/tmp/station/web/task",
        },
        confidence: "high",
        reason: "tmux workbench workspace is open and identity binding was written.",
      },
      "terminal identity binding with harness binding",
    );

    for (const [index, observation] of (observations.worktreeObservations as unknown[]).entries()) {
      expectParses(WorktreeObservationSchema, observation, `worktree observation ${index}`);
    }

    for (const [index, observation] of (
      observations.terminalTargetObservations as unknown[]
    ).entries()) {
      expectParses(
        TerminalTargetObservationSchema,
        observation,
        `terminal target observation ${index}`,
      );
    }

    for (const [index, observation] of (
      observations.harnessRunObservations as unknown[]
    ).entries()) {
      expectParses(HarnessRunObservationSchema, observation, `harness run observation ${index}`);
    }

    for (const [index, observation] of (
      observations.currentHarnessRunObservations as unknown[]
    ).entries()) {
      expectParses(
        HarnessRunObservationSchema,
        observation,
        `current harness run observation ${index}`,
      );
    }

    for (const [index, observation] of (
      observations.harnessEventObservations as unknown[]
    ).entries()) {
      expectParses(
        HarnessEventObservationSchema,
        observation,
        `harness event observation ${index}`,
      );
    }

    for (const [index, observation] of (
      observations.terminalIdentityBindings as unknown[]
    ).entries()) {
      expectParses(TerminalIdentityBindingSchema, observation, `terminal identity ${index}`);
    }

    expectFails(
      TerminalTargetObservationSchema,
      await loadJson("provider-observations/invalid-observation.json"),
      "invalid provider observation",
    );
  });
});
