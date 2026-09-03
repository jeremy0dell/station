import type { StationConfig } from "@station/config";
import {
  STATION_SCHEMA_VERSION,
  type UpdateReapRecoveryPreflight,
  UpdateReapRecoveryPreflightSchema,
  type UpdateSuccessorRequest,
} from "@station/contracts";
import { type StationBuildInfo, stationObserverBuildVersion } from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import { createTempState } from "../../../../tests/support/temp-projects";
import { runUpdateSuccessorCommand, type UpdateCommandDeps } from "../../src/commands/update.js";
import { resolveObserverPaths } from "../../src/paths.js";
import type { UpdateChannelProbe } from "../../src/update/channelDetection.js";
import {
  runUpdateSuccessorTransport,
  type UpdateSuccessorReceipt,
  UpdateSuccessorReceiptSchema,
} from "../../src/update/successorExecution.js";
import type { UpdatePlanBase } from "../../src/update/updateChannel.js";

const buildInfo: StationBuildInfo = {
  compiled: false,
  version: "1.0.0",
  buildIdentity: "a".repeat(64),
};

describe("update successor boundary", () => {
  it("runs a valid target request in-process and emits a bounded converged receipt", async () => {
    const state = await createTempState();
    const request = successorRequest();
    const recoveryPreflight = vi.fn(async () => targetPreflight());
    const convergeObserver = vi.fn(async () => runningObserver(state.config));
    const deps: UpdateCommandDeps = {
      buildInfo: () => buildInfo,
      probes: [targetProbe()],
      recoveryPreflight,
      convergeObserver,
    };

    const result = await runUpdateSuccessorCommand({
      stdin: JSON.stringify(request),
      options: commandOptions(state),
      deps,
    });
    const receipt = UpdateSuccessorReceiptSchema.parse(result.output);

    expect(result.code).toBe(0);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      status: "completed",
      channel: "installer-binary",
      target: { version: "1.0.0" },
      finalInspection: { status: "completed", plan: { outcome: "converged" } },
    });
    expect(recoveryPreflight).toHaveBeenCalledTimes(2);
    expect(convergeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "no-op",
        targetSelector: stationObserverBuildVersion(buildInfo),
      }),
    );
    expect(JSON.stringify(receipt)).not.toContain("socketPath");
    expect(JSON.stringify(receipt)).not.toContain("pid");
  });

  it("returns a typed failed receipt when the target build does not match the request", async () => {
    const state = await createTempState();
    const result = await runUpdateSuccessorCommand({
      stdin: JSON.stringify({ ...successorRequest(), target: { version: "1.1.0" } }),
      options: commandOptions(state),
      deps: { buildInfo: () => buildInfo, probes: [targetProbe()] },
    });
    const receipt = UpdateSuccessorReceiptSchema.parse(result.output);

    expect(result.code).toBe(1);
    expect(receipt).toMatchObject({
      status: "failed",
      finalInspection: { status: "failed" },
      error: { code: "UPDATE_SUCCESSOR_REQUEST_FAILED" },
    });
  });

  it("accepts a correlated failed receipt with only the providers reached before failure", async () => {
    const request = successorRequest({ hookProviderIds: ["claude", "codex"] });
    const receipt = failedReceipt(request, []);
    const commandRunner = vi.fn(async (input) => ({
      command: input.command,
      args: input.args ?? [],
      stdout: JSON.stringify(receipt),
      stderr: "",
      exitCode: 1,
    }));

    await expect(
      runUpdateSuccessorTransport({
        launcher: ["/opt/stn"],
        configPath: "/tmp/config.toml",
        request,
        commandRunner,
      }),
    ).resolves.toEqual(receipt);
    expect(commandRunner).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["--config", "/tmp/config.toml", "update", "--successor"] }),
    );
  });

  it.each([
    [
      "wrong target",
      (_request: UpdateSuccessorRequest, receipt: UpdateSuccessorReceipt) => ({
        ...receipt,
        target: { version: "9.9.9" },
      }),
    ],
    [
      "wrong provider",
      (_request: UpdateSuccessorRequest, receipt: UpdateSuccessorReceipt) => ({
        ...receipt,
        hookReconciliations: [
          {
            provider: "claude" as const,
            status: "inspection-failed" as const,
            changed: false,
            verified: false,
            error: { tag: "UpdateError" as const, code: "HOOK_FAILED", message: "failed" },
            followUp: { action: "run-doctor" as const },
          },
        ],
      }),
    ],
    [
      "extra key",
      (_request: UpdateSuccessorRequest, receipt: UpdateSuccessorReceipt) => ({
        ...receipt,
        privateAuthority: "forbidden",
      }),
    ],
  ] as const)("rejects %s receipts", async (_name, alter) => {
    const request = successorRequest();
    const receipt = alter(request, failedReceipt(request, []));
    const commandRunner = runnerFor(receipt, 1);

    await expect(
      runUpdateSuccessorTransport({ launcher: ["/opt/stn"], request, commandRunner }),
    ).rejects.toThrow();
  });

  it("rejects malformed, oversized, and exit-contradicting receipts", async () => {
    const request = successorRequest();
    await expect(
      runUpdateSuccessorTransport({
        launcher: ["/opt/stn"],
        request,
        commandRunner: runnerForText("not-json", 1),
      }),
    ).rejects.toThrow();
    await expect(
      runUpdateSuccessorTransport({
        launcher: ["/opt/stn"],
        request,
        commandRunner: runnerForText("x".repeat(256 * 1024 + 1), 1),
      }),
    ).rejects.toThrow(/size limit/);
    await expect(
      runUpdateSuccessorTransport({
        launcher: ["/opt/stn"],
        request,
        commandRunner: runnerFor(failedReceipt(request, []), 0),
      }),
    ).rejects.toThrow(/exit status/);
  });

  it("rejects a failed receipt whose completed final aggregate changes target", async () => {
    const state = await createTempState();
    const valid = await runUpdateSuccessorCommand({
      stdin: JSON.stringify(successorRequest()),
      options: commandOptions(state),
      deps: {
        buildInfo: () => buildInfo,
        probes: [targetProbe()],
        recoveryPreflight: vi.fn(async () => targetPreflight()),
        convergeObserver: vi.fn(async () => runningObserver(state.config)),
      },
    });
    const receipt = UpdateSuccessorReceiptSchema.parse(valid.output);
    if (receipt.finalInspection.status !== "completed") throw new Error("Expected final evidence.");
    const altered = {
      ...receipt,
      status: "failed" as const,
      finalInspection: {
        ...receipt.finalInspection,
        aggregate: { ...receipt.finalInspection.aggregate, target: { version: "9.9.9" } },
      },
    };

    await expect(
      runUpdateSuccessorTransport({
        launcher: ["/opt/stn"],
        request: successorRequest(),
        commandRunner: runnerFor(altered, 1),
      }),
    ).rejects.toThrow();
  });

  it("rejects request authority outside the strict transport schema", async () => {
    const request = { ...successorRequest(), executable: "/tmp/unsafe" } as never;
    const commandRunner = vi.fn();
    await expect(
      runUpdateSuccessorTransport({ launcher: ["/opt/stn"], request, commandRunner }),
    ).rejects.toThrow();
    expect(commandRunner).not.toHaveBeenCalled();
  });
});

