import type { HostHandoffFidelity } from "@station/contracts";
import { type UpdateChannelId, updateChannelIds } from "../../update/updateChannel.js";

export type UpdateRequest = {
  channel?: UpdateChannelId;
  mode: "preview" | "apply";
  output: "text" | "json";
  packageManager: "defer" | "drive";
  handoff?: HostHandoffFidelity;
};

const updateUsage =
  "Usage: stn update [--channel <installer-binary|dev-checkout|homebrew|npm-global|mise>] [--dry-run] [--json] [--drive-package-manager] [--handoff[=processes|screen]]";

function isUpdateChannelId(value: string | undefined): value is UpdateChannelId {
  return value !== undefined && updateChannelIds.some((channel) => channel === value);
}

export function parseUpdateRequest(args: readonly string[]): UpdateRequest {
  let channel: UpdateChannelId | undefined;
  let mode: UpdateRequest["mode"] = "apply";
  let output: UpdateRequest["output"] = "text";
  let packageManager: UpdateRequest["packageManager"] = "defer";
  let handoff: HostHandoffFidelity | undefined;
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
    if (arg === "--drive-package-manager") {
      if (packageManager === "drive") {
        throw new Error("--drive-package-manager may be provided only once.");
      }
      packageManager = "drive";
      continue;
    }
    if (arg === "--handoff") {
      if (handoff !== undefined) throw new Error("--handoff may be provided only once.");
      handoff = "processes";
      continue;
    }
    if (arg?.startsWith("--handoff=")) {
      if (handoff !== undefined) throw new Error("--handoff may be provided only once.");
      const value = arg.slice("--handoff=".length);
      if (value !== "processes" && value !== "screen") throw new Error(updateUsage);
      handoff = value;
      continue;
    }
    throw new Error(updateUsage);
  }
  return {
    ...(channel === undefined ? {} : { channel }),
    mode,
    output,
    packageManager,
    ...(handoff === undefined ? {} : { handoff }),
  };
}
