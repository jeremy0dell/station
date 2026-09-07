import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildPopupRendererCommand } from "../../src/popupRendererCommand.js";

describe("popup renderer command", () => {
  it.each([
    undefined,
    "/tmp/config.toml",
    "/tmp/it's a #{session_name} $config; file.toml",
  ])("preserves executable and configuration arguments for %j", (configPath) => {
    const executable = ["/opt/it's Station/stn", "fixed argument"] as const;
    const command = buildPopupRendererCommand(executable, configPath);
    const args = execFileSync("/bin/sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], {
      encoding: "utf8",
    })
      .trimEnd()
      .split("\n");
    expect(args).toEqual([
      ...executable,
      ...(configPath === undefined ? [] : ["--config", configPath]),
      "tui",
      "--popup",
      "--persistent",
    ]);
  });

  it("preserves an explicit development command", () => {
    expect(buildPopupRendererCommand(["unused"], undefined, "env DEV=1 custom-ui")).toBe(
      "env DEV=1 custom-ui tui --popup --persistent",
    );
  });
});