function successorRequest(overrides: Partial<UpdateSuccessorRequest> = {}): UpdateSuccessorRequest {
  return {
    schemaVersion: 1,
    channel: "installer-binary",
    target: { version: "1.0.0" },
    handoff: { action: "leave-in-place" },
    hookProviderIds: [],
    ...overrides,
  };
}

function commandOptions(state: Awaited<ReturnType<typeof createTempState>>) {
  return {
    config: state.config,
    configPath: "/tmp/config.toml",
    cliEntryPath: "/repo/apps/cli/dist/main.js",
  };
}

function targetProbe(): UpdateChannelProbe {
  const plan: UpdatePlanBase = {
    channel: "installer-binary",
    status: "current",
    currentVersion: "1.0.0",
    targetVersion: "1.0.0",
    currentCli: ["/opt/stn"],
  };
  return {
    channel: "installer-binary",
    detectAndPlan: async () => ({
      channel: "installer-binary",
      plan,
      apply: async () => ({
        channel: "installer-binary",
        status: "installed" as const,
        previousVersion: "1.0.0",
        installedVersion: "1.0.0",
        warnings: [],
      }),
    }),
  };
}

function targetPreflight(): UpdateReapRecoveryPreflight {
  const observer = {
    status: "exact" as const,
    buildVersion: stationObserverBuildVersion(buildInfo),
    relation: "matching-target" as const,
    health: "healthy" as const,
    recovery: {
      status: "assessed" as const,
      assessment: {
        schemaVersion: 1 as const,
        resumeEnabled: true,
        providerCapabilities: [],
        sessions: [],
      },
    },
  };
  return UpdateReapRecoveryPreflightSchema.parse({
    schemaVersion: 1,
    boundary: { authorization: "none", actions: "not-included", digest: "not-included" },
    installed: { version: "1.0.0" },
    target: { version: "1.0.0" },
    observer,
    host: { status: "absent" },
    hookProviderIds: [],
    hooks: [],
    parkedBridges: {
      status: "assessed",
      totalParkedCount: 0,
      unownedParkedCount: 0,
      adoptionRequiredCount: 0,
    },
    terminalDispositions: [],
    evidenceComplete: true,
  });
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
    lifecycle: "reused" as const,
  };
}

function failedReceipt(
  request: UpdateSuccessorRequest,
  hookReconciliations: UpdateSuccessorReceipt["hookReconciliations"],
): UpdateSuccessorReceipt {
  const error = { tag: "UpdateError", code: "HOOK_FAILED", message: "Hook failed." } as const;
  return {
    schemaVersion: 1,
    status: "failed",
    channel: request.channel,
    target: request.target,
    actions: [],
    hookReconciliations,
    finalInspection: { status: "failed", error },
    error,
  };
}

function runnerFor(receipt: unknown, exitCode: number) {
  return runnerForText(JSON.stringify(receipt), exitCode);
}

function runnerForText(stdout: string, exitCode: number) {
  return vi.fn(async (input: { command: string; args?: string[] }) => ({
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode,
  }));
}
