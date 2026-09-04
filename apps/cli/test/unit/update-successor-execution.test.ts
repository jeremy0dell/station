import type { StationConfig } from "@station/config";
import {
  HOST_PROTOCOL_VERSION,
  STATION_SCHEMA_VERSION,
  UpdateConvergencePlanningInputSchema,
  type UpdateReapRecoveryPreflight,
  UpdateReapRecoveryPreflightSchema,
  type UpdateSuccessorRequest,
} from "@station/contracts";
import { type StationBuildInfo, stationObserverBuildVersion } from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";
import { runCli } from "../../src/cliExecution.js";
import { runUpdateSuccessorCommand, type UpdateCommandDeps } from "../../src/commands/update.js";
import { resolveObserverPaths } from "../../src/paths.js";
import type { UpdateChannelProbe } from "../../src/update/channelDetection.js";
import { deriveUpdateConvergencePlan } from "../../src/update/convergencePlan.js";
import type { UpdateReapJournalPort } from "../../src/update/reapJournal.js";
import {
  createUpdateSuccessorTransportKey,
  runUpdateSuccessorTransport,
  sealUpdateSuccessorOutput,
  UPDATE_SUCCESSOR_PRIVATE_ENV,
  UPDATE_SUCCESSOR_REAP_LOCK_ENV,
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

  it("converges from local installed ownership without repeating target planning", async () => {
    const state = await createTempState();
    const probe = targetProbe();
    const inspectInstalled = vi.fn(async () => ({ version: "1.0.0" }));
    const detectAndPlan = vi.fn(async () => {
      throw new Error("target feed is offline");
    });
    probe.inspectInstalled = inspectInstalled;
    probe.detectAndPlan = detectAndPlan;

    const result = await runUpdateSuccessorCommand({
      stdin: JSON.stringify(successorRequest()),
      options: commandOptions(state),
      deps: {
        buildInfo: () => buildInfo,
        probes: [probe],
        recoveryPreflight: vi.fn(async () => targetPreflight()),
        convergeObserver: vi.fn(async () => runningObserver(state.config)),
      },
    });

    expect(result).toMatchObject({ code: 0, output: { status: "completed" } });
    expect(inspectInstalled).toHaveBeenCalledTimes(4);
    expect(detectAndPlan).not.toHaveBeenCalled();
  });

  it("runs no-handoff convergence without replacing the incumbent Host", async () => {
    const state = await createTempState();
    const request = successorRequest();
    const recoveryPreflight = vi.fn(async () => noHandoffPreflight());
    const convergeHost = vi.fn();

    const result = await runUpdateSuccessorCommand({
      stdin: JSON.stringify(request),
      options: commandOptions(state),
      deps: {
        buildInfo: () => buildInfo,
        probes: [targetProbe()],
        recoveryPreflight,
        convergeObserver: vi.fn(async () => runningObserver(state.config)),
        convergeHost,
      },
    });
    const receipt = UpdateSuccessorReceiptSchema.parse(result.output);

    expect(result.code).toBe(0);
    expect(receipt).toMatchObject({
      status: "completed",
      finalInspection: { status: "completed", plan: { outcome: "intentionally-incomplete" } },
      actions: expect.arrayContaining([
        expect.objectContaining({ id: "apply", status: "skipped" }),
        expect.objectContaining({ id: "hook-reconciliation", status: "completed" }),
        expect.objectContaining({ id: "observer-restart", status: "completed" }),
        expect.objectContaining({ id: "host-handoff", status: "skipped" }),
        expect.objectContaining({ id: "final-verification", status: "completed" }),
      ]),
    });
    expect(recoveryPreflight).toHaveBeenCalledTimes(2);
    expect(convergeHost).not.toHaveBeenCalled();
  });

  it("encrypts private successor stdout and consumes its one-shot environment key", async () => {
    const state = await createTempState();
    const configPath = await writeConfigToml(state.root, state.config);
    const request = successorRequest();
    const env = { [UPDATE_SUCCESSOR_PRIVATE_ENV]: createUpdateSuccessorTransportKey() };
    const convergeObserver = vi.fn(async () => {
      expect(env[UPDATE_SUCCESSOR_PRIVATE_ENV]).toBeUndefined();
      return runningObserver(state.config);
    });

    const result = await runCli(["--config", configPath, "update", "--successor"], {
      env,
      stdin: JSON.stringify(request),
      updateDeps: {
        buildInfo: () => buildInfo,
        probes: [targetProbe()],
        recoveryPreflight: vi.fn(async () => noHandoffPreflight()),
        convergeObserver,
      },
    });

    const output = JSON.stringify(result.output);
    expect(result).toMatchObject({ code: 0, output: { algorithm: "aes-256-gcm" } });
    expect(env[UPDATE_SUCCESSOR_PRIVATE_ENV]).toBeUndefined();
    expect(convergeObserver).toHaveBeenCalledOnce();
    for (const privateId of ["target-1", "pty-1", "project-1", "worktree-1", "session-1"]) {
      expect(output).not.toContain(privateId);
    }
  });

  it("encrypts failures that occur before successor capability composition", async () => {
    const state = await createTempState();
    const configPath = await writeConfigToml(state.root, state.config);
    const env = { [UPDATE_SUCCESSOR_PRIVATE_ENV]: createUpdateSuccessorTransportKey() };

    const result = await runCli(["--config", configPath, "update", "--successor"], {
      env,
      stdin: JSON.stringify(successorRequest()),
      updateDeps: {
        buildInfo: () => {
          throw new Error("private-path-/Users/example");
        },
      },
    });

    const output = JSON.stringify(result.output);
    expect(result).toMatchObject({ code: 1, output: { algorithm: "aes-256-gcm" } });
    expect(output).not.toContain("private-path");
    expect(output).not.toContain("Users");
    expect(env[UPDATE_SUCCESSOR_PRIVATE_ENV]).toBeUndefined();
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
    const commandRunner = runnerFor(receipt, 1);

    await expect(
      runUpdateSuccessorTransport({
        launcher: ["/opt/stn"],
        configPath: "/tmp/config.toml",
        request,
        commandRunner,
      }),
    ).resolves.toEqual(receipt);
    expect(commandRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["--config", "/tmp/config.toml", "update", "--successor"],
        env: {
          [UPDATE_SUCCESSOR_PRIVATE_ENV]: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        },
      }),
    );
  });

  it("passes the reap lock transfer token only through the private successor environment", async () => {
    const request = successorRequest({
      reapContinuation: { journalId: "00000000-0000-4000-8000-000000000001" },
    });
    const commandRunner = runnerFor(
      {
        ...failedReceipt(request, []),
        reapRecovery: {
          status: "completed",
          terminals: [],
          unresolved: false,
          recoveryCommands: [],
        },
      },
      1,
    );
    const transferToken = "00000000-0000-4000-8000-000000000099";

    await runUpdateSuccessorTransport({
      launcher: ["/opt/stn"],
      request,
      reapLockTransferToken: transferToken,
      commandRunner,
    });

    expect(commandRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ [UPDATE_SUCCESSOR_REAP_LOCK_ENV]: transferToken }),
      }),
    );
    expect(JSON.stringify(request)).not.toContain(transferToken);
  });

  it("takes over the parent lock before reading a reap continuation journal", async () => {
    const transferToken = "00000000-0000-4000-8000-000000000099";
    const takeOverLock = vi.fn<UpdateReapJournalPort["takeOverLock"]>(async (token, run) => {
      expect(token).toBe(transferToken);
      return run({
        prepareTransfer: async () => "00000000-0000-4000-8000-000000000098",
        release: async () => undefined,
      });
    });
    const reapJournal: UpdateReapJournalPort = {
      findIncomplete: async () => undefined,
      read: async () => {
        throw new Error("journal read reached");
      },
      write: async () => undefined,
      withLock: async () => {
        throw new Error("successor must not acquire a new lock");
      },
      takeOverLock,
    };

    const result = await runUpdateSuccessorCommand({
      stdin: JSON.stringify(
        successorRequest({
          reapContinuation: { journalId: "00000000-0000-4000-8000-000000000001" },
        }),
      ),
      options: commandOptions(await createTempState()),
      reapLockTransferToken: transferToken,
      deps: {
        buildInfo: () => buildInfo,
        probes: [targetProbe()],
        recoveryPreflight: async () => targetPreflight(),
        reapJournal,
      },
    });

    expect(takeOverLock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ code: 1, output: { status: "failed" } });
  });

  it("rejects a completed receipt whose final aggregate drops requested providers", async () => {
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
    const request = successorRequest({ hookProviderIds: ["codex"] });
    const altered = {
      ...receipt,
      hookReconciliations: [
        { provider: "codex" as const, status: "healthy" as const, changed: false, verified: true },
      ],
    };

    await expect(
      runUpdateSuccessorTransport({
        launcher: ["/opt/stn"],
        request,
        commandRunner: runnerFor(altered, 0),
      }),
    ).rejects.toThrow(/final aggregate/);
  });

  it("correlates reap recovery to an opaque continuation request", async () => {
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
    const reapRecovery = {
      status: "completed" as const,
      terminals: [],
      unresolved: false,
      recoveryCommands: [],
    };

    await expect(
      runUpdateSuccessorTransport({
        launcher: ["/opt/stn"],
        request: successorRequest(),
        commandRunner: runnerFor({ ...receipt, reapRecovery }, 0),
      }),
    ).rejects.toThrow(/correlate/);
    await expect(
      runUpdateSuccessorTransport({
        launcher: ["/opt/stn"],
        request: successorRequest({
          reapContinuation: { journalId: "00000000-0000-4000-8000-000000000001" },
        }),
        commandRunner: runnerFor(receipt, 0),
      }),
    ).rejects.toThrow(/correlate/);
  });

  it("rejects a completed plan that was not derived from its final aggregate", async () => {
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
      finalInspection: {
        ...receipt.finalInspection,
        aggregate: {
          ...receipt.finalInspection.aggregate,
          observer: { status: "absent" as const },
          evidenceComplete: false,
        },
      },
    };

    await expect(
      runUpdateSuccessorTransport({
        launcher: ["/opt/stn"],
        request: successorRequest(),
        commandRunner: runnerFor(altered, 0),
      }),
    ).rejects.toThrow(/not derived/);
  });

  it("rejects a completed no-handoff receipt with unfinished Observer convergence", async () => {
    const state = await createTempState();
    const request = successorRequest();
    const valid = await runUpdateSuccessorCommand({
      stdin: JSON.stringify(request),
      options: commandOptions(state),
      deps: {
        buildInfo: () => buildInfo,
        probes: [targetProbe()],
        recoveryPreflight: vi.fn(async () => noHandoffPreflight()),
        convergeObserver: vi.fn(async () => runningObserver(state.config)),
      },
    });
    const receipt = UpdateSuccessorReceiptSchema.parse(valid.output);
    if (receipt.finalInspection.status !== "completed") throw new Error("Expected final evidence.");
    const aggregate = {
      ...receipt.finalInspection.aggregate,
      observer: { ...receipt.finalInspection.aggregate.observer, health: "degraded" as const },
    };
    const planning = UpdateConvergencePlanningInputSchema.parse({
      preflight: aggregate,
      targetRuntime: receipt.finalInspection.plan.selectedTarget.runtimeBuild,
      installation: {
        whenRequired: "apply",
        owner: request.channel,
        command: { kind: "none" },
      },
      handoff: request.handoff,
    });
    const altered = {
      ...receipt,
      finalInspection: {
        status: "completed" as const,
        aggregate,
        plan: deriveUpdateConvergencePlan(planning),
      },
    };

    await expect(
      runUpdateSuccessorTransport({
        launcher: ["/opt/stn"],
        request,
        commandRunner: runnerFor(altered, 0),
      }),
    ).rejects.toThrow(/leave only Host convergence incomplete/);
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
        commandRunner: runnerForText("x".repeat(384 * 1024 + 1), 1),
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

  it("rejects schema-valid receipt fields whose serialized receipt exceeds the transport", () => {
    const request = successorRequest();
    const error = {
      tag: "UpdateError",
      code: "UPDATE_FAILED",
      message: "x".repeat(300 * 1024),
    } as const;
    const parsed = UpdateSuccessorReceiptSchema.safeParse({
      ...failedReceipt(request, []),
      finalInspection: { status: "failed", error },
      error,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toContain("size limit");
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
    installedScopeDigest: "b".repeat(64),
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
    inspectInstalled: async () => ({ version: "1.0.0" }),
    detectAndPlan: async () => ({
      channel: "installer-binary",
      installedScopeDigest: "b".repeat(64),
      plan,
      inspectInstalled: async () => ({ version: "1.0.0" }),
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

function noHandoffPreflight(): UpdateReapRecoveryPreflight {
  return UpdateReapRecoveryPreflightSchema.parse({
    ...targetPreflight(),
    host: {
      status: "inspected",
      buildVersion: "0.9.0",
      buildIdentity: "b".repeat(64),
      protocolVersion: HOST_PROTOCOL_VERSION,
      relation: "different",
      compatibility: "replace",
      terminals: [
        {
          kind: "agent",
          terminalTargetId: "target-1",
          ptyId: "pty-1",
          ptyInstanceId: "instance-1",
          projectId: "project-1",
          worktreeId: "worktree-1",
          sessionId: "session-1",
          harnessProvider: "codex",
          alive: true,
          handoffSupport: "bridge-releasable",
        },
      ],
    },
    terminalDispositions: [
      {
        terminalTargetId: "target-1",
        ptyId: "pty-1",
        ptyInstanceId: "instance-1",
        sessionId: "session-1",
        handoff: "preservable",
        reapRecovery: "non-resumable",
        reasons: ["retained_session_missing"],
      },
    ],
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
    parkedTerminals: [],
    finalInspection: { status: "failed", error },
    error,
  };
}

function runnerFor(receipt: unknown, exitCode: number) {
  return vi.fn(
    async (input: {
      command: string;
      args?: string[];
      env?: Record<string, string | undefined>;
    }) => {
      const transportKey = input.env?.[UPDATE_SUCCESSOR_PRIVATE_ENV];
      if (transportKey === undefined) throw new Error("Expected successor transport key.");
      return {
        command: input.command,
        args: input.args ?? [],
        stdout: JSON.stringify(sealUpdateSuccessorOutput(receipt, transportKey)),
        stderr: "",
        exitCode,
      };
    },
  );
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
