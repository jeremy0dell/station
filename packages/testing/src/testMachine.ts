import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Fails fast when a test mutation path escapes its machine root; this is not a security boundary. */
export function assertPathInsideTestMachineRoot(path: string, label: string): void {
  const configuredRoot = process.env.STATION_TEST_MACHINE_ROOT;
  if (configuredRoot === undefined || configuredRoot.length === 0) {
    throw new Error(`${label} requires STATION_TEST_MACHINE_ROOT.`);
  }

  const physicalRoot = realpathSync(resolve(configuredRoot));
  const destination = resolve(path);
  let existingParent = destination;
  while (!existsSync(existingParent)) {
    const parent = dirname(existingParent);
    if (parent === existingParent) break;
    existingParent = parent;
  }

  const physicalParent = realpathSync(existingParent);
  const physicalDestination = resolve(physicalParent, relative(existingParent, destination));
  const relativeDestination = relative(physicalRoot, physicalDestination);
  if (
    relativeDestination === ".." ||
    relativeDestination.startsWith(`..${sep}`) ||
    isAbsolute(relativeDestination)
  ) {
    throw new Error(`${label} must stay inside STATION_TEST_MACHINE_ROOT: ${path}`);
  }
}
