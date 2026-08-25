import {
  compareStationHostTerminalLifetimeIdentity,
  HOST_PROTOCOL_VERSION,
  StationBuildIdentitySchema,
  StationHostExactEvidenceSchema,
  StationHostInspectionResultSchema,
  UpdateReapHostEvidenceSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

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

const exactEvidence = {
  endpoint: { socketPath: "/state/station-host.sock", ino: 11n, birthtimeNs: 22n },
  health: {
    ok: true as const,
    protocolVersion: HOST_PROTOCOL_VERSION,
    buildVersion: "1.0.0",
  },
  buildIdentity: "a".repeat(64),
  terminals: [lifetime],
};

const publicTerminal = {
  kind: "agent" as const,
  terminalTargetId: "target-a",
  ptyId: "pty-a",
  ptyInstanceId: "instance-a",
  projectId: "project-a",
  worktreeId: "worktree-a",
  sessionId: "session-a",
  harnessProvider: "codex",
  alive: true,
  handoffSupport: "bridge-releasable" as const,
};

const publicEvidence = {
  status: "inspected" as const,
  buildVersion: "1.0.0",
  buildIdentity: "b".repeat(64),
  protocolVersion: HOST_PROTOCOL_VERSION,
  relation: "different" as const,
  compatibility: "replace" as const,
  terminals: [publicTerminal],
};

describe("strict current Station Host inspection contracts", () => {
  it("accepts one exact path-bound, canonical current snapshot", () => {
    expect(StationHostExactEvidenceSchema.parse(exactEvidence)).toEqual(exactEvidence);
    expect(
      StationHostInspectionResultSchema.parse({ status: "exact", evidence: exactEvidence }),
    ).toEqual({ status: "exact", evidence: exactEvidence });
  });

  it("rejects non-current protocol and invalid immutable identities directly", () => {
    expect(
      StationHostExactEvidenceSchema.safeParse({
        ...exactEvidence,
        health: { ...exactEvidence.health, protocolVersion: 7 },
      }).success,
    ).toBe(false);
    expect(StationBuildIdentitySchema.safeParse("A".repeat(64)).success).toBe(false);
    expect(StationBuildIdentitySchema.safeParse("a".repeat(63)).success).toBe(false);

    expect(UpdateReapHostEvidenceSchema.safeParse(publicEvidence).success).toBe(true);
    expect(
      UpdateReapHostEvidenceSchema.safeParse({ ...publicEvidence, protocolVersion: 7 }).success,
    ).toBe(false);
  });

  it("rejects missing endpoint paths and unknown keys", () => {
    expect(
      StationHostExactEvidenceSchema.safeParse({
        ...exactEvidence,
        endpoint: { ...exactEvidence.endpoint, socketPath: "" },
      }).success,
    ).toBe(false);
    expect(
      StationHostExactEvidenceSchema.safeParse({ ...exactEvidence, mutationAuthority: true })
        .success,
    ).toBe(false);
  });

  it.each([
    ["inode", { ...exactEvidence, endpoint: { ...exactEvidence.endpoint, ino: 0n } }],
    ["PID", { ...exactEvidence, terminals: [{ ...lifetime, pid: -1 }] }],
    ["columns", { ...exactEvidence, terminals: [{ ...lifetime, cols: 0 }] }],
    ["rows", { ...exactEvidence, terminals: [{ ...lifetime, rows: -5 }] }],
  ])("rejects nonpositive %s", (_field, evidence) => {
    expect(StationHostExactEvidenceSchema.safeParse(evidence).success).toBe(false);
  });

  it.each([
    "terminalTargetId",
    "ptyId",
    "ptyInstanceId",
  ] as const)("rejects an independently duplicated %s", (key) => {
    const second = {
      ...lifetime,
      terminalTargetId: "target-b",
      ptyId: "pty-b",
      ptyInstanceId: "instance-b",
      [key]: lifetime[key],
    };
    expect(
      StationHostExactEvidenceSchema.safeParse({
        ...exactEvidence,
        terminals: [lifetime, second],
      }).success,
    ).toBe(false);
  });

  it("rejects noncanonical lifetime order without requiring unique sessions", () => {
    expect(
      StationHostExactEvidenceSchema.safeParse({
        ...exactEvidence,
        terminals: [
          { ...lifetime, terminalTargetId: "target-b" },
          { ...lifetime, terminalTargetId: "target-a" },
        ],
      }).success,
    ).toBe(false);
    expect(
      StationHostExactEvidenceSchema.safeParse({
        ...exactEvidence,
        terminals: [
          lifetime,
          {
            ...lifetime,
            terminalTargetId: "target-b",
            ptyId: "pty-b",
            ptyInstanceId: "instance-b",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    "terminalTargetId",
    "ptyId",
    "ptyInstanceId",
  ] as const)("rejects a public Host array with an independently duplicated %s", (key) => {
    const second = {
      ...publicTerminal,
      terminalTargetId: "target-b",
      ptyId: "pty-b",
      ptyInstanceId: "instance-b",
      [key]: publicTerminal[key],
    };
    expect(
      UpdateReapHostEvidenceSchema.safeParse({
        ...publicEvidence,
        terminals: [publicTerminal, second],
      }).success,
    ).toBe(false);
  });

  it("rejects reversed public Host terminal evidence without repair-sorting", () => {
    const second = {
      ...publicTerminal,
      terminalTargetId: "target-b",
      ptyId: "pty-b",
      ptyInstanceId: "instance-b",
    };
    expect(
      UpdateReapHostEvidenceSchema.safeParse({
        ...publicEvidence,
        terminals: [second, publicTerminal],
      }).success,
    ).toBe(false);
  });

  it("orders only terminal target, PTY, then PTY-lifetime identity", () => {
    expect(
      compareStationHostTerminalLifetimeIdentity(lifetime, {
        ...lifetime,
        ptyInstanceId: "instance-b",
      }),
    ).toBeLessThan(0);
    expect(
      compareStationHostTerminalLifetimeIdentity(lifetime, {
        ...lifetime,
        sessionId: "different-session",
      }),
    ).toBe(0);
  });
});
