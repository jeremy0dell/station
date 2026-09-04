import { describe, expect, it } from "vitest";
import { generatedHookScriptPath } from "../../src/hooks/generatedCommand";

describe("generatedHookScriptPath", () => {
  it.each([
    ["station-claude-hook.sh", "station-claude-hook.sh"],
    ["/tmp/hooks/station-claude-hook.sh --fast Stop", "/tmp/hooks/station-claude-hook.sh"],
    [
      "'/tmp/hooks with spaces/station-claude-hook.sh' --fast 'PreToolUse'",
      "/tmp/hooks with spaces/station-claude-hook.sh",
    ],
    [
      "'/tmp/owner'\\''s hooks/station-claude-hook.sh' --fast Stop",
      "/tmp/owner's hooks/station-claude-hook.sh",
    ],
  ])("extracts the supported generated script from %s", (command, expected) => {
    expect(generatedHookScriptPath(command, "station-claude-hook.sh")).toBe(expected);
  });

  it.each([
    "echo station-claude-hook.sh",
    "'/tmp/hooks/station-claude-hook.sh --fast Stop",
    "/tmp/hooks/not-station.sh --fast Stop",
    "",
  ])("rejects a command that does not execute the generated script: %s", (command) => {
    expect(generatedHookScriptPath(command, "station-claude-hook.sh")).toBeUndefined();
  });
});
