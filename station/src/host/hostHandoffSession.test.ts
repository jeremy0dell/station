import { describe, expect, it } from "bun:test";
import { createHostHandoffSession } from "./hostHandoffSession.js";
import type { PtyTable } from "./ptyTable.js";

function fakeTable(overrides: Partial<PtyTable> = {}): PtyTable {
  return {
    list: () => [{ ptyId: "pty-1" } as never],
    releaseRegistryForHandoff: async () => ({
      manifest: {
        "pty-1": {
          bridgeProtocolVersion: 1 as const,
          bridgePid: 1,
          controlSocket: "/tmp/pty-1.sock",
          command: "/bin/sh",
          cols: 80,
          rows: 24,
          identity: {
            kind: "agent" as const,
            terminalTargetId: "t",
            worktreeId: "w",
            projectId: "p",
            sessionId: "s",
            worktreePath: "/repo",
            harnessProvider: "claude",
          },
        },
      },
      fidelity: "processes" as const,
      released: ["pty-1"],
      skipped: [],
    }),
    adoptRegistry: async () => ({ adopted: ["pty-1"], failed: [] }),
    ...overrides,
  } as PtyTable;
}

describe("createHostHandoffSession", () => {
  it("refuses abort after complete commits the handoff phase", async () => {
    const session = createHostHandoffSession({
      ptyTable: fakeTable(),
      buildVersion: "host-a",
    });
    await session.beginHandoff("host-b", "processes");
    expect(session.completeHandoff()).toEqual({ stopping: true });
    await expect(session.abortHandoff()).rejects.toMatchObject({
      code: "HOST_HANDOFF_INVALID_STATE",
    });
    expect(() => session.assertCanAdopt()).toThrow(/serving host/i);
  });

  it("restores serving on abort before complete", async () => {
    const session = createHostHandoffSession({
      ptyTable: fakeTable(),
      buildVersion: "host-a",
    });
    await session.beginHandoff("host-b", "processes");
    expect(() => session.assertCanAdopt()).toThrow(/not draining/i);
    await session.abortHandoff();
    session.assertCanAdopt();
    session.assertNotDraining();
  });
});
