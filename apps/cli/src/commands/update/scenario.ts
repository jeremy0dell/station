import type { StationConfig } from "@station/config";
import type { HostHandoffFidelity } from "@station/contracts";
import type { PlannedUpdateChannel } from "../../update/channelDetection.js";
import type { UpdateCommandArgv } from "../../update/updateChannel.js";
import { updateErrorFromUnknown } from "../../update/updateError.js";
import { type HostCommandDeps, runHostCommand } from "../host/index.js";
import type { UpdateRequest } from "./args.js";

export type HostHandoffScenario =
  | { kind: "not-requested" }
  | { kind: "not-needed" }
  | { kind: "handoff"; fidelity: HostHandoffFidelity };

export type PreviewMutation =
  | { kind: "apply"; managerCommand?: UpdateCommandArgv }
  | { kind: "defer-to-package-manager"; managerCommand: UpdateCommandArgv };

export type UpdateScenario =
  | { kind: "already-current" }
  | {
      kind: "preview";
      mutation: PreviewMutation;
      hostHandoff: HostHandoffScenario;
    }
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
  config: StationConfig;
  hostDeps?: HostCommandDeps;
};

function skippedHostHandoff(request: UpdateRequest): HostHandoffScenario {
  if (request.handoff === undefined) return { kind: "not-requested" };
  return { kind: "not-needed" };
}

function previewMutation(
  managerCommand: UpdateCommandArgv | undefined,
  request: UpdateRequest,
): PreviewMutation {
  if (managerCommand !== undefined && request.packageManager === "defer") {
    return { kind: "defer-to-package-manager", managerCommand };
  }
  if (managerCommand === undefined) return { kind: "apply" };
  return { kind: "apply", managerCommand };
}

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
  if (status.compatibility.action === "refuse") {
    throw updateErrorFromUnknown(undefined, {
      code: "UPDATE_HOST_HANDOFF_REFUSED",
      message: "The active Station Host protocol cannot hand off to the target build.",
      hint: "Account for every live terminal before retrying with --no-handoff; the next TUI may refuse the incumbent Host.",
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
 * Resolves the selected update path and preflights default Host preservation before mutation.
 */
export async function resolveUpdateScenario(input: UpdateScenarioInput): Promise<UpdateScenario> {
  const { selected, request } = input;
  const managerCommand = selected.plan.managerCommand;
  const managerOwned = managerCommand !== undefined;
  if (request.packageManager === "drive" && !managerOwned) {
    throw updateErrorFromUnknown(undefined, {
      code: "UPDATE_FLAG_INVALID",
      message: "--drive-package-manager requires a Homebrew, npm-global, or mise channel.",
    });
  }

  if (selected.plan.status === "current") return { kind: "already-current" };

  const mutationRequested = !managerOwned || request.packageManager === "drive";
  const hostHandoff = mutationRequested
    ? await resolveHostHandoff(input)
    : skippedHostHandoff(request);

  if (request.mode === "preview") {
    return {
      kind: "preview",
      mutation: previewMutation(managerCommand, request),
      hostHandoff,
    };
  }

  if (!mutationRequested) {
    return { kind: "defer-to-package-manager", drivePackageManager: false, hostHandoff };
  }
  return {
    kind: "apply-update",
    drivePackageManager: request.packageManager === "drive",
    hostHandoff,
  };
}
