import {
  expectedNestedHookSettings,
  generatedNestedHookEvents,
  missingNestedHookEvents,
  type NestedHookDocument,
  type NestedHookDocumentSpec,
  nestedDocumentContainsCommand,
  removeGeneratedNestedHookEntries,
} from "@station/harness-shared";
import {
  CLAUDE_HOOK_EVENT_NAMES,
  type ClaudeHookEventName,
  GENERATED_HOOK_SCRIPT_NAME,
  GENERATED_HOOK_STATUS_MESSAGE,
} from "./hookConstants.js";
import { ClaudeHookSetupError } from "./hookErrors.js";

export type ClaudeSettingsDocument = NestedHookDocument;

const claudeHookDocumentSpec: NestedHookDocumentSpec<ClaudeHookEventName> = {
  eventNames: CLAUDE_HOOK_EVENT_NAMES,
  generatedScriptName: GENERATED_HOOK_SCRIPT_NAME,
  statusMessage: GENERATED_HOOK_STATUS_MESSAGE,
  matcherForEvent,
};

function matcherForEvent(eventName: ClaudeHookEventName): string | undefined {
  if (eventName === "PreToolUse" || eventName === "PostToolUse") {
    return "*";
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectedClaudeHookSettings(input: {
  hookScriptPath: string;
}): ClaudeSettingsDocument {
  return expectedNestedHookSettings(claudeHookDocumentSpec, input);
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
  const commands = Object.fromEntries(
    CLAUDE_HOOK_EVENT_NAMES.map((eventName) => [eventName, hookScriptPath]),
  ) as Record<ClaudeHookEventName, string>;
  return missingNestedHookEvents(document, commands, claudeHookDocumentSpec);
}

export function generatedClaudeHookEvents(document: ClaudeSettingsDocument): string[] {
  return generatedNestedHookEvents(document, claudeHookDocumentSpec);
}

export function removeGeneratedClaudeHookEntries(
  document: ClaudeSettingsDocument,
): ClaudeSettingsDocument {
  return removeGeneratedNestedHookEntries(document, claudeHookDocumentSpec);
}

export function settingsDocumentContainsCommand(
  document: ClaudeSettingsDocument,
  hookScriptPath: string,
): boolean {
  return nestedDocumentContainsCommand(document, hookScriptPath);
}
