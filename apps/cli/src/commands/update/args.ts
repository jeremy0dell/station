import type { HostHandoffFidelity, UpdateArtifact } from "@station/contracts";
import { type UpdateChannelId, updateChannelIds } from "../../update/updateChannel.js";
import type { UpdateConvergenceRequest } from "../../update/updateConvergencePort.js";

export type UpdateRequest = UpdateConvergenceRequest & { output: "text" | "json" };

const updateUsage =
  "Usage: stn update [--channel <installer-binary|dev-checkout|homebrew|npm-global|mise>] [--dry-run] [--reap] [--json] [--drive-package-manager] [--handoff[=processes|screen] | --no-handoff]";

function isUpdateChannelId(value: string | undefined): value is UpdateChannelId {
  return value !== undefined && updateChannelIds.some((channel) => channel === value);
}

export function parseUpdateRequest(args: readonly string[]): UpdateRequest {
  let channel: UpdateChannelId | undefined;
  let mode: UpdateRequest["mode"] = "apply";
  let output: UpdateRequest["output"] = "text";
  let packageManager: UpdateRequest["packageManager"] = "defer";
  let handoff: HostHandoffFidelity | undefined = "processes";
  let handoffConfigured = false;
  let reap = false;
  let evaluator: UpdateRequest["evaluator"] = "incumbent-cli";
  let successorTargetVersion: string | undefined;
  let successorTargetRevision: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--channel") {
      if (channel !== undefined) throw new Error("--channel may be provided only once.");
      const value = args[index + 1];
      if (!isUpdateChannelId(value)) throw new Error(updateUsage);
      channel = value;
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      if (mode === "preview") throw new Error("--dry-run may be provided only once.");
      mode = "preview";
      continue;
    }
    if (arg === "--json") {
      if (output === "json") throw new Error("--json may be provided only once.");
      output = "json";
      continue;
    }
    if (arg === "--reap") {
      if (reap) throw new Error("--reap may be provided only once.");
      reap = true;
      continue;
    }
    if (arg === "--internal-successor-evaluator") {
      if (evaluator === "successor-cli") throw new Error(updateUsage);
      evaluator = "successor-cli";
      continue;
    }
    if (arg === "--internal-selected-target-version") {
      if (successorTargetVersion !== undefined) throw new Error(updateUsage);
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error(updateUsage);
      }
      successorTargetVersion = value;
      index += 1;
      continue;
    }
    if (arg === "--internal-selected-target-revision") {
      if (successorTargetRevision !== undefined) throw new Error(updateUsage);
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error(updateUsage);
      }
      successorTargetRevision = value;
      index += 1;
      continue;
    }
    if (arg === "--drive-package-manager") {
      if (packageManager === "drive") {
        throw new Error("--drive-package-manager may be provided only once.");
      }
      packageManager = "drive";
      continue;
    }
    if (arg === "--handoff") {
      if (handoffConfigured) throw new Error("Host handoff may be configured only once.");
      handoffConfigured = true;
      handoff = "processes";
      continue;
    }
    if (arg?.startsWith("--handoff=")) {
      if (handoffConfigured) throw new Error("Host handoff may be configured only once.");
      const value = arg.slice("--handoff=".length);
      if (value !== "processes" && value !== "screen") throw new Error(updateUsage);
      handoffConfigured = true;
      handoff = value;
      continue;
    }
    if (arg === "--no-handoff") {
      if (handoffConfigured) throw new Error("Host handoff may be configured only once.");
      handoffConfigured = true;
      handoff = undefined;
      continue;
    }
    throw new Error(updateUsage);
  }
  if (reap && mode !== "preview") {
    throw new Error(
      "stn update --reap is not an execution mode yet. Use --dry-run --reap to inspect non-resumable consequences without mutation.",
    );
  }
  if (
    (evaluator === "successor-cli") !== (successorTargetVersion !== undefined) ||
    (successorTargetRevision !== undefined && successorTargetVersion === undefined)
  ) {
    throw new Error(updateUsage);
  }
  const successorTarget: UpdateArtifact | undefined =
    successorTargetVersion === undefined
      ? undefined
      : {
          version: successorTargetVersion,
          ...(successorTargetRevision === undefined ? {} : { revision: successorTargetRevision }),
        };
  return {
    ...(channel === undefined ? {} : { channel }),
    mode,
    output,
    packageManager,
    reap,
    evaluator,
    ...(handoff === undefined ? {} : { handoff }),
    ...(successorTarget === undefined ? {} : { successorTarget }),
  };
}
