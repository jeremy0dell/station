import type {
  ObserverRecoveryAssessment,
  StationHostExactEvidence,
  UpdateConvergencePlan,
  UpdateReapRecoveryPreflight,
} from "@station/contracts";
import {
  projectUpdateRecoveryAssessment,
  STATION_SCHEMA_VERSION,
  UpdateReapJournalTargetSchema,
} from "@station/contracts";
import type { ExactObserverOwnershipEvidence } from "@station/observer/internal";
import { describe, expect, it, vi } from "vitest";
import { executeUpdateReap } from "../../src/update/reapExecution.js";
import {
  deriveExactTerminalReapAuthorizationEvidence,
  deriveUpdateReapAuthorization,
  type UpdateReapAuthorizationRefusalReason,
} from "../../src/update/reapPlan.js";

const now = "2026-09-04T12:00:00.000Z";
const target = { version: "1.2.3" };
const terminal = {
  kind: "agent" as const,
  terminalTargetId: "terminal-1",
  ptyId: "pty-1",
  ptyInstanceId: "instance-1",
  projectId: "project-1",
  worktreeId: "worktree-1",
  sessionId: "session-1",
  worktreePath: "/private/worktree",
  harnessProvider: "codex",
  pid: 200,
  alive: true,
  cols: 80,
  rows: 24,
  handoffSupport: {
    kind: "non-releasable" as const,
    reason: "no-bridge-transport" as const,
  },
};
const host: StationHostExactEvidence = {
  endpoint: { socketPath: "/private/host.sock", ino: 11n, birthtimeNs: 22n },
  health: { ok: true, protocolVersion: 8, buildVersion: "1.2.2" },
  buildIdentity: "b".repeat(64),
  terminals: [terminal],
};
const assessment: ObserverRecoveryAssessment = {
  schemaVersion: 1,
  inventory: {
    schemaVersion: 1,
    sessions: [
      {
        id: "session-1",
        projectId: "project-1",
        worktreeId: "worktree-1",
        lifecycle: "open",
        harnessProvider: "codex",
        createdAt: now,
        lastSeenAt: now,
      },
    ],
    recoveryHandles: [
      {
        id: "handle-1",
        provider: "codex",
        projectId: "project-1",
        worktreeId: "worktree-1",
        sessionId: "session-1",
        targetKind: "native-session",
        observedAt: now,
        lastSeenAt: now,
      },
    ],
  },
  resumeEnabled: true,
  providerCapabilities: [{ provider: "codex", status: "enabled" }],
  sessions: [
    {
      sessionId: "session-1",
      projectId: "project-1",
      worktreeId: "worktree-1",
      lifecycle: "open",
      harnessProvider: "codex",
      disposition: "recoverable",
      reasons: [],
      handleResolution: {
        kind: "selected",
        selectedHandleId: "handle-1",
        eligibleHandleCount: 1,
        rejectedHandleCount: 0,
        rejectedReasons: [],
      },
    },
  ],
};
const observer: ExactObserverOwnershipEvidence = {
  status: "exact",
  health: {
    schemaVersion: STATION_SCHEMA_VERSION,
    status: "healthy",
    pid: 300,
    startedAt: now,
    version: `1.2.2+station.${"d".repeat(64)}`,
    socketPath: "/private/observer.sock",
  },
  processIdentity: {
    pid: 300,
    osStartTime: "observer-start",
    processToken: "00000000-0000-4000-8000-000000000002",
    version: `1.2.2+station.${"d".repeat(64)}`,
    socketPath: "/private/observer.sock",
  },
  process: {
    pid: 300,
    argv: ["/private/stn", "observer", "serve"],
    executablePath: "/private/stn",
    startToken: "observer-start",
    processToken: "00000000-0000-4000-8000-000000000002",
    buildVersion: `1.2.2+station.${"d".repeat(64)}`,
    socketPath: "/private/observer.sock",
    startupTimeoutMs: 5_000,
    executableProvenance: "exact",
  },
  recovery: { status: "assessed", assessment },
};
const preflight: UpdateReapRecoveryPreflight = {
  schemaVersion: 1,
  boundary: {
    authorization: "none",
    actions: "not-included",
    digest: "not-included",
  },
  installed: target,
  target,
  observer: {
    status: "exact",
    buildVersion: observer.processIdentity.version,
    relation: "different",
    health: "healthy",
    recovery: {
      status: "assessed",
      assessment: {
        schemaVersion: 1,
        resumeEnabled: true,
        providerCapabilities: assessment.providerCapabilities,
        sessions: assessment.sessions.map((session) => ({
          ...session,
          handleResolution: {
            kind: "selected",
            eligibleHandleCount: 1,
            rejectedHandleCount: 0,
            rejectedReasons: [],
          },
        })),
      },
    },
  },
  host: {
    status: "inspected",
    buildVersion: host.health.buildVersion,
    buildIdentity: host.buildIdentity,
    protocolVersion: 8,
    relation: "different",
    compatibility: "replace",
    terminals: [
      {
        kind: terminal.kind,
        terminalTargetId: terminal.terminalTargetId,
        ptyId: terminal.ptyId,
        ptyInstanceId: terminal.ptyInstanceId,
        projectId: terminal.projectId,
        worktreeId: terminal.worktreeId,
        sessionId: terminal.sessionId,
        harnessProvider: terminal.harnessProvider,
        alive: true,
        handoffSupport: "non-releasable",
      },
    ],
  },
  hookProviderIds: ["codex"],
  hooks: [{ provider: "codex", status: "healthy" }],
  terminalDispositions: [
    {
      terminalTargetId: terminal.terminalTargetId,
      ptyId: terminal.ptyId,
      ptyInstanceId: terminal.ptyInstanceId,
      sessionId: terminal.sessionId,
      handoff: "non-preservable",
      reapRecovery: "recoverable",
      reasons: [],
    },
  ],
  parkedBridges: {
    status: "assessed",
    totalParkedCount: 0,
    unownedParkedCount: 0,
    adoptionRequiredCount: 0,
  },
  evidenceComplete: true,
};
const plan: UpdateConvergencePlan = {
  authorization: "none",
  selectedTarget: {
    artifact: target,
    runtimeBuild: {
      status: "known",
      buildIdentity: "e".repeat(64),
      observerSelector: `1.2.3+station.${"e".repeat(64)}`,
    },
  },
  outcome: "reap-required",
  phases: {
    artifactApplication: {
      action: "no-op",
      reason: "selected-artifact-current",
      before: target,
      owner: "installer-binary",
      command: { kind: "none" },
    },
    hookReconciliation: {
      action: "no-op",
      reason: "healthy",
      providers: [{ provider: "codex", action: "no-op", reason: "healthy" }],
    },
    observerConvergence: {
      action: "restart",
      reason: "target-precedes",
      precedence: "candidate-precedes",
    },
    terminalConvergence: {
      action: "reap-required",
      reason: "non-preservable-terminals",
      terminals: [
        {
          kind: "agent",
          alive: true,
          terminalTargetId: "terminal-1",
          ptyId: "pty-1",
          ptyInstanceId: "instance-1",
          sessionId: "session-1",
          handoff: "non-preservable",
          reapRecovery: "recoverable",
          reasons: [],
        },
      ],
    },
    hostConvergence: {
      action: "await-reap",
      reason: "non-preservable-terminals",
    },
    persistedStateReconcile: { action: "await-reap", reason: "reap-required" },
    finalVerification: { action: "await-reap", reason: "reap-required" },
  },
};
const processGroup = {
  leader: { pid: 200, parentPid: 100, pgid: 200, startToken: "terminal-start" },
  members: [{ pid: 200, parentPid: 100, pgid: 200, startToken: "terminal-start" }],
};

