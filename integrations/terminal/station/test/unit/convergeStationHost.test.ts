import {
  HOST_PROTOCOL_VERSION,
  PtyBridgeProtocolVersion,
  StationHostConvergenceCommandSchema,
  type StationHostExactEvidence,
} from "@station/contracts";
import { type StationHostLifecycleSession, stationHostSafeError } from "@station/host";
import { describe, expect, it, vi } from "vitest";
import {
  convergeStationHost,
  type ExecuteStationHostConvergenceInput,
  executeStationHostConvergence,
  type StationHostConvergencePorts,
} from "../../src/host/convergeStationHost.js";

const socketPath = "/state/station-host.sock";
const targetBuild = { buildVersion: "2.0.0", buildIdentity: "b".repeat(64) };
const incumbentEndpoint = { socketPath, ino: 11n, birthtimeNs: 12n };
const targetEndpoint = { socketPath, ino: 21n, birthtimeNs: 22n };
const terminal: StationHostExactEvidence["terminals"][number] = {
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

function evidence(
  buildVersion: string,
  buildIdentity: string,
  endpoint = incumbentEndpoint,
  terminals: StationHostExactEvidence["terminals"] = [terminal],
): StationHostExactEvidence {
  return {
    endpoint,
    health: { ok: true, protocolVersion: HOST_PROTOCOL_VERSION, buildVersion },
    buildIdentity,
    terminals: [...terminals],
  };
}

const liveExpected = evidence("1.0.0", "a".repeat(64));
const idleExpected = evidence("1.0.0", "a".repeat(64), incumbentEndpoint, []);
const successorLive = evidence(targetBuild.buildVersion, targetBuild.buildIdentity, targetEndpoint);
const successorIdle = evidence(
  targetBuild.buildVersion,
  targetBuild.buildIdentity,
  targetEndpoint,
  [],
);

type TerminalLifetime = StationHostExactEvidence["terminals"][number];
const terminalFactDrifts: ReadonlyArray<
  [name: string, mutate: (value: TerminalLifetime) => TerminalLifetime]
> = [
  ["kind", (value) => ({ ...value, kind: "aux" })],
  ["worktreeId", (value) => ({ ...value, worktreeId: "worktree-wrong" })],
  ["projectId", (value) => ({ ...value, projectId: "project-wrong" })],
  ["sessionId", (value) => ({ ...value, sessionId: "session-wrong" })],
  ["worktreePath", (value) => ({ ...value, worktreePath: "/repo/wrong" })],
  ["harnessProvider", (value) => ({ ...value, harnessProvider: "claude" })],
  ["pid", (value) => ({ ...value, pid: value.pid + 1 })],
  ["alive", (value) => ({ ...value, alive: false })],
  ["cols", (value) => ({ ...value, cols: value.cols + 1 })],
  ["rows", (value) => ({ ...value, rows: value.rows + 1 })],
  [
    "handoffSupport",
    (value) => ({
      ...value,
      handoffSupport: { kind: "non-releasable", reason: "release-unsupported" },
    }),
  ],
];

function command(action: "replace-idle" | "handoff") {
  return StationHostConvergenceCommandSchema.parse(
    action === "handoff"
      ? {
          action,
          targetBuild,
          socketPath,
          expected: liveExpected,
          fidelity: "processes",
          deadlineMs: 10_000,
        }
      : {
          action,
          targetBuild,
          socketPath,
          expected: idleExpected,
          deadlineMs: 10_000,
        },
  );
}

function lifecycle(
  overrides: Partial<StationHostLifecycleSession> = {},
): StationHostLifecycleSession {
  return {
    health: vi.fn(async () => liveExpected.health),
    recoveryInventory: vi.fn(async () => ({ buildIdentity: targetBuild.buildIdentity, ptys: [] })),
    stopIfIdle: vi.fn(async () => ({ stopping: true as const })),
    beginHandoff: vi.fn(async () => ({
      status: "accepted" as const,
      result: {
        manifest: validManifest(),
        fidelity: "processes" as const,
        released: [terminal.ptyId],
        skipped: [],
      },
    })),
    completeHandoff: vi.fn(async () => ({ stopping: true as const })),
    abortHandoff: vi.fn(async () => ({ adopted: [terminal.ptyId], failed: [] })),
    adoptRegistry: vi.fn(async () => ({ adopted: [terminal.ptyId], failed: [] })),
    dispose: vi.fn(),
    ...overrides,
  };
}

function validManifest() {
  return {
    [terminal.ptyId]: {
      bridgeProtocolVersion: PtyBridgeProtocolVersion,
      bridgePid: 900,
      controlSocket: "/state/pty-1.sock",
      command: "/bin/zsh",
      cols: terminal.cols,
      rows: terminal.rows,
      ptyInstanceId: terminal.ptyInstanceId,
      identity: {
        kind: terminal.kind,
        terminalTargetId: terminal.terminalTargetId,
        worktreeId: terminal.worktreeId,
        projectId: terminal.projectId,
        sessionId: terminal.sessionId,
        worktreePath: terminal.worktreePath,
        harnessProvider: terminal.harnessProvider,
      },
    },
  };
}

function portsFor(input: {
  incumbent: StationHostLifecycleSession;
  target?: StationHostLifecycleSession;
  incumbentEvidence?: StationHostExactEvidence;
  targetEvidence?: StationHostExactEvidence;
  finalEvidence?: StationHostExactEvidence;
  startResult?: Awaited<ReturnType<StationHostConvergencePorts["startTarget"]>>;
}) {
  const target = input.target ?? lifecycle();
  const openSession = vi.fn(async () => input.incumbent);
  const probeEndpoint = vi.fn(async () => ({ status: "absent" as const }));
  const readEvidence = vi.fn(async (session: StationHostLifecycleSession) =>
    session === input.incumbent
      ? (input.incumbentEvidence ?? liveExpected)
      : (input.targetEvidence ?? successorLive),
  );
  const startTarget = vi.fn(
    async (startInput: Parameters<StationHostConvergencePorts["startTarget"]>[0]) => {
      if (input.startResult !== undefined) return input.startResult;
      await startInput.validate?.(target);
      return {
        status: "transferred" as const,
        endpoint: targetEndpoint,
        health: successorIdle.health,
        session: target,
      };
    },
  );
  const inspectTarget = vi.fn(async () => ({
    status: "exact" as const,
    evidence: input.finalEvidence ?? successorLive,
  }));
  return {
    ports: {
      openSession,
      probeEndpoint,
      readEvidence,
      startTarget,
      inspectTarget,
      now: () => 1_000,
    } satisfies StationHostConvergencePorts,
    target,
  };
}

const executeInput = (action: "replace-idle" | "handoff"): ExecuteStationHostConvergenceInput => ({
  command: command(action),
  stateDir: "/state",
  hostCommand: ["stn", "host", "serve"] as const,
  detached: true,
});

describe("exact Station Host convergence", () => {
  it("atomically replaces the exact empty incumbent and independently proves its successor", async () => {
    const incumbent = lifecycle();
    const setup = portsFor({
      incumbent,
      incumbentEvidence: idleExpected,
      finalEvidence: successorIdle,
    });

    await expect(
      executeStationHostConvergence(executeInput("replace-idle"), setup.ports),
    ).resolves.toEqual({
      status: "completed",
      action: "replace-idle",
      targetBuild,
      finalEvidence: successorIdle,
    });
    expect(incumbent.stopIfIdle).toHaveBeenCalledWith(targetBuild.buildVersion);
    expect(incumbent.beginHandoff).not.toHaveBeenCalled();
    expect(setup.ports.startTarget).toHaveBeenCalledOnce();
    expect(setup.ports.inspectTarget).toHaveBeenCalledWith(targetBuild.buildVersion, 10_000);
  });

  it("waits through same-endpoint shutdown uncertainty before proving departure", async () => {
    const incumbent = lifecycle();
    const setup = portsFor({
      incumbent,
      incumbentEvidence: idleExpected,
      finalEvidence: successorIdle,
    });
    setup.ports.probeEndpoint
      .mockResolvedValueOnce({
        status: "inaccessible",
        endpoint: incumbentEndpoint,
        error: stationHostSafeError("HOST_UNREACHABLE", "closing"),
      })
      .mockResolvedValueOnce({ status: "absent" });

    await expect(
      executeStationHostConvergence(executeInput("replace-idle"), setup.ports),
    ).resolves.toMatchObject({ status: "completed" });
    expect(setup.ports.probeEndpoint).toHaveBeenCalledTimes(2);
    expect(setup.ports.startTarget).toHaveBeenCalledOnce();
  });

  it("refuses a different stale endpoint during incumbent departure", async () => {
    const incumbent = lifecycle();
    const setup = portsFor({
      incumbent,
      incumbentEvidence: idleExpected,
      finalEvidence: successorIdle,
    });
    setup.ports.probeEndpoint.mockResolvedValueOnce({
      status: "stale",
      endpoint: targetEndpoint,
    });

    await expect(
      executeStationHostConvergence(executeInput("replace-idle"), setup.ports),
    ).resolves.toMatchObject({
      status: "failed",
      phase: "incumbent-release",
      error: { code: "HOST_UNREACHABLE" },
    });
    expect(setup.ports.startTarget).not.toHaveBeenCalled();
  });

  it("snapshots command and spawn inputs before the first await", async () => {
    const incumbent = lifecycle();
    const setup = portsFor({
      incumbent,
      incumbentEvidence: idleExpected,
      finalEvidence: successorIdle,
    });
    const gate = Promise.withResolvers<void>();
    setup.ports.openSession.mockImplementationOnce(async () => {
      await gate.promise;
      return incumbent;
    });
    const input = executeInput("replace-idle");
    const pending = executeStationHostConvergence(input, setup.ports);

    input.command.targetBuild.buildVersion = "mutated";
    input.stateDir = "/mutated";
    (input.hostCommand as unknown as string[])[0] = "mutated";
    input.detached = false;
    gate.resolve();

    await expect(pending).resolves.toMatchObject({ status: "completed", targetBuild });
    expect(setup.ports.startTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        stateDir: "/state",
        hostCommand: ["stn", "host", "serve"],
        detached: true,
        expectedBuildVersion: targetBuild.buildVersion,
      }),
    );
  });

  it("validates, completes, adopts, and proves a live manifest on pinned sessions", async () => {
    const incumbent = lifecycle();
    const target = lifecycle();
    const setup = portsFor({ incumbent, target });

    const result = await executeStationHostConvergence(executeInput("handoff"), setup.ports);
    expect(result).toMatchObject({
      status: "completed",
      action: "handoff",
      targetBuild,
      handoffReceipt: {
        fidelity: "processes",
        terminals: [
          {
            terminalTargetId: terminal.terminalTargetId,
            ptyId: terminal.ptyId,
            ptyInstanceId: terminal.ptyInstanceId,
          },
        ],
      },
      finalEvidence: successorLive,
    });
    expect(incumbent.beginHandoff).toHaveBeenCalledWith(targetBuild.buildVersion, "processes");
    expect(incumbent.completeHandoff).toHaveBeenCalledOnce();
    expect(target.adoptRegistry).toHaveBeenCalledWith(validManifest());
    expect(setup.ports.readEvidence).toHaveBeenCalledWith(target, targetEndpoint, 10_000);
  });

  it.each(
    terminalFactDrifts,
  )("refuses target-session successor evidence with drifted %s despite matching lifetime ids", async (_field, mutate) => {
    const incumbent = lifecycle();
    const target = lifecycle();
    const drifted = evidence(targetBuild.buildVersion, targetBuild.buildIdentity, targetEndpoint, [
      mutate(terminal),
    ]);
    const setup = portsFor({ incumbent, target, targetEvidence: drifted });

    await expect(
      executeStationHostConvergence(executeInput("handoff"), setup.ports),
    ).resolves.toMatchObject({
      status: "failed",
      phase: "adoption",
      incumbentDisposition: "released",
      terminalDisposition: "parked",
      error: { code: "HOST_TARGET_CONFLICT" },
    });
    expect(target.dispose).toHaveBeenCalledOnce();
    expect(setup.ports.inspectTarget).not.toHaveBeenCalled();
  });

  it("refuses independently inspected successor facts that drift after pinned validation", async () => {
    const incumbent = lifecycle();
    const finalEvidence = evidence(
      targetBuild.buildVersion,
      targetBuild.buildIdentity,
      targetEndpoint,
      [{ ...terminal, pid: terminal.pid + 1 }],
    );
    const setup = portsFor({ incumbent, finalEvidence });

    await expect(
      executeStationHostConvergence(executeInput("handoff"), setup.ports),
    ).resolves.toMatchObject({
      status: "failed",
      phase: "final-verification",
      incumbentDisposition: "released",
      terminalDisposition: "successor",
      lastExactEvidence: { source: "independent-inspection", evidence: finalEvidence },
      error: { code: "HOST_TARGET_CONFLICT" },
    });
  });

  it("reports an idle incumbent mutation as unknown when stop delivery is ambiguous", async () => {
    const incumbent = lifecycle({
      stopIfIdle: vi.fn(async () => {
        throw stationHostSafeError("HOST_REQUEST_FAILED", "response lost");
      }),
    });
    const setup = portsFor({ incumbent, incumbentEvidence: idleExpected });

    await expect(
      executeStationHostConvergence(executeInput("replace-idle"), setup.ports),
    ).resolves.toMatchObject({
      status: "failed",
      phase: "incumbent-release",
      incumbentDisposition: "unknown",
      terminalDisposition: "none",
      lastExactEvidence: { source: "incumbent-session", evidence: idleExpected },
    });
    expect(setup.ports.startTarget).not.toHaveBeenCalled();
  });

  it("reports terminal ownership as unknown when begin delivery is ambiguous", async () => {
    const incumbent = lifecycle({
      beginHandoff: vi.fn(async () => {
        throw stationHostSafeError("HOST_REQUEST_FAILED", "response lost");
      }),
    });
    const setup = portsFor({ incumbent });

    await expect(
      executeStationHostConvergence(executeInput("handoff"), setup.ports),
    ).resolves.toMatchObject({
      status: "failed",
      phase: "incumbent-release",
      incumbentDisposition: "unknown",
      terminalDisposition: "unknown",
      terminalRecovery: [
        {
          terminalTargetId: terminal.terminalTargetId,
          ptyId: terminal.ptyId,
          ptyInstanceId: terminal.ptyInstanceId,
          lastProvenDisposition: "unknown",
        },
      ],
      lastExactEvidence: { source: "incumbent-session", evidence: liveExpected },
    });
    expect(incumbent.abortHandoff).not.toHaveBeenCalled();
    expect(setup.ports.startTarget).not.toHaveBeenCalled();
  });

  it("aborts malformed successful begin only on the incumbent and reports restored evidence", async () => {
    const incumbent = lifecycle({
      beginHandoff: vi.fn(async () => ({
        status: "malformed-success" as const,
        error: stationHostSafeError("HOST_REQUEST_FAILED", "malformed"),
      })),
    });
    const setup = portsFor({ incumbent });

    const result = await executeStationHostConvergence(executeInput("handoff"), setup.ports);
    expect(result).toMatchObject({
      status: "failed",
      phase: "incumbent-release",
      incumbentDisposition: "preserved",
      terminalDisposition: "incumbent",
      recoveryAuthority: "none",
      lastExactEvidence: { source: "incumbent-session", evidence: liveExpected },
    });
    expect(incumbent.abortHandoff).toHaveBeenCalledOnce();
    expect(setup.ports.startTarget).not.toHaveBeenCalled();
    expect(setup.ports.inspectTarget).not.toHaveBeenCalled();
  });

  it("restores after mismatched successful manifest evidence", async () => {
    const incumbent = lifecycle({
      beginHandoff: vi.fn(async () => ({
        status: "accepted" as const,
        result: {
          manifest: {
            ...validManifest(),
            [terminal.ptyId]: {
              ...validManifest()[terminal.ptyId],
              cols: terminal.cols + 1,
            },
          },
          fidelity: "processes" as const,
          released: [terminal.ptyId],
          skipped: [],
        },
      })),
    });
    const setup = portsFor({ incumbent });

    const result = await executeStationHostConvergence(executeInput("handoff"), setup.ports);
    expect(result).toMatchObject({
      status: "failed",
      incumbentDisposition: "preserved",
      terminalDisposition: "incumbent",
      error: { code: "HOST_HANDOFF_MANIFEST_INVALID" },
    });
    expect(incumbent.abortHandoff).toHaveBeenCalledOnce();
    expect(incumbent.completeHandoff).not.toHaveBeenCalled();
  });

  it("uses at most one independent recovery inspection when session restoration is unproved", async () => {
    const incumbent = lifecycle({
      beginHandoff: vi.fn(async () => ({
        status: "malformed-success" as const,
        error: stationHostSafeError("HOST_REQUEST_FAILED", "malformed"),
      })),
      abortHandoff: vi.fn(async () => ({ adopted: [], failed: [{ ptyId: "pty-1", reason: "x" }] })),
    });
    const setup = portsFor({ incumbent, finalEvidence: liveExpected });

    const result = await executeStationHostConvergence(executeInput("handoff"), setup.ports);
    expect(result).toMatchObject({
      status: "failed",
      incumbentDisposition: "preserved",
      lastExactEvidence: { source: "independent-inspection", evidence: liveExpected },
    });
    expect(setup.ports.inspectTarget).toHaveBeenCalledOnce();
    expect(setup.ports.startTarget).not.toHaveBeenCalled();
  });

  it("preserves the transferred successor when adoption acknowledgement is partial", async () => {
    const incumbent = lifecycle();
    const target = lifecycle({
      adoptRegistry: vi.fn(async () => ({
        adopted: [],
        failed: [{ ptyId: terminal.ptyId, reason: "failed" }],
      })),
    });
    const setup = portsFor({ incumbent, target });

    const result = await executeStationHostConvergence(executeInput("handoff"), setup.ports);
    expect(result).toMatchObject({
      status: "failed",
      phase: "adoption",
      incumbentDisposition: "released",
      terminalDisposition: "parked",
      lastExactEvidence: { source: "target-session", evidence: successorIdle },
    });
    expect(target.dispose).toHaveBeenCalledOnce();
    expect(setup.ports.inspectTarget).not.toHaveBeenCalled();
  });

  it("admits a concurrent exact winner only after a settled spawned loser", async () => {
    const incumbent = lifecycle();
    const winner = lifecycle();
    const loser = stationHostSafeError("HOST_TARGET_CONFLICT", "lost");
    const setup = portsFor({
      incumbent,
      incumbentEvidence: idleExpected,
      finalEvidence: successorIdle,
      startResult: { status: "failed", error: loser, childDisposition: "settled" },
    });
    setup.ports.openSession.mockResolvedValueOnce(incumbent).mockResolvedValueOnce(winner);
    setup.ports.probeEndpoint
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "listening", endpoint: targetEndpoint });
    setup.ports.readEvidence.mockImplementation(async (session) =>
      session === incumbent ? idleExpected : successorIdle,
    );

    await expect(
      executeStationHostConvergence(executeInput("replace-idle"), setup.ports),
    ).resolves.toMatchObject({
      status: "completed",
      finalEvidence: successorIdle,
    });
    expect(setup.ports.openSession).toHaveBeenCalledTimes(2);
    expect(winner.dispose).toHaveBeenCalledOnce();
  });

  it("refuses a concurrent winner that reuses lifetime ids with drifted terminal facts", async () => {
    const incumbent = lifecycle();
    const winner = lifecycle();
    const loser = stationHostSafeError("HOST_TARGET_CONFLICT", "lost");
    const drifted = evidence(targetBuild.buildVersion, targetBuild.buildIdentity, targetEndpoint, [
      { ...terminal, pid: terminal.pid + 1 },
    ]);
    const setup = portsFor({
      incumbent,
      startResult: { status: "failed", error: loser, childDisposition: "settled" },
    });
    setup.ports.openSession.mockResolvedValueOnce(incumbent).mockResolvedValueOnce(winner);
    setup.ports.probeEndpoint
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "listening", endpoint: targetEndpoint });
    setup.ports.readEvidence.mockImplementation(async (session) =>
      session === incumbent ? liveExpected : drifted,
    );

    await expect(
      executeStationHostConvergence(executeInput("handoff"), setup.ports),
    ).resolves.toMatchObject({
      status: "failed",
      phase: "target-start",
      lastExactEvidence: { source: "target-session", evidence: drifted },
      error: { code: "HOST_TARGET_CONFLICT" },
    });
    expect(winner.adoptRegistry).not.toHaveBeenCalled();
    expect(winner.dispose).toHaveBeenCalledOnce();
    expect(setup.ports.inspectTarget).not.toHaveBeenCalled();
  });

  it("never inspects or signals a possible winner after unproven loser settlement", async () => {
    const incumbent = lifecycle();
    const setup = portsFor({
      incumbent,
      incumbentEvidence: idleExpected,
      startResult: {
        status: "failed",
        error: stationHostSafeError("HOST_TARGET_CONFLICT", "lost"),
        childDisposition: "unproven",
      },
    });

    const result = await executeStationHostConvergence(executeInput("replace-idle"), setup.ports);
    expect(result).toMatchObject({ status: "failed", phase: "target-start" });
    expect(setup.ports.openSession).toHaveBeenCalledOnce();
    expect(setup.ports.inspectTarget).not.toHaveBeenCalled();
  });

  it("contextually rejects invalid authority synchronously before any adapter is called", () => {
    const openSession = vi.fn();
    const invalid = { ...command("replace-idle"), deadlineMs: 1 };
    expect(() =>
      convergeStationHost(
        {
          command: invalid,
          targetBuild,
          socketPath,
          stateDir: "/state",
          hostCommand: ["stn", "host", "serve"],
        },
        { openSession, now: () => 1 },
      ),
    ).toThrow(/expired/);
    expect(openSession).not.toHaveBeenCalled();
  });
});
