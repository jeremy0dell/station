import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

describe("setup guided feedback e2e", () => {
  it("exits instead of hanging when every agent install choice is declined", async () => {
    const fixture = await createFixture({ harness: "missing" });
    try {
      const result = await runStation(["--config", fixture.configPath, "setup"], {
        cwd: fixture.repo,
        env: fixture.env,
        answers: ["n", "n", "n", "n", "n", "n"],
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("No supported agent CLI is available.");
      expect(result.stdout).toContain("No agent CLI was installed.");
      await expect(readFile(fixture.configPath, "utf8")).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  it("prints config and Worktrunk shell integration feedback and exits", async () => {
    const fixture = await createFixture({ harness: "codex" });
    try {
      const result = await runStation(["--config", fixture.configPath, "setup"], {
        cwd: fixture.repo,
        env: fixture.env,
        answers: ["n", "n", "n", "y", "y", "n"],
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Link STATION launchers globally?");
      expect(result.stdout).toContain("Install Worktrunk lifecycle hooks?");
      expect(result.stdout).toContain("Install Codex agent hooks?");
      expect(result.stdout).toContain(`Applying: Write STATION config (${fixture.configPath})`);
      expect(result.stdout).toContain("Completed: Write STATION config");
      expect(result.stdout).toContain("Running: wt -y config shell install");
      expect(result.stdout).toContain("fake shell integration installed");
      expect(result.stdout).toContain("Completed: Install Worktrunk shell integration");
      expect(result.stdout).toContain("Core setup complete.");
      await expect(readFile(fixture.configPath, "utf8")).resolves.toContain("[harness.codex]");
    } finally {
      await fixture.cleanup();
    }
  });

  it("shows agent installer feedback, re-checks, and continues without hanging", async () => {
    const fixture = await createFixture({ harness: "installable-codex" });
    try {
      const result = await runStation(["--config", fixture.configPath, "setup"], {
        cwd: fixture.repo,
        env: fixture.env,
        // Prompt order: install codex (y), decline cursor/opencode/pi/claude, decline
        // link-launchers + Worktrunk-hooks + codex-hooks, accept Write config (y),
        // decline shell-integration + popup. (Crush removal dropped one harness prompt.)
        answers: ["y", "n", "n", "n", "n", "n", "n", "n", "y", "n", "n"],
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No supported agent CLI is available.");
      expect(result.stdout).toContain("Running: sh -c");
      expect(result.stdout).toContain("fake codex installer ran");
      expect(result.stdout).toContain("Link STATION launchers globally?");
      expect(result.stdout).toContain("Install Worktrunk lifecycle hooks?");
      expect(result.stdout).toContain("Install Codex agent hooks?");
      expect(result.stdout).toContain("Applying: Write STATION config");
      expect(result.stdout).toContain("Core setup complete.");
      await expect(readFile(fixture.configPath, "utf8")).resolves.toContain("[harness.codex]");
    } finally {
      await fixture.cleanup();
    }
  });
});

type HarnessMode = "codex" | "installable-codex" | "missing";

type Fixture = {
  root: string;
  home: string;
  repo: string;
  bin: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
};

async function createFixture(input: { harness: HarnessMode }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "station-setup-guided-feedback-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const configPath = join(home, ".config", "station", "config.toml");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeShim(
    bin,
    "git",
    [
      'if [ "$1 $2" = "rev-parse --show-toplevel" ]; then',
      `  echo ${shellQuote(repo)}`,
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3 $4" = "symbolic-ref --quiet --short refs/remotes/origin/HEAD" ]; then',
      '  echo "origin/main"',
      "  exit 0",
      "fi",
      'echo "unexpected git $*" >&2',
      "exit 2",
      "",
    ].join("\n"),
  );
  await writeShim(
    bin,
    "wt",
    [
      'if [ "$1" = "--version" ]; then echo "worktrunk 1.2.3"; exit 0; fi',
      'if [ "$1 $2 $3 $4" = "-y config shell install" ]; then',
      '  echo "fake shell integration installed"',
      "  exit 0",
      "fi",
      'echo "unexpected wt $*" >&2',
      "exit 2",
      "",
    ].join("\n"),
  );
  await writeShim(bin, "tmux", 'if [ "$1" = "-V" ]; then echo "tmux 3.5a"; exit 0; fi\nexit 2\n');
  await writeShim(
    bin,
    "brew",
    'if [ "$1" = "--version" ]; then echo "Homebrew 4.0.0"; exit 0; fi\nexit 2\n',
  );
  // diffnav + delta are required; the checks only need the binaries on PATH.
  await writeShim(bin, "diffnav", "exit 0\n");
  await writeShim(bin, "delta", "exit 0\n");
  await writeShim(bin, "bun", "exit 0\n");
  if (input.harness === "codex") {
    await writeCodexShim(bin);
  }
  if (input.harness === "installable-codex") {
    await writeShim(
      bin,
      "sh",
      [
        'if [ "$1" = "-c" ] && [ "$2" = "curl -fsSL https://chatgpt.com/codex/install.sh | sh" ]; then',
        `  cat > ${shellQuote(join(bin, "codex"))} <<'EOF'`,
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "codex 0.1.0"; exit 0; fi',
        "exit 0",
        "EOF",
        `  chmod 700 ${shellQuote(join(bin, "codex"))}`,
        '  echo "fake codex installer ran"',
        "  exit 0",
        "fi",
        'echo "unexpected sh $*" >&2',
        "exit 2",
        "",
      ].join("\n"),
    );
  }

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    NO_COLOR: "1",
    STATION_WORKTRUNK_BIN: "wt",
    STATION_TMUX_BIN: "tmux",
    // Pin every non-target harness so the post-install re-probe (which now also
    // searches the brew prefix) can't pick up a real one from the dev machine.
    STATION_CODEX_BIN: input.harness === "missing" ? "/missing/codex" : "codex",
    STATION_CURSOR_AGENT_BIN: "/missing/agent",
    STATION_OPENCODE_BIN: "/missing/opencode",
    STATION_PI_BIN: "/missing/pi",
    STATION_CLAUDE_BIN: "/missing/claude",
  };

  return {
    root,
    home,
    repo,
    bin,
    configPath,
    env,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeCodexShim(bin: string): Promise<void> {
  await writeShim(
    bin,
    "codex",
    'if [ "$1" = "--version" ]; then echo "codex 0.1.0"; exit 0; fi\nexit 0\n',
  );
}

async function writeShim(bin: string, name: string, body: string): Promise<void> {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\n${body}`, "utf8");
  await chmod(path, 0o700);
}

type StationProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function runStation(
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    answers: readonly string[];
    timeoutMs?: number;
  },
): Promise<StationProcessResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  return new Promise((resolve) => {
    const child = spawn(join(process.cwd(), "bin", "stn"), [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let answerIndex = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      const promptCount = countPrompts(Buffer.concat(stdout).toString("utf8"));
      while (answerIndex < promptCount && answerIndex < options.answers.length) {
        child.stdin.write(`${options.answers[answerIndex]}\n`);
        answerIndex += 1;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    });
  });
}

function countPrompts(output: string): number {
  const confirms = output.match(/\[y\/N\] /g)?.length ?? 0;
  const selects = output.match(/\n> /g)?.length ?? 0;
  return confirms + selects;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
