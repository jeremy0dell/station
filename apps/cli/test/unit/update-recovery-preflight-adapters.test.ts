import { emptyConfig } from "@station/config";
import type { ObserverProcessIdentity, ObserverRecoveryAssessment } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { ProviderRegistry } from "@station/observer/internal";
import type { createObserverClient } from "@station/protocol";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import { planUpdateConvergence } from "../../src/update/convergencePlan.js";
import { inspectUpdateConvergencePreflight } from "../../src/update/recoveryPreflight.js";
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
  executableProvenance: "exact" as const,
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
        currentObserverBuildVersion: identity.version,
        observerStatus: async () => testCase.status,
        readObserverIdentity,
        observerDeps: { clientFactory },
        inspectHost: async () => ({ status: "absent" }),
      });

      await expect(
        ports.inspectObserver(artifacts).then((inspection) => inspection.evidence),
      ).resolves.toMatchObject(testCase.expected);
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
      inspectHost: async () => ({
        status: "inspected",
        protocolVersion: 8,
        buildVersion: "1.0.0+station.host",
        relation: "different",
        compatibility: "replace",
        terminals: [
          {
            kind: "agent",
            terminalTargetId: "terminal-a",
            worktreeId: "worktree-a",
            projectId: "project-a",
            sessionId: "session-a",
            harnessProvider: "codex",
            ptyId: "pty-a",
            ptyInstanceId: "pty-instance-a",
            alive: true,
            handoffSupport: "non-releasable",
          },
        ],
      }),
    });

    const observerInspection = await ports.inspectObserver(artifacts);
    const observer = observerInspection.evidence;
    const host = await ports.inspectHost(artifacts);
    const hook = await ports.readHookHealth("codex");

    expect(observer).toMatchObject({
      status: "exact",
      buildVersion: identity.version,
      relation: "different",
      replacementAdmission: "not-yet-provable",
      recovery: { status: "assessed" },
    });
    expect(readObserverProcess).toHaveBeenCalledTimes(2);
    expect(getSessionRecoveryAssessment).toHaveBeenCalledOnce();
    expect(observerInspection.privateEvidence).toEqual({
      observer: {
        pid: identity.pid,
        osStartTime: identity.osStartTime,
        processToken: identity.processToken,
        buildSelector: identity.version,
        socketPath: identity.socketPath,
      },
      selectedRecoveryHandles: [{ sessionId: "session-a", selectedHandleId: "private-handle-a" }],
    });
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
      currentObserverBuildVersion: identity.version,
      observerStatus: async () => ({ status: "stopped", paths: observerPaths() }),
      readObserverIdentity: async () => identity,
      observerIdentitySource: {
        processStartToken: () => identity.osStartTime,
        readObserverProcess: () => processEntry,
      },
      observerDeps: { clientFactory },
      inspectHost: async () => ({ status: "absent" }),
    });

    await expect(
      ports.inspectObserver(artifacts).then((inspection) => inspection.evidence),
    ).resolves.toMatchObject({
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
      inspectHost: async () => ({ status: "absent" }),
    });

    await expect(
      ports.inspectObserver(artifacts).then((inspection) => inspection.evidence),
    ).resolves.toMatchObject({
      status: "unknown",
      reason: "identity-mismatch",
      error: { code: "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_DRIFT" },
    });
    expect(getSessionRecoveryAssessment).toHaveBeenCalledOnce();
  });

  it("admits only a same- or higher-build explicit restart after installed executable drift", async () => {
    const incumbentBuild = `1.0.0+station.${"a".repeat(64)}`;
    const candidateBuild = `1.1.0+station.${"b".repeat(64)}`;
    const incumbentIdentity = { ...identity, version: incumbentBuild };
    const health = {
      schemaVersion: STATION_SCHEMA_VERSION,
      status: "healthy" as const,
      pid: identity.pid,
      startedAt: now,
      version: incumbentBuild,
      socketPath,
    };
    const replacedProcess = {
      ...processEntry,
      executableProvenance: "installed-path-replaced" as const,
      buildVersion: incumbentBuild,
    };
    const makePorts = (
      currentObserverBuildVersion: string,
      readObserverProcess: () => typeof replacedProcess | undefined = () => replacedProcess,
    ) =>
      createUpdateRecoveryPreflightPorts({
        config: testConfig(),
        providers: providerRegistry(),
        currentObserverBuildVersion,
        observerStatus: async () => ({ status: "running", paths: observerPaths(), health }),
        readObserverIdentity: async () => incumbentIdentity,
        observerIdentitySource: {
          processStartToken: () => incumbentIdentity.osStartTime,
          readObserverProcess,
        },
        inspectHost: async () => ({ status: "absent" }),
      });

    const restartable = await makePorts(candidateBuild).inspectObserver({
      installed: { version: "1.1.0" },
      target: { version: "1.1.0" },
    });
    expect(restartable).toMatchObject({
      evidence: {
        status: "unknown",
        reason: "restartable-executable-drift",
        buildVersion: incumbentBuild,
        error: { code: "UPDATE_PREFLIGHT_OBSERVER_EXECUTABLE_DRIFT_RESTARTABLE" },
      },
      privateEvidence: {
        observer: {
          pid: identity.pid,
          processToken: identity.processToken,
          buildSelector: incumbentBuild,
          socketPath: identity.socketPath,
        },
        selectedRecoveryHandles: [],
      },
    });
    expect(JSON.stringify(restartable.evidence)).not.toContain(identity.processToken);

    await expect(
      makePorts(`0.9.0+station.${"0".repeat(64)}`)
        .inspectObserver(artifacts)
        .then((inspection) => inspection.evidence),
    ).resolves.toMatchObject({
      status: "unknown",
      reason: "identity-mismatch",
      error: { code: "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_MISMATCH" },
    });

    await expect(
      makePorts(candidateBuild, () => undefined)
        .inspectObserver(artifacts)
        .then((inspection) => inspection.evidence),
    ).resolves.toMatchObject({
      status: "unknown",
      reason: "identity-unavailable",
      error: { code: "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_UNAVAILABLE" },
    });

    const genericDrift = Object.assign(new Error("argv changed"), {
      tag: "ObserverProcessEvidenceError",
      code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
      message: "Observer process evidence did not match exact argv.",
    });
    await expect(
      makePorts(candidateBuild, () => {
        throw genericDrift;
      })
        .inspectObserver(artifacts)
        .then((inspection) => inspection.evidence),
    ).resolves.toMatchObject({
      status: "unknown",
      reason: "identity-mismatch",
      error: { code: "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_MISMATCH" },
    });
  });

  it("compares an Observer immutable selector when the installed target has no revision", async () => {
    const currentArtifacts = {
      installed: { version: "1.0.0" },
      target: { version: "1.0.0" },
    };
    const cases = [
      {
        runningBuildSelector: `1.0.0+station.${"a".repeat(64)}`,
        currentBuildSelector: `1.0.0+station.${"a".repeat(64)}`,
        expectedRelation: "matching-target",
        expectedAdmission: "exact-build",
      },
      {
        runningBuildSelector: `1.0.0+station.${"a".repeat(64)}`,
        currentBuildSelector: `1.0.0+station.${"b".repeat(64)}`,
        expectedRelation: "different",
        expectedAdmission: "candidate-wins",
      },
      {
        runningBuildSelector: `1.0.0+station.${"b".repeat(64)}`,
        currentBuildSelector: `1.0.0+station.${"a".repeat(64)}`,
        expectedRelation: "different",
        expectedAdmission: "refused",
      },
      {
        runningBuildSelector: `1.1.0+station.${"b".repeat(64)}`,
        currentBuildSelector: `1.0.0+station.${"a".repeat(64)}`,
        expectedRelation: "different",
        expectedAdmission: "incumbent-wins",
      },
    ] as const;

    for (const testCase of cases) {
      const ports = exactObserverPorts({
        currentObserverBuildVersion: testCase.currentBuildSelector,
        runningBuildVersion: testCase.runningBuildSelector,
      });

      await expect(
        ports.inspectObserver(currentArtifacts).then((inspection) => inspection.evidence),
      ).resolves.toMatchObject({
        status: "exact",
        relation: testCase.expectedRelation,
        replacementAdmission: testCase.expectedAdmission,
      });
    }
  });

  it("carries a newer incumbent singleton decision from aggregate inspection into the plan", async () => {
    const buildIdentity = "a".repeat(64);
    const selected = { version: "1.0.0" };
    const ports = exactObserverPorts({
      currentObserverBuildVersion: `1.0.0+station.${buildIdentity}`,
      runningBuildVersion: `1.1.0+station.${"b".repeat(64)}`,
    });
    const inspection = await inspectUpdateConvergencePreflight({
      installed: selected,
      target: selected,
      ports,
    });
    const plan = planUpdateConvergence({
      selectedTarget: {
        artifact: selected,
        buildIdentity: { status: "known", value: buildIdentity },
      },
      installation: { owner: "installer-binary", action: "no-op" },
      preflight: inspection.preflight,
    });

    expect(inspection.preflight.observer).toMatchObject({
      status: "exact",
      relation: "different",
      replacementAdmission: "incumbent-wins",
    });
    expect(plan).toMatchObject({
      status: "blocked",
      components: { observer: { action: "blocked", reason: "singleton-refused" } },
    });
  });
});

function exactObserverPorts(input: {
  currentObserverBuildVersion: string;
  runningBuildVersion: string;
}) {
  const runningIdentity = { ...identity, version: input.runningBuildVersion };
  return createUpdateRecoveryPreflightPorts({
    config: testConfig(),
    providers: providerRegistry(),
    currentObserverBuildVersion: input.currentObserverBuildVersion,
    observerStatus: async () => ({
      status: "running",
      paths: observerPaths(),
      health: {
        schemaVersion: STATION_SCHEMA_VERSION,
        status: "healthy",
        pid: runningIdentity.pid,
        startedAt: now,
        version: input.runningBuildVersion,
        socketPath,
      },
    }),
    readObserverIdentity: async () => runningIdentity,
    observerIdentitySource: {
      processStartToken: () => runningIdentity.osStartTime,
      readObserverProcess: () => ({
        ...processEntry,
        buildVersion: input.runningBuildVersion,
      }),
    },
    observerDeps: {
      clientFactory: () =>
        ({
          getSessionRecoveryAssessment: async () => emptyAssessment(),
        }) as ReturnType<typeof createObserverClient>,
    },
    inspectHost: async () => ({ status: "absent" }),
  });
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
