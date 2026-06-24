import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { checkWorktrunkDependency, parseWorktrunkVersion } from "@station/worktrunk";
import { describe, expect, it } from "vitest";

describe("Worktrunk dependency preflight", () => {
  it("parses Worktrunk version output", () => {
    expect(parseWorktrunkVersion("worktrunk 0.15.2\n")).toBe("0.15.2");
    expect(parseWorktrunkVersion("wt 1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(parseWorktrunkVersion("unexpected output")).toBeUndefined();
  });

  it("reports the attempted command, resolved path, and version", async () => {
    const calls: ExternalCommandInput[] = [];

    const status = await checkWorktrunkDependency({
      command: "wt",
      pathEnv: "/opt/homebrew/bin",
      access: async (path) => {
        if (path !== "/opt/homebrew/bin/wt") {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        }
      },
      runner: async (input) => {
        calls.push(input);
        return result(input, "worktrunk 0.15.2\n");
      },
    });

    expect(status).toMatchObject({
      status: "available",
      attemptedCommand: "wt",
      resolvedPath: "/opt/homebrew/bin/wt",
      version: "0.15.2",
    });
    expect(calls).toEqual([
      expect.objectContaining({
        command: "/opt/homebrew/bin/wt",
        args: ["--version"],
      }),
    ]);
  });

  it("returns an install hint when the wt binary is missing", async () => {
    const status = await checkWorktrunkDependency({
      command: "missing-wt",
      pathEnv: "",
      access: async () => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
      runner: async () => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    });

    expect(status).toMatchObject({
      status: "unavailable",
      attemptedCommand: "missing-wt",
      installHint: expect.stringContaining("brew install worktrunk"),
      error: {
        tag: "ProviderUnavailableError",
        code: "WORKTRUNK_UNAVAILABLE",
        provider: "worktrunk",
      },
    });
  });
});

function result(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}
