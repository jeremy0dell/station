import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@station/config";
import { afterEach, describe, expect, it } from "vitest";

type TuiDevScript = {
  installTuiDevHooks: (
    runtime: { configPath?: string; env: Record<string, string>; generated: boolean },
    runCommand?: (
      command: string,
      args: string[],
      options: { env: Record<string, string>; cwd: string },
    ) => { status?: number; stdout?: string; stderr?: string },
  ) => void;
  prepareTuiDevRuntime: (input: {
    argv?: string[];
    env?: Record<string, string>;
    root?: string;
  }) => Promise<{
    argv: string[];
    env: Record<string, string>;
    configPath?: string;
    generated: boolean;
  }>;
  tuiDevObserverSocketPath: (root: string) => string;
};

const tempRoots: string[] = [];

async function loadScript(): Promise<TuiDevScript> {
  return (await import("../../../../scripts/tui-dev.mjs")) as TuiDevScript;
}

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("tui-dev launcher runtime", () => {
  it("generates a worktree-local observer config by default", async () => {
    const root = await tempDir("station-tui-dev-root-");
    const home = await tempDir("station-tui-dev-home-");
    const configDir = join(home, ".config", "station");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.toml"),
      [
        "schema_version = 1",
        "projects = []",
        "",
        "[observer]",
        'socket_path = "~/.local/state/station/observer.sock"',
        'state_dir = "~/.local/state/station"',
        "",
        "[defaults]",
        'worktree_provider = "worktrunk"',
        'terminal = "tmux"',
        'harness = "codex"',
        'layout = "agent-shell"',
        "",
      ].join("\n"),
      "utf8",
    );

    const { prepareTuiDevRuntime, tuiDevObserverSocketPath } = await loadScript();
    const runtime = await prepareTuiDevRuntime({ argv: ["tui"], env: { HOME: home }, root });
    const configPath = join(root, ".dev-state", "tui-dev", "config.toml");
    const stateDir = join(root, ".dev-state", "tui-dev", "observer");
    const socketPath = tuiDevObserverSocketPath(root);

    expect(runtime).toMatchObject({
      argv: ["--config", configPath, "tui"],
      configPath,
      generated: true,
      env: {
        STATION_CONFIG_PATH: configPath,
        STATION_OBSERVER_SOCKET_PATH: socketPath,
      },
    });
    await expect(readFile(configPath, "utf8")).resolves.toContain(
      `socket_path = ${JSON.stringify(socketPath)}`,
    );
    expect(socketPath.startsWith(root)).toBe(false);
    expect(socketPath.length).toBeLessThan(104);
    await expect(readFile(configPath, "utf8")).resolves.toContain(
      `state_dir = ${JSON.stringify(stateDir)}`,
    );
    await expect(readFile(configPath, "utf8")).resolves.toContain('terminal = "noop-terminal"');
    for (const section of ["codex", "claude", "cursor", "opencode"]) {
      await expect(readFile(configPath, "utf8")).resolves.toContain(`[harness.${section}]`);
    }
    expect(runtime.env.CODEX_HOME).toBe(join(root, ".dev-state", "tui-dev", "codex-home"));
    expect(runtime.env.CLAUDE_CONFIG_DIR).toBe(join(root, ".dev-state", "tui-dev", "claude-home"));
    expect(runtime.env.STATION_CURSOR_HOME).toBe(
      join(root, ".dev-state", "tui-dev", "cursor-home"),
    );
    expect(runtime.env.OPENCODE_CONFIG_DIR).toBe(
      join(root, ".dev-state", "tui-dev", "opencode-config"),
    );
  });

  it("writes generated config that loads through the real config loader", async () => {
    const root = await tempDir("station-tui-dev-root-");
    const home = await tempDir("station-tui-dev-home-");
    const configDir = join(home, ".config", "station");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.toml"),
      [
        "schema_version = 1",
        "projects = []",
        "",
        "[observer]",
        'socket_path = "~/.local/state/station/observer.sock"',
        'state_dir = "~/.local/state/station"',
        "",
        "[defaults]",
        'worktree_provider = "worktrunk"',
        'terminal = "tmux"',
        'harness = "codex"',
        'layout = "agent-shell"',
        "",
      ].join("\n"),
      "utf8",
    );

    const { prepareTuiDevRuntime, tuiDevObserverSocketPath } = await loadScript();
    const runtime = await prepareTuiDevRuntime({ argv: ["tui"], env: { HOME: home }, root });
    if (runtime.configPath === undefined) throw new Error("expected generated config path");

    const loaded = await loadConfig({ configPath: runtime.configPath, homeDir: home });

    expect(loaded.config.observer).toMatchObject({
      socketPath: tuiDevObserverSocketPath(root),
      stateDir: join(root, ".dev-state", "tui-dev", "observer"),
    });
    expect(loaded.config.defaults.terminal).toBe("noop-terminal");
    expect(loaded.config.featureFlags?.stationPersistentAgents).toBe(true);
    expect(loaded.config.harness?.codex?.installHooks).toBe(true);
    expect(loaded.config.harness?.claude?.installHooks).toBe(true);
    expect(loaded.config.harness?.cursor?.installHooks).toBe(true);
    expect(loaded.config.harness?.opencode?.installHooks).toBe(true);
  });

  it("keeps generated socket paths short for long worktree roots", async () => {
    const parent = await tempDir("station-tui-dev-root-");
    const root = join(parent, "nested", "a".repeat(90), "checkout");
    const home = await tempDir("station-tui-dev-home-");
    await mkdir(root, { recursive: true });

    const { prepareTuiDevRuntime, tuiDevObserverSocketPath } = await loadScript();
    const runtime = await prepareTuiDevRuntime({ argv: ["tui"], env: { HOME: home }, root });
    const socketPath = tuiDevObserverSocketPath(root);

    expect(runtime.env.STATION_OBSERVER_SOCKET_PATH).toBe(socketPath);
    expect(socketPath.startsWith(root)).toBe(false);
    expect(socketPath.length).toBeLessThan(104);
  });

  it("expands inline harness tables before forcing isolated hook install", async () => {
    const root = await tempDir("station-tui-dev-root-");
    const home = await tempDir("station-tui-dev-home-");
    const configDir = join(home, ".config", "station");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.toml"),
      [
        "schema_version = 1",
        "projects = []",
        "",
        "  [observer] # local dev",
        'socket_path = "~/.local/state/station/observer.sock"',
        'state_dir = "~/.local/state/station"',
        "",
        "[defaults]",
        'worktree_provider = "worktrunk"',
        'terminal = "tmux"',
        'harness = "codex"',
        'layout = "agent-shell"',
        "",
        "[harness]",
        'codex = { command = "codex-dev", install_hooks = false }',
        "",
      ].join("\n"),
      "utf8",
    );

    const { prepareTuiDevRuntime } = await loadScript();
    const runtime = await prepareTuiDevRuntime({ argv: ["tui"], env: { HOME: home }, root });
    if (runtime.configPath === undefined) throw new Error("expected generated config path");

    const config = await readFile(runtime.configPath, "utf8");
    expect(config).not.toContain("codex = {");
    expect(config).toContain("[harness.codex]");
    expect(config).toContain('command = "codex-dev"');
    expect(config).toContain("install_hooks = true");

    const loaded = await loadConfig({ configPath: runtime.configPath, homeDir: home });
    expect(loaded.config.harness?.codex?.command).toBe("codex-dev");
    expect(loaded.config.harness?.codex?.installHooks).toBe(true);
  });

  it("seeds Cursor isolated HOME with git identity links", async () => {
    const root = await tempDir("station-tui-dev-root-");
    const home = await tempDir("station-tui-dev-home-");
    await mkdir(join(home, ".ssh"), { recursive: true });
    await mkdir(join(home, ".config", "git"), { recursive: true });
    await writeFile(join(home, ".gitconfig"), "[user]\n  name = Dev\n", "utf8");
    await writeFile(join(home, ".git-credentials"), "https://example.invalid\n", "utf8");
    await writeFile(join(home, ".ssh", "config"), "Host *\n", "utf8");
    await writeFile(join(home, ".config", "git", "config"), "[safe]\n", "utf8");

    const { prepareTuiDevRuntime } = await loadScript();
    const runtime = await prepareTuiDevRuntime({ argv: ["tui"], env: { HOME: home }, root });
    const cursorHome = runtime.env.STATION_CURSOR_HOME;
    if (cursorHome === undefined) throw new Error("expected Cursor home");

    for (const [target, source] of [
      [join(cursorHome, ".gitconfig"), join(home, ".gitconfig")],
      [join(cursorHome, ".git-credentials"), join(home, ".git-credentials")],
      [join(cursorHome, ".ssh"), join(home, ".ssh")],
      [join(cursorHome, ".config", "git"), join(home, ".config", "git")],
    ]) {
      const stats = await lstat(target);
      expect(stats.isSymbolicLink()).toBe(true);
      await expect(readlink(target)).resolves.toBe(source);
    }
  });

  it("respects explicit config choices", async () => {
    const { prepareTuiDevRuntime } = await loadScript();

    await expect(
      prepareTuiDevRuntime({
        argv: ["--config", "/tmp/custom.toml", "tui"],
        env: {},
        root: "/tmp/repo",
      }),
    ).resolves.toMatchObject({
      argv: ["--config", "/tmp/custom.toml", "tui"],
      configPath: "/tmp/custom.toml",
      generated: false,
      env: { STATION_CONFIG_PATH: "/tmp/custom.toml" },
    });

    await expect(
      prepareTuiDevRuntime({
        argv: ["tui"],
        env: { STATION_CONFIG_PATH: "/tmp/env.toml" },
        root: "/tmp/repo",
      }),
    ).resolves.toMatchObject({
      argv: ["--config", "/tmp/env.toml", "tui"],
      configPath: "/tmp/env.toml",
      generated: false,
    });
  });

  it("scrubs generated dev env when an explicit config is selected", async () => {
    const { prepareTuiDevRuntime } = await loadScript();
    const root = "/tmp/repo";
    const generatedRoot = join(root, ".dev-state", "tui-dev");

    const runtime = await prepareTuiDevRuntime({
      argv: ["--config", "/tmp/custom.toml", "tui"],
      env: {
        STATION_CONFIG_PATH: "/tmp/stale.toml",
        STATION_OBSERVER_SOCKET_PATH: "/tmp/stale.sock",
        CODEX_HOME: join(generatedRoot, "codex-home"),
        CLAUDE_CONFIG_DIR: "/tmp/intentional-claude-home",
      },
      root,
    });

    expect(runtime).toMatchObject({
      argv: ["--config", "/tmp/custom.toml", "tui"],
      configPath: "/tmp/custom.toml",
      generated: false,
      env: {
        STATION_CONFIG_PATH: "/tmp/custom.toml",
        CLAUDE_CONFIG_DIR: "/tmp/intentional-claude-home",
      },
    });
    expect(runtime.env.STATION_OBSERVER_SOCKET_PATH).toBeUndefined();
    expect(runtime.env.CODEX_HOME).toBeUndefined();
  });

  it("installs supported isolated harness hooks", async () => {
    const { installTuiDevHooks } = await loadScript();
    const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const env = {
      CODEX_HOME: "/tmp/codex-home",
      CLAUDE_CONFIG_DIR: "/tmp/claude-home",
      STATION_CURSOR_HOME: "/tmp/cursor-home",
      OPENCODE_CONFIG_DIR: "/tmp/opencode-config",
    };

    installTuiDevHooks(
      { configPath: "/tmp/station.toml", env, generated: true },
      (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return { status: 0 };
      },
    );

    expect(calls.map((call) => call.args.slice(-2, -1)[0])).toEqual([
      "codex",
      "claude",
      "cursor",
      "opencode",
    ]);
    for (const call of calls) {
      expect(call.args).toEqual([
        expect.any(String),
        "--config",
        "/tmp/station.toml",
        "hooks",
        "install",
        expect.any(String),
        "--yes",
      ]);
      expect(call.env).toBe(env);
    }
  });
});
