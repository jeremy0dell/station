import {
  HOST_PROTOCOL_VERSION,
  parseStationHostConvergenceCommand,
  StationHostConvergenceCommandSchema,
  StationHostConvergenceResultSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const incumbentIdentity = "a".repeat(64);
const targetIdentity = "b".repeat(64);
const socketPath = "/state/station-host.sock";
const targetBuild = { buildVersion: "2.0.0", buildIdentity: targetIdentity };
const lifetime = {
  kind: "agent" as const,
  terminalTargetId: "target-a",
  ptyId: "pty-a",
  ptyInstanceId: "instance-a",
  worktreeId: "worktree-a",
  projectId: "project-a",
  sessionId: "session-a",
  worktreePath: "/repo/a",
  harnessProvider: "codex",
  pid: 42,
  alive: true,
  cols: 80,
  rows: 24,
  handoffSupport: { kind: "bridge-releasable" as const },
};
const expected = {
  endpoint: { socketPath, ino: 11n, birthtimeNs: 22n },
  health: { ok: true as const, protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "1.0.0" },
  buildIdentity: incumbentIdentity,
  terminals: [lifetime],
};
const handoff = {
  action: "handoff" as const,
  targetBuild,
  socketPath,
  expected,
  fidelity: "processes" as const,
  deadlineMs: 2_000,
};

describe("Station Host convergence contracts", () => {
  it("contextually clones one eligible handoff without I/O", () => {
    const input = {
      ...handoff,
      expected: { ...expected, terminals: [{ ...lifetime }] },
    };
    const parsed = parseStationHostConvergenceCommand(input, {
      targetBuild,
      socketPath,
      nowMs: 1_000,
    });
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.expected).not.toBe(input.expected);

    const mutableLifetime = input.expected.terminals[0];
    expect(mutableLifetime).toBeDefined();
    if (mutableLifetime === undefined) throw new Error("missing fixture lifetime");
    mutableLifetime.pid = 99;
    expect(parsed.expected.terminals[0]?.pid).toBe(42);
  });

  it.each([
    ["target version", { targetBuild: { ...targetBuild, buildVersion: "3.0.0" } }],
    ["target identity", { targetBuild: { ...targetBuild, buildIdentity: "c".repeat(64) } }],
    ["configured socket", { socketPath: "/other.sock" }],
  ])("rejects mismatched %s authority", (_name, contextOverride) => {
    expect(() =>
      parseStationHostConvergenceCommand(handoff, {
        targetBuild,
        socketPath,
        nowMs: 1_000,
        ...contextOverride,
      }),
    ).toThrow(/context/);
  });

  it("rejects expired authority and an already-exact incumbent", () => {
    expect(() =>
      parseStationHostConvergenceCommand(handoff, { targetBuild, socketPath, nowMs: 2_000 }),
    ).toThrow(/expired/);
    expect(() =>
      parseStationHostConvergenceCommand(
        {
          ...handoff,
          expected: {
            ...expected,
            health: { ...expected.health, buildVersion: targetBuild.buildVersion },
            buildIdentity: targetBuild.buildIdentity,
          },
        },
        { targetBuild, socketPath, nowMs: 1_000 },
      ),
    ).toThrow(/already/);
  });

  it("requires action-valid, canonical terminal evidence", () => {
    expect(
      StationHostConvergenceCommandSchema.safeParse({
        ...handoff,
        action: "replace-idle",
        fidelity: undefined,
      }).success,
    ).toBe(false);
    expect(
      StationHostConvergenceCommandSchema.safeParse({
        ...handoff,
        expected: { ...expected, terminals: [] },
      }).success,
    ).toBe(false);
    expect(
      StationHostConvergenceCommandSchema.safeParse({
        ...handoff,
        expected: {
          ...expected,
          terminals: [{ ...lifetime, alive: false }],
        },
      }).success,
    ).toBe(false);
    expect(
      StationHostConvergenceCommandSchema.safeParse({
        ...handoff,
        expected: {
          ...expected,
          terminals: [
            lifetime,
            { ...lifetime, terminalTargetId: "target-b", ptyInstanceId: "instance-b" },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("requires a manifest-derived receipt for completed handoff", () => {
    const completed = {
      status: "completed" as const,
      action: "handoff" as const,
      targetBuild,
      finalEvidence: {
        ...expected,
        health: { ...expected.health, buildVersion: targetBuild.buildVersion },
        buildIdentity: targetBuild.buildIdentity,
      },
      handoffReceipt: {
        fidelity: "processes" as const,
        terminals: [
          {
            terminalTargetId: lifetime.terminalTargetId,
            ptyId: lifetime.ptyId,
            ptyInstanceId: lifetime.ptyInstanceId,
          },
        ],
      },
    };
    expect(StationHostConvergenceResultSchema.parse(completed)).toEqual(completed);
    expect(
      StationHostConvergenceResultSchema.safeParse({
        ...completed,
        handoffReceipt: undefined,
      }).success,
    ).toBe(false);
  });

  it("accepts only sourced exact evidence and non-authorizing recovery truth on failure", () => {
    const failure = {
      status: "failed" as const,
      action: "handoff" as const,
      targetBuild,
      phase: "adoption" as const,
      incumbentDisposition: "released" as const,
      terminalDisposition: "parked" as const,
      recoveryAuthority: "none" as const,
      terminalRecovery: [
        {
          terminalTargetId: lifetime.terminalTargetId,
          ptyId: lifetime.ptyId,
          ptyInstanceId: lifetime.ptyInstanceId,
          lastProvenDisposition: "parked" as const,
        },
      ],
      lastExactEvidence: { source: "target-session" as const, evidence: expected },
      error: { tag: "station-host", code: "HOST_REQUEST_FAILED", message: "failed" },
    };
    expect(StationHostConvergenceResultSchema.parse(failure)).toEqual(failure);
    expect(
      StationHostConvergenceResultSchema.safeParse({
        ...failure,
        lastExactEvidence: { source: "command-expectation", evidence: expected },
      }).success,
    ).toBe(false);
  });
});
