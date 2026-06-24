import { checkTmuxDependency } from "@station/tmux";
import type { SetupDependencyFact } from "../model.js";
import { setupProbeTimeoutMs } from "./constants.js";
import { setupEnv } from "./env.js";
import type { SetupDependencyCheckOptions } from "./system.js";

export async function checkSetupTmux(
  options: SetupDependencyCheckOptions = {},
): Promise<SetupDependencyFact> {
  const env = setupEnv(options.env);
  const command = env.STATION_TMUX_BIN ?? "tmux";
  const dependencyOptions: Parameters<typeof checkTmuxDependency>[0] = {
    command,
    timeoutMs: setupProbeTimeoutMs,
  };
  if (options.runner !== undefined) dependencyOptions.runner = options.runner;
  if (options.access !== undefined) dependencyOptions.access = options.access;
  if (env.PATH !== undefined) dependencyOptions.pathEnv = env.PATH;
  const status = await checkTmuxDependency(dependencyOptions);
  if (status.status === "available") {
    const fact: SetupDependencyFact = {
      status: "ok",
      command: status.attemptedCommand,
    };
    if (status.version !== undefined) fact.version = status.version;
    if (status.rawVersion !== undefined) fact.rawVersion = status.rawVersion;
    if (status.resolvedPath !== undefined) fact.resolvedPath = status.resolvedPath;
    return fact;
  }
  return {
    status: "missing",
    command: status.attemptedCommand,
    message: status.installHint,
    ...(status.resolvedPath === undefined ? {} : { resolvedPath: status.resolvedPath }),
  };
}
