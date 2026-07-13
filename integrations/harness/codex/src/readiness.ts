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
import { parse } from "smol-toml";
import { z } from "zod";
import { planCodexHooks, resolveCodexBaseConfigPath } from "./hooks.js";

export type CodexHarnessReadinessProviderOptions = CommonHarnessProviderOptions & {
  installHooks?: boolean;
  codexConfigPath?: string;
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

type AuthenticationSeed =
  | { inspectable: true }
  | { inspectable: false; probe: AuthenticationProbe };

const CodexAuthConfigSchema = z.object({
  cli_auth_credentials_store: z.enum(["file", "keyring", "auto"]).optional(),
});

/**
 * ADAPTER
 *
 * Translates Codex CLI, login, and generated-hook evidence into
 * provider-neutral readiness facts without changing Codex or Station state.
 */
export function createCodexHarnessReadinessProvider(
  options: CodexHarnessReadinessProviderOptions = {},
): HarnessReadinessProvider {
  return {
    id: "codex",
    probe: (context) => probeCodexReadiness(options, context),
  };
}

async function probeCodexReadiness(
  options: CodexHarnessReadinessProviderOptions,
  context: HarnessReadinessProbeContext = {},
): Promise<HarnessReadinessFacts> {
  const [commandEvidence, tracking] = await Promise.all([
    withIsolatedReadinessEnvironment(
      {
        providerHomeEnv: "CODEX_HOME",
        ...(options.env === undefined ? {} : { env: options.env }),
      },
      async ({ cwd, env, providerHomeDir }) => {
        const seed = await seedCodexAuthentication(options, providerHomeDir).catch((error) => ({
          inspectable: false as const,
          probe: authenticationSeedFailure(error),
        }));
        return Promise.all([
          probeHarnessCli(cliProbeOptions(options, env, cwd), context),
          seed.inspectable
            ? probeAuthentication(options, context, env, cwd)
            : Promise.resolve(seed.probe),
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
  options: CodexHarnessReadinessProviderOptions,
  context: HarnessReadinessProbeContext,
  env: Record<string, string>,
  cwd: string,
): Promise<AuthenticationProbe> {
  const timeoutMs = harnessReadinessCommandTimeoutMs(context, options.timeoutMs);
  const outcome = await probeReadinessCommand(
    {
      command: command(options),
      args: ["-c", 'cli_auth_credentials_store="file"', "login", "status"],
      timeoutMs,
      maxOutputChars: 4096,
      allowedExitCodes: [0, 1],
      cwd,
      env,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
    options.runner,
  );
  if (outcome.status !== "succeeded") {
    return {
      authentication: "unknown",
      technicalDetails: outcome.status === "unknown" ? [outcome.technicalDetail] : [],
    };
  }
  if (outcome.result.exitCode === 0) {
    return { authentication: "ready", technicalDetails: [] };
  }
  if (outcome.result.exitCode === 1) {
    return { authentication: "required", technicalDetails: [] };
  }
  return {
    authentication: "unknown",
    technicalDetails: [
      {
        code: "HARNESS_CODEX_AUTH_STATUS_INVALID",
        message: "Codex login status returned an unexpected result.",
      },
    ],
  };
}

async function probeTracking(
  options: CodexHarnessReadinessProviderOptions,
): Promise<TrackingProbe> {
  if (options.installHooks !== true) {
    return { trackingSetup: "needs_preparation", technicalDetails: [] };
  }
  try {
    const plan = await planCodexHooks(hookOptions(options));
    if (!plan.configChanged && !plan.scriptChanged && !plan.generatedGlobalChanged) {
      return { trackingSetup: "prepared", technicalDetails: [] };
    }
    const whollyAbsent =
      plan.before.trim().length === 0 &&
      plan.missing.length === Object.keys(plan.commands).length &&
      plan.scriptChanged &&
      !plan.generatedGlobalChanged;
    return {
      trackingSetup: whollyAbsent ? "needs_preparation" : "repair_needed",
      technicalDetails: [],
    };
  } catch (error) {
    const safeError = safeErrorFromUnknown(error, {
      tag: "CodexHarnessReadinessError",
      code: "HARNESS_CODEX_TRACKING_CHECK_FAILED",
      message: "Codex Station tracking could not be inspected.",
      provider: "codex",
    });
    return {
      trackingSetup: "unknown",
      technicalDetails: [{ code: safeError.code, message: safeError.message }],
    };
  }
}

function hookOptions(
  options: CodexHarnessReadinessProviderOptions,
): Parameters<typeof planCodexHooks>[0] {
  const hookOptions: Parameters<typeof planCodexHooks>[0] = {};
  if (options.codexConfigPath !== undefined) {
    hookOptions.codexConfigPath = options.codexConfigPath;
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

function command(options: CodexHarnessReadinessProviderOptions): string {
  return harnessCommand(options, "STATION_CODEX_BIN", "codex");
}

function cliProbeOptions(
  options: CodexHarnessReadinessProviderOptions,
  env: Record<string, string>,
  cwd: string,
): HarnessCliProbeOptions {
  const probeOptions: HarnessCliProbeOptions = {
    command: command(options),
    cwd,
    env,
    latestPackage: "@openai/codex",
  };
  if (options.runner !== undefined) {
    probeOptions.runner = options.runner;
  }
  if (options.timeoutMs !== undefined) {
    probeOptions.timeoutMs = options.timeoutMs;
  }
  return probeOptions;
}

async function seedCodexAuthentication(
  options: CodexHarnessReadinessProviderOptions,
  providerHomeDir: string,
): Promise<AuthenticationSeed> {
  const configPath = resolveCodexBaseConfigPath(options);
  const credentialStore = await readCodexCredentialStore(configPath);
  if (credentialStore === "keyring" || credentialStore === "auto") {
    return {
      inspectable: false,
      probe: {
        authentication: "unknown",
        technicalDetails: [
          {
            code: "HARNESS_CODEX_AUTH_STORE_UNINSPECTABLE",
            message: "Codex keyring authentication cannot be inspected from isolated state.",
          },
        ],
      },
    };
  }
  await copyPrivateFileIfPresent(
    join(dirname(configPath), "auth.json"),
    join(providerHomeDir, "auth.json"),
  );
  return { inspectable: true };
}

async function readCodexCredentialStore(
  source: string,
): Promise<"file" | "keyring" | "auto" | undefined> {
  try {
    const config = CodexAuthConfigSchema.parse(parse(await readFile(source, "utf8")));
    return config.cli_auth_credentials_store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
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
    tag: "CodexHarnessReadinessError",
    code: "HARNESS_CODEX_AUTH_SEED_FAILED",
    message: "Codex authentication state could not be prepared for read-only inspection.",
    provider: "codex",
  });
  return {
    authentication: "unknown",
    technicalDetails: [{ code: safeError.code, message: safeError.message }],
  };
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
