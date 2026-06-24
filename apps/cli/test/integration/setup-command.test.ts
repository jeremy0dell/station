import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runCli } from "@station/cli";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { afterEach, describe, expect, it } from "vitest";

describe("CLI setup command", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("returns deterministic JSON for setup check without loading observer config", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];

    const result = await runCli(
      ["--config", join(root, "missing.toml"), "setup", "check", "--json"],
      {
        setupDeps: {
          cwd: repo,
          homeDir: join(root, "home"),
          env: { PATH: "/fake/bin" },
          runner: fakeRunner(calls, {
            "git rev-parse --show-toplevel": repo,
            "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
            "wt --version": "worktrunk 1.2.3\n",
            "tmux -V": "tmux 3.5a\n",
            "codex --version": "codex 0.1.0\n",
          }),
          access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux"]),
          fs: readOnlyFs({}),
          now: () => new Date("2026-06-08T12:00:00.000Z"),
        },
      },
    );

    expect(result.code).toBe(1);
    expect(result.output).toMatchObject({
      generatedAt: "2026-06-08T12:00:00.000Z",
      mode: "check",
      summary: {
        requiredOk: false,
        selectedHarness: "codex",
        configPath: join(root, "missing.toml"),
      },
    });
    expect(calls.map((call) => call.command)).not.toContain("gh");
  });

  it("setup plan is read-only and includes a config write action", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const chunks: string[] = [];

    const result = await runCli(["--config", join(root, "config.toml"), "setup", "plan"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "brew --version": "Homebrew 4.0.0\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux"]),
        fs: readOnlyFs({}),
        writeStdout: (chunk) => chunks.push(chunk),
      },
    });

    expect(result).toEqual({ code: 0 });
    expect(chunks.join("")).toContain("Write STATION config");
  });

  it("setup apply --dry-run performs no writes or external installs", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs({});

    const result = await runCli(
      ["--config", join(root, "config.toml"), "setup", "apply", "--dry-run"],
      {
        setupDeps: {
          cwd: repo,
          homeDir: join(root, "home"),
          env: { PATH: "/fake/bin" },
          runner: fakeRunner(calls, {
            "git rev-parse --show-toplevel": repo,
            "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
            "wt --version": "worktrunk 1.2.3\n",
            "tmux -V": "tmux 3.5a\n",
            "brew --version": "Homebrew 4.0.0\n",
            "codex --version": "codex 0.1.0\n",
          }),
          access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux"]),
          fs,
          writeStdout: () => undefined,
        },
      },
    );

    expect(result.code).toBe(0);
    expect(Object.keys(fs.files)).toEqual([]);
    expect(calls.some((call) => call.command === "brew" && call.args?.[0] === "install")).toBe(
      false,
    );
  });

  it("rejects bare setup --dry-run without writing files", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});

    const result = await runCli(["--config", join(root, "config.toml"), "setup", "--dry-run"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        fs,
        writeStdout: () => undefined,
      },
    });

    expect(result.code).toBe(2);
    expect(Object.keys(fs.files)).toEqual([]);
  });

  it("setup check --json exits non-zero for invalid existing config", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });

    const result = await runCli(["--config", configPath, "setup", "check", "--json"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux"]),
        fs: readOnlyFs({ [configPath]: "schema_version = 1\n[defaults\n" }),
      },
    });

    expect(result.code).toBe(1);
    expect(result.output).toMatchObject({
      summary: { requiredOk: false },
    });
  });

  it("setup system reports incompatible development toolchain versions without changing them", async () => {
    const root = await tempRoot(tempRoots);
    const chunks: string[] = [];

    const result = await runCli(["setup", "system", "--check"], {
      setupDeps: {
        cwd: root,
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "brew --version": "Homebrew 4.0.0\n",
          "pnpm --version": "8.15.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux"]),
        writeStdout: (chunk) => chunks.push(chunk),
      },
    });

    const output = chunks.join("");
    expect(result.code).toBe(1);
    expect(output).toContain("incompatible pnpm 8.15.0 (expected 11.x)");
    expect(output).toContain("corepack prepare pnpm@11.0.0 --activate");
    expect(output).toContain("STATION setup does not change Node or pnpm automatically.");
  });

  it("setup system --check --yes is invalid and performs no install calls", async () => {
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];

    const result = await runCli(["setup", "system", "--check", "--yes"], {
      setupDeps: {
        runner: fakeRunner(calls, {}),
        writeStdout: (chunk) => chunks.push(chunk),
      },
    });

    expect(result.code).toBe(2);
    expect(chunks.join("")).toContain("cannot use --check and --yes together");
    expect(calls).toEqual([]);
  });

  it("setup system --yes rechecks after fake installs and returns refreshed readiness", async () => {
    const root = await tempRoot(tempRoots);
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];
    const available = new Set<string>();

    const result = await runCli(["setup", "system", "--yes"], {
      setupDeps: {
        cwd: root,
        env: { PATH: "/fake/bin" },
        runner: async (input) => {
          calls.push(input);
          const key = `${input.command} ${(input.args ?? []).join(" ")}`;
          if (key === "brew install worktrunk") {
            available.add("/fake/bin/wt");
            return commandResult(input, "");
          }
          if (key === "brew install tmux") {
            available.add("/fake/bin/tmux");
            return commandResult(input, "");
          }
          return fakeRunner([], {
            "brew --version": "Homebrew 4.0.0\n",
            "pnpm --version": "11.0.0\n",
            "wt --version": "worktrunk 1.2.3\n",
            "tmux -V": "tmux 3.5a\n",
          })(input);
        },
        access: async (path) => {
          if (!available.has(path)) {
            throw Object.assign(new Error(`missing path: ${path}`), { code: "ENOENT" });
          }
        },
        writeStdout: (chunk) => chunks.push(chunk),
      },
    });

    expect(result.code).toBe(0);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "brew", args: ["install", "worktrunk"] }),
        expect.objectContaining({ command: "brew", args: ["install", "tmux"] }),
        expect.objectContaining({ command: "/fake/bin/wt", args: ["--version"] }),
        expect.objectContaining({ command: "/fake/bin/tmux", args: ["-V"] }),
      ]),
    );
    expect(chunks.join("")).toContain("stn setup system final");
    expect(chunks.join("")).toContain("ok Worktrunk / wt");
  });
});

