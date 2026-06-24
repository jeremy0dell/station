import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { checkTmuxDependency, parseTmuxVersion } from "@station/tmux";
import { describe, expect, it } from "vitest";

describe("tmux dependency preflight", () => {
  it("parses tmux version output", () => {
    expect(parseTmuxVersion("tmux 3.5a\n")).toBe("3.5a");
    expect(parseTmuxVersion("unexpected output")).toBeUndefined();
  });

  it("reports the attempted command, resolved path, and version", async () => {
    const calls: ExternalCommandInput[] = [];

    const status = await checkTmuxDependency({
      command: "tmux",
      pathEnv: "/opt/homebrew/bin",
      access: async (path) => {
        if (path !== "/opt/homebrew/bin/tmux") {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        }
      },
      runner: async (input) => {
        calls.push(input);
        return result(input, "tmux 3.5a\n");
      },
    });

    expect(status).toMatchObject({
      status: "available",
      attemptedCommand: "tmux",
      resolvedPath: "/opt/homebrew/bin/tmux",
      version: "3.5a",
    });
    expect(calls).toEqual([
      expect.objectContaining({
        command: "/opt/homebrew/bin/tmux",
        args: ["-V"],
      }),
    ]);
  });

  it("returns an install hint when tmux is missing", async () => {
    const status = await checkTmuxDependency({
      command: "missing-tmux",
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
      attemptedCommand: "missing-tmux",
      installHint: expect.stringContaining("brew install tmux"),
      error: {
        tag: "ProviderUnavailableError",
        code: "TMUX_UNAVAILABLE",
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
