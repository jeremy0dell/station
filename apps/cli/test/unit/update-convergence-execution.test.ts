import type { StationConfig } from "@station/config";
import {
  HOST_PROTOCOL_VERSION,
  STATION_SCHEMA_VERSION,
  UpdateConvergencePlanningInputSchema,
  type UpdateReapRecoveryPreflight,
  UpdateReapRecoveryPreflightSchema,
  updateReapEvidenceIsComplete,
} from "@station/contracts";
import type { ProviderRegistry } from "@station/observer/internal";
import { type StationBuildInfo, stationObserverBuildVersion } from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import { createTempState } from "../../../../tests/support/temp-projects";
import { createUpdateReport } from "../../src/commands/update/report.js";
import { resolveObserverPaths } from "../../src/paths.js";
import type { PlannedUpdateChannel } from "../../src/update/channelDetection.js";
import {
  executeUpdateConvergence,
  type UpdateConvergenceExecutionInput,
} from "../../src/update/convergenceExecution.js";
import { deriveUpdateConvergencePlan } from "../../src/update/convergencePlan.js";

const buildInfo: StationBuildInfo = {
  compiled: false,
  version: "1.0.0",
  buildIdentity: "a".repeat(64),
};
const providers = {} as ProviderRegistry;

describe("executeUpdateConvergence", () => {
  it("runs hook, Observer, Host, persisted-state, and final verification in order", async () => {
    const state = await createTempState();
    const initial = preflight({
      observer: { status: "absent" },
      hooks: [{ provider: "codex", status: "needs-repair", reason: "missing" }],
    });
    const final = preflight({ observer: matchingObserver(), host: matchingHost() });
    const planning = planningInput(initial);
    const plan = deriveUpdateConvergencePlan(planning);
    const report = createUpdateReport(selectedChannel(), initial, plan);
    const events: string[] = [];
    const inspect = vi.fn().mockResolvedValue(final);
    const result = await executeUpdateConvergence(
      executionInput(state.config, initial, plan, planning, report),
      {
        inspect,
        inspectInstalled: async () => ({ version: "1.0.0" }),
        providers,
        reconcileHook: vi.fn(async () => {
          events.push("hook");
          return { provider: "codex", status: "repaired", changed: true, verified: true };
        }),
        convergeObserver: vi.fn(async () => {
          events.push("observer");
          return runningObserver(state.config);
        }),
        reconcilePersisted: vi.fn(async () => {
          events.push("persisted");
        }),
      },
    );

    expect(result).toMatchObject({ status: "current", finalInspection: { status: "completed" } });
    expect(events).toEqual(["hook", "observer", "persisted"]);
    expect(inspect).toHaveBeenCalledOnce();
    expect(report.steps.map(({ id }) => id)).toEqual([
      "detect",
      "plan",
      "apply",
      "hook-reconciliation",
      "observer-restart",
      "persisted-state-reconcile",
      "final-verification",
    ]);
  });

  it("attempts final inspection after a hook failure and performs no later mutation", async () => {
    const state = await createTempState();
    const initial = preflight({
      observer: matchingObserver(),
      host: matchingHost(),
      hooks: [
        {
          provider: "codex",
          status: "needs-repair",
          reason: "missing",
        },
      ],
    });
    const planning = planningInput(initial);
    const plan = deriveUpdateConvergencePlan(planning);
    const report = createUpdateReport(selectedChannel(), initial, plan);
    const inspect = vi.fn().mockResolvedValue(initial);
    const convergeObserver = vi.fn();
    const convergeHost = vi.fn();
    const result = await executeUpdateConvergence(
      executionInput(state.config, initial, plan, planning, report),
      {
        inspect,
        inspectInstalled: async () => ({ version: "1.0.0" }),
        providers,
        reconcileHook: vi.fn(async () => ({
          provider: "codex" as const,
          status: "write-failed" as const,
          changed: false,
          verified: false,
          error: { tag: "HarnessProviderError" as const, code: "HOOK_FAILED", message: "failed" },
          followUp: { action: "retry" as const },
        })),
        convergeObserver,
        convergeHost,
      },
    );

    expect(result.status).toBe("failed");
    expect(inspect).toHaveBeenCalledOnce();
    expect(convergeObserver).not.toHaveBeenCalled();
    expect(convergeHost).not.toHaveBeenCalled();
    expect(report.steps.at(-1)?.id).toBe("final-verification");
  });

  it("performs no runtime mutation when the selected artifact drifts after preflight", async () => {
    const state = await createTempState();
    const initial = preflight({
      observer: { status: "absent" },
      hooks: [{ provider: "codex", status: "needs-repair", reason: "missing" }],
    });
    const planning = planningInput(initial);
    const plan = deriveUpdateConvergencePlan(planning);
    const report = createUpdateReport(selectedChannel(), initial, plan);
    const reconcileHook = vi.fn();
    const convergeObserver = vi.fn();
    const convergeHost = vi.fn();

    const result = await executeUpdateConvergence(
      executionInput(state.config, initial, plan, planning, report),
      {
        inspect: vi.fn().mockResolvedValue(initial),
        inspectInstalled: async () => ({ version: "9.9.9" }),
        providers,
        reconcileHook,
        convergeObserver,
        convergeHost,
      },
    );

    expect(result.status).toBe("failed");
    expect(reconcileHook).not.toHaveBeenCalled();
    expect(convergeObserver).not.toHaveBeenCalled();
    expect(convergeHost).not.toHaveBeenCalled();
  });

  it("final-verifies the target artifact after successor transport fails", async () => {
    const state = await createTempState();
    const target = { version: "2.0.0" };
    const initial = preflight({
      installed: { version: "1.0.0" },
      target,
      observer: { status: "absent" },
      host: { status: "absent" },
    });
    const final = preflight({
      installed: target,
      target,
      observer: matchingObserver(),
      host: matchingHost(),
    });
    const planning = UpdateConvergencePlanningInputSchema.parse({
      preflight: initial,
      targetRuntime: { status: "not-yet-provable" },
      installation: {
        whenRequired: "apply",
        owner: "installer-binary",
        command: { kind: "none" },
      },
      handoff: { action: "leave-in-place" },
    });
    const plan = deriveUpdateConvergencePlan(planning);
    const report = createUpdateReport(selectedChannel("2.0.0"), initial, plan);
    const inspect = vi.fn().mockResolvedValue(final);
    const input = executionInput(state.config, initial, plan, planning, report);
    input.artifactChanged = true;
    input.apply = async () => ({
      channel: "installer-binary",
      status: "installed",
      previousVersion: "1.0.0",
      installedVersion: "2.0.0",
      successorCli: ["/opt/stn"],
      warnings: [],
    });
    input.runSuccessor = async () => {
      throw new Error("target launcher unavailable");
    };

    const result = await executeUpdateConvergence(input, {
      inspect,
      inspectInstalled: async () => target,
    });

    expect(result.status).toBe("failed");
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ currentBuildArtifact: { version: "1.0.0" }, target }),
    );
  });
});

