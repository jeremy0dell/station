import type { StationConfig } from "@station/config";
import type { HostHandoffFidelity, UpdateConvergencePlanningInput } from "@station/contracts";
import type { PlannedUpdateChannel } from "../../update/channelDetection.js";
import { updateErrorFromUnknown } from "../../update/updateError.js";
import { type HostCommandDeps, runHostCommand } from "../host/index.js";
import type { UpdateRequest } from "./args.js";

export type HostHandoffScenario =
  | { kind: "not-requested" }
  | { kind: "not-needed" }
  | { kind: "handoff"; fidelity: HostHandoffFidelity };

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
  config: StationConfig;
  hostDeps?: HostCommandDeps;
};

async function resolveHostHandoff(input: UpdateScenarioInput): Promise<HostHandoffScenario> {
  const { selected, request } = input;
  if (request.handoff === undefined) return { kind: "not-requested" };

  // Prove handoff viability before any install channel can mutate the current build.
  const targetDeps: HostCommandDeps = {
    ...input.hostDeps,
    expectedBuildVersion: selected.plan.targetVersion,
  };
  const status = await runHostCommand(["status"], { config: input.config }, targetDeps);
  if (status.action !== "status") throw new Error("Host status returned the wrong action.");
  if (status.probe === "absent" || status.probe === "stale") {
    return { kind: "not-needed" };
  }
  if (status.probe !== "listening" || status.compatibility === undefined) {
    throw updateErrorFromUnknown(undefined, {
      code: "UPDATE_HOST_HANDOFF_PREFLIGHT_FAILED",
      message: "The active Station Host could not be inspected before update.",
      hint: "Run stn host status and resolve its reported socket error before retrying.",
    });
  }
  if (status.compatibility.action === "reuse") {
    return { kind: "not-needed" };
  }
  if (status.livePtyCount === undefined) {
    throw updateErrorFromUnknown(undefined, {
      code: "UPDATE_HOST_HANDOFF_PREFLIGHT_FAILED",
      message: "The active Station Host inventory could not be inspected before update.",
      hint: status.error ?? "Run stn host status and resolve its reported error before retrying.",
    });
  }
  if (status.livePtyCount === 0) return { kind: "not-needed" };
  const planned = await runHostCommand(
    ["handoff", "--dry-run", "--fidelity", request.handoff],
    { config: input.config },
    targetDeps,
  );
  if (planned.action === "handoff" && planned.status === "planned") {
    return { kind: "handoff", fidelity: request.handoff };
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
    return { kind: "already-current", hostHandoff: await resolveHostHandoff(input) };
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
