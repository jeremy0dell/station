import { createHookFileOps } from "@station/harness-shared";
import { ClaudeHookSetupError, type ClaudeHookSetupErrorCode } from "./hookErrors.js";

const hookFiles = createHookFileOps({
  codes: {
    unreadable: "CLAUDE_HOOK_CONFIG_UNREADABLE",
    writeFailed: "CLAUDE_HOOK_WRITE_FAILED",
  },
  messages: {
    configUnreadable: "Claude hook config could not be read.",
    configMetadataUnreadable: "Claude hook config metadata could not be read.",
    configWriteFailed: "Claude hook config could not be written.",
    scriptWriteFailed: "Claude hook script could not be written.",
    scriptRemoveFailed: "Claude hook file could not be removed.",
    backupWriteFailed: "Claude hook config backup could not be written.",
  },
  error: (code, message, cause) =>
    new ClaudeHookSetupError(code as ClaudeHookSetupErrorCode, message, { cause }),
});

export const readOptionalFile = hookFiles.readOptionalFile;
export const writeHookConfig = hookFiles.writeHookConfig;
export const writeHookScript = hookFiles.writeHookScript;
export const removeHookFileIfPresent = hookFiles.removeHookScriptIfPresent;
export const backupIfPresent = hookFiles.backupIfPresent;
