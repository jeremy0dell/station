import { stationHostSocketPath } from "@station/config";
import { HOST_PROTOCOL_VERSION, type StationHostInspectionResult } from "@station/contracts";
import { stationHostSafeError } from "@station/host";
import { describe, expect, it, vi } from "vitest";
import { createTempState } from "../../../../tests/support/temp-projects";
import { runHostCommand } from "../../src/commands/host/index.js";

const requestingBuild = "0.0.0-cli-request";
const targetIdentity = "b".repeat(64);
const incumbentIdentity = "a".repeat(64);
type ExactEvidence = Extract<StationHostInspectionResult, { status: "exact" }>["evidence"];

const terminal = {
  kind: "agent" as const,
  terminalTargetId: "target-1",
  ptyId: "pty-1",
  ptyInstanceId: "instance-1",
  worktreeId: "worktree-1",
  projectId: "project-1",
  sessionId: "session-1",
  worktreePath: "/repo/one",
  harnessProvider: "codex",
  pid: 42,
  alive: true,
  cols: 80,
  rows: 24,
  handoffSupport: { kind: "bridge-releasable" as const },
};

function exactEvidence(
  socketPath: string,
  buildVersion = "older-build",
  buildIdentity = incumbentIdentity,
  terminals: readonly (typeof terminal)[] = [terminal],
): ExactEvidence {
  return {
    endpoint: { socketPath, ino: 11n, birthtimeNs: 22n },
    health: { ok: true, protocolVersion: HOST_PROTOCOL_VERSION, buildVersion },
    buildIdentity,
    terminals: [...terminals],
  };
}

