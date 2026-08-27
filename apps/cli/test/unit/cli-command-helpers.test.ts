import { isSafeError } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { resolveCliCommandRoute } from "../../src/commandRegistry.js";
import { loadedConfigCommandOptions } from "../../src/commands/cliCommand/helpers.js";
import type { CliCommandRunContext } from "../../src/commands/cliCommand/types.js";

describe("CLI command helpers", () => {
  it("reports a SafeError when a config-required route violates its loading invariant", () => {
    const context: CliCommandRunContext = {
      path: ["hooks", "doctor"],
      args: ["worktrunk"],
      allArgs: ["hooks", "doctor", "worktrunk"],
      cliEntryPath: "/tmp/main.js",
      renderHelpTopic: () => "",
      options: {},
    };

    let thrown: unknown;
    try {
      loadedConfigCommandOptions(context);
    } catch (error) {
      thrown = error;
    }

    expect(isSafeError(thrown)).toBe(true);
    expect(thrown).toEqual({
      tag: "CliCommandError",
      code: "CLI_CONFIG_NOT_LOADED",
      message: "Station config was not loaded for the hooks doctor command.",
    });
  });

  it("keeps runnable-parent routing while exposing canonical diagnostic paths", () => {
    expect(resolveCliCommandRoute("project", ["add", "/private/repo"])).toMatchObject({
      path: ["project"],
      resolvedPath: ["project", "add"],
      args: ["add", "/private/repo"],
    });
    expect(resolveCliCommandRoute("session", ["current"])).toMatchObject({
      path: ["session"],
      resolvedPath: ["session", "current"],
      args: ["current"],
    });
  });
});
