import type { ManagedTerminalAttachment } from "@station/contracts";
import {
  StationHostProviderError,
  type HostListEntry,
} from "@station/host";
import { listLiveHostPtys } from "../../host/listLiveHostPtys.js";
import type { StationTerminalProcess, StationTerminalSpawnOptions } from "../types.js";
import {
  createHostAttachedTerminal,
  type HostAttachedTerminalOptions,
} from "./hostAttachedTerminal.js";

export type ManagedTerminalFactory = (
  options: StationTerminalSpawnOptions,
) => StationTerminalProcess;

/**
 * Resolves an advertised managed-terminal attachment only when exactly one live
 * target matches, then retains that entry's canonical PTY reference.
 *
 * A rejection is terminal for the launch and must never permit a local spawn fallback.
 */
export type ManagedTerminalAttacher = {
  resolve(
    attachment: ManagedTerminalAttachment,
    expectedSessionId: string,
  ): Promise<ManagedTerminalFactory>;
};

type ManagedTerminalAttacherDeps = {
  listHost?: (socketPath: string) => Promise<readonly HostListEntry[] | undefined>;
  createTerminal?: (options: HostAttachedTerminalOptions) => StationTerminalProcess;
};

/**
 * ADAPTER
 *
 * Binds gate-negotiated Host inventory to advertised managed attachments at
 * renderer composition. Resolution failure remains terminal and never permits
 * a local spawn fallback.
 */
export function createStationHostManagedTerminalAttacher(
  hostSocketPath: string,
  deps: ManagedTerminalAttacherDeps = {},
): ManagedTerminalAttacher {
  const listHost = deps.listHost ?? listLiveHostPtys;
  const createTerminal = deps.createTerminal ?? createHostAttachedTerminal;

  return {
    async resolve(attachment, expectedSessionId) {
      const entries = await listHost(hostSocketPath);
      if (entries === undefined) {
        throw new StationHostProviderError("HOST_UNREACHABLE", "Station host is not reachable.");
      }
      const matches = entries.filter(
        (candidate) =>
          candidate.alive && candidate.terminalTargetId === attachment.terminalTargetId,
      );
      if (matches.length === 0) {
        throw new StationHostProviderError(
          "HOST_ATTACH_GONE",
          `No live host terminal is available for target "${attachment.terminalTargetId}".`,
        );
      }
      if (matches.length > 1) {
        throw new StationHostProviderError(
          "HOST_TARGET_CONFLICT",
          `Multiple live Host PTYs claim target "${attachment.terminalTargetId}".`,
        );
      }
      const entry = matches[0];
      if (entry === undefined || entry.kind !== "agent" || entry.sessionId !== expectedSessionId) {
        throw new StationHostProviderError(
          "HOST_ATTACHMENT_MISMATCH",
          `The live Host PTY for target "${attachment.terminalTargetId}" has a different immutable identity.`,
        );
      }

      return (spawnOptions) =>
        createTerminal({
          hostSocketPath,
          ptyRef: entry,
          size: {
            cols: spawnOptions.size?.cols ?? 80,
            rows: spawnOptions.size?.rows ?? 24,
          },
        });
    },
  };
}
