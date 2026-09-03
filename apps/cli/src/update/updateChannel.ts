import type { UpdateArtifact, UpdateChannelId, UpdateCommandArgv } from "@station/contracts";
import { UpdateChannelIdSchema } from "@station/contracts";
import type { RuntimeSafeError } from "@station/runtime";
import type { ExecutableArgv } from "../selfExec.js";

export const updateChannelIds = UpdateChannelIdSchema.options;
export type { UpdateChannelId, UpdateCommandArgv } from "@station/contracts";

export type UpdateDetectionBase = {
  channel: UpdateChannelId;
  currentVersion: string;
  currentRevision?: string;
};

export type UpdatePlanBase = {
  channel: UpdateChannelId;
  status: "current" | "update-available";
  currentVersion: string;
  targetVersion: string;
  currentCli: ExecutableArgv;
  currentRevision?: string;
  targetRevision?: string;
  managerCommand?: UpdateCommandArgv;
};

export type UpdateApplyReportBase = {
  channel: UpdateChannelId;
  status: "installed" | "updated" | "deferred";
  previousVersion: string;
  installedVersion: string;
  successorCli?: ExecutableArgv;
  warnings: RuntimeSafeError[];
};

export type UpdateOperationOptions = {
  signal?: AbortSignal;
  drivePackageManager?: boolean;
};

/**
 * DRIVEN PORT
 *
 * Defines one install owner's typed detect, plan, apply, installed-artifact inspection, and
 * optional adapter-owned recovery lifecycle.
 */
export interface UpdateChannel<
  Detection extends UpdateDetectionBase = UpdateDetectionBase,
  Plan extends UpdatePlanBase = UpdatePlanBase,
  Report extends UpdateApplyReportBase = UpdateApplyReportBase,
> {
  readonly id: UpdateChannelId;
  detect(options?: UpdateOperationOptions): Promise<Detection | undefined>;
  /** Stable local installation identity fields that exclude mutable artifact contents. */
  installedScope(detection: Detection): readonly string[];
  plan(detection: Detection, options?: UpdateOperationOptions): Promise<Plan>;
  apply(plan: Plan, options?: UpdateOperationOptions): Promise<Report>;
  inspectInstalled(
    plan: Plan,
    options?: UpdateOperationOptions,
  ): Promise<UpdateArtifact | undefined>;
  applyRecoveryCommands?(plan: Plan, error: unknown): readonly UpdateCommandArgv[] | undefined;
}
