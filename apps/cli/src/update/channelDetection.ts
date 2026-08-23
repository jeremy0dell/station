import type { UpdateArtifact } from "@station/contracts";
import type {
  UpdateApplyReportBase,
  UpdateChannel,
  UpdateChannelId,
  UpdateCommandArgv,
  UpdateDetectionBase,
  UpdateOperationOptions,
  UpdatePlanBase,
} from "./updateChannel.js";
import { updateErrorFromUnknown } from "./updateError.js";

export type PlannedUpdateChannel = {
  channel: UpdateChannelId;
  plan: UpdatePlanBase;
  apply(options?: UpdateOperationOptions): Promise<UpdateApplyReportBase>;
  applyRecoveryCommands?(error: unknown): readonly UpdateCommandArgv[] | undefined;
};

export type UpdateChannelProbe = {
  channel: UpdateChannelId;
  detectAndPlan(options?: UpdateOperationOptions): Promise<PlannedUpdateChannel | undefined>;
  proveInstalledTarget(
    target: UpdateArtifact,
    options?: UpdateOperationOptions,
  ): Promise<PlannedUpdateChannel | undefined>;
};
export type UpdateDiscoveryProbe = Pick<UpdateChannelProbe, "channel" | "detectAndPlan">;

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
      const applyRecoveryCommands = channel.applyRecoveryCommands;
      return {
        channel: channel.id,
        plan,
        apply: (applyOptions = {}) => channel.apply(plan, applyOptions),
        ...(applyRecoveryCommands === undefined
          ? {}
          : { applyRecoveryCommands: (error: unknown) => applyRecoveryCommands(plan, error) }),
      };
    },
    async proveInstalledTarget(target, options = {}) {
      const plan = await channel.proveInstalledTarget(target, options);
      if (plan === undefined) return undefined;
      return {
        channel: channel.id,
        plan,
        apply: async () => {
          throw selectionError(
            "UPDATE_SUCCESSOR_ARTIFACT_APPLY_FORBIDDEN",
            "A successor convergence evaluator cannot apply another artifact.",
            "Rerun stn update from the installed launcher to select a new artifact.",
          );
        },
      };
    },
  };
}

/** Selects the local owner of an inherited target without invoking ordinary target discovery. */
export async function selectInstalledUpdateChannel(input: {
  probes: readonly UpdateChannelProbe[];
  target: UpdateArtifact;
  requested?: UpdateChannelId;
  options?: UpdateOperationOptions;
}): Promise<PlannedUpdateChannel> {
  return selectMatchingChannel(input, (probe) =>
    probe.proveInstalledTarget(input.target, input.options),
  );
}

export async function selectUpdateChannel(input: {
  probes: readonly UpdateDiscoveryProbe[];
  requested?: UpdateChannelId;
  options?: UpdateOperationOptions;
}): Promise<PlannedUpdateChannel> {
  return selectMatchingChannel(input, (probe) => probe.detectAndPlan(input.options));
}

async function selectMatchingChannel<Probe extends { channel: UpdateChannelId }>(
  input: {
    probes: readonly Probe[];
    requested?: UpdateChannelId;
  },
  matchProbe: (probe: Probe) => Promise<PlannedUpdateChannel | undefined>,
): Promise<PlannedUpdateChannel> {
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
    const match = await matchProbe(probe);
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
