import {
  CLAUDE_HOOK_EVENT_NAMES,
  type ClaudeHookEventName,
  GENERATED_HOOK_SCRIPT_NAME,
  GENERATED_HOOK_STATUS_MESSAGE,
} from "./hookConstants.js";
import { ClaudeHookSetupError } from "./hookErrors.js";

export type ClaudeSettingsDocument = Record<string, unknown>;

function matcherForEvent(eventName: ClaudeHookEventName): string | undefined {
  if (eventName === "PreToolUse" || eventName === "PostToolUse") {
    return "*";
  }
  return undefined;
}

function generatedHookCommand(hookScriptPath: string): Record<string, unknown> {
  return {
    type: "command",
    command: hookScriptPath,
    timeout: 30,
    statusMessage: GENERATED_HOOK_STATUS_MESSAGE,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGeneratedStationHookCommand(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type !== "command" || typeof value.command !== "string") {
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

function hookEntriesOf(document: ClaudeSettingsDocument, eventName: string): unknown[] {
  const hooks = document.hooks;
  if (!isRecord(hooks)) {
    return [];
  }
  const entries = hooks[eventName];
  return Array.isArray(entries) ? entries : [];
}

function entryContainsGeneratedCommand(entry: unknown): boolean {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
    return false;
  }
  return entry.hooks.some((command) => isGeneratedStationHookCommand(command));
}

function entryContainsCommandPath(entry: unknown, hookScriptPath: string): boolean {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
    return false;
  }
  return entry.hooks.some((command) => isRecord(command) && command.command === hookScriptPath);
}

function cleanEntry(entry: unknown): unknown | undefined {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
    return entry;
  }
  const remaining = entry.hooks.filter((command) => !isGeneratedStationHookCommand(command));
  if (remaining.length === 0) {
    return undefined;
  }
  if (remaining.length === entry.hooks.length) {
    return entry;
  }
  return { ...entry, hooks: remaining };
}

export function expectedClaudeHookSettings(input: {
  hookScriptPath: string;
}): ClaudeSettingsDocument {
  const hooks: Record<string, unknown> = {};
  for (const eventName of CLAUDE_HOOK_EVENT_NAMES) {
    const entry: Record<string, unknown> = {};
    const matcher = matcherForEvent(eventName);
    if (matcher !== undefined) {
      entry.matcher = matcher;
    }
    entry.hooks = [generatedHookCommand(input.hookScriptPath)];
    hooks[eventName] = [entry];
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
  if (!isRecord(parsed)) {
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
  return CLAUDE_HOOK_EVENT_NAMES.filter(
    (eventName) =>
      !hookEntriesOf(document, eventName).some((entry) =>
        entryContainsCommandPath(entry, hookScriptPath),
      ),
  );
}

export function generatedClaudeHookEvents(document: ClaudeSettingsDocument): string[] {
  const hooks = document.hooks;
  if (!isRecord(hooks)) {
    return [];
  }
  return Object.keys(hooks)
    .filter((eventName) =>
      hookEntriesOf(document, eventName).some((entry) => entryContainsGeneratedCommand(entry)),
    )
    .sort();
}

export function removeGeneratedClaudeHookEntries(
  document: ClaudeSettingsDocument,
): ClaudeSettingsDocument {
  const hooks = document.hooks;
  if (!isRecord(hooks)) {
    return document;
  }
  const cleanedHooks: Record<string, unknown> = {};
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      cleanedHooks[eventName] = entries;
      continue;
    }
    const cleanedEntries = entries
      .map((entry) => cleanEntry(entry))
      .filter((entry) => entry !== undefined);
    if (cleanedEntries.length > 0) {
      cleanedHooks[eventName] = cleanedEntries;
    }
  }
  const cleaned: ClaudeSettingsDocument = { ...document };
  if (Object.keys(cleanedHooks).length > 0) {
    cleaned.hooks = cleanedHooks;
  } else {
    delete cleaned.hooks;
  }
  return cleaned;
}

export function settingsDocumentContainsCommand(
  document: ClaudeSettingsDocument,
  hookScriptPath: string,
): boolean {
  const hooks = document.hooks;
  if (!isRecord(hooks)) {
    return false;
  }
  return Object.keys(hooks).some((eventName) =>
    hookEntriesOf(document, eventName).some((entry) =>
      entryContainsCommandPath(entry, hookScriptPath),
    ),
  );
}
