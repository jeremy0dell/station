import { access } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Bun renderer is a root-managed workspace package; resolve it relative to
 * this CLI module so both a built (dist) and a source run find it.
 */
export function resolveStationWorkspaceDir(): string {
  const here = fileURLToPath(import.meta.url);
  const marker = `${sep}apps${sep}cli${sep}`;
  const index = here.indexOf(marker);
  const repoRoot = index >= 0 ? here.slice(0, index) : process.cwd();
  return join(repoRoot, "station");
}

/** Human-facing remediation when the root Bun workspace has not been installed.
 * Absolute path: bare stn runs from arbitrary working directories. */
export const stationUiInstallHint = `Install the STATION UI dependencies: cd ${join(resolveStationWorkspaceDir(), "..")} && bun install.`;

/**
 * @opentui is the renderer's first import, so its root-workspace link under
 * station/node_modules proves the unified Bun install materialized Station's
 * renderer graph. The Bun binary check alone cannot establish that readiness.
 */
export async function isStationUiInstalled(): Promise<boolean> {
  const marker = join(
    resolveStationWorkspaceDir(),
    "node_modules",
    "@opentui",
    "core",
    "package.json",
  );
  try {
    await access(marker);
    return true;
  } catch (cause) {
    // Only a missing marker means "bun install never ran". Fail open on other
    // errors (EACCES etc.) so a probe hiccup cannot veto an otherwise working lane.
    return (cause as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT";
  }
}
