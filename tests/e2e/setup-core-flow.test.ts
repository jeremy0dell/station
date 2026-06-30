import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "@station/config";
import { describe, expect, it } from "vitest";

describe("setup core flow e2e", () => {
  it("creates core config from a temp git repo without real external tools", async () => {
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
      // diffnav + delta are required; the checks only need the binaries on PATH.
      await writeShim(bin, "diffnav", "exit 0\n");
      await writeShim(bin, "delta", "exit 0\n");
      await writeShim(bin, "bun", "exit 0\n");
      run("git", ["init", "-b", "main"], { cwd: repo });

      const env = {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        STATION_FAST_POPUP_NO_FALLBACK: "1",
      };
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
      if (passed || process.env.STATION_KEEP_SETUP_E2E_TEMP !== "1") {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("preserves custom Worktrunk and tmux commands in generated config", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-setup-e2e-"));
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
      // diffnav + delta are required; without them config write is blocked.
      await writeShim(bin, "diffnav", "exit 0\n");
      await writeShim(bin, "delta", "exit 0\n");
      await writeShim(bin, "bun", "exit 0\n");
      run("git", ["init", "-b", "main"], { cwd: repo });

      const env = {
        ...process.env,
        HOME: home,
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
      if (passed || process.env.STATION_KEEP_SETUP_E2E_TEMP !== "1") {
        await rm(root, { recursive: true, force: true });
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

async function writeShim(bin: string, name: string, body: string): Promise<void> {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\n${body}`, "utf8");
  await chmod(path, 0o700);
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
