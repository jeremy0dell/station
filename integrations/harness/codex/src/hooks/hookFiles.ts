import { createHookFileOps } from "@station/harness-shared";
import { CodexHookSetupError, type CodexHookSetupErrorCode } from "./hookErrors.js";

const hookFiles = createHookFileOps({
  codes: {
    unreadable: "CODEX_HOOK_CONFIG_UNREADABLE",
    writeFailed: "CODEX_HOOK_WRITE_FAILED",
  },
  messages: {
    configUnreadable: "Codex hook config could not be read.",
    configMetadataUnreadable: "Codex hook config metadata could not be read.",
    configWriteFailed: "Codex hook config could not be written.",
    scriptWriteFailed: "Codex hook script could not be written.",
    scriptRemoveFailed: "Codex hook script could not be removed.",
    backupWriteFailed: "Codex hook config backup could not be written.",
  },
  error: (code, message, cause) =>
    new CodexHookSetupError(code as CodexHookSetupErrorCode, message, { cause }),
});

export const readOptionalFile = hookFiles.readOptionalFile;
export const writeHookConfig = hookFiles.writeHookConfig;
export const writeHookScript = hookFiles.writeHookScript;
export const removeHookScriptIfPresent = hookFiles.removeHookScriptIfPresent;
export const backupIfPresent = hookFiles.backupIfPresent;