async function tempRoot(tempRoots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-setup-cli-"));
  tempRoots.push(root);
  return root;
}

function fakeRunner(
  calls: ExternalCommandInput[],
  outputs: Record<string, string>,
): (input: ExternalCommandInput) => Promise<ExternalCommandResult> {
  return async (input) => {
    calls.push(input);
    const key = `${input.command} ${(input.args ?? []).join(" ")}`;
    const stdout = outputs[key] ?? fakeBinOutput(input, outputs);
    if (stdout === undefined) {
      throw Object.assign(new Error(`missing fake command: ${key}`), { code: "ENOENT" });
    }
    return {
      command: input.command,
      args: input.args ?? [],
      stdout,
      stderr: "",
      exitCode: 0,
    };
  };
}

function fakeBinOutput(
  input: ExternalCommandInput,
  outputs: Record<string, string>,
): string | undefined {
  if (!input.command.startsWith("/fake/bin/")) {
    return undefined;
  }
  return outputs[`${basename(input.command)} ${(input.args ?? []).join(" ")}`];
}

function commandResult(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}

function fakeAccess(paths: readonly string[]): (path: string) => Promise<void> {
  const available = new Set(paths);
  return async (path) => {
    if (!available.has(path)) {
      throw Object.assign(new Error(`missing path: ${path}`), { code: "ENOENT" });
    }
  };
}

function readOnlyFs(files: Record<string, string>) {
  return {
    async readFile(path: string) {
      const source = files[path];
      if (source === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return source;
    },
  };
}

function fakeFs(initial: Record<string, string>) {
  const files = { ...initial };
  return {
    files,
    async mkdir() {
      return undefined;
    },
    async readFile(path: string) {
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return content;
    },
    async writeFile(path: string, content: string) {
      files[path] = content;
    },
    async rename(from: string, to: string) {
      const content = files[from];
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files[to] = content;
      delete files[from];
    },
    async access(path: string) {
      if (files[path] === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
}
