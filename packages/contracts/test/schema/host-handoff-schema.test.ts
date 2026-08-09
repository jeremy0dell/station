import {
  HostHandoffFidelitySchema,
  PtyBridgeAdoptCommandSchema,
  PtyBridgeAdoptionAckSchema,
  PtyBridgeParkStateSchema,
  PtyBridgeProtocolVersion,
  PtyBridgeStatusSchema,
  PtyHandoffEntrySchema,
  PtyHandoffIdentitySchema,
  PtyHandoffManifestSchema,
  PtyScreenSnapshotSchema,
  PtyScrollbackExportSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

function identity(overrides: Record<string, unknown> = {}) {
  return {
    kind: "agent",
    terminalTargetId: "native:wt-1",
    worktreeId: "wt-1",
    projectId: "proj-1",
    sessionId: "ses-1",
    worktreePath: "/repo/wt-1",
    harnessProvider: "claude",
    ...overrides,
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    bridgeProtocolVersion: PtyBridgeProtocolVersion,
    bridgePid: 4242,
    controlSocket: "/state/run/pty-bridges/pty-1.sock",
    command: "/bin/zsh",
    cols: 80,
    rows: 24,
    ptyInstanceId: "ptyi-1",
    identity: identity(),
    ...overrides,
  };
}

describe("pty handoff identity schema", () => {
  it("parses a complete identity and defaults kind to agent", () => {
    const full = PtyHandoffIdentitySchema.parse(identity());
    expect(full.kind).toEqual("agent");
    const defaulted = PtyHandoffIdentitySchema.parse(identity({ kind: undefined }));
    expect(defaulted.kind).toEqual("agent");
  });

  it("rejects unknown kinds, empty ids, and unknown fields", () => {
    expect(() => PtyHandoffIdentitySchema.parse(identity({ kind: "ghost" }))).toThrow();
    expect(() => PtyHandoffIdentitySchema.parse(identity({ terminalTargetId: "" }))).toThrow();
    expect(() => PtyHandoffIdentitySchema.parse(identity({ extra: true }))).toThrow();
  });
});

describe("pty handoff manifest schema", () => {
  it("parses a manifest keyed by ptyId with optional scrollback and screen fields", () => {
    const manifest = PtyHandoffManifestSchema.parse({
      "pty-1": entry(),
      "pty-2": entry({
        bridgePid: 4243,
        ptyInstanceId: "ptyi-2",
        identity: identity({ terminalTargetId: "native:wt-2" }),
        scrollbackRef: "/state/run/pty-bridges/pty-2.scrollback.json",
        ringComplete: true,
        screenSnapshotRef: "/state/run/pty-bridges/pty-2.screen.json",
      }),
    });
    expect(Object.keys(manifest)).toEqual(["pty-1", "pty-2"]);
    expect(manifest["pty-2"]?.scrollbackRef).toContain("pty-2.scrollback.json");
    expect(manifest["pty-2"]?.screenSnapshotRef).toContain("pty-2.screen.json");
  });

  it("accepts handoff fidelity values and screen snapshot payloads", () => {
    expect(HostHandoffFidelitySchema.parse("processes")).toEqual("processes");
    expect(HostHandoffFidelitySchema.parse("screen")).toEqual("screen");
    expect(() => HostHandoffFidelitySchema.parse("exact")).toThrow();
    expect(
      PtyScreenSnapshotSchema.parse({
        cols: 80,
        rows: 24,
        sequences: ["\x1bcrestored"],
      }),
    ).toMatchObject({ cols: 80, rows: 24, sequences: ["\x1bcrestored"] });
    expect(() => PtyScreenSnapshotSchema.parse({ cols: 80, rows: 24, sequences: [] })).toThrow();
  });

  it("rejects unknown entry fields and malformed values", () => {
    expect(() => PtyHandoffEntrySchema.parse(entry({ bogus: 1 }))).toThrow();
    expect(() => PtyHandoffEntrySchema.parse(entry({ bridgePid: -1 }))).toThrow();
    expect(() => PtyHandoffEntrySchema.parse(entry({ cols: 0 }))).toThrow();
    expect(() => PtyHandoffEntrySchema.parse(entry({ controlSocket: "" }))).toThrow();
    expect(() =>
      PtyHandoffEntrySchema.parse(entry({ bridgeProtocolVersion: PtyBridgeProtocolVersion + 1 })),
    ).toThrow();
    expect(() =>
      PtyHandoffManifestSchema.parse({ "pty-1": entry({ identity: undefined }) }),
    ).toThrow();
    expect(() => PtyHandoffManifestSchema.parse({ "pty-1": entry(), "pty-2": entry() })).toThrow();
  });
});

describe("pty bridge park state schema", () => {
  it("parses a live park state and an exited park state", () => {
    const live = PtyBridgeParkStateSchema.parse({
      v: 2,
      bridgePid: 4242,
      pid: 4343,
      controlSocket: "/state/run/pty-bridges/pty-1.sock",
      command: "/bin/zsh",
      cols: 80,
      rows: 24,
      ptyInstanceId: "ptyi-1",
      identity: identity(),
      orphanedAtMs: 1_000,
      ttlMs: 86_400_000,
      heartbeatAtMs: 2_000,
      exited: false,
    });
    expect(live.exited).toEqual(false);
    const exited = PtyBridgeParkStateSchema.parse({
      ...live,
      exited: true,
      exitCode: 3,
      signal: 15,
    });
    expect(exited.exitCode).toEqual(3);
  });

  it("rejects malformed park states fail-closed", () => {
    expect(() =>
      PtyBridgeParkStateSchema.parse({
        v: 1,
        bridgePid: 4242,
        pid: 4343,
        controlSocket: "/x.sock",
        command: "/bin/zsh",
        cols: 80,
        rows: 24,
        ptyInstanceId: "ptyi-1",
        identity: identity(),
        orphanedAtMs: 1,
        ttlMs: 1,
        heartbeatAtMs: 1,
        exited: false,
      }),
    ).toThrow();
    expect(() => PtyBridgeParkStateSchema.parse({ v: 2 })).toThrow();
  });

  it("strictly parses bridge status with the same PTY instance", () => {
    const status = {
      type: "status",
      bridgeProtocol: PtyBridgeProtocolVersion,
      ptyInstanceId: "ptyi-1",
      pid: 4343,
      bridgePid: 4242,
      cols: 80,
      rows: 24,
      adopted: false,
      exited: false,
      parkedEvicted: false,
    };
    expect(PtyBridgeStatusSchema.parse(status)).toEqual(status);
    expect(() => PtyBridgeStatusSchema.parse({ ...status, extra: true })).toThrow();
    expect(PtyBridgeStatusSchema.parse({ ...status, adopted: false }).adopted).toBe(false);
    expect(PtyBridgeAdoptionAckSchema.parse({ ...status, adopted: true }).adopted).toBe(true);
    expect(() => PtyBridgeAdoptionAckSchema.parse(status)).toThrow();
    expect(() =>
      PtyBridgeAdoptionAckSchema.parse({ ...status, adopted: true, extra: true }),
    ).toThrow();
  });

  it("strictly parses bridge adoption commands", () => {
    const command = { type: "adopt", ptyInstanceId: "ptyi-1" };
    expect(PtyBridgeAdoptCommandSchema.parse(command)).toEqual(command);
    expect(() => PtyBridgeAdoptCommandSchema.parse({ type: "adopt" })).toThrow();
    expect(() => PtyBridgeAdoptCommandSchema.parse({ ...command, extra: true })).toThrow();
  });
});

describe("pty scrollback export schema", () => {
  it("parses data and resize events in order", () => {
    const exportData = PtyScrollbackExportSchema.parse({
      initialCols: 80,
      initialRows: 24,
      complete: true,
      events: [
        { type: "data", data: "hello" },
        { type: "resize", cols: 100, rows: 30 },
        { type: "data", data: "world" },
      ],
    });
    expect(exportData.events).toHaveLength(3);
  });

  it("rejects unknown event fields and non-positive geometry", () => {
    expect(() =>
      PtyScrollbackExportSchema.parse({
        initialCols: 80,
        initialRows: 24,
        complete: true,
        events: [{ type: "data", data: "x", extra: 1 }],
      }),
    ).toThrow();
    expect(() =>
      PtyScrollbackExportSchema.parse({
        initialCols: 0,
        initialRows: 24,
        complete: true,
        events: [],
      }),
    ).toThrow();
  });
});
