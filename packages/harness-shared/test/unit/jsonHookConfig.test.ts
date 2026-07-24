import { describe, expect, it } from "vitest";
import {
  createJsonHookConfigEditor,
  isJsonObject,
  type JsonHookDocument,
} from "../../src/hooks/jsonConfig";

type EventName = "start" | "stop";

function commandPath(value: unknown): string | undefined {
  if (!isJsonObject(value) || typeof value.command !== "string") return undefined;
  return value.command;
}

const flatEditor = createJsonHookConfigEditor<EventName>({
  eventNames: ["start", "stop"],
  cleanupAllEvents: true,
  entryCommands: (entry) => [entry],
  withEntryCommands: (_entry, commands) => commands[0],
  commandPath,
  isGeneratedCommand: (command) => commandPath(command)?.endsWith("/generated.sh") === true,
  createEntry: (_event, command) => ({ command, timeout: 30 }),
});

const nestedEditor = createJsonHookConfigEditor<EventName>({
  eventNames: ["start", "stop"],
  entryCommands: (entry) =>
    isJsonObject(entry) && Array.isArray(entry.commands) ? entry.commands : undefined,
  withEntryCommands: (entry, commands) =>
    commands.length > 0 && isJsonObject(entry) ? { ...entry, commands } : undefined,
  commandPath,
  isGeneratedCommand: (command) => commandPath(command)?.endsWith("/generated.sh") === true,
  createEntry: (event, command) => ({
    ...(event === "stop" ? { matcher: "*" } : {}),
    commands: [{ command }],
  }),
});

const commands: Record<EventName, string> = {
  start: "/new/generated.sh",
  stop: "/new/generated.sh",
};

describe("createJsonHookConfigEditor", () => {
  it("installs one current flat entry per event and removes stale generated entries", () => {
    const document: JsonHookDocument = {
      version: 1,
      hooks: {
        start: [{ command: "/old/generated.sh" }, { command: "custom" }],
        custom: [{ command: "/old/generated.sh" }],
      },
    };

    const installed = flatEditor.installCommands(document, commands);

    expect(installed).toEqual({
      version: 1,
      hooks: {
        start: [{ command: "custom" }, { command: "/new/generated.sh", timeout: 30 }],
        stop: [{ command: "/new/generated.sh", timeout: 30 }],
      },
    });
    expect(flatEditor.missingEvents(installed, commands)).toEqual([]);
  });

  it("removes generated nested commands while preserving custom commands and metadata", () => {
    const document: JsonHookDocument = {
      hooks: {
        start: [
          {
            matcher: "custom",
            commands: [{ command: "/old/generated.sh" }, { command: "custom" }],
          },
        ],
        stop: [{ commands: [{ command: "/old/generated.sh" }] }],
        malformed: "preserve",
      },
    };

    expect(nestedEditor.removeGeneratedCommands(document)).toEqual({
      hooks: {
        start: [{ matcher: "custom", commands: [{ command: "custom" }] }],
        malformed: "preserve",
      },
    });
  });

  it("reports generated events and command references across configured and custom events", () => {
    const document: JsonHookDocument = {
      hooks: {
        start: [{ commands: [{ command: "/old/generated.sh" }] }],
        custom: [{ commands: [{ command: "/shared/custom.sh" }] }],
      },
    };

    expect(nestedEditor.generatedEvents(document)).toEqual(["start"]);
    expect(nestedEditor.documentContainsCommand(document, "/shared/custom.sh")).toBe(true);
    expect(nestedEditor.missingEvents(document, commands)).toEqual(["start", "stop"]);
  });
});
