import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createObserverClient } from "@station/protocol";
import { describe, expect, it } from "vitest";
import { waitForSocketClosed } from "../support/sockets";

const shellIntegrationMarker = "# Worktrunk shell integration";
const supportedShells = ["zsh", "bash"] as const;
type SupportedShell = (typeof supportedShells)[number];

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

  for (const shell of supportedShells) {
    it(`gives one optional recovery command when the active ${shell} rc file is missing`, async () => {
      const fixture = await createFixture({ harness: "codex", shell });
      const rcPath = shellRcPath(fixture.home, shell);
      try {
        const result = await runStation(["--config", fixture.configPath, "setup"], {
          cwd: fixture.repo,
          env: fixture.env,
          answers: ["n", "n", "n", "y", "y", "n"],
        });

        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(
          "Optional Worktrunk shell integration was not installed; core setup is complete.",
        );
        expect(result.stdout).toContain(`Active ${shell} rc file not found: ${rcPath}`);
        expect(result.stdout).toContain(
          `Run: touch ${rcPath} && wt -y config shell install ${shell}`,
        );
        expect(result.stdout).not.toContain("Failed: Install Worktrunk shell integration");
        expect(result.stdout).not.toContain("fake shell integration installed");
        expect(result.stdout).toContain("Core setup complete.");
        await expect(readFile(rcPath, "utf8")).rejects.toThrow();
        await expect(readFile(otherShellRcPath(fixture.home, shell), "utf8")).rejects.toThrow();
      } finally {
        await fixture.cleanup();
      }
    });

    it(`preserves an existing ${shell} rc file and does not duplicate integration`, async () => {
      const fixture = await createFixture({ harness: "codex", shell });
      const rcPath = shellRcPath(fixture.home, shell);
      const original = "# user shell config\nexport USER_SETTING=preserved\n";
      await writeFile(rcPath, original, "utf8");
      try {
        const first = await runStation(["--config", fixture.configPath, "setup"], {
          cwd: fixture.repo,
          env: fixture.env,
          answers: ["n", "n", "n", "y", "y", "n"],
        });
        const second = await runStation(["--config", fixture.configPath, "setup"], {
          cwd: fixture.repo,
          env: fixture.env,
          answers: ["n", "y", "n"],
        });

        expect(first.exitCode).toBe(0);
        expect(second.exitCode).toBe(0);
        expect(first.stdout).toContain(`Running: wt -y config shell install ${shell}`);
        expect(second.stdout).toContain(`Running: wt -y config shell install ${shell}`);
        const contents = await readFile(rcPath, "utf8");
        expect(contents.startsWith(original)).toBe(true);
        expect(contents.split(shellIntegrationMarker)).toHaveLength(2);
        await expect(readFile(otherShellRcPath(fixture.home, shell), "utf8")).rejects.toThrow();
      } finally {
        await fixture.cleanup();
      }
    });
  }

  it("does not create or modify shell files when integration is declined", async () => {
    const fixture = await createFixture({ harness: "codex", shell: "zsh" });
    const bashrc = shellRcPath(fixture.home, "bash");
    const existingBashrc = "# unrelated bash config\n";
    await writeFile(bashrc, existingBashrc, "utf8");
    try {
      const result = await runStation(["--config", fixture.configPath, "setup"], {
        cwd: fixture.repo,
        env: fixture.env,
        answers: ["n", "n", "n", "y", "n", "n"],
      });

      expect(result.exitCode).toBe(0);
      await expect(readFile(shellRcPath(fixture.home, "zsh"), "utf8")).rejects.toThrow();
      await expect(readFile(bashrc, "utf8")).resolves.toBe(existingBashrc);
      expect(result.stdout).not.toContain("fake shell integration installed");
      expect(result.stdout).not.toContain("Optional Worktrunk shell integration was not installed");
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
        // Prompt order: install codex (y), decline cursor/opencode/pi/claude,
        // decline Worktrunk-hooks + codex-hooks, accept Write config (y),
        // decline shell-integration + popup.
        answers: ["y", "n", "n", "n", "n", "n", "n", "y", "n", "n"],
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No supported agent CLI is available.");
      expect(result.stdout).toContain("Running: sh -c");
      expect(result.stdout).toContain("fake codex installer ran");
      expect(result.stdout).toContain("Install Worktrunk lifecycle hooks?");
      expect(result.stdout).toContain("Install Codex agent hooks?");
      expect(result.stdout).toContain("Applying: Write STATION config");
      expect(result.stdout).toContain("Core setup complete.");
      await expect(readFile(fixture.configPath, "utf8")).resolves.toContain("[harness.codex]");
    } finally {
      await fixture.cleanup();
    }
  });

  it("runs the persisted absolute popup launcher in a fresh minimal-PATH tmux context", async () => {
    const fixture = await createFixture({ harness: "codex", launchers: "complex" });
    try {
      const result = await runStation(["--config", fixture.configPath, "setup"], {
        cwd: fixture.repo,
        env: fixture.env,
        // Decline Worktrunk and Codex hooks, write config, decline shell integration,
        // then accept the popup binding.
        answers: ["n", "n", "y", "n", "y"],
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "Tmux popup binding: Ctrl-b Space is persisted for future tmux servers; no current server was live-loaded.",
      );
      expect(result.stdout).toContain("Direct fallback: stn popup");

      const tmuxConfigPath = join(fixture.home, ".tmux.conf");
      const tmuxConfig = await readFile(tmuxConfigPath, "utf8");
      expect(tmuxConfig).toContain("bind-key Space run-shell -b");
      expect(tmuxConfig).not.toContain("STATION_FOCUS_CLIENT_ID=#{q:client_name} stn-tmux-popup");

      const freshTmux = spawnSync(
        "/bin/sh",
        [
          "-c",
          [
            "set -eu",
            "bind_key() {",
            '  [ "$#" -eq 4 ]',
            '  [ "$1 $2 $3" = "Space run-shell -b" ]',
            '  PATH=/usr/bin:/bin /bin/sh -c "$4"',
            "}",
            "alias bind-key=bind_key",
            '. "$1"',
          ].join("\n"),
          "fresh-tmux",
          tmuxConfigPath,
        ],
        {
          cwd: fixture.repo,
          encoding: "utf8",
          env: {
            HOME: fixture.home,
            PATH: "/usr/bin:/bin",
            STATION_POPUP_TEST_MARKER: fixture.popupMarker,
          },
        },
      );

      expect(freshTmux.status, freshTmux.stderr).toBe(0);
      expect(await readFile(fixture.popupMarker, "utf8")).toBe(
        "/usr/bin:/bin\ntmux\n#{q:client_name}\n",
      );
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
  popupMarker: string;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
};

async function createFixture(input: {
  harness: HarnessMode;
  launchers?: "complex";
  shell?: SupportedShell;
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "station-setup-guided-feedback-"));
  const runtimeDir = await mkdtemp(join(tmpdir(), "stn-setup-run-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const launcherBin = input.launchers === "complex" ? join(root, "installed path's bin") : bin;
  const popupMarker = join(root, "popup-ran.txt");
  const configPath = join(home, ".config", "station", "config.toml");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(launcherBin, { recursive: true });
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
      '  if [ "$#" -ge 5 ]; then',
      '    case "$5" in',
      '      zsh) rc="$HOME/.zshrc" ;;',
      '      bash) rc="$HOME/.bashrc" ;;',
      '      *) echo "unexpected shell $5" >&2; exit 2 ;;',
      "    esac",
      '    if [ ! -f "$rc" ]; then echo "No shell config file found" >&2; exit 1; fi',
      `    marker=${shellQuote(shellIntegrationMarker)}`,
      '    grep -F -x "$marker" "$rc" >/dev/null 2>&1 || printf "\\n%s\\n" "$marker" >> "$rc"',
      "  fi",
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
  await writeShim(bin, "npm", "echo 0.1.0\n");
  if (input.harness === "codex") {
    await writeCodexShim(bin);
  }
  if (input.launchers === "complex") {
    await writeShim(launcherBin, "stn", "exit 0\n");
    await writeShim(launcherBin, "stn-ingress", "exit 0\n");
    await writeShim(
      launcherBin,
      "stn-tmux-popup",
      [
        'test -n "$STATION_POPUP_TEST_MARKER"',
        'printf "%s\\n" "$PATH" > "$STATION_POPUP_TEST_MARKER"',
        'printf "%s\\n" "$STATION_FOCUS_PROVIDER" >> "$STATION_POPUP_TEST_MARKER"',
        'printf "%s\\n" "$STATION_FOCUS_CLIENT_ID" >> "$STATION_POPUP_TEST_MARKER"',
        "",
      ].join("\n"),
    );
  }
  if (input.harness === "installable-codex") {
    await writeShim(bin, "stn", "exit 0\n");
    await writeShim(bin, "stn-ingress", "exit 0\n");
    await writeShim(bin, "stn-tmux-popup", "exit 0\n");
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
    XDG_RUNTIME_DIR: runtimeDir,
    PATH: `${launcherBin}:${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
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
  if (input.shell !== undefined) env.SHELL = `/bin/${input.shell}`;

  return {
    root,
    home,
    repo,
    bin,
    configPath,
    popupMarker,
    env,
    async cleanup() {
      try {
        await stopObservers([
          join(runtimeDir, "station", "observer.sock"),
          join(home, ".local", "state", "station", "observer.sock"),
        ]);
      } finally {
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(runtimeDir, { recursive: true, force: true }),
        ]);
      }
    },
  };
}

function shellRcPath(home: string, shell: SupportedShell): string {
  return join(home, shell === "zsh" ? ".zshrc" : ".bashrc");
}

function otherShellRcPath(home: string, shell: SupportedShell): string {
  return shellRcPath(home, shell === "zsh" ? "bash" : "zsh");
}

async function stopObservers(socketPaths: readonly string[]): Promise<void> {
  const results = await Promise.allSettled(
    socketPaths.map(async (socketPath) => {
      const client = createObserverClient({ socketPath, timeoutMs: 1_000 });
      await client.stop().catch(() => undefined);
      await waitForSocketClosed(socketPath, { timeoutMs: 5_000 });
    }),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
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
  const timeoutMs = options.timeoutMs ?? 15_000;
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