describe("update reap authorization", () => {
  it("preserves the existing authorization digests", () => {
    expect(authorize().digest).toBe(
      "d4e26235ecf2e0fd982995f9ae9f5c6dce041e6c067c5b21213baaa36ab2f9dd",
    );
    expect(authorize(withUnrelatedSession()).digest).toBe(
      "eb6774170655c84c1af96ddd2775e6a7759f36843e2ac7fb539cdff9c95f141e",
    );
  });
  it("shares one exact-target authorizer with targeted repair", () => {
    const evidence = deriveExactTerminalReapAuthorizationEvidence({
      preflight,
      commitments: { observer, host },
      hostProcess: { pid: 100, startToken: "host-start" },
      processGroup,
      terminalTargetId: "terminal-1",
    });
    expect(evidence.target.terminal.terminalTargetId).toBe("terminal-1");
    expect(evidence.target.processGroup.leader.parentPid).toBe(100);
    expect(evidence.target.recovery).toMatchObject({
      kind: "selected",
      handleId: "handle-1",
    });
  });

  it("authorizes exact targets while binding an unrelated missing-worktree record", () => {
    const input = withUnrelatedSession();
    expect(authorize(input).targets).toEqual(authorize().targets);
    expect(input.preflight.evidenceComplete).toBe(false);
    const changed = withUnrelatedSession();
    if (
      changed.preflight.observer.status !== "exact" ||
      changed.preflight.observer.recovery.status !== "assessed"
    )
      throw new Error("Expected assessment");
    const changedSession = changed.preflight.observer.recovery.assessment.sessions.at(-1);
    if (changedSession === undefined) throw new Error("Expected session");
    changedSession.lifecycle = "ended";
    const retained = changed.assessment.sessions.at(-1);
    if (retained === undefined) throw new Error("Expected retained session");
    retained.lifecycle = "ended";
    expect(authorize(changed).digest).not.toBe(authorize(input).digest);
  });

  it.each([
    "session",
    "worktree",
    "parked",
    "parked-worktree",
    "reason",
    "hook",
    "handoff",
    "handle",
    "parked-unknown",
    "recovery-authority",
  ])("refuses incomplete or overlapping %s evidence", (change) => {
    const input = withUnrelatedSession();
    const publicObserver = input.preflight.observer;
    if (publicObserver.status !== "exact" || publicObserver.recovery.status !== "assessed")
      throw new Error("Expected assessment");
    const excluded = publicObserver.recovery.assessment.sessions.at(-1);
    if (excluded === undefined) throw new Error("Expected excluded session");
    const privateObserver = input.commitments.observer;
    if (privateObserver.status !== "exact" || privateObserver.recovery.status !== "assessed")
      throw new Error("Expected private assessment");
    const retained = privateObserver.recovery.assessment.sessions.at(-1);
    const selected = privateObserver.recovery.assessment.sessions[0];
    const disposition = input.preflight.terminalDispositions[0];
    if (
      retained === undefined ||
      selected === undefined ||
      disposition === undefined ||
      preflight.host.status !== "inspected" ||
      preflight.host.terminals[0] === undefined
    )
      throw new Error("Expected evidence");
    if (change === "session") excluded.sessionId = retained.sessionId = terminal.sessionId;
    if (change === "worktree") {
      excluded.projectId = retained.projectId = terminal.projectId;
      excluded.worktreeId = retained.worktreeId = terminal.worktreeId;
    }
    if (change === "parked" || change === "parked-worktree") {
      input.preflight.parkedBridges = {
        status: "assessed",
        totalParkedCount: 1,
        unownedParkedCount: 1,
        adoptionRequiredCount: 0,
      };
      input.commitments.parkedTerminals = [
        change === "parked"
          ? { ...preflight.host.terminals[0], sessionId: excluded.sessionId }
          : {
              ...preflight.host.terminals[0],
              projectId: excluded.projectId,
              worktreeId: excluded.worktreeId,
            },
      ];
    }
    // Forward compatibility: the Observer currently emits only worktree_evidence_missing here.
    if (change === "reason") retained.reasons.push("harness_provider_missing");
    if (change === "hook")
      input.preflight.hooks = [
        {
          provider: "codex",
          status: "inspection-failed",
          error: { tag: "TestError", code: "UNKNOWN", message: "Unknown" },
          followUp: { action: "run-doctor" },
        },
      ];
    if (change === "handoff") disposition.handoff = "unknown";
    if (change === "handle")
      selected.handleResolution = { kind: "unknown", reasons: ["worktree_evidence_missing"] };
    if (change === "recovery-authority")
      Object.assign(privateObserver, {
        recovery: {
          status: "unknown",
          error: { tag: "TestError", code: "UNKNOWN", message: "Unknown" },
        },
      });
    if (change === "parked-unknown")
      input.preflight.parkedBridges = {
        status: "unknown",
        error: { tag: "TestError", code: "UNKNOWN", message: "Unknown" },
      };
    Object.assign(input.publicAssessment, projectUpdateRecoveryAssessment(input.assessment));
    const reasons: Record<string, UpdateReapAuthorizationRefusalReason> = {
      session: "retained-session-overlap",
      worktree: "retained-session-overlap",
      parked: "retained-session-overlap",
      "parked-worktree": "retained-session-overlap",
      reason: "unsupported-session-uncertainty",
      hook: "evidence-incomplete",
      handoff: "evidence-incomplete",
      handle: "recovery-handle-unavailable",
      "parked-unknown": "parked-evidence-unavailable",
      "recovery-authority": "observer-recovery-unavailable",
    };
    expect(() => authorize(input)).toThrow(expect.objectContaining({ reason: reasons[change] }));
  });

  it.each([
    "resume-enabled",
    "provider-capability",
    "session-count",
    "session-lifecycle",
    "session-provider",
    "selected-count",
    "selected-rejections",
  ])("refuses a mismatched full public recovery projection: %s", (change) => {
    const input = withUnrelatedSession();
    const session = input.publicAssessment.sessions[0];
    if (session === undefined || session.handleResolution.kind !== "selected")
      throw new Error("Expected selected session");
    if (change === "resume-enabled") input.publicAssessment.resumeEnabled = false;
    if (change === "provider-capability") input.publicAssessment.providerCapabilities = [];
    if (change === "session-count") input.publicAssessment.sessions.pop();
    if (change === "session-lifecycle") session.lifecycle = "ended";
    if (change === "session-provider") session.harnessProvider = "claude";
    if (change === "selected-count") session.handleResolution.eligibleHandleCount += 1;
    if (change === "selected-rejections")
      session.handleResolution.rejectedReasons.push("station_session_mismatch");
    expect(() => authorize(input)).toThrow(
      expect.objectContaining({
        reason: "recovery-assessment-mismatch",
        code: "UPDATE_REAP_RECOVERY_ASSESSMENT_MISMATCH",
      }),
    );
  });

  it.each([
    true,
    false,
  ])("requires parked commitment coverage when evidenceComplete is %s", (complete) => {
    const input = withUnrelatedSession();
    if (complete) {
      input.assessment.sessions.pop();
      Object.assign(input.publicAssessment, projectUpdateRecoveryAssessment(input.assessment));
      input.preflight.evidenceComplete = true;
    }
    input.preflight.parkedBridges = {
      status: "assessed",
      totalParkedCount: 1,
      unownedParkedCount: 1,
      adoptionRequiredCount: 0,
    };
    expect(() => authorize(input)).toThrow(
      expect.objectContaining({ reason: "parked-evidence-mismatch" }),
    );
    expect(() =>
      authorize({
        ...input,
        commitments: { observer: input.commitments.observer, host: input.commitments.host },
      }),
    ).toThrow(expect.objectContaining({ reason: "parked-evidence-mismatch" }));
  });

  it.each([
    "dead-agent",
    "live-aux",
    "dead-aux",
  ])("refuses an excluded session overlapping a %s terminal", (kind) => {
    const input = withUnrelatedSession();
    if (input.preflight.host.status !== "inspected") throw new Error("Expected Host");
    const extra = {
      ...terminal,
      kind: kind.endsWith("aux") ? ("aux" as const) : ("agent" as const),
      alive: kind === "live-aux",
      terminalTargetId: "terminal-2",
      ptyId: "pty-2",
      ptyInstanceId: "instance-2",
      pid: 201,
      sessionId: "session-unrelated",
    };
    input.commitments.host.terminals.push(extra);
    input.preflight.host.terminals.push({ ...extra, handoffSupport: "non-releasable" });
    expect(() => authorize(input)).toThrow(
      expect.objectContaining({ reason: "retained-session-overlap" }),
    );
  });

  it("preserves known non-resumable targets while refusing unknown target recovery", () => {
    const input = withUnrelatedSession();
    const disposition = input.preflight.terminalDispositions[0];
    if (disposition === undefined) throw new Error("Expected terminal disposition");
    disposition.reapRecovery = "non-resumable";
    expect(authorize(input).targets[0]?.recovery).toEqual({ kind: "non-resumable" });
    disposition.reapRecovery = "unknown";
    expect(() => authorize(input)).toThrow(
      expect.objectContaining({ reason: "evidence-incomplete" }),
    );
  });

  it("refuses changed Host identity and missing group coverage for explicit reasons", () => {
    const changedHost = structuredClone(host);
    const changedTerminal = changedHost.terminals[0];
    if (changedTerminal === undefined) throw new Error("Expected terminal");
    changedTerminal.ptyInstanceId = "another-instance";
    expect(() => authorize({ commitments: { observer, host: changedHost } })).toThrow(
      expect.objectContaining({ reason: "host-evidence-mismatch" }),
    );
    expect(() => authorize({ processGroups: [] })).toThrow(
      expect.objectContaining({ reason: "process-group-coverage-mismatch" }),
    );
  });

  it("refuses a reappearing worktree during locked preflight before writing or signaling", async () => {
    const initial = withUnrelatedSession();
    const authorization = authorize(initial);
    const repeated = withUnrelatedSession();
    const retained = repeated.assessment.sessions.at(-1);
    if (retained === undefined) throw new Error("Expected retained session");
    retained.disposition = "non-resumable";
    retained.reasons = ["no_recovery_handles"];
    retained.handleResolution = {
      kind: "none",
      eligibleHandleCount: 0,
      rejectedHandleCount: 0,
      reasons: ["no_recovery_handles"],
    };
    Object.assign(repeated.publicAssessment, projectUpdateRecoveryAssessment(repeated.assessment));
    repeated.preflight.evidenceComplete = true;
    const write = vi.fn();
    const signal = vi.fn();
    await expect(
      executeUpdateReap({
        expected: authorization,
        authorization,
        reauthorize: async () => authorize(repeated),
        journal: {
          findIncomplete: async () => undefined,
          write,
          read: vi.fn(),
          withLock: vi.fn(),
          takeOverLock: vi.fn(),
        },
        processGroups: { read: async () => processGroup, signal, wait: async () => undefined },
      }),
    ).rejects.toThrow("changed during locked preflight");
    expect(write).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it("binds the public plan, exact identities, process group, and selected handle", () => {
    const authorized = authorize();
    expect(authorized.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(authorized.targets[0]?.recovery).toEqual({
      kind: "selected",
      projectId: "project-1",
      worktreeId: "worktree-1",
      sessionId: "session-1",
      handleId: "handle-1",
    });
    expect(() => UpdateReapJournalTargetSchema.parse(authorized.targets[0])).not.toThrow();
    expect(authorize({ installedScopeDigest: "f".repeat(64) }).digest).not.toBe(authorized.digest);
    const changed = withUnrelatedSession();
    const selected = changed.assessment.sessions[0];
    if (selected?.handleResolution.kind !== "selected") throw new Error("Expected selected handle");
    const before = authorize(changed).digest;
    selected.handleResolution.selectedHandleId = "another-private-handle";
    expect(authorize(changed).digest).not.toBe(before);
  });

  it("ignores volatile Observer health while retaining its exact process identity", () => {
    const authorized = authorize();
    expect(
      authorize({
        commitments: {
          observer: {
            ...observer,
            health: { ...observer.health, uptimeMs: 9_000 },
          },
          host,
        },
      }).digest,
    ).toBe(authorized.digest);
    expect(
      authorize({
        commitments: {
          observer: {
            ...observer,
            processIdentity: {
              ...observer.processIdentity,
              osStartTime: "another-start",
            },
          },
          host,
        },
      }).digest,
    ).not.toBe(authorized.digest);
  });

  it("refuses a group leader that is not the exact Host child", () => {
    expect(() =>
      authorize({
        processGroups: [
          {
            ...processGroup,
            leader: { ...processGroup.leader, parentPid: 99 },
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ reason: "terminal-process-not-owned" }));
  });

  it("refuses a recovery disposition for another session", () => {
    const disposition = preflight.terminalDispositions[0];
    if (disposition === undefined) throw new Error("Expected a terminal disposition fixture.");
    expect(() =>
      authorize({
        preflight: {
          ...preflight,
          terminalDispositions: [{ ...disposition, sessionId: "session-other" }],
        },
      }),
    ).toThrow(expect.objectContaining({ reason: "terminal-recovery-unknown" }));
  });
});

function authorize(overrides: Partial<Parameters<typeof deriveUpdateReapAuthorization>[0]> = {}) {
  return deriveUpdateReapAuthorization({
    channel: "installer-binary",
    selectedArtifact: target,
    installedScopeDigest: "a".repeat(64),
    preflight,
    plan,
    commitments: { observer, host },
    hostProcess: { pid: 100, startToken: "host-start" },
    processGroups: [processGroup],
    ...overrides,
  });
}

function withUnrelatedSession() {
  const unrelated = {
    sessionId: "session-unrelated",
    projectId: "project-unrelated",
    worktreeId: "worktree-missing",
    lifecycle: "open" as const,
    harnessProvider: "codex",
    disposition: "unknown" as const,
    reasons: ["worktree_evidence_missing" as const],
    handleResolution: { kind: "unknown" as const, reasons: ["worktree_evidence_missing" as const] },
  };
  const aggregate = structuredClone(preflight);
  if (aggregate.observer.status !== "exact" || aggregate.observer.recovery.status !== "assessed")
    throw new Error("Expected assessment");
  aggregate.observer.recovery.assessment.sessions.push(unrelated);
  aggregate.evidenceComplete = false;
  const privateObserver = structuredClone(observer);
  if (privateObserver.status !== "exact" || privateObserver.recovery.status !== "assessed")
    throw new Error("Expected assessment");
  privateObserver.recovery.assessment.sessions.push(structuredClone(unrelated));
  return {
    preflight: aggregate,
    assessment: privateObserver.recovery.assessment,
    publicAssessment: aggregate.observer.recovery.assessment,
    commitments: {
      observer: privateObserver,
      host: structuredClone(host),
      parkedTerminals: [] as import("@station/contracts").UpdateReapTerminalEvidence[],
    },
  };
}
