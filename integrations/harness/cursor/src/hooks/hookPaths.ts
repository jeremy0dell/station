import { join } from "node:path";
import { defaultStationStateDir, resolveLocalPath } from "@station/runtime";
import { CURSOR_HOOKS_FILE, GENERATED_HOOK_SCRIPT_NAME } from "./hookConstants.js";

export type CursorHookPathOptions = {
  cursorHooksPath?: string;
  hookScriptPath?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export function resolveCursorHooksPath(options: CursorHookPathOptions = {}): string {
  if (options.cursorHooksPath !== undefined) {
    return resolveLocalPath(options.cursorHooksPath, options.homeDir);
  }
  const env = options.env ?? process.env;
  if (env.STATION_CURSOR_HOOKS_PATH !== undefined && env.STATION_CURSOR_HOOKS_PATH.length > 0) {
    return resolveLocalPath(env.STATION_CURSOR_HOOKS_PATH, options.homeDir);
  }
  if (env.STATION_CURSOR_HOME !== undefined && env.STATION_CURSOR_HOME.length > 0) {
    return join(
      resolveLocalPath(env.STATION_CURSOR_HOME, options.homeDir),
      ".cursor",
      CURSOR_HOOKS_FILE,
    );
  }
  return resolveLocalPath(join("~", ".cursor", CURSOR_HOOKS_FILE), options.homeDir);
}

export function resolveCursorHookScriptPath(options: CursorHookPathOptions = {}): string {
  if (options.hookScriptPath !== undefined) {
    return resolveLocalPath(options.hookScriptPath, options.homeDir);
  }
  const stateDir = options.stateDir ?? defaultStationStateDir(options.env, options.homeDir);
  return resolveLocalPath(join(stateDir, "hooks", GENERATED_HOOK_SCRIPT_NAME), options.homeDir);
}
