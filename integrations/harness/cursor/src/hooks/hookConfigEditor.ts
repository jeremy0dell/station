import { createJsonHookConfigEditor, isJsonObject } from "@station/harness-shared";
import { z } from "zod";
import {
  CURSOR_HOOK_EVENT_NAMES,
  type CursorHookEventName,
  GENERATED_HOOK_SCRIPT_NAME,
} from "./hookConstants.js";
import { CursorHookSetupError } from "./hookErrors.js";

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

const hookConfigEditor = createJsonHookConfigEditor<CursorHookEventName, CursorHooksDocument>({
  eventNames: CURSOR_HOOK_EVENT_NAMES,
  entryCommands: (entry) => [entry],
  withEntryCommands: (_entry, commands) => commands[0],
  commandPath: (command) =>
    isJsonObject(command) && typeof command.command === "string" ? command.command : undefined,
  isGeneratedCommand: (command) => {
    const parsed = cursorHookEntrySchema.safeParse(command);
    return parsed.success && parsed.data.command !== undefined
      ? commandLooksLikeGeneratedHookScript(parsed.data.command)
      : false;
  },
  createEntry: (_eventName, command) => ({ command, timeout: 30 }),
});

export const removeGeneratedCursorHookCommands: (
  document: CursorHooksDocument,
  commands: Record<CursorHookEventName, string>,
) => CursorHooksDocument = hookConfigEditor.removeGeneratedCommands;
export const missingCursorHookEvents: (
  document: CursorHooksDocument,
  commands: Record<CursorHookEventName, string>,
) => CursorHookEventName[] = hookConfigEditor.missingEvents;
export const generatedCursorHookCommands: (
  document: CursorHooksDocument,
) => Record<CursorHookEventName, string[]> = hookConfigEditor.generatedCommands;
export const documentContainsCommand: (document: CursorHooksDocument, command: string) => boolean =
  hookConfigEditor.documentContainsCommand;

function commandLooksLikeGeneratedHookScript(command: string): boolean {
  return (
    command === GENERATED_HOOK_SCRIPT_NAME || command.endsWith(`/${GENERATED_HOOK_SCRIPT_NAME}`)
  );
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
  return hookConfigEditor.installCommands(
    { ...document, version: document.version ?? 1 },
    commands,
  );
}
