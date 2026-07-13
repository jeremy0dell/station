import type { Dirent } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  HarnessReadinessFacts,
  HarnessReadinessProbeContext,
  HarnessReadinessTechnicalDetail,
} from "@station/contracts";
import {
  type ExternalCommandInput,
  type ExternalCommandResult,
  type ExternalCommandRunner,
  runExternalCommand,
  safeErrorFromUnknown,
} from "@station/runtime";

export type HarnessReadinessCommandOutcome =
  | { status: "succeeded"; result: ExternalCommandResult }
  | { status: "missing" }
  | { status: "unknown"; technicalDetail: HarnessReadinessTechnicalDetail };

export type HarnessCliReadiness = {
  cli: "available" | "missing" | "unknown";
  installedVersion?: string;
  latestVersion?: string;
  technicalDetails: HarnessReadinessTechnicalDetail[];
};

export type HarnessCliProbeOptions = {
  command: string;
  args?: string[];
  latestPackage?: string;
  runner?: ExternalCommandRunner;
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
};

export type HarnessReadinessEnvironmentOptions = {
  env?: NodeJS.ProcessEnv;
  providerHomeEnv?: string;
};

export type HarnessReadinessEnvironment = {
  cwd: string;
  env: Record<string, string>;
  homeDir: string;
  providerHomeDir: string;
};

export type HarnessReadinessFactsInput = {
  cli: HarnessReadinessFacts["cli"];
  authentication: HarnessReadinessFacts["authentication"];
  launchability: HarnessReadinessFacts["launchability"];
  trackingSetup: HarnessReadinessFacts["trackingSetup"];
  installedVersion?: string;
  latestVersion?: string;
  technicalDetails: HarnessReadinessTechnicalDetail[];
};

/**
 * Runs nominally read-only CLIs in PID-owned disposable homes because some providers initialize state during inspection.
 * Dead-owner homes are reaped on the next probe; live or indeterminate owners remain isolated.
 */
export async function withIsolatedReadinessEnvironment<T>(
  options: HarnessReadinessEnvironmentOptions,
  task: (environment: HarnessReadinessEnvironment) => Promise<T>,
): Promise<T> {
  await reapOrphanedReadinessEnvironments();
  const root = await mkdtemp(join(tmpdir(), `station-readiness-${process.pid}-`));
  const homeDir = join(root, "home");
  const cwd = join(root, "cwd");
  const tempDir = join(root, "tmp");
  const providerHomeDir = join(root, "provider");
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(tempDir, { recursive: true }),
    mkdir(providerHomeDir, { recursive: true }),
  ]);

  const env = definedEnvironment(options.env ?? process.env);
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.XDG_CACHE_HOME = join(root, "cache");
  env.XDG_CONFIG_HOME = join(root, "config");
  env.XDG_DATA_HOME = join(root, "data");
  env.XDG_STATE_HOME = join(root, "state");
  env.APPDATA = join(root, "appdata", "roaming");
  env.LOCALAPPDATA = join(root, "appdata", "local");
  env.NODE_COMPILE_CACHE = join(root, "cache", "node");
  env.npm_config_cache = join(root, "cache", "npm");
  env.npm_config_logs_max = "0";
  env.npm_config_update_notifier = "false";
  env.npm_config_userconfig = join(root, "npmrc");
  env.TMPDIR = tempDir;
  env.TMP = tempDir;
  env.TEMP = tempDir;
  if (options.providerHomeEnv !== undefined) {
    env[options.providerHomeEnv] = providerHomeDir;
  }
  try {
    return await task({ cwd, env, homeDir, providerHomeDir });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function reapOrphanedReadinessEnvironments(): Promise<void> {
  const baseDir = tmpdir();
  let entries: Dirent[];
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const match = /^station-readiness-(\d+)-[A-Za-z0-9]{6}$/.exec(entry.name);
      if (!entry.isDirectory() || match === null) return;

      const ownerPid = Number(match[1]);
      if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !isProcessProvablyDead(ownerPid)) {
        return;
      }

      const path = join(baseDir, entry.name);
      try {
        const metadata = await lstat(path);
        const currentUid = process.getuid?.();
        if (!metadata.isDirectory() || (currentUid !== undefined && metadata.uid !== currentUid)) {
          return;
        }
        await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Orphan cleanup is best-effort and must not block the current readiness probe.
      }
    }),
  );
}

function isProcessProvablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export function harnessReadinessFacts(input: HarnessReadinessFactsInput): HarnessReadinessFacts {
  const common = {
    authentication: input.authentication,
    launchability: input.launchability,
    trackingSetup: input.trackingSetup,
    technicalDetails: input.technicalDetails,
  };
  const facts: HarnessReadinessFacts =
    input.cli === "available"
      ? {
          cli: "available",
          ...common,
          ...(input.installedVersion === undefined
            ? {}
            : { installedVersion: input.installedVersion }),
        }
      : input.cli === "missing"
        ? { cli: "missing", ...common }
        : { cli: "unknown", ...common };
  if (input.latestVersion !== undefined) {
    facts.latestVersion = input.latestVersion;
  }
  return facts;
}

