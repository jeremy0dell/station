import { constants as fsConstants } from "node:fs";
import { access as nodeAccess, stat as nodeStat, realpath } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliEnv } from "../../../env.js";
import type { SetupLauncherFact, SetupLaunchersFact } from "../model.js";

export type CheckSetupLaunchersOptions = {
  env?: CliEnv;
  access?: (path: string) => Promise<void>;
  packageRoot?: string;
  compiled?: boolean;
  providerHookIngressLauncher?: string;
};

const launcherDefinitions = {
  station: {
    command: "stn",
    relativePath: "bin/stn",
  },
  ingress: {
    command: "stn-ingress",
    relativePath: "bin/stn-ingress",
  },
  tmuxPopup: {
    command: "stn-tmux-popup",
    relativePath: "integrations/terminal/tmux/bin/stn-popup",
  },
} as const;

export async function checkSetupLaunchers(
  options: CheckSetupLaunchersOptions = {},
): Promise<SetupLaunchersFact> {
  const env = options.env ?? process.env;
  const packageRoot = options.packageRoot ?? setupPackageRoot();
  const access = options.access ?? executableAccess;
  if (options.providerHookIngressLauncher !== undefined) {
    const runtimeRoot = dirname(options.providerHookIngressLauncher);
    const source = options.compiled === true ? "installed" : "checkout";
    const [station, ingress, tmuxPopup] = await Promise.all([
      checkRuntimeLauncher(launcherDefinitions.station, join(runtimeRoot, "stn"), source, {
        access,
        env,
        packageRoot,
      }),
      checkRuntimeLauncher(
        launcherDefinitions.ingress,
        options.providerHookIngressLauncher,
        source,
        { access, env, packageRoot },
      ),
      checkLauncher(launcherDefinitions.tmuxPopup, { access, env, packageRoot }),
    ]);
    return { packageRoot, station, ingress, tmuxPopup };
  }
  const [station, ingress, tmuxPopup] = await Promise.all([
    checkLauncher(launcherDefinitions.station, { access, env, packageRoot }),
    checkLauncher(launcherDefinitions.ingress, { access, env, packageRoot }),
    checkLauncher(launcherDefinitions.tmuxPopup, { access, env, packageRoot }),
  ]);
  return {
    packageRoot,
    station,
    ingress,
    tmuxPopup,
  };
}

async function checkRuntimeLauncher(
  definition: (typeof launcherDefinitions)["station" | "ingress"],
  runtimePath: string,
  runtimeSource: "installed" | "checkout",
  options: {
    access: (path: string) => Promise<void>;
    env: CliEnv | NodeJS.ProcessEnv;
    packageRoot: string;
  },
): Promise<SetupLauncherFact> {
  const checkoutPath = join(options.packageRoot, definition.relativePath);
  try {
    await options.access(runtimePath);
  } catch {
    return {
      status: "missing",
      source: "missing",
      command: runtimePath,
      checkoutPath,
      message: `The active ${definition.command} runtime launcher is missing or not executable at ${runtimePath}.`,
    };
  }

  const pathMatch = await resolveOnPath(definition.command, options.env.PATH, options.access);
  const onPath = pathMatch !== undefined && (await setupLauncherPathsMatch(pathMatch, runtimePath));
  const launcher: SetupLauncherFact = {
    status: "ok",
    source: onPath ? "path" : runtimeSource,
    command: runtimePath,
    resolvedPath: runtimePath,
    checkoutPath,
  };
  if (pathMatch !== undefined && !onPath) {
    launcher.message = `${definition.command} on PATH belongs to a different runtime; setup will use ${runtimePath}.`;
  } else if (pathMatch === undefined && runtimeSource === "checkout") {
    launcher.message = `${definition.command} is not on PATH; setup will use the current checkout launcher.`;
  }
  return launcher;
}

export async function setupLauncherPathsMatch(left: string, right: string): Promise<boolean> {
  if (resolve(left) === resolve(right)) return true;
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return false;
  }
}

export function setupLauncherExecutable(launcher: SetupLauncherFact): string {
  return launcher.resolvedPath ?? launcher.command;
}

export function setupPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
}

async function checkLauncher(
  definition: (typeof launcherDefinitions)[keyof typeof launcherDefinitions],
  options: {
    access: (path: string) => Promise<void>;
    env: CliEnv | NodeJS.ProcessEnv;
    packageRoot: string;
  },
): Promise<SetupLauncherFact> {
  const pathMatch = await resolveOnPath(definition.command, options.env.PATH, options.access);
  const checkoutPath = join(options.packageRoot, definition.relativePath);
  if (pathMatch !== undefined) {
    return {
      status: "ok",
      source: "path",
      command: definition.command,
      resolvedPath: pathMatch,
      checkoutPath,
    };
  }

  try {
    await options.access(checkoutPath);
    return {
      status: "ok",
      source: "checkout",
      command: checkoutPath,
      checkoutPath,
      message: `${definition.command} is not on PATH; setup will use the current checkout launcher.`,
    };
  } catch {
    return {
      status: "missing",
      source: "missing",
      command: definition.command,
      checkoutPath,
      message: `${definition.command} is not available on PATH or in the current checkout.`,
    };
  }
}

async function resolveOnPath(
  command: string,
  pathEnv: string | undefined,
  access: (path: string) => Promise<void>,
): Promise<string | undefined> {
  if (pathEnv === undefined || pathEnv.length === 0) {
    return undefined;
  }
  for (const pathEntry of pathEnv.split(delimiter)) {
    if (pathEntry.length === 0) continue;
    const candidate = resolve(pathEntry, command);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep probing PATH entries.
    }
  }
  return undefined;
}

async function executableAccess(path: string): Promise<void> {
  if (!(await nodeStat(path)).isFile()) {
    throw new Error(`${path} is not a regular file.`);
  }
  await nodeAccess(path, fsConstants.X_OK);
}