describe("runHostCommand", () => {
  it("reports exact status, compatibility, identity, and handoff eligibility", async () => {
    const fixture = await createTempState();
    const socketPath = stationHostSocketPath(fixture.config);
    const inspection = exactEvidence(socketPath);
    const inspectHost = vi.fn(async () => ({ status: "exact" as const, evidence: inspection }));

    const result = await runHostCommand(
      ["status"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        expectedBuildIdentity: targetIdentity,
        inspectHost,
      },
    );

    expect(result).toMatchObject({
      action: "status",
      probe: "listening",
      livePtyCount: 1,
      handoffEligible: true,
      compatibility: { action: "replace", runningBuildVersion: "older-build" },
      buildIdentity: incumbentIdentity,
      ptys: [{ handoffSupport: { kind: "bridge-releasable" } }],
    });
    expect(inspectHost).toHaveBeenCalledWith({
      socketPath,
      expectedBuildVersion: requestingBuild,
    });
  });

  it("marks same-display/different-identity live ownership eligible while retaining compatibility reuse", async () => {
    const fixture = await createTempState();
    const socketPath = stationHostSocketPath(fixture.config);
    const result = await runHostCommand(
      ["status"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        expectedBuildIdentity: targetIdentity,
        inspectHost: async () => ({
          status: "exact",
          evidence: exactEvidence(socketPath, requestingBuild, incumbentIdentity),
        }),
      },
    );
    expect(result).toMatchObject({
      action: "status",
      compatibility: { action: "reuse" },
      handoffEligible: true,
    });
  });

  it("fails closed on incomplete exact inspection without a host.list fallback", async () => {
    const fixture = await createTempState();
    const result = await runHostCommand(
      ["status"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        expectedBuildIdentity: targetIdentity,
        inspectHost: async () => ({
          status: "unknown",
          reason: "inventory-failed",
          error: stationHostSafeError("HOST_BAD_REQUEST", "unknown method"),
        }),
      },
    );
    expect(result).toMatchObject({
      action: "status",
      probe: "listening",
      error: "unknown method",
    });
    expect(result).not.toHaveProperty("buildIdentity");
    expect(result).not.toHaveProperty("ptys");
  });

  it("dry-run plans an eligible handoff using inspection only", async () => {
    const fixture = await createTempState();
    const socketPath = stationHostSocketPath(fixture.config);
    const convergeHost = vi.fn();
    const resolveHostCommand = vi.fn();
    const result = await runHostCommand(
      ["handoff", "--dry-run", "--fidelity", "screen"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        expectedBuildIdentity: targetIdentity,
        inspectHost: async () => ({ status: "exact", evidence: exactEvidence(socketPath) }),
        convergeHost,
        resolveHostCommand,
      },
    );

    expect(result).toMatchObject({
      action: "handoff",
      dryRun: true,
      fidelity: "screen",
      status: "planned",
      livePtyCount: 1,
      message:
        "Would beginHandoff(fidelity=screen) → completeHandoff → spawn successor → adoptRegistry.",
    });
    expect(convergeHost).not.toHaveBeenCalled();
    expect(resolveHostCommand).not.toHaveBeenCalled();
  });

  it("dry-run refuses only an exact incumbent/target pair as unnecessary", async () => {
    const fixture = await createTempState();
    const socketPath = stationHostSocketPath(fixture.config);
    const convergeHost = vi.fn();
    const result = await runHostCommand(
      ["handoff", "--dry-run"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        expectedBuildIdentity: targetIdentity,
        inspectHost: async () => ({
          status: "exact",
          evidence: exactEvidence(socketPath, requestingBuild, targetIdentity),
        }),
        convergeHost,
      },
    );
    expect(result).toMatchObject({
      action: "handoff",
      status: "refused",
      message: "Host already matches this build; handoff is unnecessary.",
    });
    expect(convergeHost).not.toHaveBeenCalled();
  });

  it("preserves protocol-mismatch dry-run refusal text", async () => {
    const fixture = await createTempState();
    const result = await runHostCommand(
      ["handoff", "--dry-run"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        expectedBuildIdentity: targetIdentity,
        inspectHost: async () => ({
          status: "unknown",
          reason: "health-failed",
          error: stationHostSafeError("HOST_VERSION_INCOMPATIBLE", "protocol mismatch"),
        }),
      },
    );
    expect(result).toMatchObject({
      action: "handoff",
      status: "refused",
      message: "Host protocol is incompatible; live handoff is refused.",
    });
  });

  it("dry-run refuses an exact empty incumbent without mutation", async () => {
    const fixture = await createTempState();
    const socketPath = stationHostSocketPath(fixture.config);
    const convergeHost = vi.fn();
    const resolveHostCommand = vi.fn();
    const result = await runHostCommand(
      ["handoff", "--dry-run"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        expectedBuildIdentity: targetIdentity,
        inspectHost: async () => ({
          status: "exact",
          evidence: exactEvidence(socketPath, "older-build", incumbentIdentity, []),
        }),
        convergeHost,
        resolveHostCommand,
      },
    );
    expect(result).toMatchObject({ action: "handoff", status: "refused", livePtyCount: 0 });
    expect(convergeHost).not.toHaveBeenCalled();
    expect(resolveHostCommand).not.toHaveBeenCalled();
  });

  it("delegates live handoff to convergence and projects only receipt PTY IDs", async () => {
    const fixture = await createTempState();
    const socketPath = stationHostSocketPath(fixture.config);
    const incumbent = exactEvidence(socketPath);
    const successor = exactEvidence(socketPath, requestingBuild, targetIdentity);
    const convergeHost = vi.fn(async () => ({
      status: "completed" as const,
      action: "handoff" as const,
      targetBuild: { buildVersion: requestingBuild, buildIdentity: targetIdentity },
      finalEvidence: successor,
      handoffReceipt: {
        fidelity: "screen" as const,
        terminals: [
          {
            terminalTargetId: terminal.terminalTargetId,
            ptyId: terminal.ptyId,
            ptyInstanceId: terminal.ptyInstanceId,
          },
        ],
      },
    }));
    const result = await runHostCommand(
      ["handoff", "--fidelity", "screen"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        expectedBuildIdentity: targetIdentity,
        now: () => 1_000,
        inspectHost: async () => ({ status: "exact", evidence: incumbent }),
        resolveHostCommand: () => ["station-host", "serve"],
        convergeHost: convergeHost as never,
      },
    );

    expect(result).toEqual({
      action: "handoff",
      dryRun: false,
      fidelity: "screen",
      socketPath,
      status: "completed",
      message: "Live handoff completed; successor adopted 1 terminal(s).",
      livePtyCount: 1,
      adopted: ["pty-1"],
    });
    expect(convergeHost).toHaveBeenCalledWith({
      command: {
        action: "handoff",
        targetBuild: { buildVersion: requestingBuild, buildIdentity: targetIdentity },
        socketPath,
        expected: incumbent,
        deadlineMs: 13_000,
        fidelity: "screen",
      },
      targetBuild: { buildVersion: requestingBuild, buildIdentity: targetIdentity },
      socketPath,
      stateDir: expect.any(String),
      hostCommand: ["station-host", "serve"],
    });
  });

  it("retains the refused result after successful internal idle replacement", async () => {
    const fixture = await createTempState();
    const socketPath = stationHostSocketPath(fixture.config);
    const incumbent = exactEvidence(socketPath, "older-build", incumbentIdentity, []);
    const successor = exactEvidence(socketPath, requestingBuild, targetIdentity, []);
    const result = await runHostCommand(
      ["handoff"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        expectedBuildIdentity: targetIdentity,
        inspectHost: async () => ({ status: "exact", evidence: incumbent }),
        resolveHostCommand: () => ["station-host"],
        convergeHost: async (options) => {
          expect(options.command).toMatchObject({ action: "replace-idle", expected: incumbent });
          return {
            status: "completed",
            action: "replace-idle",
            targetBuild: { buildVersion: requestingBuild, buildIdentity: targetIdentity },
            finalEvidence: successor,
          };
        },
      },
    );
    expect(result).toEqual({
      action: "handoff",
      dryRun: false,
      fidelity: "processes",
      socketPath,
      status: "refused",
      message: "Host is idle; ordinary stop-if-idle replacement ran instead of handoff.",
      livePtyCount: 0,
    });
  });

  it("surfaces convergence failure without claiming completion", async () => {
    const fixture = await createTempState();
    const socketPath = stationHostSocketPath(fixture.config);
    const failure = stationHostSafeError(
      "HOST_HANDOFF_INVALID_STATE",
      "handoff could not complete",
    );
    const result = await runHostCommand(
      ["handoff"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        expectedBuildIdentity: targetIdentity,
        inspectHost: async () => ({ status: "exact", evidence: exactEvidence(socketPath) }),
        resolveHostCommand: () => ["station-host"],
        convergeHost: async () => ({
          status: "failed",
          action: "handoff",
          targetBuild: { buildVersion: requestingBuild, buildIdentity: targetIdentity },
          phase: "incumbent-release",
          incumbentDisposition: "preserved",
          terminalDisposition: "incumbent",
          recoveryAuthority: "none",
          terminalRecovery: [
            {
              terminalTargetId: terminal.terminalTargetId,
              ptyId: terminal.ptyId,
              ptyInstanceId: terminal.ptyInstanceId,
              lastProvenDisposition: "incumbent",
            },
          ],
          error: failure,
        }),
      },
    );
    expect(result).toMatchObject({
      action: "handoff",
      status: "unavailable",
      message: "handoff could not complete",
    });
  });

  it("refuses ineligible terminals before resolving or mutating", async () => {
    const fixture = await createTempState();
    const socketPath = stationHostSocketPath(fixture.config);
    const convergeHost = vi.fn();
    const resolveHostCommand = vi.fn();
    const result = await runHostCommand(
      ["handoff"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        expectedBuildIdentity: targetIdentity,
        inspectHost: async () => ({
          status: "exact",
          evidence: exactEvidence(socketPath, "older-build", incumbentIdentity, [
            {
              ...terminal,
              handoffSupport: { kind: "non-releasable", reason: "release-unsupported" },
            },
          ] as never),
        }),
        convergeHost,
        resolveHostCommand,
      },
    );
    expect(result).toMatchObject({ action: "handoff", status: "refused", livePtyCount: 1 });
    expect(convergeHost).not.toHaveBeenCalled();
    expect(resolveHostCommand).not.toHaveBeenCalled();
  });
});
