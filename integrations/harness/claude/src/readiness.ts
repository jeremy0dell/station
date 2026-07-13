import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  harnessReadinessCommandTimeoutMs,
  harnessReadinessFacts,
  mergeReadinessTechnicalDetails,
  probeHarnessCli,
  probeReadinessCommand,
  withIsolatedReadinessEnvironment,
} from "@station/harness-shared";
import { safeErrorFromUnknown } from "@station/runtime";
import { z } from "zod";
import { planClaudeHooks, resolveClaudeUserSettingsPath } from "./hooks.js";

export type ClaudeHarnessReadinessProviderOptions = CommonHarnessProviderOptions & {
  installHooks?: boolean;
  claudeSettingsPath?: string;
  claudeConfigDir?: string;
  hookScriptPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  stationConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

type AuthenticationProbe = {
  authentication: HarnessReadinessFacts["authentication"];
  technicalDetails: HarnessReadinessTechnicalDetail[];
};

type TrackingProbe = {
  trackingSetup: HarnessReadinessFacts["trackingSetup"];
  technicalDetails: HarnessReadinessTechnicalDetail[];
};

const ClaudeAuthStatusSchema = z
  .object({
    loggedIn: z.boolean(),
    authMethod: z.string().optional(),
    apiProvider: z.string().optional(),
    email: z.string().optional(),
    subscriptionType: z.string().optional(),
  })
  .strict();

async function probeClaudeReadiness(
  options: ClaudeHarnessReadinessProviderOptions,
  context: HarnessReadinessProbeContext = {},
): Promise<HarnessReadinessFacts> {
  const [commandEvidence, tracking] = await Promise.all([
    withIsolatedReadinessEnvironment(
      {
        providerHomeEnv: "CLAUDE_CONFIG_DIR",
        ...(options.env === undefined ? {} : { env: options.env }),
      },
      async ({ cwd, env, providerHomeDir }) => {
        env.CLAUDE_CODE_TMPDIR = env.TMPDIR ?? providerHomeDir;
        env.DISABLE_AUTOUPDATER = "1";
        const seedFailure = await seedClaudeAuthentication(options, providerHomeDir).then(
          () => undefined,
          authenticationSeedFailure,
        );
        return Promise.all([
          probeHarnessCli(cliProbeOptions(options, env, cwd), context),
          seedFailure === undefined
            ? probeAuthentication(options, context, env, cwd)
            : Promise.resolve(seedFailure),
        ]);
      },
    ),
    probeTracking(options),
  ]);
  const [cli, authentication] = commandEvidence;
  return harnessReadinessFacts({
    cli: cli.cli,
    authentication: authentication.authentication,
    launchability: launchability(cli.cli, authentication.authentication),
    trackingSetup: tracking.trackingSetup,
    technicalDetails: mergeReadinessTechnicalDetails(
      cli.technicalDetails,
      authentication.technicalDetails,
      tracking.technicalDetails,
    ),
    ...(cli.installedVersion === undefined ? {} : { installedVersion: cli.installedVersion }),
    ...(cli.latestVersion === undefined ? {} : { latestVersion: cli.latestVersion }),
  });
}

async function probeAuthentication(
  options: ClaudeHarnessReadinessProviderOptions,
  context: HarnessReadinessProbeContext,
  env: Record<string, string>,
  cwd: string,
): Promise<AuthenticationProbe> {
  const timeoutMs = harnessReadinessCommandTimeoutMs(context, options.timeoutMs);
  const input = {
    command: command(options),
    args: ["auth", "status"],
    timeoutMs,
    maxOutputChars: 4096,
    allowedExitCodes: [0, 1],
    env,
    cwd,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  };
  const outcome = await probeReadinessCommand(input, options.runner);
  if (outcome.status !== "succeeded") {
    return {
      authentication: "unknown",
      technicalDetails: outcome.status === "unknown" ? [outcome.technicalDetail] : [],
    };
  }
  const loggedIn = parseClaudeAuthStatus(outcome.result.stdout);
  if (loggedIn === undefined) {
    return {
      authentication: "unknown",
      technicalDetails: [
        {
          code: "HARNESS_CLAUDE_AUTH_STATUS_INVALID",
          message: "Claude authentication status output could not be recognized.",
        },
      ],
    };
  }
  return { authentication: loggedIn ? "ready" : "required", technicalDetails: [] };
}

async function probeTracking(
  options: ClaudeHarnessReadinessProviderOptions,
): Promise<TrackingProbe> {
  if (options.installHooks !== true) {
    return { trackingSetup: "needs_preparation", technicalDetails: [] };
  }
  try {
    const plan = await planClaudeHooks(hookOptions(options));
    if (
      !plan.settingsChanged &&
      !plan.scriptChanged &&
      !plan.artifactInvalid &&
      !plan.userSettingsCleanup.changed
    ) {
      return { trackingSetup: "prepared", technicalDetails: [] };
    }
    const whollyAbsent =
      plan.before.trim().length === 0 &&
      plan.missing.length === plan.events.length &&
      plan.scriptChanged &&
      !plan.artifactInvalid &&
      !plan.userSettingsCleanup.changed;
    return {
      trackingSetup: whollyAbsent ? "needs_preparation" : "repair_needed",
      technicalDetails: [],
    };
  } catch (error) {
    return trackingFailure(error, "HARNESS_CLAUDE_TRACKING_CHECK_FAILED");
  }
}

function hookOptions(
  options: ClaudeHarnessReadinessProviderOptions,
): Parameters<typeof planClaudeHooks>[0] {
  const hookOptions: Parameters<typeof planClaudeHooks>[0] = {};
  if (options.claudeSettingsPath !== undefined) {
    hookOptions.claudeSettingsPath = options.claudeSettingsPath;
  }
  if (options.claudeConfigDir !== undefined) {
    hookOptions.claudeConfigDir = options.claudeConfigDir;
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
  if (options.stationConfigPath !== undefined) {
    hookOptions.stationConfigPath = options.stationConfigPath;
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
  options: ClaudeHarnessReadinessProviderOptions,
  env: Record<string, string>,
  cwd: string,
): HarnessCliProbeOptions {
  const probeOptions: HarnessCliProbeOptions = {
    command: command(options),
    cwd,
    env,
    latestPackage: "@anthropic-ai/claude-code",
  };
  if (options.runner !== undefined) {
    probeOptions.runner = options.runner;
  }
  if (options.timeoutMs !== undefined) {
    probeOptions.timeoutMs = options.timeoutMs;
  }
  return probeOptions;
}

async function seedClaudeAuthentication(
  options: ClaudeHarnessReadinessProviderOptions,
  providerHomeDir: string,
): Promise<void> {
  const settingsPath = resolveClaudeUserSettingsPath(options);
  await Promise.all([
    copyPrivateFileIfPresent(settingsPath, join(providerHomeDir, "settings.json")),
    copyPrivateFileIfPresent(
      join(dirname(settingsPath), ".credentials.json"),
      join(providerHomeDir, ".credentials.json"),
    ),
  ]);
}

async function copyPrivateFileIfPresent(source: string, target: string): Promise<void> {
  try {
    await writeFile(target, await readFile(source), { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function authenticationSeedFailure(error: unknown): AuthenticationProbe {
  const safeError = safeErrorFromUnknown(error, {
    tag: "ClaudeHarnessReadinessError",
    code: "HARNESS_CLAUDE_AUTH_SEED_FAILED",
    message: "Claude authentication state could not be prepared for read-only inspection.",
    provider: "claude",
  });
  return {
    authentication: "unknown",
    technicalDetails: [{ code: safeError.code, message: safeError.message }],
  };
}

function command(options: ClaudeHarnessReadinessProviderOptions): string {
  return harnessCommand(options, "STATION_CLAUDE_BIN", "claude");
}

function launchability(
  cli: HarnessReadinessFacts["cli"],
  authentication: HarnessReadinessFacts["authentication"],
): HarnessReadinessFacts["launchability"] {
  if (cli === "missing" || authentication === "required") {
    return "blocked";
  }
  return cli === "available" && authentication === "ready" ? "ready" : "unknown";
}

function trackingFailure(error: unknown, code: string): TrackingProbe {
  const safeError = safeErrorFromUnknown(error, {
    tag: "ClaudeHarnessReadinessError",
    code,
    message: "Claude Station tracking could not be inspected.",
    provider: "claude",
  });
  return {
    trackingSetup: "unknown",
    technicalDetails: [{ code: safeError.code, message: safeError.message }],
  };
}

/**
 * ADAPTER
 *
 * Translates Claude CLI, authentication, and generated-hook evidence into
 * provider-neutral readiness facts without changing Claude or Station state.
 */
export function createClaudeHarnessReadinessProvider(
  options: ClaudeHarnessReadinessProviderOptions = {},
): HarnessReadinessProvider {
  return {
    id: "claude",
    probe: (context) => probeClaudeReadiness(options, context),
  };
}

export function parseClaudeAuthStatus(stdout: string): boolean | undefined {
  try {
    const parsed = ClaudeAuthStatusSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.loggedIn : undefined;
  } catch {
    return undefined;
  }
}
