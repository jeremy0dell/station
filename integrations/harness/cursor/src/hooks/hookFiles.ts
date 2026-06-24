import { createHookFileOps } from "@station/harness-shared";
import { CursorHookSetupError, type CursorHookSetupErrorCode } from "./hookErrors.js";

const hookFiles = createHookFileOps({
  codes: {
    unreadable: "CURSOR_HOOK_CONFIG_UNREADABLE",
    writeFailed: "CURSOR_HOOK_WRITE_FAILED",
  },
  messages: {
    configUnreadable: "Cursor hook config could not be read.",
    configMetadataUnreadable: "Cursor hook config metadata could not be read.",
    configWriteFailed: "Cursor hook config could not be written.",
    scriptWriteFailed: "Cursor hook script could not be written.",
    scriptRemoveFailed: "Cursor hook script could not be removed.",
    backupWriteFailed: "Cursor hook config backup could not be written.",
  },
  error: (code, message, cause) =>
    new CursorHookSetupError(code as CursorHookSetupErrorCode, message, { cause }),
});

export const readOptionalFile = hookFiles.readOptionalFile;
export const writeHookConfig = hookFiles.writeHookConfig;
export const writeHookScript = hookFiles.writeHookScript;
export const removeHookScriptIfPresent = hookFiles.removeHookScriptIfPresent;
export const backupIfPresent = hookFiles.backupIfPresent;
