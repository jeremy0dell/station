import {
  type ExternalCommandRunner,
  normalizeCancellationError,
  runExternalCommand,
} from "@station/runtime";
import type { ExecutableArgv } from "../selfExec.js";
import type {
  UpdateApplyReportBase,
  UpdateChannelId,
  UpdateCommandArgv,
  UpdateOperationOptions,
  UpdatePlanBase,
} from "./updateChannel.js";
import { updateErrorFromUnknown } from "./updateError.js";

const managerTimeoutMs = 10 * 60_000;
const managerOutputMaxChars = 64 * 1024;

export type PackageManagerChannelId = Extract<UpdateChannelId, "homebrew" | "npm-global" | "mise">;

export type PackageManagerPlanBase = UpdatePlanBase & {
  channel: PackageManagerChannelId;
  managerCommand: UpdateCommandArgv;
  successorCli: ExecutableArgv;
};

export type PackageManagerUpdateReport = UpdateApplyReportBase & {
  channel: PackageManagerChannelId;
  status: "updated" | "deferred";
  managerCommand: UpdateCommandArgv;
};

export async function applyPackageManagerPlan(
  plan: PackageManagerPlanBase,
  options: UpdateOperationOptions,
  input: {
    commandRunner: ExternalCommandRunner | undefined;
    commandEnv?: Record<string, string>;
    revalidate: () => Promise<void>;
    postcheck: () => Promise<void>;
  },
): Promise<PackageManagerUpdateReport> {
  if (plan.status !== "update-available") throw invalidManagerPlan();
  if (!options.drivePackageManager) {
    return report(plan, "deferred");
  }

  await input.revalidate();
  const [command, ...args] = plan.managerCommand;
  try {
    await runExternalCommand(
      {
        command,
        args,
        ...(input.commandEnv === undefined ? {} : { env: input.commandEnv }),
        timeoutMs: managerTimeoutMs,
        maxOutputChars: managerOutputMaxChars,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      input.commandRunner,
    );
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_PACKAGE_MANAGER_FAILED",
      message: `${plan.channel} could not update Station.`,
    });
  }

  try {
    await input.postcheck();
  } catch (error) {
    const cancellation = normalizeCancellationError(error);
    if (cancellation !== undefined) throw cancellation;
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_POSTCHECK_FAILED",
      message: `${plan.channel} completed but the Station installation could not be verified.`,
    });
  }
  return report(plan, "updated");
}

export function sameUpdateCommand(left: UpdateCommandArgv, right: UpdateCommandArgv): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function invalidManagerPlan() {
  return updateErrorFromUnknown(undefined, {
    code: "UPDATE_PLAN_INVALID",
    message: "The package-manager update plan is invalid.",
    hint: "Run stn update again to build a fresh plan.",
  });
}

function report(
  plan: PackageManagerPlanBase,
  status: PackageManagerUpdateReport["status"],
): PackageManagerUpdateReport {
  const result: PackageManagerUpdateReport = {
    channel: plan.channel,
    status,
    previousVersion: plan.currentVersion,
    installedVersion: status === "deferred" ? plan.currentVersion : plan.targetVersion,
    managerCommand: plan.managerCommand,
    warnings: [],
  };
  if (status === "updated") result.successorCli = plan.successorCli;
  return result;
}
