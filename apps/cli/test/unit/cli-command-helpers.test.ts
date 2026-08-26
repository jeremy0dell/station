import { isSafeError } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { cliCommandRegistry, resolveCliCommandRoute } from "../../src/commandRegistry.js";
import { loadedConfigCommandOptions } from "../../src/commands/cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../../src/commands/cliCommand/types.js";
import {
  buildCliInvocationArgumentShape,
  classifyCliInvocationEffect,
  hasExplicitCliInvocationEffectPolicy,
  terminalStatusForResult,
} from "../../src/invocationAudit.js";

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

  it("keeps runnable parent routing while exposing the deepest declared command path", () => {
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

  it("classifies every declared registry path and conditional mutation policy", () => {
    for (const path of registryPaths(cliCommandRegistry)) {
      expect(hasExplicitCliInvocationEffectPolicy(path), path.join(" ")).toBe(true);
    }
    expect(classifyCliInvocationEffect(["observer", "reap"], [])).toBe("read");
    expect(classifyCliInvocationEffect(["observer", "reap"], ["--force"])).toBe("mutation");
    expect(classifyCliInvocationEffect(["setup", "apply"], ["--dry-run"])).toBe("read");
    expect(classifyCliInvocationEffect(["host", "handoff"], [])).toBe("mutation");
    expect(classifyCliInvocationEffect(["project"], ["unknown"])).toBe("mutation");
  });

  it("records only known option names without retaining arbitrary argv tokens", () => {
    const sentinel = "--token=cli-invocation-super-secret";
    const shape = buildCliInvocationArgumentShape([
      "command",
      "dispatch",
      "--stdin",
      "--timeout-ms=1000",
      sentinel,
    ]);

    expect(shape.recognizedOptions).toEqual(["--stdin", "--timeout-ms"]);
    expect(JSON.stringify(shape)).not.toContain("cli-invocation-super-secret");
  });

  it("classifies typed command results without inspecting rendered output", () => {
    expect(terminalStatusForResult({ help: true, version: false, recovery: false, code: 0 })).toBe(
      "help",
    );
    expect(terminalStatusForResult({ help: false, version: true, recovery: false, code: 0 })).toBe(
      "version",
    );
    expect(terminalStatusForResult({ help: false, version: false, recovery: true, code: 1 })).toBe(
      "diagnostic_recovery",
    );
    expect(
      terminalStatusForResult({
        help: false,
        version: false,
        recovery: false,
        code: 1,
        audit: { commandStatus: "rejected" },
      }),
    ).toBe("rejected");
    expect(
      terminalStatusForResult({
        help: false,
        version: false,
        recovery: false,
        code: 1,
        audit: { commandStatus: "failed" },
      }),
    ).toBe("failed");
    expect(terminalStatusForResult({ help: false, version: false, recovery: false, code: 0 })).toBe(
      "succeeded",
    );
  });
});

function registryPaths(root: CliCommandNode): string[][] {
  const paths: string[][] = [];
  const visit = (node: CliCommandNode, parent: readonly string[]) => {
    const path = [...parent, node.name];
    if (parent.length > 0) paths.push(path.slice(1));
    for (const child of node.children ?? []) visit(child, path);
  };
  visit(root, []);
  return paths;
}
