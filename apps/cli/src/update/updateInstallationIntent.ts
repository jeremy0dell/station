import type { UpdateConvergencePlanningInput } from "@station/contracts";
import type { PlannedUpdateChannel } from "./channelDetection.js";
import { updateErrorFromUnknown } from "./updateError.js";

type PackageManagerIntent = "defer" | "drive";

/**
 * POLICY
 *
 * Resolves package-manager ownership intent shared by preview planning and non-dry execution.
 */
export function resolveUpdateInstallationIntent(
  selected: PlannedUpdateChannel,
  packageManager: PackageManagerIntent,
): UpdateConvergencePlanningInput["installation"] {
  const managerCommand = selected.plan.managerCommand;
  if (packageManager === "drive" && managerCommand === undefined) {
    throw updateErrorFromUnknown(undefined, {
      code: "UPDATE_FLAG_INVALID",
      message: "--drive-package-manager requires a Homebrew, npm-global, or mise channel.",
    });
  }
  if (managerCommand === undefined) {
    return { whenRequired: "apply", owner: selected.channel, command: { kind: "none" } };
  }
  const command = {
    kind: "manager" as const,
    argv: [managerCommand[0], ...managerCommand.slice(1)] as [string, ...string[]],
  };
  return packageManager === "drive"
    ? { whenRequired: "apply", owner: selected.channel, command }
    : { whenRequired: "defer", owner: selected.channel, command };
}
