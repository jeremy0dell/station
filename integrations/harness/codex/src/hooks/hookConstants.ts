import { type CodexForwardedEventType, codexForwardedEventTypes } from "../ingressRules.js";

export const CODEX_STATION_PROFILE_NAME = "station";
export const CODEX_STATION_PROFILE_CONFIG_FILE = "station.config.toml";
export const CODEX_BASE_CONFIG_FILE = "config.toml";
export const GENERATED_HOOK_STATUS_MESSAGE = "Notify station";
export const GENERATED_HOOK_SCRIPT_NAME = "station-codex-hook.sh";

export const CODEX_HOOK_EVENT_NAMES = codexForwardedEventTypes;

export type CodexHookEventName = CodexForwardedEventType;

export const CODEX_OBSOLETE_HOOK_EVENT_NAMES = ["SubagentStop"] as const;

export type CodexObsoleteHookEventName = (typeof CODEX_OBSOLETE_HOOK_EVENT_NAMES)[number];
export type CodexGeneratedHookEventName = CodexHookEventName | CodexObsoleteHookEventName;
