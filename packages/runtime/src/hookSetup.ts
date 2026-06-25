export type ProviderHookScriptOptions = {
  hookScriptPath?: string;
  stationConfigPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  hookBin?: string;
};

export function providerHookCommandArgs(
  provider: string,
  options: ProviderHookScriptOptions = {},
  event?: string,
): string[] {
  const hookArgs = [options.hookBin ?? "stn-ingress"];
  if (options.observerSocketPath !== undefined) {
    hookArgs.push("--socket", options.observerSocketPath);
  }
  if (options.stateDir !== undefined) {
    hookArgs.push("--state-dir", options.stateDir);
  }
  if (options.hookSpoolDir !== undefined) {
    hookArgs.push("--spool-dir", options.hookSpoolDir);
  }
  if (options.stationConfigPath !== undefined) {
    hookArgs.push("--config", options.stationConfigPath);
  }
  if (options.autoStartFromHooks === false) {
    hookArgs.push("--no-auto-start");
  }
  hookArgs.push(provider);
  if (event !== undefined) {
    hookArgs.push(event);
  }
  return hookArgs;
}

export function providerHookCommandLine(
  provider: string,
  options: ProviderHookScriptOptions = {},
  event?: string,
): string {
  return commandLine(providerHookCommandArgs(provider, options, event));
}

export function providerHookScriptOptions(
  hookScriptPath: string,
  options: ProviderHookScriptOptions = {},
): ProviderHookScriptOptions & { hookScriptPath: string } {
  const input: ProviderHookScriptOptions & { hookScriptPath: string } = { hookScriptPath };
  if (options.stationConfigPath !== undefined) {
    input.stationConfigPath = options.stationConfigPath;
  }
  if (options.observerSocketPath !== undefined) {
    input.observerSocketPath = options.observerSocketPath;
  }
  if (options.stateDir !== undefined) {
    input.stateDir = options.stateDir;
  }
  if (options.hookSpoolDir !== undefined) {
    input.hookSpoolDir = options.hookSpoolDir;
  }
  if (options.autoStartFromHooks !== undefined) {
    input.autoStartFromHooks = options.autoStartFromHooks;
  }
  if (options.hookBin !== undefined) {
    input.hookBin = options.hookBin;
  }
  return input;
}

export function expectedProviderHookScript(input: {
  provider: string;
  options?: ProviderHookScriptOptions;
  ignoreFailure?: boolean;
  redirectStderr?: boolean;
}): string {
  const suffix = input.ignoreFailure === true ? " || true" : "";
  const redirect = input.redirectStderr === true ? " > /dev/null 2>&1" : " > /dev/null";
  const options = input.options ?? {};
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `if [ -z "\${STATION_SESSION_ID:-}" ] || [ -z "\${STATION_WORKTREE_ID:-}" ]; then`,
    "  exit 0",
    "fi",
    ...dynamicHookArg(
      "SOCKET_ARG",
      "STATION_OBSERVER_SOCKET_PATH",
      "--socket",
      options.observerSocketPath,
    ),
    ...dynamicHookArg("CONFIG_ARG", "STATION_CONFIG_PATH", "--config", options.stationConfigPath),
    ...dynamicHookArg("STATE_DIR_ARG", "STATION_STATE_DIR", "--state-dir", options.stateDir, {
      skipFallbackWhenEnvPresent: "STATION_CONFIG_PATH",
    }),
    ...dynamicHookArg(
      "SPOOL_DIR_ARG",
      "STATION_HOOK_SPOOL_DIR",
      "--spool-dir",
      options.hookSpoolDir,
      { skipFallbackWhenEnvPresent: "STATION_CONFIG_PATH" },
    ),
    `${providerHookCommandLineFromScriptArgs(input.provider, options)}${redirect}${suffix}`,
    "",
  ].join("\n");
}

function providerHookCommandLineFromScriptArgs(
  provider: string,
  options: ProviderHookScriptOptions,
): string {
  return [
    shellQuote(options.hookBin ?? "stn-ingress"),
    guardedArrayExpansion("SOCKET_ARG"),
    guardedArrayExpansion("STATE_DIR_ARG"),
    guardedArrayExpansion("SPOOL_DIR_ARG"),
    guardedArrayExpansion("CONFIG_ARG"),
    ...(options.autoStartFromHooks === false ? ["--no-auto-start"] : []),
    shellQuote(provider),
  ].join(" ");
}

function guardedArrayExpansion(name: string): string {
  return ["$", `{${name}[@]+"`, "$", `{${name}[@]}"}`].join("");
}

function dynamicHookArg(
  name: string,
  envName: string,
  flag: string,
  fallback: string | undefined,
  options: { skipFallbackWhenEnvPresent?: string } = {},
): string[] {
  const lines = [
    `${name}=()`,
    `if [ -n "\${${envName}:-}" ]; then`,
    `  ${name}=(${flag} "$${envName}")`,
  ];
  if (fallback !== undefined) {
    if (options.skipFallbackWhenEnvPresent !== undefined) {
      lines.push(`elif [ -z "\${${options.skipFallbackWhenEnvPresent}:-}" ]; then`);
    } else {
      lines.push("else");
    }
    lines.push(`  ${name}=(${flag} ${shellQuote(fallback)})`);
  }
  lines.push("fi");
  return lines;
}

export function hookCommandsForEvents<EventName extends string>(
  eventNames: readonly EventName[],
  hookScriptPath: string,
): Record<EventName, string> {
  return Object.fromEntries(eventNames.map((eventName) => [eventName, hookScriptPath])) as Record<
    EventName,
    string
  >;
}

export function assignBackupPaths(
  target: { backupPath?: string; backupPaths?: string[] },
  paths: readonly (string | undefined)[],
): void {
  const backupPaths = paths.filter((path): path is string => path !== undefined);
  if (backupPaths.length === 0) {
    return;
  }
  const first = backupPaths[0];
  if (first === undefined) {
    return;
  }
  target.backupPath = first;
  target.backupPaths = backupPaths;
}

export function commandLine(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