export async function probeReadinessCommand(
  input: ExternalCommandInput,
  runner?: ExternalCommandRunner,
): Promise<HarnessReadinessCommandOutcome> {
  try {
    const commandInput =
      input.cwd !== undefined && isRelativePathCommand(input.command)
        ? { ...input, command: resolve(input.command) }
        : input;
    return { status: "succeeded", result: await runExternalCommand(commandInput, runner) };
  } catch (error) {
    const safeError = safeErrorFromUnknown(error, {
      tag: "HarnessReadinessProbeError",
      code: "HARNESS_READINESS_PROBE_FAILED",
      message: "The harness readiness probe failed.",
    });
    if (safeError.code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "unknown",
      technicalDetail: { code: safeError.code, message: safeError.message },
    };
  }
}

export async function probeHarnessCli(
  options: HarnessCliProbeOptions,
  context: HarnessReadinessProbeContext = {},
): Promise<HarnessCliReadiness> {
  const timeoutMs = harnessReadinessCommandTimeoutMs(context, options.timeoutMs);
  const installedPromise = probeReadinessCommand(
    commandInput(
      options.command,
      options.args ?? ["--version"],
      timeoutMs,
      context,
      options.env,
      options.cwd,
    ),
    options.runner,
  );
  const latestPromise =
    options.latestPackage === undefined
      ? Promise.resolve(undefined)
      : probeLatestVersion(
          options.latestPackage,
          timeoutMs,
          context,
          options.runner,
          options.env,
          options.cwd,
        );
  const [installed, latestVersion] = await Promise.all([installedPromise, latestPromise]);

  if (installed.status === "missing") {
    return withLatestVersion({ cli: "missing", technicalDetails: [] }, latestVersion);
  }
  if (installed.status === "unknown") {
    return withLatestVersion(
      { cli: "unknown", technicalDetails: [installed.technicalDetail] },
      latestVersion,
    );
  }

  const installedVersion = parseVersionToken(installed.result.stdout);
  if (installedVersion === undefined) {
    return withLatestVersion(
      {
        cli: "unknown",
        technicalDetails: [
          {
            code: "HARNESS_READINESS_VERSION_INVALID",
            message: "The harness version output could not be recognized.",
          },
        ],
      },
      latestVersion,
    );
  }

  const readiness: HarnessCliReadiness = {
    cli: "available",
    installedVersion,
    technicalDetails: [],
  };
  return withLatestVersion(readiness, latestVersion);
}

export function harnessReadinessCommandTimeoutMs(
  context: HarnessReadinessProbeContext,
  configuredTimeoutMs?: number,
): number {
  return Math.min(context.timeoutMs ?? 5_000, configuredTimeoutMs ?? 5_000, 5_000);
}

export function mergeReadinessTechnicalDetails(
  ...groups: readonly HarnessReadinessTechnicalDetail[][]
): HarnessReadinessTechnicalDetail[] {
  const seen = new Set<string>();
  const merged: HarnessReadinessTechnicalDetail[] = [];
  for (const detail of groups.flat()) {
    const key = `${detail.code}\0${detail.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(detail);
    }
  }
  return merged;
}

function commandInput(
  command: string,
  args: string[],
  timeoutMs: number,
  context: HarnessReadinessProbeContext,
  env: Record<string, string> | undefined,
  cwd: string | undefined,
): ExternalCommandInput {
  const input: ExternalCommandInput = {
    command,
    args,
    timeoutMs,
    maxOutputChars: 4096,
  };
  if (context.signal !== undefined) {
    input.signal = context.signal;
  }
  if (env !== undefined) {
    input.env = env;
  }
  if (cwd !== undefined) {
    input.cwd = cwd;
  }
  return input;
}

async function probeLatestVersion(
  packageName: string,
  timeoutMs: number,
  context: HarnessReadinessProbeContext,
  runner?: ExternalCommandRunner,
  env?: Record<string, string>,
  cwd?: string,
): Promise<string | undefined> {
  const outcome = await probeReadinessCommand(
    commandInput("npm", ["view", packageName, "version"], timeoutMs, context, env, cwd),
    runner,
  );
  return outcome.status === "succeeded" ? parseVersionToken(outcome.result.stdout) : undefined;
}

function withLatestVersion(
  readiness: HarnessCliReadiness,
  latestVersion: string | undefined,
): HarnessCliReadiness {
  if (latestVersion !== undefined) {
    readiness.latestVersion = latestVersion;
  }
  return readiness;
}

function parseVersionToken(output: string): string | undefined {
  return output.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

function definedEnvironment(input: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function isRelativePathCommand(command: string): boolean {
  return !isAbsolute(command) && (command.includes("/") || command.includes("\\"));
}
