import { describe, expect, it } from "bun:test";
import { StationHostProviderError, type HostListEntry } from "@station/host";
import { createScriptedTerminal } from "../../testing/scriptedTerminal.js";
import type { HostAttachedTerminalOptions } from "../hostAttachedTerminal.js";
import { createStationHostManagedTerminalAttacher } from "../managedTerminalAttacher.js";

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
    ptyInstanceId: "instance-agent",
    pid: 42,
    alive: true,
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

describe("createStationHostManagedTerminalAttacher", () => {
  it("resolves one live matching agent to a lazy host terminal factory", async () => {
    const created: HostAttachedTerminalOptions[] = [];
    const scripted = createScriptedTerminal();
    const listed = [
      hostEntry({ ptyId: "pty-dead", alive: false }),
      hostEntry({ ptyId: "pty-aux", kind: "aux", terminalTargetId: "aux:pane-1" }),
      hostEntry({ ptyId: "pty-other", terminalTargetId: "native:other" }),
      hostEntry({ ptyId: "pty-first" }),
    ];
    const attacher = createStationHostManagedTerminalAttacher("/run/station-host.sock", {
      listHost: async () => listed,
      createTerminal: (options) => {
        created.push(options);
        return scripted.terminal;
      },
    });

    const createTerminal = await attacher.resolve(ATTACHMENT, "ses-agent");
    expect(created).toEqual([]);

    expect(createTerminal({ size: { cols: 120, rows: 40 } })).toBe(scripted.terminal);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      hostSocketPath: "/run/station-host.sock",
      ptyRef: { ptyId: "pty-first", ptyInstanceId: "instance-agent" },
      size: { cols: 120, rows: 40 },
    });
  });

  it("reports HOST_UNREACHABLE when the host cannot be listed", async () => {
    const attacher = createStationHostManagedTerminalAttacher("/missing/station-host.sock", {
      listHost: async () => undefined,
    });

    await expect(attacher.resolve(ATTACHMENT, "ses-agent")).rejects.toMatchObject({
      code: "HOST_UNREACHABLE",
    });
  });

  it("reports HOST_ATTACH_GONE when no live agent matches the attachment", async () => {
    const attacher = createStationHostManagedTerminalAttacher("/run/station-host.sock", {
      listHost: async () => [
        hostEntry({ alive: false }),
        hostEntry({ kind: "aux", terminalTargetId: "aux:pane-1" }),
        hostEntry({ terminalTargetId: "native:other" }),
      ],
    });

    await expect(attacher.resolve(ATTACHMENT, "ses-agent")).rejects.toMatchObject({
      code: "HOST_ATTACH_GONE",
    });
  });

  it("rejects duplicate live targets before constructing a terminal", async () => {
    let created = false;
    const attacher = createStationHostManagedTerminalAttacher("/run/station-host.sock", {
      listHost: async () => [hostEntry(), hostEntry({ ptyId: "pty-duplicate" })],
      createTerminal: () => {
        created = true;
        return createScriptedTerminal().terminal;
      },
    });

    await expect(attacher.resolve(ATTACHMENT, "ses-agent")).rejects.toMatchObject({
      code: "HOST_TARGET_CONFLICT",
    });
    expect(created).toBe(false);
  });

  it("rejects a unique target with the wrong session or kind", async () => {
    const attacher = createStationHostManagedTerminalAttacher("/run/station-host.sock", {
      listHost: async () => [hostEntry({ sessionId: "ses-replacement" })],
    });
    await expect(attacher.resolve(ATTACHMENT, "ses-agent")).rejects.toMatchObject({
      code: "HOST_ATTACHMENT_MISMATCH",
    });
  });

  it("propagates host compatibility failures without a local fallback", async () => {
    const attacher = createStationHostManagedTerminalAttacher("/run/station-host.sock", {
      listHost: async () => {
        throw new StationHostProviderError(
          "HOST_VERSION_INCOMPATIBLE",
          "Station host version is incompatible.",
        );
      },
    });

    await expect(attacher.resolve(ATTACHMENT, "ses-agent")).rejects.toMatchObject({
      code: "HOST_VERSION_INCOMPATIBLE",
    });
  });
});
