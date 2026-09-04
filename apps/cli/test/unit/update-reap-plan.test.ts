import type {
  ObserverRecoveryAssessment,
  StationHostExactEvidence,
  UpdateConvergencePlan,
  UpdateReapRecoveryPreflight,
} from "@station/contracts";
import { STATION_SCHEMA_VERSION, UpdateReapJournalTargetSchema } from "@station/contracts";
import type { ExactObserverOwnershipEvidence } from "@station/observer/internal";
import { describe, expect, it } from "vitest";
import {
  deriveExactTerminalReapAuthorizationEvidence,
  deriveUpdateReapAuthorization,
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
    ).toThrow("Host-owned child");
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
    ).toThrow("complete recovery disposition");
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
