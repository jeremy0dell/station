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

describe("createUpdateRecoveryPreflightPorts", () => {
  it("uses the shared exact verifier, pins the Observer query, and redacts Host inventory", async () => {
    const assessment = emptyAssessment();
    const getSessionRecoveryAssessment = vi.fn(async () => assessment);
    const readObserverProcess = vi.fn(() => processEntry);
    const providers = providerRegistry();
    const ports = createUpdateRecoveryPreflightPorts({
      config: testConfig(),
      providers,
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

    const observer = await ports.inspectObserver("1.1.0+station.target");
    const host = await ports.inspectHost("1.1.0+station.target");
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
  });

  it("returns typed unknown when exact process evidence drifts after the single API read", async () => {
    let reads = 0;
    const getSessionRecoveryAssessment = vi.fn(async () => emptyAssessment());
    const ports = createUpdateRecoveryPreflightPorts({
      config: testConfig(),
      providers: providerRegistry(),
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

    await expect(ports.inspectObserver("1.1.0+station.target")).resolves.toMatchObject({
      status: "unknown",
      reason: "identity-mismatch",
      error: { code: "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_DRIFT" },
    });
    expect(getSessionRecoveryAssessment).toHaveBeenCalledOnce();
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
