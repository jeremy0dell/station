import { join } from "node:path";
import type {
  HarnessReadinessFacts,
  HarnessReadinessProbeContext,
  HarnessReadinessProvider,
  HarnessReadinessTechnicalDetail,
} from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  type HarnessCliProbeOptions,
  harnessCommand,
  harnessReadinessFacts,
  mergeReadinessTechnicalDetails,
  probeHarnessCli,
  withIsolatedReadinessEnvironment,
} from "@station/harness-shared";
import { safeErrorFromUnknown } from "@station/runtime";
import { planOpenCodePlugin } from "./pluginInstall.js";

export type OpenCodeHarnessReadinessProviderOptions = CommonHarnessProviderOptions & {
  installHooks?: boolean;
  opencodeConfigDir?: string;
  pluginPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

type TrackingProbe = {
  trackingSetup: HarnessReadinessFacts["trackingSetup"];
  technicalDetails: HarnessReadinessTechnicalDetail[];
};

/**
 * ADAPTER
 *
 * Translates OpenCode CLI and generated-plugin evidence into provider-neutral
 * readiness facts without changing OpenCode or Station state.
 */
export function createOpenCodeHarnessReadinessProvider(
  options: OpenCodeHarnessReadinessProviderOptions = {},
): HarnessReadinessProvider {
  return {
    id: "opencode",
    probe: (context) => probeOpenCodeReadiness(options, context),
  };
}

async function probeOpenCodeReadiness(
  options: OpenCodeHarnessReadinessProviderOptions,
  context: HarnessReadinessProbeContext = {},
): Promise<HarnessReadinessFacts> {
  const [cli, tracking] = await Promise.all([
    withIsolatedReadinessEnvironment(
      {
        providerHomeEnv: "OPENCODE_CONFIG_DIR",
        ...(options.env === undefined ? {} : { env: options.env }),
      },
      ({ cwd, env, providerHomeDir }) => {
        env.OPENCODE_CONFIG = join(providerHomeDir, "opencode.json");
        env.OPENCODE_TUI_CONFIG = join(providerHomeDir, "tui.json");
        env.OPENCODE_DISABLE_AUTOUPDATE = "true";
        env.OPENCODE_DISABLE_PRUNE = "true";
        return probeHarnessCli(cliProbeOptions(options, env, cwd), context);
      },
    ),
    probeTracking(options),
  ]);
  return harnessReadinessFacts({
    cli: cli.cli,
    authentication: "unknown",
    launchability:
      cli.cli === "available" ? "ready" : cli.cli === "missing" ? "blocked" : "unknown",
    trackingSetup: tracking.trackingSetup,
    technicalDetails: mergeReadinessTechnicalDetails(
      cli.technicalDetails,
      tracking.technicalDetails,
    ),
    ...(cli.installedVersion === undefined ? {} : { installedVersion: cli.installedVersion }),
  });
}

async function probeTracking(
  options: OpenCodeHarnessReadinessProviderOptions,
): Promise<TrackingProbe> {
  if (options.installHooks !== true) {
    return { trackingSetup: "needs_preparation", technicalDetails: [] };
  }
  try {
    const plan = await planOpenCodePlugin(pluginOptions(options));
    if (plan.installed && !plan.changed) {
      return { trackingSetup: "prepared", technicalDetails: [] };
    }
    return {
      trackingSetup: plan.before.trim().length === 0 ? "needs_preparation" : "repair_needed",
      technicalDetails: [],
    };
  } catch (error) {
    const safeError = safeErrorFromUnknown(error, {
      tag: "OpenCodeHarnessReadinessError",
      code: "HARNESS_OPENCODE_TRACKING_CHECK_FAILED",
      message: "OpenCode Station tracking could not be inspected.",
      provider: "opencode",
    });
    return {
      trackingSetup: "unknown",
      technicalDetails: [{ code: safeError.code, message: safeError.message }],
    };
  }
}

function pluginOptions(
  options: OpenCodeHarnessReadinessProviderOptions,
): Parameters<typeof planOpenCodePlugin>[0] {
  const pluginOptions: Parameters<typeof planOpenCodePlugin>[0] = {};
  if (options.opencodeConfigDir !== undefined) {
    pluginOptions.opencodeConfigDir = options.opencodeConfigDir;
  }
  if (options.pluginPath !== undefined) {
    pluginOptions.pluginPath = options.pluginPath;
  }
  if (options.observerSocketPath !== undefined) {
    pluginOptions.observerSocketPath = options.observerSocketPath;
  }
  if (options.stateDir !== undefined) {
    pluginOptions.stateDir = options.stateDir;
  }
  if (options.hookSpoolDir !== undefined) {
    pluginOptions.hookSpoolDir = options.hookSpoolDir;
  }
  if (options.env !== undefined) {
    pluginOptions.env = options.env;
  }
  if (options.homeDir !== undefined) {
    pluginOptions.homeDir = options.homeDir;
  }
  return pluginOptions;
}

function cliProbeOptions(
  options: OpenCodeHarnessReadinessProviderOptions,
  env: Record<string, string>,
  cwd: string,
): HarnessCliProbeOptions {
  const probeOptions: HarnessCliProbeOptions = {
    command: harnessCommand(options, "STATION_OPENCODE_BIN", "opencode"),
    cwd,
    env,
  };
  if (options.runner !== undefined) {
    probeOptions.runner = options.runner;
  }
  if (options.timeoutMs !== undefined) {
    probeOptions.timeoutMs = options.timeoutMs;
  }
  return probeOptions;
}
