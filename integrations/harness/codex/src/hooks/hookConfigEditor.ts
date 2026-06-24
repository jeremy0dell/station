import {
  generatedNestedHookEvents,
  installNestedHookCommands,
  missingNestedHookEvents,
  type NestedHookDocument,
  type NestedHookDocumentSpec,
  nestedDocumentContainsCommand,
  removeGeneratedNestedHookCommands,
} from "@station/harness-shared";
import { parse, stringify } from "smol-toml";
import {
  CODEX_HOOK_EVENT_NAMES,
  type CodexHookEventName,
  GENERATED_HOOK_SCRIPT_NAME,
  GENERATED_HOOK_STATUS_MESSAGE,
} from "./hookConstants.js";
import { CodexHookSetupError } from "./hookErrors.js";

const codexHookDocumentSpec: NestedHookDocumentSpec<CodexHookEventName> = {
  eventNames: CODEX_HOOK_EVENT_NAMES,
  generatedScriptName: GENERATED_HOOK_SCRIPT_NAME,
  statusMessage: GENERATED_HOOK_STATUS_MESSAGE,
  matcherForEvent,
};

function matcherForEvent(eventName: CodexHookEventName): string | undefined {
  if (eventName === "SessionStart") return "startup|resume|clear|compact";
  if (eventName === "PreToolUse") return ".*";
  if (eventName === "PermissionRequest") return ".*";
  if (eventName === "PostToolUse") return ".*";
  if (eventName === "PreCompact") return "manual|auto";
  if (eventName === "PostCompact") return "manual|auto";
  if (eventName === "SubagentStart") return ".*";
  if (eventName === "SubagentStop") return ".*";
  return undefined;
}

export function parseTomlDocument(source: string): NestedHookDocument {
  if (source.trim().length === 0) {
    return {};
  }
  try {
    return parse(source) as NestedHookDocument;
  } catch (cause) {
    throw new CodexHookSetupError("CODEX_HOOK_INVALID_TOML", "Codex config is not valid TOML.", {
      cause,
    });
  }
}

export function stringifyTomlDocument(document: NestedHookDocument): string {
  const result = stringify(document);
  return result.endsWith("\n") ? result : `${result}\n`;
}

export function installCodexHookCommands(
  document: NestedHookDocument,
  commands: Record<CodexHookEventName, string>,
): NestedHookDocument {
  return installNestedHookCommands(document, commands, codexHookDocumentSpec);
}

export function removeGeneratedCodexHookCommands(
  document: NestedHookDocument,
  commands: Record<CodexHookEventName, string>,
): NestedHookDocument {
  return removeGeneratedNestedHookCommands(document, commands, codexHookDocumentSpec);
}

export function missingCodexHookEvents(
  document: NestedHookDocument,
  commands: Record<CodexHookEventName, string>,
): CodexHookEventName[] {
  return missingNestedHookEvents(document, commands, codexHookDocumentSpec);
}

export function documentContainsCommand(document: NestedHookDocument, command: string): boolean {
  return nestedDocumentContainsCommand(document, command);
}

export function generatedStationHookEvents(
  document: NestedHookDocument,
  commands: Record<CodexHookEventName, string>,
): CodexHookEventName[] {
  return generatedNestedHookEvents(document, codexHookDocumentSpec, commands);
}
