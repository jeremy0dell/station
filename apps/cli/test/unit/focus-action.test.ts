import { describe, expect, it } from "vitest";
import {
  buildClickFocusShellCommand,
  defaultCliCommandParts,
} from "../../src/commands/notify/focusAction.js";

describe("notification focus action", () => {
  it("keeps the source CLI entry prefix", () => {
    const previousEntry = process.argv[1];
    process.argv[1] = "/tmp/station/apps/cli/dist/main.js";
    try {
      expect(defaultCliCommandParts()).toEqual([
        process.execPath,
        "/tmp/station/apps/cli/dist/main.js",
      ]);
    } finally {
      if (previousEntry === undefined) process.argv.splice(1, 1);
      else process.argv[1] = previousEntry;
    }
  });

  it("uses the compiled binary without an internal token for normal CLI commands", () => {
    expect(defaultCliCommandParts({ compiled: true, execPath: "/opt/station/stn" })).toEqual([
      "/opt/station/stn",
    ]);
  });

  it("preserves command JSON and shell quoting", () => {
    expect(
      buildClickFocusShellCommand({
        command: { type: "terminal.focus", payload: { sessionId: "session-1" } },
        cliCommandParts: ["node", "/tmp/station main.js"],
        configPath: "/tmp/station config.toml",
      }),
    ).toBe(
      "printf '%s\\n' '{\"type\":\"terminal.focus\",\"payload\":{\"sessionId\":\"session-1\"}}' | 'node' '/tmp/station main.js' '--config' '/tmp/station config.toml' 'command' 'dispatch' '--stdin' '--wait' '--timeout-ms' '5000' >/dev/null 2>&1",
    );
  });
});
