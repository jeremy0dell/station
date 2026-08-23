import { emptyConfig } from "@station/config";
import type { UpdateHostConvergenceCommitment } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { createUpdateHostRuntimeAdapter } from "../../src/update/updateHostRuntimeAdapter.js";

const identityA = "a".repeat(64);
const identityB = "b".repeat(64);

describe("update Host runtime adapter", () => {
  it("keeps target-version-only and legacy Host build evidence unknown", async () => {
    const cases = [
      {
        health: { ok: true as const, protocolVersion: 8, buildVersion: "1.1.0" },
        compatibility: { action: "reuse" as const },
        expected: { buildVersion: "1.1.0", relation: "unknown", compatibility: "refuse" },
      },
      {
        health: { ok: true as const, protocolVersion: 8 },
        compatibility: { action: "refuse" as const, reason: "legacy-health" as const },
        expected: { relation: "unknown", compatibility: "refuse" },
      },
    ];

    for (const testCase of cases) {
      const adapter = createUpdateHostRuntimeAdapter(
        { config: emptyConfig(), buildInfo: () => build("1.1.0", identityA) },
        {
          inspectHost: async () => ({
            socketPath: "/private/host.sock",
            probe: "listening",
            health: testCase.health,
            compatibility: testCase.compatibility,
            ptys: [],
          }),
        },
      );

      await expect(
        adapter.inspect({ installed: { version: "1.0.0" }, target: { version: "1.1.0" } }),
      ).resolves.toMatchObject({ status: "inspected", terminals: [], ...testCase.expected });
    }
  });

  it("compares immutable identity for same-version targets with and without revisions", async () => {
    const cases = [
      {
        installed: { version: "1.0.0" },
        target: { version: "1.0.0" },
        runningBuildIdentity: identityA,
        expectedRelation: "matching-target",
      },
      {
        installed: { version: "1.0.0" },
        target: { version: "1.0.0" },
        runningBuildIdentity: identityB,
        expectedRelation: "different",
      },
      {
        installed: { version: "1.0.0" },
        target: { version: "1.0.0" },
        runningBuildIdentity: undefined,
        expectedRelation: "unknown",
      },
      {
        installed: { version: "1.0.0", revision: "old" },
        target: { version: "1.0.0", revision: "new" },
        runningBuildIdentity: identityA,
        expectedRelation: "different",
      },
      {
        installed: { version: "1.0.0", revision: "old" },
        target: { version: "1.0.0", revision: "new" },
        runningBuildIdentity: identityB,
        expectedRelation: "unknown",
      },
    ] as const;

    for (const testCase of cases) {
      const adapter = createUpdateHostRuntimeAdapter(
        { config: emptyConfig(), buildInfo: () => build("1.0.0", identityA) },
        {
          inspectHost: async () => ({
            socketPath: "/private/host.sock",
            probe: "listening",
            health: { ok: true, protocolVersion: 8, buildVersion: "1.0.0" },
            compatibility: { action: "reuse" },
            ptys: [],
            ...(testCase.runningBuildIdentity === undefined
              ? {}
              : { buildIdentity: testCase.runningBuildIdentity }),
          }),
        },
      );

      await expect(
        adapter.inspect({ installed: testCase.installed, target: testCase.target }),
      ).resolves.toMatchObject({ status: "inspected", relation: testCase.expectedRelation });
    }
  });

  it("supplies the exact planned target build and immutable inventory to the typed mutation", async () => {
    const commitment = hostCommitment();
    const convergeHost = vi.fn(async (options) => ({
      schemaVersion: 1 as const,
      action: "update-converge" as const,
      requestedAction: options.command.action,
      ...(options.command.action === "handoff"
        ? { requestedFidelity: options.command.fidelity }
        : {}),
      status: "completed" as const,
      receipt: {
        ensuredBy: "handoff" as const,
        fidelity: options.command.action === "handoff" ? options.command.fidelity : "processes",
        validatedCommitment: options.command.commitment,
        actualInventory: options.command.commitment.incumbent.inventory,
        handoffReceipt: options.command.commitment.incumbent.inventory,
      },
    }));
    const adapter = createUpdateHostRuntimeAdapter(
      { config: emptyConfig(), buildInfo: () => build("2.0.0", identityB) },
      { convergeHost: convergeHost as never, resolveHostCommand: () => ["/opt/stn-host"] },
    );

    await expect(adapter.handoffHost("screen", commitment)).resolves.toMatchObject({
      status: "completed",
      receipt: { ensuredBy: "handoff", validatedCommitment: commitment },
    });
    expect(convergeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        hostCommand: ["/opt/stn-host"],
        command: { schemaVersion: 1, action: "handoff", fidelity: "screen", commitment },
      }),
      expect.anything(),
    );
  });

  it("refuses a mutation before Host access when the evaluator build is not the selected target", async () => {
    const convergeHost = vi.fn();
    const adapter = createUpdateHostRuntimeAdapter(
      { config: emptyConfig(), buildInfo: () => build("1.0.0", identityA) },
      { convergeHost },
    );

    await expect(
      adapter.replaceIdleHost({ ...hostCommitment(), incumbent: idleIncumbent() }),
    ).resolves.toMatchObject({
      status: "stale",
      error: { code: "HOST_CONVERGENCE_PLAN_DRIFT" },
    });
    expect(convergeHost).not.toHaveBeenCalled();
  });
});

function build(version: string, buildIdentity: string) {
  return { version, buildIdentity, compiled: true };
}

function hostCommitment(): UpdateHostConvergenceCommitment {
  return {
    incumbent: {
      buildVersion: { status: "known", value: "1.0.0" },
      buildIdentity: { status: "known", value: identityA },
      protocolVersion: 8,
      inventory: {
        terminals: [
          {
            terminalTargetId: "terminal-1",
            ptyId: "pty-1",
            ptyInstanceId: "pty-instance-1",
            sessionId: "session-1",
          },
        ],
      },
    },
    target: { buildVersion: "2.0.0", buildIdentity: identityB },
  };
}

function idleIncumbent(): UpdateHostConvergenceCommitment["incumbent"] {
  return {
    buildVersion: { status: "known", value: "1.0.0" },
    buildIdentity: { status: "known", value: identityA },
    protocolVersion: 8,
    inventory: { terminals: [] },
  };
}
