import { fileURLToPath } from "node:url";

/**
 * Worktree-local dev state, isolated from global ~/.local/state/station and other
 * checkouts. Resolved from this file's URL, so it always targets THIS worktree.
 */
export function devStateDir(): string {
  return fileURLToPath(new URL("../../../.dev-state", import.meta.url));
}

export function devHostSocketPath(): string {
  return fileURLToPath(new URL("../../../.dev-state/run/station-host.sock", import.meta.url));
}

export function devRenderProfilePath(): string {
  return fileURLToPath(new URL("../../../.dev-state/station-renders.jsonl", import.meta.url));
}
