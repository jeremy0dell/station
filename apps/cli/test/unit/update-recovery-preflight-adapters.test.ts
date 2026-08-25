import { emptyConfig } from "@station/config";
import type { ObserverProcessIdentity, ObserverRecoveryAssessment } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { type ExactObserverOwnershipEvidence, ProviderRegistry } from "@station/observer/internal";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import { createUpdateRecoveryPreflightPorts } from "../../src/update/recoveryPreflightAdapters";

const now = "2026-08-21T12:00:00.000Z";
const socketPath = "/private/runtime/observer.sock";
const currentBuildIdentity = "a".repeat(64);
const currentBuildInfo = { version: "1.0.0", compiled: false, buildIdentity: currentBuildIdentity };
const identity: ObserverProcessIdentity = {
  pid: 4242,
  osStartTime: "Fri Aug 21 12:00:00 2026",
  processToken: "123e4567-e89b-42d3-a456-426614174000",
  version: `1.0.0+station.${currentBuildIdentity}`,
  socketPath,
};
const processEntry = {
  pid: identity.pid,
  argv: ["/private/bin/stn", "--token", "secret"],
  executablePath: "/private/bin/stn",
  startToken: identity.osStartTime,
  processToken: identity.processToken,
  buildVersion: identity.version,
  socketPath,
  startupTimeoutMs: 5_000,
  executableProvenance: "exact" as const,
};
const artifacts = {
  installed: { version: "1.0.0" },
  target: { version: "1.1.0+station.target" },
};

