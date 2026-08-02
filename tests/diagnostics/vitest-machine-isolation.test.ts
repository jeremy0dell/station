import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const vitestPath = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));
const fixtureConfig = join(
  repoRoot,
  "tests/diagnostics/fixtures/vitest-machine-isolation/vitest.config.ts",
);
const distinctRootFixture =
  "tests/diagnostics/fixtures/vitest-machine-isolation/distinct-root.fixture.ts";
const environmentResetFixture =
  "tests/diagnostics/fixtures/vitest-machine-isolation/environment-reset.fixture.ts";

const fixtureResultSchema = z
  .object({
    machineRoot: z.string().min(1),
  })
  .strict();

type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

describe("Vitest machine isolation", () => {
  it("isolates hostile inherited machine state and cleans roots on every exit path", async () => {
    const controllerRoot = await mkdtemp(join(tmpdir(), "station-machine-isolation-regression-"));
    const socketRoot = await mkdtemp("/tmp/stn-mi-");
    const hostileRoot = join(controllerRoot, "hostile-machine");
    const hostileRuntimeDirectory = socketRoot;
    const hostileSocketPath = join(hostileRuntimeDirectory, "station", "observer.sock");
    const hostileConfigPath = join(hostileRoot, "xdg", "config", "station", "config.toml");
    const hostileCursorHooksPath = join(hostileRoot, "cursor", ".cursor", "hooks.json");
    const hostileLayoutPath = join(hostileRoot, "state", "layout.json");
    const hostileGitConfigPath = join(hostileRoot, "git", "global.gitconfig");
    const sentinels = new Map<string, string>([
      [hostileConfigPath, "hostile station config sentinel\n"],
      [hostileCursorHooksPath, "hostile cursor hooks sentinel\n"],
      [hostileLayoutPath, "hostile layout sentinel\n"],
      [hostileGitConfigPath, "hostile git config sentinel\n"],
    ]);
    let hostileConnections = 0;
    let retainedRoot: string | undefined;
    const server = createServer((socket) => {
      hostileConnections += 1;
      socket.destroy();
    });

    try {
      for (const [path, contents] of sentinels) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents, "utf8");
      }
      await mkdir(dirname(hostileSocketPath), { recursive: true });
      server.listen(hostileSocketPath);
      await once(server, "listening");

      const hostileEnvironment = machineHostileEnvironment({
        hostileRoot,
        hostileRuntimeDirectory,
        hostileSocketPath,
        hostileConfigPath,
        hostileCursorHooksPath,
        hostileLayoutPath,
        hostileGitConfigPath,
      });

      const passingResults = join(controllerRoot, "passing-results");
      const passing = await runFixtureVitest(
        [distinctRootFixture, environmentResetFixture],
        hostileEnvironment,
        passingResults,
      );
      expect(passing.code, passing.stderr || passing.stdout).toBe(0);
      const distinct = await readFixtureResult(join(passingResults, "distinct-root.json"));
      const reset = await readFixtureResult(join(passingResults, "environment-reset.json"));
      expect(distinct.machineRoot).not.toBe(reset.machineRoot);
      await expect(access(distinct.machineRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(reset.machineRoot)).rejects.toMatchObject({ code: "ENOENT" });

      const failureResults = join(controllerRoot, "failure-results");
      const failing = await runFixtureVitest(
        [distinctRootFixture],
        { ...hostileEnvironment, STATION_TEST_MACHINE_FAIL: "1" },
        failureResults,
      );
      expect(failing.code).not.toBe(0);
      expect(`${failing.stdout}\n${failing.stderr}`).toContain(
        "intentional machine-isolation fixture failure",
      );
      const failed = await readFixtureResult(join(failureResults, "distinct-root.json"));
      await expect(access(failed.machineRoot)).rejects.toMatchObject({ code: "ENOENT" });

      const retainedResults = join(controllerRoot, "retained-results");
      const retained = await runFixtureVitest(
        [distinctRootFixture],
        { ...hostileEnvironment, STATION_TEST_MACHINE_KEEP_ROOT: "1" },
        retainedResults,
      );
      expect(retained.code, retained.stderr || retained.stdout).toBe(0);
      const retainedFixture = await readFixtureResult(join(retainedResults, "distinct-root.json"));
      retainedRoot = retainedFixture.machineRoot;
      await expect(access(retainedRoot)).resolves.toBeUndefined();
      expect(`${retained.stdout}\n${retained.stderr}`).toContain(
        `[station test machine] retained root: ${retainedRoot}`,
      );

      for (const [path, contents] of sentinels) {
        await expect(readFile(path, "utf8")).resolves.toBe(contents);
      }
      expect(hostileConnections).toBe(0);
    } finally {
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
      if (retainedRoot !== undefined) {
        await rm(retainedRoot, { recursive: true, force: true });
      }
      await rm(controllerRoot, { recursive: true, force: true });
      await rm(socketRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

function machineHostileEnvironment(input: {
  hostileRoot: string;
  hostileRuntimeDirectory: string;
  hostileSocketPath: string;
  hostileConfigPath: string;
  hostileCursorHooksPath: string;
  hostileLayoutPath: string;
  hostileGitConfigPath: string;
}): NodeJS.ProcessEnv {
  const expectedPath = process.env.PATH ?? "";
  return {
    ...process.env,
    HOME: join(input.hostileRoot, "home"),
    XDG_CONFIG_HOME: join(input.hostileRoot, "xdg", "config"),
    XDG_DATA_HOME: join(input.hostileRoot, "xdg", "data"),
    XDG_CACHE_HOME: join(input.hostileRoot, "xdg", "cache"),
    XDG_STATE_HOME: join(input.hostileRoot, "xdg", "state"),
    XDG_RUNTIME_DIR: input.hostileRuntimeDirectory,
    CODEX_HOME: join(input.hostileRoot, "codex"),
    CLAUDE_CONFIG_DIR: join(input.hostileRoot, "claude"),
    STATION_CURSOR_HOME: join(input.hostileRoot, "cursor"),
    STATION_CURSOR_HOOKS_PATH: input.hostileCursorHooksPath,
    OPENCODE_CONFIG_DIR: join(input.hostileRoot, "opencode"),
    GH_CONFIG_DIR: join(input.hostileRoot, "gh"),
    GIT_CONFIG_GLOBAL: input.hostileGitConfigPath,
    STATION_CONFIG_PATH: input.hostileConfigPath,
    STATION_OBSERVER_SOCKET_PATH: input.hostileSocketPath,
    STATION_HOST_SOCKET_PATH: join(input.hostileRoot, "state", "hostile-host.sock"),
    STATION_LAYOUT_PATH: input.hostileLayoutPath,
    STATION_OBSERVER_STATE_DIR: join(input.hostileRoot, "state"),
    STATION_STATE_DIR: join(input.hostileRoot, "state"),
    STATION_HOOK_SPOOL_DIR: join(input.hostileRoot, "state", "spool", "hooks"),
    STATION_SESSION_ID: "hostile-session",
    STATION_PROJECT_ID: "hostile-project",
    STATION_WORKTREE_ID: "hostile-worktree",
    STATION_WORKTREE_PATH: input.hostileRoot,
    STATION_TERMINAL_TARGET_ID: "hostile-terminal",
    STATION_TMUX_BIN: join(input.hostileRoot, "bin", "tmux"),
    STATION_CURSOR_AGENT_BIN: join(input.hostileRoot, "bin", "agent"),
    STATION_INGRESS_BIN: join(input.hostileRoot, "bin", "stn-ingress"),
    TMUX: `${join(input.hostileRoot, "tmux.sock")},1,0`,
    TMUX_PANE: "%9",
    GIT_DIR: join(input.hostileRoot, "repo", ".git"),
    GIT_WORK_TREE: join(input.hostileRoot, "repo"),
    GIT_CONFIG_PARAMETERS: "'user.name=Hostile'",
    GIT_CONFIG_COUNT: "1",
    GIT_ASKPASS: join(input.hostileRoot, "bin", "askpass"),
    SSH_ASKPASS: join(input.hostileRoot, "bin", "ssh-askpass"),
    SSH_AUTH_SOCK: join(input.hostileRoot, "ssh-agent.sock"),
    SSH_AGENT_PID: "1234",
    GIT_AUTHOR_NAME: "Hostile Author",
    GIT_AUTHOR_EMAIL: "hostile@example.invalid",
    GIT_COMMITTER_NAME: "Hostile Committer",
    GIT_COMMITTER_EMAIL: "hostile@example.invalid",
    GH_TOKEN: "hostile-gh-token",
    GITHUB_TOKEN: "hostile-github-token",
    STATION_TEST_MACHINE_ROOT: input.hostileRoot,
    STATION_TEST_MACHINE_HOSTILE_ROOT: input.hostileRoot,
    STATION_TEST_MACHINE_HOSTILE_SOCKET_PATH: input.hostileSocketPath,
    STATION_TEST_MACHINE_EXPECTED_PATH: expectedPath,
    PATH: expectedPath,
    LANG: "C",
    CI: "machine-isolation-regression",
  };
}

function runFixtureVitest(
  fixtures: string[],
  environment: NodeJS.ProcessEnv,
  resultDirectory: string,
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [vitestPath, "run", "--no-color", "--config", fixtureConfig, ...fixtures],
      {
        cwd: repoRoot,
        env: { ...environment, STATION_TEST_MACHINE_RESULT_DIR: resultDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function readFixtureResult(path: string): Promise<z.infer<typeof fixtureResultSchema>> {
  try {
    return fixtureResultSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (cause) {
    throw new Error(`Machine-isolation fixture returned invalid JSON: ${path}`, { cause });
  }
}
