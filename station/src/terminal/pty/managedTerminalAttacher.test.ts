import { describe, expect, it } from "bun:test";
import type { HostListEntry } from "@station/host";
import { createScriptedTerminal } from "../testing/scriptedTerminal.js";
import type { HostAttachedTerminalOptions } from "./hostAttachedTerminal.js";
import { createStationHostManagedTerminalAttacher } from "./managedTerminalAttacher.js";

const TARGET_ID = "native:wt-agent";
const ATTACHMENT = { kind: "managed-terminal", terminalTargetId: TARGET_ID } as const;

function hostEntry(overrides: Partial<HostListEntry> = {}): HostListEntry {
  return {
    kind: "agent",
    terminalTargetId: TARGET_ID,
    worktreeId: "wt-agent",
    projectId: "station",
    sessionId: "ses-agent",
    worktreePath: "/work/agent",
    harnessProvider: "codex",
    ptyId: "pty-agent",
    pid: 42,
    alive: true,
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

describe("createStationHostManagedTerminalAttacher", () => {
  it("resolves the first live matching agent to a lazy host terminal factory", async () => {
    const created: HostAttachedTerminalOptions[] = [];
    const scripted = createScriptedTerminal();
    const listed = [
      hostEntry({ ptyId: "pty-dead", alive: false }),
      hostEntry({ ptyId: "pty-aux", kind: "aux" }),
      hostEntry({ ptyId: "pty-other", terminalTargetId: "native:other" }),
      hostEntry({ ptyId: "pty-first" }),
      hostEntry({ ptyId: "pty-second" }),
    ];
    const attacher = createStationHostManagedTerminalAttacher("/run/station-host.sock", {
      listHost: async () => listed,
      createTerminal: (options) => {
        created.push(options);
        return scripted.terminal;
      },
    });

    const createTerminal = await attacher.resolve(ATTACHMENT);
    expect(created).toEqual([]);

    expect(createTerminal({ size: { cols: 120, rows: 40 } })).toBe(scripted.terminal);
    expect(created).toEqual([
      {
        hostSocketPath: "/run/station-host.sock",
        ptyId: "pty-first",
        size: { cols: 120, rows: 40 },
      },
    ]);
  });

  it("reports HOST_UNREACHABLE when the host cannot be listed", async () => {
    const attacher = createStationHostManagedTerminalAttacher("/missing/station-host.sock", {
      listHost: async () => undefined,
    });

    await expect(attacher.resolve(ATTACHMENT)).rejects.toMatchObject({
      code: "HOST_UNREACHABLE",
    });
  });

  it("reports HOST_ATTACH_GONE when no live agent matches the attachment", async () => {
    const attacher = createStationHostManagedTerminalAttacher("/run/station-host.sock", {
      listHost: async () => [
        hostEntry({ alive: false }),
        hostEntry({ kind: "aux" }),
        hostEntry({ terminalTargetId: "native:other" }),
      ],
    });

    await expect(attacher.resolve(ATTACHMENT)).rejects.toMatchObject({
      code: "HOST_ATTACH_GONE",
    });
  });
});