describe("createUpdateRecoveryPreflightPorts", () => {
  it("keeps stopped, stale, and unhealthy Observer evidence typed without querying recovery", async () => {
    const cases: Array<{
      evidence: ExactObserverOwnershipEvidence;
      expected: { status: string; reason?: string };
    }> = [
      {
        evidence: { status: "absent" },
        expected: { status: "absent" },
      },
      {
        evidence: { status: "blocked", reason: "stale-socket" },
        expected: { status: "unknown", reason: "stale-socket" },
      },
      {
        evidence: {
          status: "blocked",
          reason: "unhealthy",
          error: {
            tag: "ObserverConnectionError",
            code: "OBSERVER_HEALTH_FAILED",
            message: "Observer health is unavailable.",
          },
        },
        expected: { status: "unknown", reason: "unhealthy" },
      },
    ];

    for (const testCase of cases) {
      const inspectObserverOwner = vi.fn(async () => testCase.evidence);
      const ports = createUpdateRecoveryPreflightPorts({
        config: testConfig(),
        providers: providerRegistry(),
        currentBuildInfo,
        inspectObserverOwner,
        hostStatus: async () => ({
          action: "status",
          socketPath: "/private/runtime/host.sock",
          probe: "absent",
        }),
      });

      await expect(ports.inspectObserver(artifacts)).resolves.toMatchObject(testCase.expected);
      expect(inspectObserverOwner).toHaveBeenCalledOnce();
    }
  });

  it("projects complete exact inspection and redacts private Observer and Host evidence", async () => {
    const assessment = selectedAssessment();
    const inspectObserverOwner = vi.fn(async () => exactObserver(identity.version, assessment));
    const providers = providerRegistry();
    const ports = createUpdateRecoveryPreflightPorts({
      config: testConfig(),
      providers,
      currentBuildInfo,
      inspectObserverOwner,
      hostStatus: async () => ({
        action: "status",
        socketPath: "/private/runtime/host.sock",
        probe: "listening",
        health: { ok: true, protocolVersion: 8, buildVersion: "1.0.0+station.host" },
        compatibility: { action: "replace", runningBuildVersion: "1.0.0+station.host" },
        livePtyCount: 1,
        handoffEligible: true,
        ptys: [
          {
            kind: "agent",
            terminalTargetId: "terminal-a",
            worktreeId: "worktree-a",
            projectId: "project-a",
            sessionId: "session-a",
            worktreePath: "/private/worktree",
            harnessProvider: "codex",
            ptyId: "pty-a",
            ptyInstanceId: "pty-instance-a",
            pid: 9999,
            alive: true,
            cols: 80,
            rows: 24,
            handoffSupport: { kind: "non-releasable", reason: "no-bridge-transport" },
          },
        ],
      }),
    });

    const observer = await ports.inspectObserver(artifacts);
    const host = await ports.inspectHost(artifacts);
    const hook = await ports.readHookHealth("codex");

    expect(observer).toMatchObject({
      status: "exact",
      buildVersion: identity.version,
      relation: "different",
      recovery: { status: "assessed" },
    });
    expect(inspectObserverOwner).toHaveBeenCalledOnce();
    expect(host).toMatchObject({
      status: "inspected",
      relation: "different",
      terminals: [
        {
          terminalTargetId: "terminal-a",
          handoffSupport: "non-releasable",
        },
      ],
    });
    expect(hook).toEqual({ provider: "codex", status: "healthy" });
    const serialized = JSON.stringify({ observer, host, hook });
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("9999");
    expect(serialized).not.toContain("selectedHandleId");
    expect(serialized).not.toContain("recoveryHandles");
  });

  it("reports an exact live Observer process when its socket is missing", async () => {
    const ports = createUpdateRecoveryPreflightPorts({
      config: testConfig(),
      providers: providerRegistry(),
      currentBuildInfo,
      inspectObserverOwner: async () => ({ status: "blocked", reason: "process-without-socket" }),
      hostStatus: async () => ({
        action: "status",
        socketPath: "/private/runtime/host.sock",
        probe: "absent",
      }),
    });

    await expect(ports.inspectObserver(artifacts)).resolves.toMatchObject({
      status: "unknown",
      reason: "process-without-socket",
      error: { code: "UPDATE_PREFLIGHT_OBSERVER_PROCESS_WITHOUT_SOCKET" },
    });
  });

  it("returns typed unknown when exact process evidence drifts after the single API read", async () => {
    const ports = createUpdateRecoveryPreflightPorts({
      config: testConfig(),
      providers: providerRegistry(),
      currentBuildInfo,
      inspectObserverOwner: async () => ({ status: "blocked", reason: "identity-drift" }),
      hostStatus: async () => ({
        action: "status",
        socketPath: "/private/runtime/host.sock",
        probe: "absent",
      }),
    });

    await expect(ports.inspectObserver(artifacts)).resolves.toMatchObject({
      status: "unknown",
      reason: "identity-mismatch",
      error: { code: "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_DRIFT" },
    });
  });

  it("keeps unproven and older idle Host build evidence explicit", async () => {
    const targetBuildVersion = "1.1.0+station.target";
    const cases = [
      {
        health: { ok: true as const, protocolVersion: 8, buildVersion: targetBuildVersion },
        compatibility: { action: "reuse" as const },
        expected: {
          status: "inspected",
          buildVersion: targetBuildVersion,
          relation: "unknown",
          compatibility: "reuse",
          terminals: [],
        },
      },
      {
        health: { ok: true as const, protocolVersion: 8 },
        compatibility: { action: "refuse" as const, reason: "legacy-health" as const },
        expected: {
          status: "inspected",
          relation: "unknown",
          compatibility: "refuse",
          terminals: [],
        },
      },
    ];

    for (const testCase of cases) {
      const ports = createUpdateRecoveryPreflightPorts({
        config: testConfig(),
        providers: providerRegistry(),
        currentBuildInfo,
        hostStatus: async () => ({
          action: "status",
          socketPath: "/private/runtime/host.sock",
          probe: "listening",
          health: testCase.health,
          compatibility: testCase.compatibility,
          livePtyCount: 0,
          handoffEligible: true,
          ptys: [],
        }),
      });

      await expect(
        ports.inspectHost({
          installed: { version: "1.0.0" },
          target: { version: targetBuildVersion },
        }),
      ).resolves.toMatchObject(testCase.expected);
    }
  });

  it("does not equate same-version Host revisions without exact build evidence", async () => {
    const target = { version: "1.1.0", revision: "target-revision" };
    const cases = [
      {
        installed: target,
        runningBuildIdentity: currentBuildIdentity,
        expectedRelation: "matching-target",
      },
      {
        installed: { version: "1.1.0", revision: "installed-revision" },
        runningBuildIdentity: currentBuildIdentity,
        expectedRelation: "different",
      },
      {
        installed: { version: "1.1.0", revision: "installed-revision" },
        runningBuildIdentity: "unidentified-other-build",
        expectedRelation: "unknown",
      },
      {
        installed: { version: "1.1.0", revision: "installed-revision" },
        runningBuildIdentity: undefined,
        expectedRelation: "unknown",
      },
    ] as const;

    for (const testCase of cases) {
      const ports = createUpdateRecoveryPreflightPorts({
        config: testConfig(),
        providers: providerRegistry(),
        currentBuildInfo,
        hostStatus: async () => ({
          action: "status",
          socketPath: "/private/runtime/host.sock",
          probe: "listening",
          health: { ok: true, protocolVersion: 8, buildVersion: target.version },
          compatibility: { action: "reuse" },
          livePtyCount: 0,
          handoffEligible: false,
          ptys: [],
          ...(testCase.runningBuildIdentity === undefined
            ? {}
            : { buildIdentity: testCase.runningBuildIdentity }),
        }),
      });

      await expect(
        ports.inspectHost({ installed: testCase.installed, target }),
      ).resolves.toMatchObject({
        status: "inspected",
        relation: testCase.expectedRelation,
      });
    }
  });

  it.each([
    "observer",
    "host",
  ] as const)("compares %s immutable identity for same-display targets without a revision", async (runtime) => {
    const target = { version: "1.0.0" };
    const cases: ReadonlyArray<{
      runningIdentity: string | undefined;
      expectedRelation: "matching-target" | "different" | "unknown";
    }> = [
      { runningIdentity: currentBuildIdentity, expectedRelation: "matching-target" },
      ...(runtime === "host"
        ? [{ runningIdentity: undefined, expectedRelation: "unknown" as const }]
        : []),
      { runningIdentity: "different-build-identity", expectedRelation: "different" },
    ];

    for (const testCase of cases) {
      const exactObserverSelector = `1.0.0+station.${"a".repeat(64)}`;
      const observerBuildVersion =
        testCase.runningIdentity === currentBuildIdentity
          ? exactObserverSelector
          : `1.0.0+station.${"b".repeat(64)}`;
      const ports = createUpdateRecoveryPreflightPorts({
        config: testConfig(),
        providers: providerRegistry(),
        currentBuildInfo,
        inspectObserverOwner: async () => exactObserver(observerBuildVersion),
        hostStatus: async () => ({
          action: "status",
          socketPath: "/private/runtime/host.sock",
          probe: "listening",
          health: { ok: true, protocolVersion: 8, buildVersion: target.version },
          compatibility: { action: "reuse" },
          livePtyCount: 0,
          handoffEligible: false,
          ptys: [],
          ...(testCase.runningIdentity === undefined
            ? {}
            : { buildIdentity: testCase.runningIdentity }),
        }),
      });

      const evidence =
        runtime === "observer"
          ? await ports.inspectObserver({ installed: target, target })
          : await ports.inspectHost({ installed: target, target });
      expect(evidence).toMatchObject({
        status: runtime === "observer" ? "exact" : "inspected",
        relation: testCase.expectedRelation,
      });
    }
  });

  it("keeps a same-display not-yet-installed target relation conservative", async () => {
    const target = { version: "1.0.0" };
    const ports = createUpdateRecoveryPreflightPorts({
      config: testConfig(),
      providers: providerRegistry(),
      currentBuildInfo,
      hostStatus: async () => ({
        action: "status",
        socketPath: "/private/runtime/host.sock",
        probe: "listening",
        health: { ok: true, protocolVersion: 8, buildVersion: target.version },
        compatibility: { action: "replace", runningBuildVersion: target.version },
        buildIdentity: "different-build-identity",
        livePtyCount: 0,
        handoffEligible: false,
        ptys: [],
      }),
    });

    await expect(
      ports.inspectHost({ installed: { version: "0.9.0" }, target }),
    ).resolves.toMatchObject({ relation: "unknown" });
  });
});

