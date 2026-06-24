import { z } from "zod";
import {
  CURSOR_HOOK_EVENT_NAMES,
  type CursorHookEventName,
  GENERATED_HOOK_SCRIPT_NAME,
} from "./hookConstants.js";
import { CursorHookSetupError } from "./hookErrors.js";

type CursorHookEntry = z.infer<typeof cursorHookEntrySchema>;
type CursorHooksDocument = z.infer<typeof cursorHooksDocumentSchema>;

const cursorHookEntrySchema = z
  .object({
    command: z.string().min(1).optional(),
  })
  .catchall(z.unknown());

const cursorHooksDocumentSchema = z
  .object({
    version: z.number().int().positive().optional(),
    hooks: z.record(z.string(), z.array(cursorHookEntrySchema)).optional(),
  })
  .catchall(z.unknown());

function withGeneratedHookEntry(
  value: CursorHookEntry[] | undefined,
  command: string,
): CursorHookEntry[] {
  const entries = withoutGeneratedHookEntries(value ?? [], command);
  entries.push(generatedHookEntry(command));
  return entries;
}

function withoutGeneratedHookEntries(
  entries: CursorHookEntry[],
  command: string,
): CursorHookEntry[] {
  return entries.filter((entry) => !isGeneratedStationHook(entry, command));
}

function generatedHookEntry(command: string): CursorHookEntry {
  return {
    command,
    timeout: 30,
  };
}

function hookContainsCommand(
  document: CursorHooksDocument,
  eventName: CursorHookEventName,
  command: string,
): boolean {
  return document.hooks?.[eventName]?.some((entry) => entry.command === command) === true;
}

function isGeneratedStationHook(entry: CursorHookEntry, command: string): boolean {
  if (entry.command === command) {
    return true;
  }
  if (entry.command === undefined) {
    return false;
  }
  return commandLooksLikeGeneratedHookScript(entry.command);
}

function commandLooksLikeGeneratedHookScript(command: string): boolean {
  return (
    command === GENERATED_HOOK_SCRIPT_NAME || command.endsWith(`/${GENERATED_HOOK_SCRIPT_NAME}`)
  );
}

function cloneDocument(document: CursorHooksDocument): CursorHooksDocument {
  return { ...document };
}

function cloneHooks(
  hooks: Record<string, CursorHookEntry[]> | undefined,
): Record<string, CursorHookEntry[]> {
  const next: Record<string, CursorHookEntry[]> = {};
  if (hooks === undefined) {
    return next;
  }
  for (const [eventName, entries] of Object.entries(hooks)) {
    next[eventName] = entries.map((entry) => ({ ...entry }));
  }
  return next;
}

export function parseJsonDocument(source: string): CursorHooksDocument {
  if (source.trim().length === 0) {
    return {};
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new CursorHookSetupError(
      "CURSOR_HOOK_INVALID_JSON",
      "Cursor hooks config is not valid JSON.",
      { cause },
    );
  }

  const result = cursorHooksDocumentSchema.safeParse(value);
  if (!result.success) {
    throw new CursorHookSetupError(
      "CURSOR_HOOK_INVALID_JSON",
      "Cursor hooks config does not match the expected hooks.json shape.",
      { cause: result.error },
    );
  }
  return result.data;
}

export function stringifyJsonDocument(document: CursorHooksDocument): string {
  if (Object.keys(document).length === 0) {
    return "";
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function installCursorHookCommands(
  document: CursorHooksDocument,
  commands: Record<CursorHookEventName, string>,
): CursorHooksDocument {
  const next = cloneDocument(document);
  next.version = document.version ?? 1;
  const hooks = cloneHooks(document.hooks);
  for (const eventName of CURSOR_HOOK_EVENT_NAMES) {
    hooks[eventName] = withGeneratedHookEntry(hooks[eventName], commands[eventName]);
  }
  next.hooks = hooks;
  return next;
}

export function removeGeneratedCursorHookCommands(
  document: CursorHooksDocument,
  commands: Record<CursorHookEventName, string>,
): CursorHooksDocument {
  const next = cloneDocument(document);
  if (document.hooks === undefined) {
    return next;
  }

  const hooks = cloneHooks(document.hooks);
  for (const eventName of CURSOR_HOOK_EVENT_NAMES) {
    const entries = withoutGeneratedHookEntries(hooks[eventName] ?? [], commands[eventName]);
    if (entries.length === 0) {
      delete hooks[eventName];
    } else {
      hooks[eventName] = entries;
    }
  }
  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = hooks;
  }
  return next;
}

export function missingCursorHookEvents(
  document: CursorHooksDocument,
  commands: Record<CursorHookEventName, string>,
): CursorHookEventName[] {
  return CURSOR_HOOK_EVENT_NAMES.filter(
    (eventName) => !hookContainsCommand(document, eventName, commands[eventName]),
  );
}

export function documentContainsCommand(document: CursorHooksDocument, command: string): boolean {
  if (document.hooks === undefined) {
    return false;
  }
  return Object.values(document.hooks).some((entries) =>
    entries.some((entry) => entry.command === command),
  );
}
