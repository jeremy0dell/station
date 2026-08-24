import { emptyConfig } from "@station/config";
import type { ObserverProcessIdentity, ObserverRecoveryAssessment } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { ProviderRegistry } from "@station/observer/internal";
import type { createObserverClient } from "@station/protocol";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import { createUpdateRecoveryPreflightPorts } from "../../src/update/recoveryPreflightAdapters";

const now = "2026-08-21T12:00:00.000Z";
const socketPath = "/private/runtime/observer.sock";
const identity: ObserverProcessIdentity = {
  pid: 4242,
  osStartTime: "Fri Aug 21 12:00:00 2026",
  processToken: "123e4567-e89b-42d3-a456-426614174000",
  version: "1.0.0+station.observer",
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
};
const artifacts = {
  installed: { version: "1.0.0" },
  target: { version: "1.1.0+station.target" },
};

describe("createUpdateRecoveryPreflightPorts", () => {
  it("keeps stopped, stale, and unhealthy Observer evidence typed without querying recovery", async () => {
    const cases = [
      {
        status: { status: "stopped" as const, paths: observerPaths() },
        expected: { status: "absent" },
      },
      {
        status: { status: "stale" as const, paths: observerPaths() },
        expected: { status: "unknown", reason: "stale-socket" },
      },
      {
        status: {
          status: "unhealthy" as const,
          paths: observerPaths(),
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
      const readObserverIdentity = vi.fn(async () =>
        testCase.status.status === "stopped" ? undefined : identity,
      );
      const clientFactory = vi.fn();
      const ports = createUpdateRecoveryPreflightPorts({
        config: testConfig(),
        providers: providerRegistry(),
        currentBuildIdentity: "current-build-identity",
        currentObserverBuildVersion: identity.version,
        observerStatus: async () => testCase.status,
        readObserverIdentity,
        observerDeps: { clientFactory },
        hostStatus: async () => ({
          action: "status",
          socketPath: "/private/runtime/host.sock",
          probe: "absent",
        }),
      });

      await expect(ports.inspectObserver(artifacts)).resolves.toMatchObject(testCase.expected);
      expect(readObserverIdentity).toHaveBeenCalledTimes(
        testCase.status.status === "stopped" ? 1 : 0,
      );
      expect(clientFactory).not.toHaveBeenCalled();
    }
  });

  it("uses the shared exact verifier, pins the Observer query, and redacts Host inventory", async () => {
    const assessment = selectedAssessment();
    const getSessionRecoveryAssessment = vi.fn(async () => assessment);
    const readObserverProcess = vi.fn(() => processEntry);
    const providers = providerRegistry();
    const ports = createUpdateRecoveryPreflightPorts({
      config: testConfig(),
      providers,
      currentBuildIdentity: "current-build-identity",
      currentObserverBuildVersion: identity.version,
      observerStatus: async () => ({
        status: "running",
        paths: observerPaths(),
        health: {
          schemaVersion: STATION_SCHEMA_VERSION,
          status: "healthy",
          pid: identity.pid,
          startedAt: now,
          version: identity.version,
          socketPath,
        },
      }),
      readObserverIdentity: async () => identity,
      observerIdentitySource: {
        processStartToken: () => identity.osStartTime,
        readObserverProcess,
      },
      observerDeps: {
        clientFactory: () =>
          ({ getSessionRecoveryAssessment }) as ReturnType<typeof createObserverClient>,
      },
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
    expect(readObserverProcess).toHaveBeenCalledTimes(2);
    expect(getSessionRecoveryAssessment).toHaveBeenCalledOnce();
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
    const clientFactory = vi.fn();
    const ports = createUpdateRecoveryPreflightPorts({
      config: testConfig(),
      providers: providerRegistry(),
      currentBuildIdentity: "current-build-identity",
      currentObserverBuildVersion: identity.version,
      observerStatus: async () => ({ status: "stopped", paths: observerPaths() }),
      readObserverIdentity: async () => identity,
      observerIdentitySource: {
        processStartToken: () => identity.osStartTime,
        readObserverProcess: () => processEntry,
      },
      observerDeps: { clientFactory },
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
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("returns typed unknown when exact process evidence drifts after the single API read", async () => {
    let reads = 0;
    const getSessionRecoveryAssessment = vi.fn(async () => emptyAssessment());
    const ports = createUpdateRecoveryPreflightPorts({
      config: testConfig(),
      providers: providerRegistry(),
      currentBuildIdentity: "current-build-identity",
      currentObserverBuildVersion: identity.version,
      observerStatus: async () => ({
        status: "running",
        paths: observerPaths(),
        health: {
          schemaVersion: STATION_SCHEMA_VERSION,
          status: "healthy",
          pid: identity.pid,
          startedAt: now,
          version: identity.version,
          socketPath,
        },
      }),
      readObserverIdentity: async () => identity,
      observerIdentitySource: {
        processStartToken: () => identity.osStartTime,
        readObserverProcess: () => {
          reads += 1;
          return reads === 1 ? processEntry : { ...processEntry, processToken: "drifted-token" };
        },
      },
      observerDeps: {
        clientFactory: () =>
          ({ getSessionRecoveryAssessment }) as ReturnType<typeof createObserverClient>,
      },
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
    expect(getSessionRecoveryAssessment).toHaveBeenCalledOnce();
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
        currentBuildIdentity: "current-build-identity",
        currentObserverBuildVersion: identity.version,
        observerStatus: async () => ({ status: "stopped", paths: observerPaths() }),
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
        runningBuildIdentity: "current-build-identity",
        expectedRelation: "matching-target",
      },
      {
        installed: { version: "1.1.0", revision: "installed-revision" },
        runningBuildIdentity: "current-build-identity",
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
        currentBuildIdentity: "current-build-identity",
        currentObserverBuildVersion: identity.version,
        observerStatus: async () => ({ status: "stopped", paths: observerPaths() }),
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
    const cases = [
      { runningIdentity: "current-build-identity", expectedRelation: "matching-target" },
      { runningIdentity: undefined, expectedRelation: "unknown" },
      { runningIdentity: "different-build-identity", expectedRelation: "different" },
    ] as const;

    for (const testCase of cases) {
      const exactObserverSelector = `1.0.0+station.${"a".repeat(64)}`;
      const observerBuildVersion =
        testCase.runningIdentity === "current-build-identity"
          ? exactObserverSelector
          : testCase.runningIdentity === undefined
            ? "1.0.0"
            : `1.0.0+station.${"b".repeat(64)}`;
      const ports = createUpdateRecoveryPreflightPorts({
        config: testConfig(),
        providers: providerRegistry(),
        currentBuildIdentity: "current-build-identity",
        currentObserverBuildVersion: exactObserverSelector,
        observerStatus: async () => ({
          status: "running",
          paths: observerPaths(),
          health: {
            schemaVersion: STATION_SCHEMA_VERSION,
            status: "healthy",
            pid: identity.pid,
            startedAt: now,
            version: observerBuildVersion,
            socketPath,
          },
        }),
        readObserverIdentity: async () => ({ ...identity, version: observerBuildVersion }),
        observerIdentitySource: {
          processStartToken: () => identity.osStartTime,
          readObserverProcess: () => ({ ...processEntry, buildVersion: observerBuildVersion }),
        },
        observerDeps: {
          clientFactory: () =>
            ({ getSessionRecoveryAssessment: async () => emptyAssessment() }) as ReturnType<
              typeof createObserverClient
            >,
        },
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
      currentBuildIdentity: "current-build-identity",
      currentObserverBuildVersion: "current-build-identity",
      observerStatus: async () => ({ status: "stopped", paths: observerPaths() }),
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

function observerPaths() {
  return {
    socketPath,
    stateDir: "/private/runtime/state",
    dbPath: "/private/runtime/state/observer.sqlite",
    logDir: "/private/runtime/state/logs",
    diagnosticsDir: "/private/runtime/state/diagnostics",
    hookSpoolDir: "/private/runtime/state/hooks",
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
