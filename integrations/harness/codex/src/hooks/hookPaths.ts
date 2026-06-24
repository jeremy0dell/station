import { homedir } from "node:os";
import { join } from "node:path";
import { defaultStationStateDir, resolveLocalPath } from "@station/runtime";
import {
  CODEX_BASE_CONFIG_FILE,
  CODEX_STATION_PROFILE_CONFIG_FILE,
  GENERATED_HOOK_SCRIPT_NAME,
} from "./hookConstants.js";

export type CodexHookPathOptions = {
  codexConfigPath?: string;
  hookScriptPath?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export function resolveCodexConfigPath(options: CodexHookPathOptions = {}): string {
  if (options.codexConfigPath !== undefined) {
    return resolveLocalPath(options.codexConfigPath, options.homeDir);
  }

  return join(resolveCodexHome(options), CODEX_STATION_PROFILE_CONFIG_FILE);
}

export function resolveCodexBaseConfigPath(options: CodexHookPathOptions = {}): string {
  return join(resolveCodexHome(options), CODEX_BASE_CONFIG_FILE);
}

export function resolveCodexHookScriptPath(options: CodexHookPathOptions = {}): string {
  if (options.hookScriptPath !== undefined) {
    return resolveLocalPath(options.hookScriptPath, options.homeDir);
  }
  const stateDir = options.stateDir ?? defaultStationStateDir(options.env, options.homeDir);
  return resolveLocalPath(join(stateDir, "hooks", GENERATED_HOOK_SCRIPT_NAME), options.homeDir);
}

function resolveCodexHome(options: CodexHookPathOptions): string {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  if (env.CODEX_HOME !== undefined && env.CODEX_HOME.length > 0) {
    return resolveLocalPath(env.CODEX_HOME, homeDir);
  }
  return resolveLocalPath("~/.codex", homeDir);
}