function exactObserver(
  version: string,
  assessment: ObserverRecoveryAssessment = emptyAssessment(),
): ExactObserverOwnershipEvidence {
  const currentIdentity = { ...identity, version };
  return {
    status: "exact",
    health: {
      schemaVersion: STATION_SCHEMA_VERSION,
      status: "healthy",
      pid: currentIdentity.pid,
      startedAt: now,
      version,
      socketPath,
    },
    processIdentity: currentIdentity,
    process: { ...processEntry, buildVersion: version },
    recovery: { status: "assessed", assessment },
  };
}

function providerRegistry(): ProviderRegistry {
  const harness = Object.assign(new FakeHarnessProvider({ id: "codex" }), {
    hookHealth: async () => ({ provider: "codex" as const, status: "healthy" as const }),
  });
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider(),
    terminal: new FakeTerminalProvider(),
    harnesses: [harness],
  });
}

function testConfig() {
  return {
    ...emptyConfig(),
    observer: { socketPath },
    harness: { codex: { installHooks: true, resume: true } },
  };
}

function emptyAssessment(): ObserverRecoveryAssessment {
  return {
    schemaVersion: 1,
    inventory: { schemaVersion: 1, sessions: [], recoveryHandles: [] },
    resumeEnabled: true,
    providerCapabilities: [],
    sessions: [],
  };
}

function selectedAssessment(): ObserverRecoveryAssessment {
  return {
    schemaVersion: 1,
    inventory: {
      schemaVersion: 1,
      sessions: [
        {
          id: "session-a",
          projectId: "project-a",
          worktreeId: "worktree-a",
          lifecycle: "open",
          harnessProvider: "codex",
          createdAt: now,
          lastSeenAt: now,
        },
      ],
      recoveryHandles: [
        {
          id: "private-handle-a",
          provider: "codex",
          projectId: "project-a",
          worktreeId: "worktree-a",
          sessionId: "session-a",
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
        sessionId: "session-a",
        projectId: "project-a",
        worktreeId: "worktree-a",
        lifecycle: "open",
        harnessProvider: "codex",
        disposition: "recoverable",
        reasons: [],
        handleResolution: {
          kind: "selected",
          selectedHandleId: "private-handle-a",
          eligibleHandleCount: 1,
          rejectedHandleCount: 0,
          rejectedReasons: [],
        },
      },
    ],
  };
}
