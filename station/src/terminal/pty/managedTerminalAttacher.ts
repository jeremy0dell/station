import type { ManagedTerminalAttachment } from "@station/contracts";
import {
  StationHostProviderError,
  type HostListEntry,
} from "@station/host";
import { listLiveHostPtys } from "../../sources/listLiveHostPtys.js";
import type { StationTerminalProcess, StationTerminalSpawnOptions } from "../types.js";
import {
  createHostAttachedTerminal,
  type HostAttachedTerminalOptions,
} from "./hostAttachedTerminal.js";

export type ManagedTerminalFactory = (
  options: StationTerminalSpawnOptions,
) => StationTerminalProcess;

/**
 * Resolves an advertised managed-terminal attachment to lazy pane construction.
 *
 * A rejection is terminal for the launch and must never permit a local spawn fallback.
 */
export type ManagedTerminalAttacher = {
  resolve(attachment: ManagedTerminalAttachment): Promise<ManagedTerminalFactory>;
};

type ManagedTerminalAttacherDeps = {
  listHost?: (socketPath: string) => Promise<readonly HostListEntry[] | undefined>;
  createTerminal?: (options: HostAttachedTerminalOptions) => StationTerminalProcess;
};

export function createStationHostManagedTerminalAttacher(
  hostSocketPath: string,
  deps: ManagedTerminalAttacherDeps = {},
): ManagedTerminalAttacher {
  const listHost = deps.listHost ?? listLiveHostPtys;
  const createTerminal = deps.createTerminal ?? createHostAttachedTerminal;

  return {
    async resolve(attachment) {
      const entries = await listHost(hostSocketPath);
      if (entries === undefined) {
        throw new StationHostProviderError("HOST_UNREACHABLE", "Station host is not reachable.");
      }
      const entry = entries.find(
        (candidate) =>
          candidate.kind === "agent" &&
          candidate.alive &&
          candidate.terminalTargetId === attachment.terminalTargetId,
      );
      if (entry === undefined) {
        throw new StationHostProviderError(
          "HOST_ATTACH_GONE",
          `No live host terminal is available for target "${attachment.terminalTargetId}".`,
        );
      }

      return (spawnOptions) =>
        createTerminal({
          hostSocketPath,
          ptyId: entry.ptyId,
          size: {
            cols: spawnOptions.size?.cols ?? 80,
            rows: spawnOptions.size?.rows ?? 24,
          },
        });
    },
  };
}
