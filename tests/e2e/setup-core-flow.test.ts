import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "@station/config";
import { createObserverClient } from "@station/protocol";
import { describe, expect, it } from "vitest";
import { waitForSocketClosed } from "../support/sockets";

describe("setup core flow e2e", () => {
  it("bootstraps setup and runs all checkout launchers with the pinned pnpm", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-launcher-install-e2e-"));
    const home = join(root, "home");
    const runtimeDir = await mkdtemp(join(tmpdir(), "stn-r-"));
    const observerSocket = join(runtimeDir, "station", "observer.sock");
    const fallbackObserverSocket = join(home, ".local/state/station/run/observer.sock");
    let passed = false;
    try {
      const repoRoot = process.cwd();
      const pnpmHome = join(root, "pnpm-home");
      const bin = join(root, "bin");
      const pnpmBin = run("/bin/sh", ["-c", "command -v pnpm"], {
        cwd: repoRoot,
      }).stdout.trim();
      await mkdir(bin, { recursive: true });
      await writeShim(
        bin,
        "pnpm",
        [
          'case "$1" in',
          "  install|build) exit 0 ;;",
          `  station:link) exec ${shellQuote(pnpmBin)} --dir "$PWD" station:link ;;`,
          `  add|--version) exec ${shellQuote(pnpmBin)} "$@" ;;`,
          "esac",
          'echo "unexpected pnpm $*" >&2',
          "exit 2",
          "",
        ].join("\n"),
      );
      await writeShim(
        bin,
        "brew",
        [
          'if [ "$1" = "--version" ]; then echo "Homebrew 4.0.0"; exit 0; fi',
          'if [ "$1" = "bundle" ]; then exit 0; fi',
          'if [ "$1 $2" = "--prefix node@24" ]; then exit 1; fi',
          'echo "unexpected brew $*" >&2',
          "exit 2",
          "",
        ].join("\n"),
      );
      await writeShim(bin, "corepack", "exit 0\n");
      await writeShim(
        bin,
        "xcode-select",
        'if [ "$1" = "-p" ]; then echo "/Library/Developer/CommandLineTools"; exit 0; fi\nexit 2\n',
      );
      await writeShim(
        bin,
        "bun",
        'if [ "$1" = "--version" ]; then echo "1.2.0"; exit 0; fi\nexit 0\n',
      );
      await writeShim(
        bin,
        "wt",
        'if [ "$1" = "--version" ]; then echo "worktrunk 1.2.3"; exit 0; fi\nexit 0\n',
      );
      await writeShim(
        bin,
        "tmux",
        'if [ "$1" = "-V" ]; then echo "tmux 3.5a"; exit 0; fi\nexit 0\n',
      );
      await writeShim(
        bin,
        "codex",
        'if [ "$1" = "--version" ]; then echo "codex 0.1.0"; exit 0; fi\nexit 0\n',
      );
      await writeShim(bin, "diffnav", "exit 0\n");
      await writeShim(bin, "delta", "exit 0\n");
      const env = {
        ...process.env,
        HOME: home,
        PNPM_HOME: pnpmHome,
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        XDG_DATA_HOME: join(root, "xdg-data"),
        XDG_CACHE_HOME: join(root, "xdg-cache"),
        XDG_STATE_HOME: join(root, "xdg-state"),
        XDG_RUNTIME_DIR: runtimeDir,
        COREPACK_HOME: join(root, "corepack"),
        PATH: `${join(pnpmHome, "bin")}:${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        NO_COLOR: "1",
        STATION_FAST_POPUP_NO_FALLBACK: "1",
      };
      await Promise.all([
        mkdir(home, { recursive: true }),
        mkdir(join(pnpmHome, "bin"), { recursive: true }),
        mkdir(env.XDG_CONFIG_HOME, { recursive: true }),
        mkdir(env.XDG_DATA_HOME, { recursive: true }),
        mkdir(env.XDG_CACHE_HOME, { recursive: true }),
        mkdir(env.XDG_STATE_HOME, { recursive: true }),
        mkdir(env.COREPACK_HOME, { recursive: true }),
      ]);

      expect(run("pnpm", ["--version"], { cwd: repoRoot, env }).stdout.trim()).toBe("11.0.0");
      const bootstrap = run(join(repoRoot, "scripts/setup/bootstrap.sh"), [], { cwd: root, env });
      expect(bootstrap.stdout).toContain("Linking STATION launchers onto your PATH");
      expect(bootstrap.stdout).toContain("Station is installed.");

      const globalStation = await findGlobalStationLink(pnpmHome);
      await expect(realpath(globalStation)).resolves.toBe(repoRoot);
      expect(run("stn", ["--help"], { cwd: root, env }).stdout).toContain("stn --help");

      const project = join(root, "project");
      const configPath = join(home, ".config", "station", "config.toml");
      await mkdir(project, { recursive: true });
      run("git", ["init", "-b", "main"], { cwd: project, env });
      const setup = run("stn", ["--config", configPath, "setup", "apply", "--yes", "--no-brew"], {
        cwd: project,
        env,
      });
      expect(setup.stdout).toContain("Core setup complete.");
      await expect(readFile(configPath, "utf8")).resolves.toContain("[harness.codex]");

      const observer = createObserverClient({ socketPath: observerSocket, timeoutMs: 1000 });
      const health = await observer.health();
      const snapshot = await observer.getSnapshot();
      expect(health.pid).toBeTypeOf("number");
      expect(snapshot.projects).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "project" })]),
      );
      expect(snapshot.counts.projects).toBe(1);

      const ingress = run("stn-ingress", [], { cwd: root, env, allowFailure: true });
      expect(ingress.status).toBe(1);
      expect(ingress.stderr).toContain("Usage: stn-ingress [options] <provider> [event]");

      const popup = run("stn-tmux-popup", [], {
        cwd: root,
        env: {
          ...env,
          STATION_DISABLE_FAST_POPUP: "1",
          STATION_FAST_POPUP_NO_FALLBACK: "0",
          STATION_POPUP_FALLBACK_COMMAND: 'printf "stn-tmux-popup ok\\n"',
        },
      });
      expect(popup.stdout.trim()).toBe("stn-tmux-popup ok");
      passed = true;
    } finally {
      await stopObserverCandidates([observerSocket, fallbackObserverSocket]);
      if (passed || process.env.STATION_KEEP_SETUP_E2E_TEMP !== "1") {
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(runtimeDir, { recursive: true, force: true }),
        ]);
      }
    }
  });

  it("creates core config from a temp git repo without real external tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-setup-e2e-"));
    const runtimeDir = await mkdtemp(join(tmpdir(), "stn-r-"));
    const observerSocket = join(runtimeDir, "station", "observer.sock");
    const legacyObserverSocket = join(root, "home", ".local", "state", "station", "observer.sock");
    let passed = false;
    try {
      const home = join(root, "home");
      const repo = join(root, "repo");
      const bin = join(root, "bin");
      const configPath = join(home, ".config", "station", "config.toml");
      await mkdir(home, { recursive: true });
      await mkdir(repo, { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeShim(
        bin,
        "wt",
        'if [ "$1" = "--version" ]; then echo "worktrunk 1.2.3"; exit 0; fi\nexit 0\n',
      );
      await writeShim(
        bin,
        "tmux",
        'if [ "$1" = "-V" ]; then echo "tmux 3.5a"; exit 0; fi\nexit 0\n',
      );
      await writeShim(
        bin,
        "codex",
        'if [ "$1" = "--version" ]; then echo "codex 0.1.0"; exit 0; fi\nexit 0\n',
      );
      await writeShim(
        bin,
        "brew",
        'if [ "$1" = "--version" ]; then echo "Homebrew 4.0.0"; exit 0; fi\nexit 0\n',
      );
      await writeShim(bin, "npm", "echo 0.1.0\n");
      // diffnav + delta are required; the checks only need the binaries on PATH.
      await writeShim(bin, "diffnav", "exit 0\n");
      await writeShim(bin, "delta", "exit 0\n");
      await writeShim(bin, "bun", "exit 0\n");
      run("git", ["init", "-b", "main"], { cwd: repo });

      const env = {
        ...process.env,
        HOME: home,
        XDG_RUNTIME_DIR: runtimeDir,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMUX: "",
        STATION_DASHBOARD_COMMAND: "true",
        STATION_FAST_POPUP_NO_FALLBACK: "1",
      };
      const launch = runStation([], { cwd: repo, env });
      expect(launch.status).toBe(0);
      const observer = createObserverClient({ socketPath: observerSocket, timeoutMs: 1000 });
      const beforeHealth = await observer.health();
      const beforeSnapshot = await observer.getSnapshot();
      expect(beforeHealth.pid).toBeTypeOf("number");
      expect(beforeSnapshot).toMatchObject({ counts: { projects: 0 }, projects: [] });

      const firstCheck = runStation(["--config", configPath, "setup", "check", "--json"], {
        cwd: repo,
        env,
        allowFailure: true,
      });
      expect(firstCheck.status).toBe(1);
      const firstPlan = JSON.parse(firstCheck.stdout);
      expect(firstPlan.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "worktrunk", status: "ok" }),
          expect.objectContaining({ id: "tmux", status: "ok" }),
          expect.objectContaining({ id: "harness", status: "ok" }),
          expect.objectContaining({ id: "config", status: "missing" }),
        ]),
      );

      const plan = runStation(["--config", configPath, "setup", "plan", "--json"], {
        cwd: repo,
        env,
      });
      const parsedPlan = JSON.parse(plan.stdout);
      expect(parsedPlan.actions).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "write-config" })]),
      );
      expect(JSON.stringify(parsedPlan.actions)).not.toContain("github");

      const apply = runStation(["--config", configPath, "setup", "apply", "--yes"], {
        cwd: repo,
        env,
      });
      expect(apply.stdout).toContain("Core setup complete.");
      await expect(readFile(configPath, "utf8")).resolves.toContain("[harness.codex]");

      const afterHealth = await observer.health();
      const afterSnapshot = await observer.getSnapshot();
      expect(afterHealth.pid).toBeTypeOf("number");
      expect(afterHealth.pid).not.toBe(beforeHealth.pid);
      expect(afterSnapshot.projects).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "repo" })]),
      );
      expect(afterSnapshot.counts.projects).toBe(1);

      const finalCheck = runStation(["--config", configPath, "setup", "check", "--json"], {
        cwd: repo,
        env,
      });
      const finalPlan = JSON.parse(finalCheck.stdout);
      expect(finalPlan.summary.requiredOk).toBe(true);
      await expect(loadConfig({ configPath, homeDir: home })).resolves.toMatchObject({
        config: {
          defaults: {
            harness: "codex",
            terminal: "tmux",
            worktreeProvider: "worktrunk",
          },
        },
      });
      passed = true;
    } finally {
      await stopObserverCandidates([observerSocket, legacyObserverSocket]);
      if (passed || process.env.STATION_KEEP_SETUP_E2E_TEMP !== "1") {
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(runtimeDir, { recursive: true, force: true }),
        ]);
      }
    }
  });

  it("preserves custom Worktrunk and tmux commands in generated config", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-setup-e2e-"));
    const runtimeDir = await mkdtemp(join(tmpdir(), "stn-r-"));
    const observerSocket = join(runtimeDir, "station", "observer.sock");
    const legacyObserverSocket = join(root, "home", ".local", "state", "station", "observer.sock");
    let passed = false;
    try {
      const home = join(root, "home");
      const repo = join(root, "repo");
      const bin = join(root, "bin");
      const customWt = join(bin, "custom-wt");
      const customTmux = join(bin, "custom-tmux");
      const configPath = join(home, ".config", "station", "config.toml");
      await mkdir(home, { recursive: true });
      await mkdir(repo, { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeShim(
        bin,
        "custom-wt",
        'if [ "$1" = "--version" ]; then echo "worktrunk 1.2.3"; exit 0; fi\nexit 0\n',
      );
      await writeShim(
        bin,
        "custom-tmux",
        'if [ "$1" = "-V" ]; then echo "tmux 3.5a"; exit 0; fi\nexit 0\n',
      );
      await writeShim(
        bin,
        "codex",
        'if [ "$1" = "--version" ]; then echo "codex 0.1.0"; exit 0; fi\nexit 0\n',
      );
      await writeShim(bin, "npm", "echo 0.1.0\n");
      // diffnav + delta are required; without them config write is blocked.
      await writeShim(bin, "diffnav", "exit 0\n");
      await writeShim(bin, "delta", "exit 0\n");
      await writeShim(bin, "bun", "exit 0\n");
      run("git", ["init", "-b", "main"], { cwd: repo });

      const env = {
        ...process.env,
        HOME: home,
        XDG_RUNTIME_DIR: runtimeDir,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        STATION_FAST_POPUP_NO_FALLBACK: "1",
        STATION_WORKTRUNK_BIN: customWt,
        STATION_TMUX_BIN: customTmux,
      };

      runStation(["--config", configPath, "setup", "apply", "--yes", "--no-brew"], {
        cwd: repo,
        env,
      });

      const config = await readFile(configPath, "utf8");
      expect(config).toContain(`command = ${JSON.stringify(customWt)}`);
      expect(config).toContain(`[terminal.tmux]\ncommand = ${JSON.stringify(customTmux)}`);
      passed = true;
    } finally {
      await stopObserverCandidates([observerSocket, legacyObserverSocket]);
      if (passed || process.env.STATION_KEEP_SETUP_E2E_TEMP !== "1") {
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(runtimeDir, { recursive: true, force: true }),
        ]);
      }
    }
  });

  it("returns non-zero JSON for invalid existing config", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-setup-e2e-"));
    let passed = false;
    try {
      const home = join(root, "home");
      const repo = join(root, "repo");
      const bin = join(root, "bin");
      const configPath = join(home, ".config", "station", "config.toml");
      await mkdir(home, { recursive: true });
      await mkdir(repo, { recursive: true });
      await mkdir(bin, { recursive: true });
      await mkdir(join(home, ".config", "station"), { recursive: true });
      await writeFile(configPath, "schema_version = 1\n[defaults\n", "utf8");
      await writeShim(
        bin,
        "wt",
        'if [ "$1" = "--version" ]; then echo "worktrunk 1.2.3"; exit 0; fi\nexit 0\n',
      );
      await writeShim(
        bin,
        "tmux",
        'if [ "$1" = "-V" ]; then echo "tmux 3.5a"; exit 0; fi\nexit 0\n',
      );
      await writeShim(
        bin,
        "codex",
        'if [ "$1" = "--version" ]; then echo "codex 0.1.0"; exit 0; fi\nexit 0\n',
      );
      run("git", ["init", "-b", "main"], { cwd: repo });

      const result = runStation(["--config", configPath, "setup", "check", "--json"], {
        cwd: repo,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          STATION_FAST_POPUP_NO_FALLBACK: "1",
        },
        allowFailure: true,
      });
      const output = JSON.parse(result.stdout);

      expect(result.status).toBe(1);
      expect(output.summary.requiredOk).toBe(false);
      expect(output.checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "config", status: "missing" })]),
      );
      passed = true;
    } finally {
      if (passed || process.env.STATION_KEEP_SETUP_E2E_TEMP !== "1") {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("compatibility wrapper bare setup:system dispatches apply mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-setup-e2e-"));
    let passed = false;
    try {
      const bin = join(root, "bin");
      const worktrunkBin = join(bin, "wt");
      const tmuxBin = join(bin, "tmux");
      const log = join(root, "brew.log");
      await mkdir(bin, { recursive: true });
      await writeShim(
        bin,
        "brew",
        [
          'if [ "$1" = "--version" ]; then echo "Homebrew 4.0.0"; exit 0; fi',
          'if [ "$1 $2" = "install worktrunk" ]; then',
          `  echo worktrunk >> ${shellQuote(log)}`,
          `  cat > ${shellQuote(join(bin, "wt"))} <<'EOF'`,
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo "worktrunk 1.2.3"; exit 0; fi',
          "exit 0",
          "EOF",
          `  chmod 700 ${shellQuote(join(bin, "wt"))}`,
          "  exit 0",
          "fi",
          'if [ "$1 $2" = "install tmux" ]; then',
          `  echo tmux >> ${shellQuote(log)}`,
          `  cat > ${shellQuote(join(bin, "tmux"))} <<'EOF'`,
          "#!/bin/sh",
          'if [ "$1" = "-V" ]; then echo "tmux 3.5a"; exit 0; fi',
          "exit 0",
          "EOF",
          `  chmod 700 ${shellQuote(join(bin, "tmux"))}`,
          "  exit 0",
          "fi",
          'echo "unexpected brew $*" >&2',
          "exit 2",
          "",
        ].join("\n"),
      );
      await writeShim(
        bin,
        "pnpm",
        'if [ "$1" = "--version" ]; then echo "11.0.0"; exit 0; fi\nexit 2\n',
      );
      // diffnav + delta are required for `setup system` readiness.
      await writeShim(bin, "diffnav", "exit 0\n");
      await writeShim(bin, "delta", "exit 0\n");
      await writeShim(bin, "bun", "exit 0\n");

      const result = run("scripts/setup/setup-system-dependencies.sh", [], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
          STATION_FAST_POPUP_NO_FALLBACK: "1",
          STATION_WORKTRUNK_BIN: worktrunkBin,
          STATION_TMUX_BIN: tmuxBin,
        },
      });

      expect(result.stdout).toContain("stn setup system final");
      await expect(readFile(log, "utf8")).resolves.toContain("worktrunk");
      await expect(readFile(log, "utf8")).resolves.toContain("tmux");
      passed = true;
    } finally {
      if (passed || process.env.STATION_KEEP_SETUP_E2E_TEMP !== "1") {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});

async function findGlobalStationLink(pnpmHome: string): Promise<string> {
  const globalRoot = join(pnpmHome, "global", "v11");
  for (const entry of await readdir(globalRoot)) {
    const candidate = join(globalRoot, entry, "node_modules", "station");
    try {
      await realpath(candidate);
      return candidate;
    } catch {
      // pnpm v11 keeps global installs beside non-package metadata in this directory.
    }
  }
  throw new Error(`Global station link was not found under ${globalRoot}.`);
}

async function writeShim(bin: string, name: string, body: string): Promise<void> {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\n${body}`, "utf8");
  await chmod(path, 0o700);
}

async function stopObserverCandidates(socketPaths: readonly string[]): Promise<void> {
  for (const socketPath of new Set(socketPaths)) {
    const client = createObserverClient({ socketPath, timeoutMs: 1000 });
    await client.stop().catch(() => undefined);
    await waitForSocketClosed(socketPath, { timeoutMs: 5000 });
  }
}

function runStation(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; allowFailure?: boolean },
): { stdout: string; stderr: string; status: number | null } {
  return run(join(process.cwd(), "bin", "stn"), args, options);
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
