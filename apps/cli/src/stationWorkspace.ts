import { access } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Bun renderer lives in the isolated station/ workspace; resolve it relative
 * to this CLI module so both a built (dist) and a source run find it.
 */
export function resolveStationWorkspaceDir(): string {
  const here = fileURLToPath(import.meta.url);
  const marker = `${sep}apps${sep}cli${sep}`;
  const index = here.indexOf(marker);
  const repoRoot = index >= 0 ? here.slice(0, index) : process.cwd();
  return join(repoRoot, "station");
}

/** Human-facing remediation when the station/ Bun lane has not been installed. */
export const stationUiInstallHint =
  "Install the STATION UI dependencies: cd station && bun install.";

/**
 * @opentui is the renderer's first import, so its presence under
 * station/node_modules is the marker that `bun install` ran there. The Bun binary
 * check cannot see this: bare `stn` on an uninstalled lane dies at launch with
 * "@opentui not found" while `bun --version` still succeeds.
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
  } catch {
    return false;
  }
}
