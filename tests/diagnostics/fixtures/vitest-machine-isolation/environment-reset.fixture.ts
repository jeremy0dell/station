import { spawnSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { installCursorHooks } from "../../../../integrations/harness/cursor/src/index.js";
import { resolveObserverPaths } from "../../../../packages/config/src/index.js";
import { assertPathInsideTestMachineRoot } from "../../../../packages/testing/src/index.js";

const childEnvironmentSchema = z
  .object({
    HOME: z.string(),
    TMPDIR: z.string(),
    XDG_RUNTIME_DIR: z.string(),
    STATION_TEST_MACHINE_ROOT: z.string(),
  })
  .strict();

const machineRoot = requiredEnvironmentVariable("STATION_TEST_MACHINE_ROOT");
const resultDirectory = requiredEnvironmentVariable("STATION_TEST_MACHINE_RESULT_DIR");
const hostileRoot = requiredEnvironmentVariable("STATION_TEST_MACHINE_HOSTILE_ROOT");
let mutationPending = false;

afterEach(() => {
  if (!mutationPending) return;
  expect(process.env.HOME).toBe(hostileRoot);
  expect(process.env.CLAUDE_CONFIG_DIR).toBe(hostileRoot);
  expect(process.env.STATION_TEST_MACHINE_ADDED).toBe("added");
  mutationPending = false;
});

describe("per-file test machine environment", () => {
  it("redirects machine paths and clears inherited integration state", async () => {
    await mkdir(resultDirectory, { recursive: true });
    await writeFile(
      join(resultDirectory, "environment-reset.json"),
      JSON.stringify({ machineRoot }),
      "utf8",
    );

    expect(machineRoot).not.toBe(hostileRoot);
    expect(process.env.HOME).toBe(join(machineRoot, "home"));
    const redirectedTemporaryDirectory = requiredEnvironmentVariable("TMPDIR");
    expect(tmpdir()).toBe(redirectedTemporaryDirectory);
    await expect(realpath(redirectedTemporaryDirectory)).resolves.toBe(
      await realpath(join(machineRoot, "tmp")),
    );
    expect(process.env.XDG_CONFIG_HOME).toBe(join(machineRoot, "xdg", "config"));
    expect(process.env.XDG_DATA_HOME).toBe(join(machineRoot, "xdg", "data"));
    expect(process.env.XDG_CACHE_HOME).toBe(join(machineRoot, "xdg", "cache"));
    expect(process.env.XDG_STATE_HOME).toBe(join(machineRoot, "xdg", "state"));
    expect(process.env.XDG_RUNTIME_DIR).toBe(join(machineRoot, "xdg", "runtime"));
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(machineRoot, "harness", "claude"));
    expect(process.env.CODEX_HOME).toBe(join(machineRoot, "harness", "codex"));
    expect(process.env.STATION_CURSOR_HOME).toBe(join(machineRoot, "harness", "cursor"));
    expect(process.env.OPENCODE_CONFIG_DIR).toBe(join(machineRoot, "harness", "opencode"));
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(join(machineRoot, "git", "global.gitconfig"));
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(process.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(process.env.GH_PROMPT_DISABLED).toBe("1");

    for (const key of [
      "STATION_CONFIG_PATH",
      "STATION_OBSERVER_SOCKET_PATH",
      "STATION_HOST_SOCKET_PATH",
      "STATION_LAYOUT_PATH",
      "STATION_CURSOR_HOOKS_PATH",
      "STATION_SESSION_ID",
      "STATION_WORKTREE_PATH",
      "STATION_TMUX_BIN",
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_ASKPASS",
      "SSH_AUTH_SOCK",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "TMUX",
      "TMUX_PANE",
    ]) {
      expect(process.env[key], key).toBeUndefined();
    }

    expect(process.env.PATH).toBe(process.env.STATION_TEST_MACHINE_EXPECTED_PATH);
    expect(process.env.LANG).toBe("C");
    expect(process.env.CI).toBe("machine-isolation-regression");
  });

  it("allows direct, deletion, replacement-object, and stub mutations", () => {
    process.env.HOME = hostileRoot;
    delete process.env.XDG_CONFIG_HOME;
    vi.stubEnv("CLAUDE_CONFIG_DIR", hostileRoot);
    process.env.STATION_TEST_MACHINE_ADDED = "added";
    process.env = { ...process.env, STATION_TEST_MACHINE_REPLACED: "replaced" };
    mutationPending = true;
  });

  it("restores the complete sandbox baseline before the next test", () => {
    expect(process.env.HOME).toBe(join(machineRoot, "home"));
    expect(process.env.XDG_CONFIG_HOME).toBe(join(machineRoot, "xdg", "config"));
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(machineRoot, "harness", "claude"));
    expect(process.env.STATION_TEST_MACHINE_ADDED).toBeUndefined();
    expect(process.env.STATION_TEST_MACHINE_REPLACED).toBeUndefined();
  });

  it("passes sandbox paths to child processes", () => {
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,STATION_TEST_MACHINE_ROOT:process.env.STATION_TEST_MACHINE_ROOT}))",
      ],
      { encoding: "utf8" },
    );

    expect(child.status).toBe(0);
    expect(parseChildEnvironment(child.stdout)).toEqual({
      HOME: join(machineRoot, "home"),
      TMPDIR: process.env.TMPDIR,
      XDG_RUNTIME_DIR: join(machineRoot, "xdg", "runtime"),
      STATION_TEST_MACHINE_ROOT: machineRoot,
    });
  });

  it("cannot resolve the default Observer socket to the hostile listener", async () => {
    const socketPath = resolveObserverPaths().socketPath;
    expect(socketPath).toBe(join(machineRoot, "xdg", "runtime", "station", "observer.sock"));
    expect(socketPath).not.toBe(process.env.STATION_TEST_MACHINE_HOSTILE_SOCKET_PATH);
    await expect(socketOutcome(socketPath)).resolves.toBe("error");
  });

  it("installs default Cursor hooks only inside the sandbox", async () => {
    const hooksPath = join(machineRoot, "harness", "cursor", ".cursor", "hooks.json");
    const hookScriptPath = join(
      machineRoot,
      "xdg",
      "state",
      "station",
      "hooks",
      "station-cursor-hook.sh",
    );
    assertPathInsideTestMachineRoot(hooksPath, "Cursor hooks path");
    assertPathInsideTestMachineRoot(hookScriptPath, "Cursor hook script path");

    const installed = await installCursorHooks();

    expect(installed.hooksPath).toBe(hooksPath);
    expect(installed.hookScriptPath).toBe(hookScriptPath);
    expect(installed.installed).toBe(true);
  });
});

function requiredEnvironmentVariable(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}

function parseChildEnvironment(source: string): z.infer<typeof childEnvironmentSchema> {
  try {
    return childEnvironmentSchema.parse(JSON.parse(source));
  } catch (cause) {
    throw new Error("Child process returned an invalid environment payload.", { cause });
  }
}

function socketOutcome(path: string): Promise<"connected" | "error"> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", () => resolve("error"));
  });
}
