import type { StationConfig } from "@station/config";
import type { HostHandoffFidelity, UpdateConvergencePlanningInput } from "@station/contracts";
import type { StationBuildInfo } from "@station/runtime";
import type { PlannedUpdateChannel } from "../../update/channelDetection.js";
import { updateErrorFromUnknown } from "../../update/updateError.js";
import { type HostCommandDeps, runHostCommand } from "../host/index.js";
import type { UpdateRequest } from "./args.js";

/** Describes whether runtime crossover must re-establish exact Host ownership after preflight. */
export type HostHandoffScenario =
  | { kind: "not-requested" }
  | { kind: "not-needed" }
  | { kind: "converge"; fidelity: HostHandoffFidelity };

export type UpdateScenario =
  | { kind: "already-current"; hostHandoff: HostHandoffScenario }
  | {
      kind: "defer-to-package-manager";
      drivePackageManager: false;
      hostHandoff: HostHandoffScenario;
    }
  | {
      kind: "apply-update";
      drivePackageManager: boolean;
      hostHandoff: HostHandoffScenario;
    };

type UpdateScenarioInput = {
  selected: PlannedUpdateChannel;
  request: UpdateRequest;
  installation: UpdateConvergencePlanningInput["installation"];
  currentBuildInfo: StationBuildInfo;
  config: StationConfig;
  hostDeps?: HostCommandDeps;
};

async function resolveHostHandoff(input: UpdateScenarioInput): Promise<HostHandoffScenario> {
  const { selected, request } = input;
  if (request.handoff === undefined) return { kind: "not-requested" };

  // Prove preservation viability now; the successor must independently converge fresh evidence.
  const targetDeps: HostCommandDeps = {
    ...input.hostDeps,
    expectedBuildVersion: selected.plan.targetVersion,
    expectedBuildIdentity: input.currentBuildInfo.buildIdentity,
  };
  const planned = await runHostCommand(
    [
      "handoff",
      "--dry-run",
      "--update-crossover",
      ...(selected.plan.status === "current" ? [] : ["--replacement-required"]),
      "--fidelity",
      request.handoff,
    ],
    { config: input.config },
    targetDeps,
  );
  if (planned.action === "handoff" && planned.status === "planned") {
    return { kind: "converge", fidelity: request.handoff };
  }
  throw updateErrorFromUnknown(undefined, {
    code: "UPDATE_HOST_HANDOFF_PREFLIGHT_FAILED",
    message: "The active Station Host could not prepare a safe live handoff.",
    hint: planned.action === "handoff" ? planned.message : "Run stn host status before retrying.",
  });
}

/**
 * ADAPTER
 *
 * Resolves the non-dry update path and preflights default Host preservation before mutation.
 */
export async function resolveUpdateScenario(input: UpdateScenarioInput): Promise<UpdateScenario> {
  const { selected, request, installation } = input;

  if (selected.plan.status === "current") {
    return {
      kind: "already-current",
      hostHandoff: await resolveHostHandoff(input),
    };
  }

  if (installation.whenRequired === "defer") {
    return {
      kind: "defer-to-package-manager",
      drivePackageManager: false,
      hostHandoff:
        request.handoff === undefined ? { kind: "not-requested" } : { kind: "not-needed" },
    };
  }
  return {
    kind: "apply-update",
    drivePackageManager: installation.command.kind === "manager",
    hostHandoff: await resolveHostHandoff(input),
  };
}