function executionInput(
  config: StationConfig,
  initial: UpdateReapRecoveryPreflight,
  plan: ReturnType<typeof deriveUpdateConvergencePlan>,
  planning: Parameters<typeof deriveUpdateConvergencePlan>[0],
  report: ReturnType<typeof createUpdateReport>,
): UpdateConvergenceExecutionInput {
  return {
    selectedChannel: "installer-binary",
    installedScopeDigest: "b".repeat(64),
    installed: initial.installed,
    target: initial.target,
    buildInfo,
    config,
    configPath: "/tmp/config.toml",
    request: {
      mode: "apply",
      output: "json",
      packageManager: "defer",
      handoff: "processes",
      reap: false,
    },
    report,
    initial,
    plan,
    planning,
    artifactChanged: false,
  };
}

function selectedChannel(targetVersion = "1.0.0"): PlannedUpdateChannel {
  return {
    channel: "installer-binary",
    installedScopeDigest: "b".repeat(64),
    plan: {
      channel: "installer-binary",
      status: "current",
      currentVersion: "1.0.0",
      targetVersion,
      currentCli: ["/opt/stn"],
    },
    apply: vi.fn(),
    inspectInstalled: vi.fn(),
  };
}

function planningInput(preflight: UpdateReapRecoveryPreflight) {
  return UpdateConvergencePlanningInputSchema.parse({
    preflight,
    targetRuntime: {
      status: "known",
      buildIdentity: buildInfo.buildIdentity,
      observerSelector: stationObserverBuildVersion(buildInfo),
    },
    installation: {
      whenRequired: "apply",
      owner: "installer-binary",
      command: { kind: "none" },
    },
    handoff: { action: "preserve", fidelity: "processes" },
  });
}

function preflight(
  input: {
    installed?: UpdateReapRecoveryPreflight["installed"];
    target?: UpdateReapRecoveryPreflight["target"];
    observer?: unknown;
    host?: unknown;
    hooks?: readonly unknown[];
  } = {},
): UpdateReapRecoveryPreflight {
  const evidence = {
    observer: input.observer ?? { status: "absent" },
    host: input.host ?? { status: "absent" },
    hookProviderIds: input.hooks === undefined ? [] : ["codex"],
    hooks: input.hooks ?? [],
    parkedBridges: {
      status: "assessed" as const,
      totalParkedCount: 0,
      unownedParkedCount: 0,
      adoptionRequiredCount: 0,
    },
    terminalDispositions: [],
  };
  return UpdateReapRecoveryPreflightSchema.parse({
    schemaVersion: 1,
    boundary: { authorization: "none", actions: "not-included", digest: "not-included" },
    installed: input.installed ?? { version: "1.0.0" },
    target: input.target ?? { version: "1.0.0" },
    ...evidence,
    evidenceComplete: updateReapEvidenceIsComplete(evidence),
  });
}

function matchingObserver(): UpdateReapRecoveryPreflight["observer"] {
  return {
    status: "exact",
    buildVersion: stationObserverBuildVersion(buildInfo),
    relation: "matching-target",
    health: "healthy",
    recovery: {
      status: "assessed",
      assessment: { schemaVersion: 1, resumeEnabled: true, providerCapabilities: [], sessions: [] },
    },
  };
}

function matchingHost(): UpdateReapRecoveryPreflight["host"] {
  return {
    status: "inspected",
    buildVersion: buildInfo.version,
    buildIdentity: buildInfo.buildIdentity,
    protocolVersion: HOST_PROTOCOL_VERSION,
    relation: "matching-target",
    compatibility: "reuse",
    terminals: [],
  };
}

function runningObserver(config: StationConfig) {
  const paths = resolveObserverPaths(config);
  return {
    status: "running" as const,
    paths,
    health: {
      schemaVersion: STATION_SCHEMA_VERSION,
      status: "healthy" as const,
      pid: 42,
      startedAt: "2026-09-02T00:00:00.000Z",
      version: stationObserverBuildVersion(buildInfo),
      socketPath: paths.socketPath,
    },
    lifecycle: "started" as const,
  };
}
