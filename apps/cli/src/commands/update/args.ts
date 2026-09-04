import type { HostHandoffFidelity } from "@station/contracts";
import { type UpdateChannelId, updateChannelIds } from "../../update/updateChannel.js";

export type UpdateRequest = {
  channel?: UpdateChannelId;
  mode: "preview" | "apply";
  output: "text" | "json";
  packageManager: "defer" | "drive";
  handoff?: HostHandoffFidelity;
  reap: boolean;
};

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
  return {
    ...(channel === undefined ? {} : { channel }),
    mode,
    output,
    packageManager,
    reap,
    ...(handoff === undefined ? {} : { handoff }),
  };
}
