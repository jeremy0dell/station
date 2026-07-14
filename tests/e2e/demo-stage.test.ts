import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "@station/config";
import { describe, expect, it } from "vitest";

const showcaseRemotes = [
  { name: "linux", branch: "master", url: "https://github.com/torvalds/linux.git" },
  { name: "ghostty", branch: "main", url: "https://github.com/ghostty-org/ghostty.git" },
  { name: "svelte", branch: "main", url: "https://github.com/sveltejs/svelte.git" },
  { name: "is-even", branch: "master", url: "https://github.com/jonschlinkert/is-even.git" },
] as const;

describe("demo staging e2e", () => {
  it("stages the rich demo at bounded depth without touching user state", async () => {
    const root = await realpath(await mkdtemp("/tmp/stn-demo-e2e-"));
    const home = join(root, "home");
    const bin = join(root, "bin");
    const remotes = join(root, "remotes");
    const demoRoot = join(root, "demo root");
    const gitConfig = join(root, "gitconfig");
    const stnLog = join(root, "stn.log");
    const lsofPidFile = join(root, "lsof.pid");
    const ownerHelper = join(root, "socket-owner.mjs");
    const repoRoot = process.cwd();
    let ownerPid: number | undefined;
    let passed = false;

    try {
      await Promise.all([
        mkdir(join(home, ".codex"), { recursive: true }),
        mkdir(join(root, "xdg-config"), { recursive: true }),
        mkdir(join(root, "xdg-state"), { recursive: true }),
        mkdir(bin, { recursive: true }),
        mkdir(remotes, { recursive: true }),
      ]);
      await writeFile(join(home, ".codex", "config.toml"), "# user codex config\n", "utf8");
      await writeFile(join(home, ".gitconfig"), "# user git config\n", "utf8");
      await writeFile(join(root, "xdg-config", "canary"), "config\n", "utf8");
      await writeFile(join(root, "xdg-state", "canary"), "state\n", "utf8");
      await writeFile(gitConfig, "", "utf8");

      for (const remote of showcaseRemotes) {
        const path = join(remotes, remote.name);
        await createShowcaseRemote(path, remote.branch);
        run("git", ["config", "--file", gitConfig, `url.file://${path}.insteadOf`, remote.url], {
          cwd: root,
        });
      }

      for (const name of [
        "wt",
        "tmux",
        "diffnav",
        "delta",
        "bun",
        "claude",
        "codex",
        "opencode",
        "pi",
        "agent",
      ]) {
        await writeShim(bin, name, "exit 0\n");
      }
      await writeShim(
        bin,
        "lsof",
        [
          'pid_file="$STATION_DEMO_LSOF_PID_FILE"',
          '[ -f "$pid_file" ] || exit 0',
          'socket=""',
          'for arg in "$@"; do socket="$arg"; done',
          '[ -S "$socket" ] || exit 0',
          'pid=$(cat "$pid_file")',
          'kill -0 "$pid" >/dev/null 2>&1 || exit 0',
          "printf '%s\\n' \"$pid\"",
          "",
        ].join("\n"),
      );
      await writeFile(
        ownerHelper,
        [
          'import { unlinkSync, writeFileSync } from "node:fs";',
          'import { createServer } from "node:net";',
          "const arg = (name) => process.argv[process.argv.indexOf(name) + 1];",
          'const socketPath = arg("--socket");',
          'const readyPath = arg("--ready");',
          'const exitedPath = arg("--exited");',
          "const server = createServer(() => undefined);",
          "let stopping = false;",
          "const stop = () => {",
          "  if (stopping) return;",
          "  stopping = true;",
          "  server.close();",
          "  try { unlinkSync(socketPath); } catch {}",
          '  setTimeout(() => { writeFileSync(exitedPath, "exited\\n"); process.exit(0); }, 500);',
          "};",
          'server.listen(socketPath, () => writeFileSync(readyPath, "ready\\n"));',
          'process.on("SIGTERM", stop);',
          'process.on("SIGINT", stop);',
          "setInterval(() => undefined, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );
      const fakeStn = await writeShim(
        bin,
        "demo-stn",
        [
          'log="$STATION_DEMO_STN_LOG"',
          "{",
          "  printf 'args=%s\\n' \"$*\"",
          "  printf 'config=%s\\n' \"$STATION_CONFIG_PATH\"",
          "  printf 'socket=%s\\n' \"$STATION_OBSERVER_SOCKET_PATH\"",
          "  printf 'layout=%s\\n' \"$STATION_LAYOUT_PATH\"",
          "  printf 'codex=%s\\n' \"$CODEX_HOME\"",
          "  printf 'claude=%s\\n' \"$CLAUDE_CONFIG_DIR\"",
          "  printf 'cursor=%s\\n' \"$STATION_CURSOR_HOME\"",
          "  printf 'opencode=%s\\n' \"$OPENCODE_CONFIG_DIR\"",
          '} >> "$log"',
          `if [ -n "\${STATION_DEMO_FAIL_HOOK_TARGET:-}" ]; then`,
          '  case "$*" in *"hooks doctor $STATION_DEMO_FAIL_HOOK_TARGET"*) exit 42 ;; esac',
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      );
      const fakeIngress = await writeShim(bin, "demo-stn-ingress", "exit 0\n");

      const env = cleanGitEnvironment({
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        XDG_STATE_HOME: join(root, "xdg-state"),
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        STATION_DEMO_ROOT: demoRoot,
        STATION_DEMO_STN: fakeStn,
        STATION_DEMO_HOOK_BIN: fakeIngress,
        STATION_DEMO_STN_LOG: stnLog,
        STATION_DEMO_LSOF_PID_FILE: lsofPidFile,
      });

      run(join(repoRoot, "scripts/demo/stage.sh"), [], { cwd: repoRoot, env });

      for (const relativePath of [
        "root.txt",
        "one/one.txt",
        "one/two/two.txt",
        "one/two/three/three.txt",
      ]) {
        await expect(
          access(join(demoRoot, "repos", "linux", relativePath)),
        ).resolves.toBeUndefined();
        await expect(
          access(join(demoRoot, "worktrees", "linux", "sched-eevdf-latency", relativePath)),
        ).resolves.toBeUndefined();
      }
      await expect(
        access(join(demoRoot, "repos", "linux", "one/two/three/four/four.txt")),
      ).rejects.toThrow();
      await expect(
        access(
          join(
            demoRoot,
            "worktrees",
            "linux",
            "sched-eevdf-latency",
            "one/two/three/four/four.txt",
          ),
        ),
      ).rejects.toThrow();
      expect(
        run("git", ["rev-parse", "--is-shallow-repository"], {
          cwd: join(demoRoot, "repos", "linux"),
          env,
        }).stdout.trim(),
      ).toBe("true");
      expect(
        run("git", ["config", "--local", "--get", "remote.origin.promisor"], {
          cwd: join(demoRoot, "repos", "linux"),
          env,
          allowFailure: true,
        }).status,
      ).not.toBe(0);
      expect(
        run("git", ["config", "--local", "--get", "remote.origin.url"], {
          cwd: join(demoRoot, "repos", "linux"),
          env,
        }).stdout.trim(),
      ).toBe(showcaseRemotes[0].url);
      const worktreeCounts = await Promise.all(
        ["linux", "ghostty", "svelte", "is-even", "t3-code"].map(async (project) =>
          (await readdir(join(demoRoot, "worktrees", project), { withFileTypes: true })).filter(
            (entry) => entry.isDirectory(),
          ),
        ),
      );
      expect(worktreeCounts.map((entries) => entries.length)).toEqual([3, 2, 1, 1, 10]);

      const configPath = join(demoRoot, "config.toml");
      const source = await readFile(configPath, "utf8");
      const loaded = await loadConfig({ configPath, homeDir: home });
      expect(loaded.config.observer).toMatchObject({
        socketPath: join(demoRoot, "state", "run", "observer.sock"),
        stateDir: join(demoRoot, "state"),
      });
      expect(loaded.config.worktree?.worktrunk?.managedRoot).toBe(join(demoRoot, "worktrees"));
      expect(loaded.config.repository?.github?.enabled).toBe(false);
      expect(loaded.config.featureFlags?.stationPersistentAgents).toBe(true);
      expect(
        Object.fromEntries(
          loaded.config.projects.map((project) => [project.id, project.defaults.harness]),
        ),
      ).toEqual({
        linux: "claude",
        ghostty: "codex",
        svelte: "opencode",
        "is-even": "pi",
        "t3-code": "cursor",
      });
      expect(
        Object.fromEntries(
          loaded.config.projects.map((project) => [project.id, project.worktrunk?.base]),
        ),
      ).toEqual({
        linux: "master",
        ghostty: "main",
        svelte: "main",
        "is-even": "master",
        "t3-code": "main",
      });
      expect(loaded.config.projects.every((project) => project.root.startsWith(demoRoot))).toBe(
        true,
      );
      expect(source).not.toContain("worktree_launches");
      expect(source).not.toContain("harness.crush");
      await expect(
        access(join(demoRoot, "repos", "t3-code", "apps/web/src/index.ts")),
      ).resolves.toBeUndefined();

      run(join(demoRoot, "run.sh"), [], { cwd: root, env });
      const stnCalls = await readFile(stnLog, "utf8");
      expect(stnCalls).toContain(`args=--config ${configPath} tui`);
      expect(stnCalls).toContain(`config=${configPath}`);
      expect(stnCalls).toContain(`socket=${join(demoRoot, "state", "run", "observer.sock")}`);
      expect(stnCalls).toContain(`layout=${join(demoRoot, "state", "station", "layout.json")}`);
      expect(stnCalls).toContain(`codex=${join(demoRoot, "codex-home")}`);
      expect(stnCalls).toContain(`claude=${join(demoRoot, "claude-home")}`);
      expect(stnCalls).toContain(`cursor=${join(demoRoot, "cursor-home")}`);
      expect(stnCalls).toContain(`opencode=${join(demoRoot, "opencode-home")}`);
      expect(stnCalls).toContain(
        `args=--config ${configPath} hooks install worktrunk --yes --hook-bin ${fakeIngress} --worktrunk-config ${join(demoRoot, "worktrunk", "config.toml")}`,
      );
      expect(stnCalls).toContain(
        `args=--config ${configPath} hooks doctor worktrunk --worktrunk-config ${join(demoRoot, "worktrunk", "config.toml")}`,
      );
      expect(stnCalls).toContain(
        `args=--config ${configPath} hooks install codex --yes --hook-bin ${fakeIngress}`,
      );
      expect(stnCalls).toContain(`args=--config ${configPath} hooks doctor codex\n`);
      expect(stnCalls).toContain(`args=--config ${configPath} hooks install opencode --yes\n`);
      await expect(readFile(join(demoRoot, "hooks.txt"), "utf8")).resolves.toContain(
        "codex: installed and runtime-verified",
      );

      const ownerReady = join(root, "owner.ready");
      const ownerExited = join(root, "owner.exited");
      const ownerSocket = join(demoRoot, "state", "run", "observer.sock");
      ownerPid = Number(
        run(
          "/bin/sh",
          [
            "-c",
            'exec "$@" >/dev/null 2>&1 & echo $!',
            "station-demo-owner",
            process.execPath,
            ownerHelper,
            "__observer",
            "--socket",
            ownerSocket,
            "--state-dir",
            join(demoRoot, "state"),
            "--ready",
            ownerReady,
            "--exited",
            ownerExited,
          ],
          { cwd: root, env },
        ).stdout.trim(),
      );
      expect(Number.isInteger(ownerPid)).toBe(true);
      await writeFile(lsofPidFile, `${ownerPid}\n`, "utf8");
      await waitForFile(ownerReady);

      run(join(repoRoot, "scripts/demo/reset.sh"), [], { cwd: repoRoot, env });
      await expect(readFile(ownerExited, "utf8")).resolves.toBe("exited\n");
      ownerPid = undefined;
      await expect(access(demoRoot)).rejects.toThrow();
      await expect(readFile(join(home, ".codex", "config.toml"), "utf8")).resolves.toBe(
        "# user codex config\n",
      );
      await expect(readFile(join(home, ".gitconfig"), "utf8")).resolves.toBe("# user git config\n");
      await expect(readFile(join(root, "xdg-config", "canary"), "utf8")).resolves.toBe("config\n");
      await expect(readFile(join(root, "xdg-state", "canary"), "utf8")).resolves.toBe("state\n");

      const unmarkedRoot = join(root, "unmarked-custom-root");
      await mkdir(unmarkedRoot);
      await writeFile(join(unmarkedRoot, "canary"), "keep\n", "utf8");
      const refusedReset = run(join(repoRoot, "scripts/demo/reset.sh"), [], {
        cwd: repoRoot,
        env: { ...env, STATION_DEMO_ROOT: unmarkedRoot },
        allowFailure: true,
      });
      expect(refusedReset.status).not.toBe(0);
      await expect(readFile(join(unmarkedRoot, "canary"), "utf8")).resolves.toBe("keep\n");

      const forgedRoot = join(root, "forged-socket-root");
      const externalTarget = join(root, "external-socket-target");
      await mkdir(join(forgedRoot, "state", "run"), { recursive: true });
      await writeFile(join(forgedRoot, ".station-demo-root"), "station-demo-v1\n", "utf8");
      await writeFile(externalTarget, "external\n", "utf8");
      await symlink(externalTarget, join(forgedRoot, "state", "run", "observer.sock"));
      const refusedSymlink = run(join(repoRoot, "scripts/demo/reset.sh"), [], {
        cwd: repoRoot,
        env: { ...env, STATION_DEMO_ROOT: forgedRoot },
        allowFailure: true,
      });
      expect(refusedSymlink.status).not.toBe(0);
      await expect(readFile(externalTarget, "utf8")).resolves.toBe("external\n");
      await expect(access(forgedRoot)).resolves.toBeUndefined();

      const victimRoot = join(root, "victim");
      await mkdir(victimRoot);
      await writeFile(join(victimRoot, "canary"), "victim\n", "utf8");
      const refusedTraversal = run(join(repoRoot, "scripts/demo/reset.sh"), [], {
        cwd: repoRoot,
        env: { ...env, STATION_DEMO_ROOT: `${root}/missing/../victim` },
        allowFailure: true,
      });
      expect(refusedTraversal.status).not.toBe(0);
      await expect(readFile(join(victimRoot, "canary"), "utf8")).resolves.toBe("victim\n");

      const unsafeTomlRoot = `${root}/unsafe"root`;
      const refusedUnsafeToml = run(join(repoRoot, "scripts/demo/stage.sh"), [], {
        cwd: repoRoot,
        env: { ...env, STATION_DEMO_ROOT: unsafeTomlRoot },
        allowFailure: true,
      });
      expect(refusedUnsafeToml.status).not.toBe(0);
      await expect(access(unsafeTomlRoot)).rejects.toThrow();

      const failedHookRoot = join(root, "failed-provider-hook");
      const failedHookLog = join(root, "failed-provider-hook.log");
      const failedHookStage = run(join(repoRoot, "scripts/demo/stage.sh"), [], {
        cwd: repoRoot,
        env: {
          ...env,
          STATION_DEMO_ROOT: failedHookRoot,
          STATION_DEMO_STN_LOG: failedHookLog,
          STATION_DEMO_FAIL_HOOK_TARGET: "codex",
        },
        allowFailure: true,
      });
      expect(failedHookStage.status).not.toBe(0);
      expect(await readFile(failedHookLog, "utf8")).not.toContain("observer start");
      passed = true;
    } finally {
      if (ownerPid !== undefined) {
        try {
          process.kill(ownerPid, "SIGKILL");
        } catch {}
      }
      if (passed || process.env.STATION_KEEP_DEMO_E2E_TEMP !== "1") {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function createShowcaseRemote(path: string, branch: string): Promise<void> {
  await Promise.all([
    mkdir(join(path, "one", "two", "three", "four"), { recursive: true }),
    mkdir(join(path, "other"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(path, "README"), "Fixture repository.\n", "utf8"),
    writeFile(join(path, "README.md"), "# Fixture repository\n", "utf8"),
    writeFile(join(path, "root.txt"), "root\n", "utf8"),
    writeFile(join(path, "one", "one.txt"), "one\n", "utf8"),
    writeFile(join(path, "one", "two", "two.txt"), "two\n", "utf8"),
    writeFile(join(path, "one", "two", "three", "three.txt"), "three\n", "utf8"),
    writeFile(join(path, "one", "two", "three", "four", "four.txt"), "four\n", "utf8"),
    writeFile(join(path, "other", "other.txt"), "other\n", "utf8"),
  ]);
  run("git", ["init", "-q", "-b", branch], { cwd: path });
  run("git", ["add", "-A"], { cwd: path });
  run(
    "git",
    ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-qm", "initial"],
    { cwd: path },
  );
  await writeFile(join(path, "root.txt"), "root second commit\n", "utf8");
  run("git", ["add", "root.txt"], { cwd: path });
  run(
    "git",
    ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-qm", "second"],
    { cwd: path },
  );
  run("git", ["config", "uploadpack.allowFilter", "true"], { cwd: path });
}

async function writeShim(bin: string, name: string, body: string): Promise<string> {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\n${body}`, "utf8");
  await chmod(path, 0o700);
  return path;
}

function cleanGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete result[name];
  }
  return result;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean },
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (options.allowFailure !== true && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}
