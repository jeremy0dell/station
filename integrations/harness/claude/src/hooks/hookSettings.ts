import {
  createJsonHookConfigEditor,
  generatedHookScriptPath,
  isJsonObject,
} from "@station/harness-shared";
import { commandLine } from "@station/runtime";
import {
  CLAUDE_HOOK_EVENT_NAMES,
  type ClaudeForwardedEventType,
  GENERATED_HOOK_SCRIPT_NAME,
  GENERATED_HOOK_STATUS_MESSAGE,
} from "./hookConstants.js";
import { ClaudeHookSetupError } from "./hookErrors.js";

export type ClaudeSettingsDocument = Record<string, unknown>;

const hookConfigEditor = createJsonHookConfigEditor<ClaudeForwardedEventType>({
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

function matcherForEvent(eventName: ClaudeForwardedEventType): string | undefined {
  if (eventName === "PreToolUse" || eventName === "PostToolUse") {
    return "*";
  }
  return undefined;
}

function generatedHookEntry(
  eventName: ClaudeForwardedEventType,
  command: string,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { hooks: [generatedHookCommand(command)] };
  const matcher = matcherForEvent(eventName);
  if (matcher !== undefined) entry.matcher = matcher;
  return entry;
}

function generatedHookCommand(command: string): Record<string, unknown> {
  return {
    type: "command",
    command,
    timeout: 30,
    statusMessage: GENERATED_HOOK_STATUS_MESSAGE,
  };
}

function isGeneratedStationHookCommand(value: unknown): boolean {
  if (!isJsonObject(value) || value.type !== "command" || typeof value.command !== "string") {
    return false;
  }
  if (generatedHookScriptPath(value.command, GENERATED_HOOK_SCRIPT_NAME) !== undefined) {
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
  const commands = expectedClaudeHookCommands(input.hookScriptPath);
  for (const eventName of CLAUDE_HOOK_EVENT_NAMES) {
    hooks[eventName] = [generatedHookEntry(eventName, commands[eventName])];
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
): ClaudeForwardedEventType[] {
  return hookConfigEditor.missingEvents(document, expectedClaudeHookCommands(hookScriptPath));
}

function expectedClaudeHookCommands(
  hookScriptPath: string,
): Record<ClaudeForwardedEventType, string> {
  return Object.fromEntries(
    CLAUDE_HOOK_EVENT_NAMES.map((eventName) => [
      eventName,
      commandLine([hookScriptPath, "--fast", eventName]),
    ]),
  ) as Record<ClaudeForwardedEventType, string>;
}
