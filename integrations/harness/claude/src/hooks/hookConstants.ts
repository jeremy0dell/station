import { type ClaudeForwardedEventType, claudeForwardedEventTypes } from "../ingressRules.js";

export type ClaudeHookEventName = ClaudeForwardedEventType;

export const CLAUDE_STATION_SETTINGS_FILE = "station-claude-settings.json";
export const CLAUDE_USER_SETTINGS_FILE = "settings.json";
export const GENERATED_HOOK_STATUS_MESSAGE = "Notify station";
export const GENERATED_HOOK_SCRIPT_NAME = "station-claude-hook.sh";

// The installed hook event set is derived from the ingress rules so the settings
// generator and status projection can never drift apart (docs/harness-ingress.md).
export const CLAUDE_HOOK_EVENT_NAMES = claudeForwardedEventTypes;
