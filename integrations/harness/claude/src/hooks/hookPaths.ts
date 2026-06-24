import { homedir } from "node:os";
import { join } from "node:path";
import { defaultStationStateDir, resolveLocalPath } from "@station/runtime";
import {
  CLAUDE_STATION_SETTINGS_FILE,
  CLAUDE_USER_SETTINGS_FILE,
  GENERATED_HOOK_SCRIPT_NAME,
} from "./hookConstants.js";

export type ClaudeHookPathOptions = {
  claudeSettingsPath?: string;
  claudeConfigDir?: string;
  hookScriptPath?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

function resolveStationHooksDir(options: ClaudeHookPathOptions): string {
  const stateDir = options.stateDir ?? defaultStationStateDir(options.env, options.homeDir);
  return resolveLocalPath(join(stateDir, "hooks"), options.homeDir);
}

function resolveClaudeConfigDir(options: ClaudeHookPathOptions): string {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  if (options.claudeConfigDir !== undefined) {
    return resolveLocalPath(options.claudeConfigDir, homeDir);
  }
  if (env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR.length > 0) {
    return resolveLocalPath(env.CLAUDE_CONFIG_DIR, homeDir);
  }
  return resolveLocalPath("~/.claude", homeDir);
}

export function resolveClaudeSettingsArtifactPath(options: ClaudeHookPathOptions = {}): string {
  if (options.claudeSettingsPath !== undefined) {
    return resolveLocalPath(options.claudeSettingsPath, options.homeDir);
  }
  return join(resolveStationHooksDir(options), CLAUDE_STATION_SETTINGS_FILE);
}

export function resolveClaudeHookScriptPath(options: ClaudeHookPathOptions = {}): string {
  if (options.hookScriptPath !== undefined) {
    return resolveLocalPath(options.hookScriptPath, options.homeDir);
  }
  return join(resolveStationHooksDir(options), GENERATED_HOOK_SCRIPT_NAME);
}

export function resolveClaudeUserSettingsPath(options: ClaudeHookPathOptions = {}): string {
  return join(resolveClaudeConfigDir(options), CLAUDE_USER_SETTINGS_FILE);
}
