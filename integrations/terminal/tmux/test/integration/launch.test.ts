import { spawnSync } from "node:child_process";
import { buildRespawnPaneLaunchArgs } from "@station/tmux";
import { expect, it } from "vitest";

it("replaces the tmux launch shell while preserving literal agent arguments", () => {
  const literal = "spaces; $(printf expanded) 'quoted'";
  const args = buildRespawnPaneLaunchArgs({
    paneTarget: "%fixture",
    cwdFallback: process.cwd(),
    plan: {
      provider: "codex",
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({ pid: process.pid, argument: process.argv[1] }))",
        literal,
      ],
      mode: "interactive",
    },
  });
  // An exit trap prevents the shell from implicitly replacing itself with its last command.
  const child = spawnSync("/bin/sh", ["-c", `trap : EXIT; ${args.at(-1)}`], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ pid: child.pid, argument: literal });
});
