import type {
  UpdateApplyReportBase,
  UpdateChannel,
  UpdateChannelId,
  UpdateDetectionBase,
  UpdateOperationOptions,
  UpdatePlanBase,
} from "./updateChannel.js";
import { updateErrorFromUnknown } from "./updateError.js";

export type PlannedUpdateChannel = {
  channel: UpdateChannelId;
  plan: UpdatePlanBase;
  apply(options?: UpdateOperationOptions): Promise<UpdateApplyReportBase>;
};

export type UpdateChannelProbe = {
  channel: UpdateChannelId;
  detectAndPlan(options?: UpdateOperationOptions): Promise<PlannedUpdateChannel | undefined>;
};

export function createUpdateChannelProbe<
  Detection extends UpdateDetectionBase,
  Plan extends UpdatePlanBase,
  Report extends UpdateApplyReportBase,
>(channel: UpdateChannel<Detection, Plan, Report>): UpdateChannelProbe {
  return {
    channel: channel.id,
    async detectAndPlan(options = {}) {
      const detection = await channel.detect(options);
      if (detection === undefined) return undefined;
      const plan = await channel.plan(detection, options);
      return {
        channel: channel.id,
        plan,
        apply: (applyOptions = {}) => channel.apply(plan, applyOptions),
      };
    },
  };
}

export async function selectUpdateChannel(input: {
  probes: readonly UpdateChannelProbe[];
  requested?: UpdateChannelId;
  options?: UpdateOperationOptions;
}): Promise<PlannedUpdateChannel> {
  const selectedProbes =
    input.requested === undefined
      ? input.probes
      : input.probes.filter(({ channel }) => channel === input.requested);
  if (selectedProbes.length === 0) {
    throw selectionError(
      "UPDATE_CHANNEL_UNKNOWN",
      `Unknown Station update channel '${input.requested ?? ""}'.`,
      "Use stn update --help to list supported channels.",
    );
  }

  const matches: PlannedUpdateChannel[] = [];
  for (const probe of selectedProbes) {
    const match = await probe.detectAndPlan(input.options);
    if (match !== undefined) matches.push(match);
  }
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) {
    throw selectionError(
      "UPDATE_CHANNEL_NOT_DETECTED",
      input.requested === undefined
        ? "No supported update channel owns the running Station installation."
        : `The ${input.requested} channel does not own the running Station installation.`,
      "Run the installation owner's update command or select the channel that owns this launcher.",
    );
  }
  throw selectionError(
    "UPDATE_CHANNEL_AMBIGUOUS",
    `Multiple update channels own the running Station installation: ${matches
      .map(({ channel }) => channel)
      .join(", ")}.`,
    "Rerun stn update with one explicit --channel value.",
  );
}

function selectionError(code: string, message: string, hint: string) {
  return updateErrorFromUnknown(undefined, { code, message, hint });
}
