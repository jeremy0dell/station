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
import { planCursorHooks } from "./hooks.js";

export type CursorHarnessReadinessProviderOptions = CommonHarnessProviderOptions & {
  installHooks?: boolean;
  configPath?: string;
  cursorHooksPath?: string;
  hookScriptPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

type TrackingProbe = {
  trackingSetup: HarnessReadinessFacts["trackingSetup"];
  technicalDetails: HarnessReadinessTechnicalDetail[];
};

async function probeCursorReadiness(
  options: CursorHarnessReadinessProviderOptions,
  context: HarnessReadinessProbeContext = {},
): Promise<HarnessReadinessFacts> {
  const [cli, tracking] = await Promise.all([
    withIsolatedReadinessEnvironment(
      {
        providerHomeEnv: "STATION_CURSOR_HOME",
        ...(options.env === undefined ? {} : { env: options.env }),
      },
      ({ cwd, env }) => probeHarnessCli(cliProbeOptions(options, env, cwd), context),
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
  options: CursorHarnessReadinessProviderOptions,
): Promise<TrackingProbe> {
  if (options.installHooks !== true) {
    return { trackingSetup: "needs_preparation", technicalDetails: [] };
  }
  try {
    const plan = await planCursorHooks(hookOptions(options));
    if (!plan.configChanged && !plan.scriptChanged && plan.missing.length === 0) {
      return { trackingSetup: "prepared", technicalDetails: [] };
    }
    const whollyAbsent =
      plan.before.trim().length === 0 &&
      plan.missing.length === Object.keys(plan.commands).length &&
      plan.scriptChanged;
    return {
      trackingSetup: whollyAbsent ? "needs_preparation" : "repair_needed",
      technicalDetails: [],
    };
  } catch (error) {
    const safeError = safeErrorFromUnknown(error, {
      tag: "CursorHarnessReadinessError",
      code: "HARNESS_CURSOR_TRACKING_CHECK_FAILED",
      message: "Cursor Station tracking could not be inspected.",
      provider: "cursor",
    });
    return {
      trackingSetup: "unknown",
      technicalDetails: [{ code: safeError.code, message: safeError.message }],
    };
  }
}

function hookOptions(
  options: CursorHarnessReadinessProviderOptions,
): Parameters<typeof planCursorHooks>[0] {
  const hookOptions: Parameters<typeof planCursorHooks>[0] = {};
  if (options.cursorHooksPath !== undefined) {
    hookOptions.cursorHooksPath = options.cursorHooksPath;
  }
  if (options.hookScriptPath !== undefined) {
    hookOptions.hookScriptPath = options.hookScriptPath;
  }
  if (options.observerSocketPath !== undefined) {
    hookOptions.observerSocketPath = options.observerSocketPath;
  }
  if (options.stateDir !== undefined) {
    hookOptions.stateDir = options.stateDir;
  }
  if (options.hookSpoolDir !== undefined) {
    hookOptions.hookSpoolDir = options.hookSpoolDir;
  }
  if (options.autoStartFromHooks !== undefined) {
    hookOptions.autoStartFromHooks = options.autoStartFromHooks;
  }
  if (options.configPath !== undefined) {
    hookOptions.stationConfigPath = options.configPath;
  }
  if (options.env !== undefined) {
    hookOptions.env = options.env;
  }
  if (options.homeDir !== undefined) {
    hookOptions.homeDir = options.homeDir;
  }
  return hookOptions;
}

function cliProbeOptions(
  options: CursorHarnessReadinessProviderOptions,
  env: Record<string, string>,
  cwd: string,
): HarnessCliProbeOptions {
  const probeOptions: HarnessCliProbeOptions = {
    command: harnessCommand(options, "STATION_CURSOR_AGENT_BIN", "agent"),
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

/**
 * ADAPTER
 *
 * Translates Cursor CLI and generated-hook evidence into provider-neutral
 * readiness facts without changing Cursor or Station state.
 */
export function createCursorHarnessReadinessProvider(
  options: CursorHarnessReadinessProviderOptions = {},
): HarnessReadinessProvider {
  return {
    id: "cursor",
    probe: (context) => probeCursorReadiness(options, context),
  };
}
