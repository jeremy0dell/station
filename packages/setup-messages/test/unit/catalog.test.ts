import { describe, expect, it } from "vitest";
import {
  resolveSetupMessage,
  type SetupMessageCatalog,
  type SetupMessageId,
  type SetupMessageRef,
  setupMessageCatalog,
} from "../../src/index.js";

const fixtureArguments: Readonly<Record<string, string | number>> = {
  code: "TEST_CODE",
  command: "stn setup check",
  count: 2,
  description: "fixture description",
  directory: "/tmp/bin",
  formula: "fixture-formula",
  harness: "Codex",
  harnessId: "codex",
  harnessIds: "codex, opencode",
  harnesses: "Codex and OpenCode",
  hint: "Retry the command.",
  installHint: "Install dependencies.",
  key: "Space",
  label: "Fixture",
  launchers: "stn, stn-ingress",
  message: "Fixture evidence.",
  messages: "First; second",
  mode: "check",
  path: "/tmp/config.toml",
  provider: "worktrunk",
  shell: "zsh",
  source: "configured",
  terminal: "tmux",
  url: "https://example.com/tool",
  version: "1.4.0",
};

const placeholderPattern = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const catalog: SetupMessageCatalog = setupMessageCatalog;

describe("setup message catalog", () => {
  it("resolves every nonempty template with complete fixture arguments", () => {
    for (const [id, definition] of Object.entries(catalog)) {
      expect(definition.terminal.trim().length).toBeGreaterThan(0);
      if (definition.graphical !== undefined) {
        expect(definition.graphical.trim().length).toBeGreaterThan(0);
      }
      const placeholders = [
        ...new Set(
          [definition.terminal, definition.graphical]
            .filter((template): template is string => template !== undefined)
            .flatMap((template) =>
              [...template.matchAll(placeholderPattern)].map((match) => match[1]),
            ),
        ),
      ];
      const args: Record<string, string | number> = {};
      for (const placeholder of placeholders) {
        expect(fixtureArguments).toHaveProperty(placeholder);
        const value = fixtureArguments[placeholder];
        if (value !== undefined) args[placeholder] = value;
      }
      const ref = (placeholders.length === 0 ? { id } : { id, args }) as SetupMessageRef;
      const terminal = resolveSetupMessage(ref);
      const graphical = resolveSetupMessage(ref, "graphical");
      expect(terminal).not.toMatch(placeholderPattern);
      expect(graphical).not.toMatch(placeholderPattern);
      expect(graphical.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps graphical fallback valid for every public message", () => {
    for (const id of Object.keys(catalog) as SetupMessageId[]) {
      const template = catalog[id].terminal;
      const placeholders = [...template.matchAll(placeholderPattern)].map((match) => match[1]);
      const args = Object.fromEntries(
        placeholders.flatMap((placeholder) => {
          const value = fixtureArguments[placeholder];
          return value === undefined ? [] : [[placeholder, value]];
        }),
      );
      const ref = (placeholders.length === 0 ? { id } : { id, args }) as SetupMessageRef;
      expect(resolveSetupMessage(ref, "graphical").trim().length).toBeGreaterThan(0);
    }
  });
});
