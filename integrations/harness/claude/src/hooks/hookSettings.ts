import { createJsonHookConfigEditor, isJsonObject } from "@station/harness-shared";
import {
  CLAUDE_HOOK_EVENT_NAMES,
  type ClaudeHookEventName,
  GENERATED_HOOK_SCRIPT_NAME,
  GENERATED_HOOK_STATUS_MESSAGE,
} from "./hookConstants.js";
import { ClaudeHookSetupError } from "./hookErrors.js";

export type ClaudeSettingsDocument = Record<string, unknown>;

const hookConfigEditor = createJsonHookConfigEditor<ClaudeHookEventName>({
  eventNames: CLAUDE_HOOK_EVENT_NAMES,
  entryCommands: (entry) =>
    isJsonObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : undefined,
  withEntryCommands: (entry, commands) =>
    isJsonObject(entry) && commands.length > 0 ? { ...entry, hooks: commands } : undefined,
  commandPath: (command) =>
    isJsonObject(command) && typeof command.command === "string" ? command.command : undefined,
  isGeneratedCommand: isGeneratedStationHookCommand,
  cleanupAllEvents: true,
  createEntry: generatedHookEntry,
});

export const generatedClaudeHookEvents: (document: ClaudeSettingsDocument) => string[] =
  hookConfigEditor.generatedEvents;
export const removeGeneratedClaudeHookEntries: (
  document: ClaudeSettingsDocument,
) => ClaudeSettingsDocument = hookConfigEditor.removeGeneratedCommands;
export const settingsDocumentContainsCommand: (
  document: ClaudeSettingsDocument,
  hookScriptPath: string,
) => boolean = hookConfigEditor.documentContainsCommand;

function matcherForEvent(eventName: ClaudeHookEventName): string | undefined {
  if (eventName === "PreToolUse" || eventName === "PostToolUse") {
    return "*";
  }
  return undefined;
}

function generatedHookEntry(
  eventName: ClaudeHookEventName,
  hookScriptPath: string,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { hooks: [generatedHookCommand(hookScriptPath)] };
  const matcher = matcherForEvent(eventName);
  if (matcher !== undefined) entry.matcher = matcher;
  return entry;
}

function generatedHookCommand(hookScriptPath: string): Record<string, unknown> {
  return {
    type: "command",
    command: hookScriptPath,
    timeout: 30,
    statusMessage: GENERATED_HOOK_STATUS_MESSAGE,
  };
}

function isGeneratedStationHookCommand(value: unknown): boolean {
  if (!isJsonObject(value) || value.type !== "command" || typeof value.command !== "string") {
    return false;
  }
  if (value.command.endsWith(`/${GENERATED_HOOK_SCRIPT_NAME}`)) {
    return true;
  }
  return (
    value.statusMessage === GENERATED_HOOK_STATUS_MESSAGE &&
    value.command.includes(GENERATED_HOOK_SCRIPT_NAME)
  );
}

export function expectedClaudeHookSettings(input: {
  hookScriptPath: string;
}): ClaudeSettingsDocument {
  const hooks: Record<string, unknown> = {};
  for (const eventName of CLAUDE_HOOK_EVENT_NAMES) {
    hooks[eventName] = [generatedHookEntry(eventName, input.hookScriptPath)];
  }
  return { hooks };
}

export function stringifyClaudeSettings(document: ClaudeSettingsDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function parseClaudeSettingsDocument(contents: string): ClaudeSettingsDocument {
  if (contents.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    throw new ClaudeHookSetupError(
      "CLAUDE_HOOK_INVALID_JSON",
      "Claude settings JSON could not be parsed.",
      { cause },
    );
  }
  if (!isJsonObject(parsed)) {
    throw new ClaudeHookSetupError(
      "CLAUDE_HOOK_INVALID_JSON",
      "Claude settings JSON is not an object.",
    );
  }
  return parsed;
}

export function missingClaudeHookEvents(
  document: ClaudeSettingsDocument,
  hookScriptPath: string,
): ClaudeHookEventName[] {
  return hookConfigEditor.missingEvents(
    document,
    Object.fromEntries(
      CLAUDE_HOOK_EVENT_NAMES.map((eventName) => [eventName, hookScriptPath]),
    ) as Record<ClaudeHookEventName, string>,
  );
}
