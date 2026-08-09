import { describe, expect, it } from "bun:test";
import { createHostHandoffSession } from "./hostHandoffSession.js";
import type { PtyTable } from "./ptyTable.js";

function fakeTable(overrides: Partial<PtyTable> = {}): PtyTable {
  return {
    list: () => [{ ptyId: "pty-1" } as never],
    releaseRegistryForHandoff: async () => ({
      manifest: {
        "pty-1": {
          bridgeProtocolVersion: 2 as const,
          bridgePid: 1,
          controlSocket: "/tmp/pty-1.sock",
          command: "/bin/sh",
          cols: 80,
          rows: 24,
          ptyInstanceId: "instance-1",
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
    await expect(session.adoptRegistry({})).rejects.toMatchObject({
      code: "HOST_HANDOFF_INVALID_STATE",
    });
  });

  it("restores serving on abort before complete", async () => {
    const session = createHostHandoffSession({
      ptyTable: fakeTable(),
      buildVersion: "host-a",
    });
    await session.beginHandoff("host-b", "processes");
    await expect(session.adoptRegistry({})).rejects.toMatchObject({
      code: "HOST_HANDOFF_INVALID_STATE",
    });
    await session.abortHandoff();
    await expect(session.adoptRegistry({})).resolves.toEqual({ adopted: ["pty-1"], failed: [] });
    session.assertNotDraining();
  });

  it("blocks host operations until registry adoption finishes", async () => {
    let finishAdoption: () => void = () => {};
    const adoptionGate = new Promise<void>((resolve) => {
      finishAdoption = resolve;
    });
    const session = createHostHandoffSession({
      ptyTable: fakeTable({
        adoptRegistry: async () => {
          await adoptionGate;
          return { adopted: ["pty-1"], failed: [] };
        },
      }),
      buildVersion: "host-a",
    });

    const adopting = session.adoptRegistry({});
    expect(() => session.assertNotDraining()).toThrow(/adopting a PTY registry/);
    finishAdoption();
    await expect(adopting).resolves.toEqual({ adopted: ["pty-1"], failed: [] });
    session.assertNotDraining();
  });
});
