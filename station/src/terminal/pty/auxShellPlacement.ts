import { existsSync } from "node:fs";
import process from "node:process";
import type { HostSpawnParamsInput, StationHostClient } from "@station/host";
import { auxTerminalTargetId, type PaneId } from "../../state/types.js";
import type { StationTerminalProcess, StationTerminalSpawnOptions } from "../types.js";
import { createHostAttachedTerminal } from "./hostAttachedTerminal.js";
import { defaultShell, defaultShellArgs } from "./localPtyTerminal.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Identity fields the host requires but never interprets for an aux PTY: the
 * provider excludes `kind:"aux"` from reconcile, so these are non-empty
 * placeholders, not real session/worktree identity. (`worktreePath` is the one
 * exception — it carries the real cwd so a recovered orphan reopens in place.)
 */
const AUX_IDENTITY_PLACEHOLDER = "aux";

/** Resolves whether a Station-owned shell should land in the host or stay local. */
export type AuxShellPlacement = (
  paneId: PaneId,
) => ((options: StationTerminalSpawnOptions) => StationTerminalProcess) | undefined;

export function resolveAuxShellPlacement(
  socketPath: string,
  /** Test seam; production dials the host unix socket. */
  clientFactory?: (socketPath: string) => StationHostClient,
): AuxShellPlacement {
  return (paneId) => {
    // Decide local-vs-host at spawn-decision time: a host that is down here means
    // a plain local shell, never a "failed to start shell" against a dead socket.
    if (!existsSync(socketPath)) {
      return undefined;
    }
    return (spawnOptions) => {
      const cols = spawnOptions.size?.cols ?? DEFAULT_COLS;
      const rows = spawnOptions.size?.rows ?? DEFAULT_ROWS;
      // host.spawn requires a non-empty cwd and command (the local bridge would
      // have defaulted both); mirror the local shell so an aux pane is identical
      // whether it lands in the host or stays local.
      const cwd = spawnOptions.cwd ?? process.cwd();
      // The host applies child capability policy at final PTY spawn, so aux placement must not duplicate TERM values.
      const spawn: HostSpawnParamsInput = {
        kind: "aux",
        terminalTargetId: auxTerminalTargetId(paneId),
        sessionId: auxTerminalTargetId(paneId),
        worktreeId: AUX_IDENTITY_PLACEHOLDER,
        projectId: AUX_IDENTITY_PLACEHOLDER,
        harnessProvider: AUX_IDENTITY_PLACEHOLDER,
        worktreePath: cwd,
        command: defaultShell(),
        args: defaultShellArgs(),
        cwd,
        cols,
        rows,
      };
      return createHostAttachedTerminal({
        hostSocketPath: socketPath,
        size: { cols, rows },
        spawn,
        ...(clientFactory === undefined ? {} : { clientFactory }),
      });
    };
  };
}
