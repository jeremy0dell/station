import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyConfig, loadConfigFromToml, resolveObserverPaths } from "@station/config";
import { afterEach, describe, expect, it } from "vitest";
import { planSetupConfigWrite } from "../../src/commands/setup/configWriter.js";
import type { SetupFacts } from "../../src/commands/setup/model.js";

describe("setup config writer", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("generates new config TOML that parses through the config loader", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const facts = setupFacts(repo, {
      config: {
        status: "missing",
        path: join(root, "config.toml"),
        message: "missing",
      },
    });

    const write = await planSetupConfigWrite(facts);

    expect(write.operation).toBe("create");
    if (write.operation !== "create") throw new Error("expected create plan");
    expect(write.content).not.toMatch(/^socket_path\s*=/m);
    const loaded = await loadConfigFromToml(write.content, {
      configPath: write.path,
      homeDir: root,
    });
    expect(loaded.config.defaults).toMatchObject({
      worktreeProvider: "worktrunk",
      terminal: "tmux",
      harness: "codex",
    });
    expect(loaded.config.defaults.defaultBranch).toBeUndefined();
    expect(loaded.config.worktree?.worktrunk?.base).toBeUndefined();
    expect(loaded.config.projects).toEqual([]);
  });

  it("keeps generated config on the first-run observer socket", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const write = await planSetupConfigWrite(
      setupFacts(repo, {
        config: {
          status: "missing",
          path: join(root, "config.toml"),
          message: "missing",
        },
      }),
    );

    expect(write.operation).toBe("create");
    if (write.operation !== "create") throw new Error("expected create plan");
    const loaded = await loadConfigFromToml(write.content, {
      configPath: write.path,
      homeDir: root,
    });
    const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;

    try {
      for (const runtimeDir of [undefined, join(root, "runtime")]) {
        if (runtimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = runtimeDir;

        expect(resolveObserverPaths(loaded.config, root).socketPath).toBe(
          resolveObserverPaths(emptyConfig(), root).socketPath,
        );
      }
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    }
  });

  it("writes hook flags when guided setup accepts hooks", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const facts = setupFacts(repo, {
      config: {
        status: "missing",
        path: join(root, "config.toml"),
        message: "missing",
      },
    });

    const write = await planSetupConfigWrite(facts, {
      installWorktrunkHooks: true,
      installHarnessHooks: ["codex"],
    });

    expect(write.operation).toBe("create");
    if (write.operation !== "create") throw new Error("expected create plan");
    expect(write.content).toContain("use_lifecycle_hooks = true");
    expect(write.content).toContain('hook_mode = "required-for-mvp"');
    expect(write.content).toContain("install_hooks = true");
  });

  it("writes every selected harness while preserving the first as the default", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const facts = setupFacts(repo, {
      harnesses: [
        { id: "codex", label: "Codex", status: "ok", command: "codex" },
        { id: "opencode", label: "OpenCode", status: "ok", command: "opencode" },
      ],
      config: {
        status: "missing",
        path: join(root, "config.toml"),
        message: "missing",
      },
    });

    const write = await planSetupConfigWrite(facts, {
      harnessSelection: {
        defaultHarness: "codex",
        selected: facts.harnesses,
      },
      installHarnessHooks: ["codex"],
    });

    expect(write.operation).toBe("create");
    if (write.operation !== "create") throw new Error("expected create plan");
    const loaded = await loadConfigFromToml(write.content, {
      configPath: write.path,
      homeDir: root,
    });
    expect(loaded.config.defaults.harness).toBe("codex");
    expect(Object.keys(loaded.config.harness ?? {})).toEqual(["codex", "opencode"]);
    expect(loaded.config.harness?.codex?.installHooks).toBe(true);
    expect(loaded.config.harness?.opencode?.installHooks).toBeUndefined();
  });

  it("appends only a missing harness block to a valid existing config", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const otherRepo = join(root, "other");
    await mkdir(repo, { recursive: true });
    await mkdir(otherRepo, { recursive: true });
    const source = existingConfigToml(root, { projectRoot: otherRepo });
    const facts = setupFacts(repo, {
      config: {
        status: "valid",
        path: join(root, "config.toml"),
        source,
        hasProjectForRoot: false,
        configuredHarnesses: [],
        configuredHookHarnesses: [],
        defaults: {
          worktreeProvider: "worktrunk",
          terminal: "tmux",
          harness: "codex",
        },
      },
    });

    const write = await planSetupConfigWrite(facts);

    expect(write).toMatchObject({
      operation: "update",
      path: join(root, "config.toml"),
    });
    if (write.operation !== "update") throw new Error("expected update plan");
    expect(write.content.startsWith(source.trimEnd())).toBe(true);
    expect(write.content).toContain("[harness.codex]");
    expect(write.content.match(/\[\[projects\]\]/g)).toHaveLength(1);
    expect(write.content.match(/\[defaults\]/g)).toHaveLength(1);
  });

  it("creates a zero-project config when setup is run outside a repository", async () => {
    const root = await tempRoot(tempRoots);
    const facts = setupFacts(root, {
      git: {
        status: "missing",
        reason: "not-a-repo",
        defaultBranch: "main",
        message: "Choose a project after setup.",
      },
      config: {
        status: "missing",
        path: join(root, "config.toml"),
        message: "missing",
      },
    });

    const write = await planSetupConfigWrite(facts);

    expect(write.operation).toBe("create");
    if (write.operation !== "create") throw new Error("expected create plan");
    const loaded = await loadConfigFromToml(write.content, {
      configPath: write.path,
      homeDir: root,
    });
    expect(loaded.config.projects).toEqual([]);
    expect(write.content).toContain("projects = []");
    expect(write.content).not.toContain("[[projects]]");
  });

  it("keeps zero-project config independent of an ancestor repository's default branch", async () => {
    const root = await tempRoot(tempRoots);
    const config = {
      status: "missing" as const,
      path: join(root, "config.toml"),
      message: "missing",
    };
    const outsideRepo = await planSetupConfigWrite(
      setupFacts(root, {
        git: {
          status: "missing",
          reason: "not-a-repo",
          defaultBranch: "main",
          message: "Choose a project after setup.",
        },
        config,
      }),
    );
    const insideTrunkRepo = await planSetupConfigWrite(
      setupFacts(join(root, "ancestor"), {
        git: {
          status: "ok",
          root: join(root, "ancestor"),
          repoName: "ancestor",
          defaultBranch: "trunk",
        },
        config,
      }),
    );

    expect(outsideRepo.operation).toBe("create");
    expect(insideTrunkRepo.operation).toBe("create");
    if (outsideRepo.operation !== "create" || insideTrunkRepo.operation !== "create") {
      throw new Error("expected create plans");
    }
    expect(insideTrunkRepo.content).toBe(outsideRepo.content);
    expect(insideTrunkRepo.content).not.toContain("default_branch =");
    expect(insideTrunkRepo.content).not.toContain("base =");
    expect(insideTrunkRepo.content).not.toContain('default_branch = "trunk"');
    expect(insideTrunkRepo.content).not.toContain('base = "trunk"');
  });

  it("does not plan broad rewrites for an already-covered config", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const source = existingConfigToml(root, { projectRoot: repo, includeHarness: true });
    const facts = setupFacts(repo, {
      config: {
        status: "valid",
        path: join(root, "config.toml"),
        source,
        hasProjectForRoot: true,
        configuredHarnesses: ["codex"],
        configuredHookHarnesses: [],
        defaults: {
          worktreeProvider: "worktrunk",
          terminal: "tmux",
          harness: "codex",
        },
        matchedProject: {
          id: "repo",
          worktreeProvider: "worktrunk",
          worktrunkEnabled: true,
          terminal: "tmux",
          harness: "codex",
        },
      },
    });

    await expect(planSetupConfigWrite(facts)).resolves.toEqual({
      operation: "none",
      reason: "Config already includes the selected harness and core defaults.",
    });
  });

  it("enables hooks in an existing harness while appending another hook-enabled provider", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const source = existingConfigToml(root, { projectRoot: repo, includeHarness: true }).replace(
      'command = "codex"\n',
      'command = "codex"\ninstall_hooks = false # enable during setup\n',
    );
    const facts = setupFacts(repo, {
      harnesses: [
        { id: "codex", label: "Codex", status: "ok", command: "codex" },
        { id: "opencode", label: "OpenCode", status: "ok", command: "opencode" },
      ],
      config: {
        status: "valid",
        path: join(root, "config.toml"),
        source,
        observerStateDir: join(root, "state"),
        hasProjectForRoot: false,
        configuredHarnesses: ["codex"],
        configuredHookHarnesses: [],
        defaults: {
          worktreeProvider: "worktrunk",
          terminal: "tmux",
          harness: "codex",
        },
      },
    });

    const write = await planSetupConfigWrite(facts, {
      harnessSelection: {
        defaultHarness: "codex",
        selected: facts.harnesses,
      },
      installHarnessHooks: ["codex", "opencode"],
    });

    expect(write.operation).toBe("update");
    if (write.operation !== "update") throw new Error("expected update plan");
    expect(write.content.match(/\[harness\.codex\]/g)).toHaveLength(1);
    expect(write.content.match(/\[harness\.opencode\]/g)).toHaveLength(1);
    expect(write.content.match(/install_hooks = true/g)).toHaveLength(2);
    expect(write.content).toContain("install_hooks = true # enable during setup");
    expect(write.content).not.toContain("install_hooks = false # enable during setup");
    expect(write.content).toContain(
      '[defaults]\nworktree_provider = "worktrunk"\nterminal = "tmux"\nharness = "codex"',
    );
    const loaded = await loadConfigFromToml(write.content, {
      configPath: write.path,
      homeDir: root,
    });
    expect(loaded.config.harness?.codex?.installHooks).toBe(true);
    expect(loaded.config.harness?.opencode?.installHooks).toBe(true);

    await expect(
      planSetupConfigWrite(
        {
          ...facts,
          config: {
            ...facts.config,
            source: write.content,
            configuredHarnesses: ["codex", "opencode"],
            configuredHookHarnesses: ["codex", "opencode"],
          },
        },
        {
          harnessSelection: {
            defaultHarness: "codex",
            selected: facts.harnesses,
          },
          installHarnessHooks: ["opencode"],
        },
      ),
    ).resolves.toEqual({
      operation: "none",
      reason: "Config already includes the selected harnesses and core defaults.",
    });
  });

  it("preserves an existing available default that was not selected", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const source = existingConfigToml(root, { projectRoot: repo, includeHarness: true });
    const write = await planSetupConfigWrite(
      setupFacts(repo, {
        harnesses: [
          { id: "codex", label: "Codex", status: "ok", command: "codex" },
          { id: "pi", label: "Pi", status: "ok", command: "pi" },
        ],
        config: {
          status: "valid",
          path: join(root, "config.toml"),
          source,
          hasProjectForRoot: false,
          configuredHarnesses: ["codex"],
          configuredHookHarnesses: [],
          defaults: {
            worktreeProvider: "worktrunk",
            terminal: "tmux",
            harness: "codex",
          },
        },
      }),
      {
        harnessSelection: {
          defaultHarness: "codex",
          selected: [{ id: "pi", label: "Pi", status: "ok", command: "pi" }],
        },
      },
    );

    expect(write.operation).toBe("update");
    if (write.operation !== "update") throw new Error("expected update plan");
    expect(write.content).toContain('harness = "codex"');
    expect(write.content.match(/\[harness\.codex\]/g)).toHaveLength(1);
    expect(write.content.match(/\[harness\.pi\]/g)).toHaveLength(1);
  });

  it("preserves an unavailable existing default while appending an available provider", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const source = existingConfigToml(root, { projectRoot: repo, includeHarness: true });
    const facts = setupFacts(repo, {
      harnesses: [
        { id: "codex", label: "Codex", status: "missing", command: "codex" },
        { id: "pi", label: "Pi", status: "ok", command: "pi" },
      ],
      config: {
        status: "valid",
        path: join(root, "config.toml"),
        source,
        hasProjectForRoot: false,
        configuredHarnesses: ["codex"],
        configuredHookHarnesses: [],
        defaults: {
          worktreeProvider: "worktrunk",
          terminal: "tmux",
          harness: "codex",
        },
      },
    });

    const write = await planSetupConfigWrite(facts, {
      harnessSelection: {
        defaultHarness: "codex",
        selected: [{ id: "pi", label: "Pi", status: "ok", command: "pi" }],
      },
    });

    expect(write.operation).toBe("update");
    if (write.operation !== "update") throw new Error("expected update plan");
    expect(write.content.startsWith(source.trimEnd())).toBe(true);
    expect(write.content).toContain('harness = "codex"');
    expect(write.content.match(/\[harness\.codex\]/g)).toHaveLength(1);
    expect(write.content.match(/\[harness\.pi\]/g)).toHaveLength(1);
  });

  it("updates a quoted table while ignoring fake tables in multiline TOML strings", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const source = [
      "schema_version = 1",
      "projects = []",
      "",
      "[defaults]",
      'worktree_provider = "worktrunk"',
      'terminal = "tmux"',
      "harness = 'codex'",
      'layout = "agent-shell"',
      "",
      '["harness"."codex"]',
      "enabled = true",
      'command = """codex',
      "[harness.opencode]",
      'install_hooks = false"""',
      "",
    ].join("\n");
    const facts = setupFacts(repo, {
      harnesses: [
        { id: "codex", label: "Codex", status: "ok", command: "codex" },
        { id: "opencode", label: "OpenCode", status: "ok", command: "opencode" },
      ],
      config: {
        status: "valid",
        path: join(root, "config.toml"),
        source,
        observerStateDir: join(root, "state"),
        hasProjectForRoot: false,
        configuredHarnesses: ["codex"],
        configuredHookHarnesses: [],
        defaults: {
          worktreeProvider: "worktrunk",
          terminal: "tmux",
          harness: "codex",
        },
      },
    });

    const write = await planSetupConfigWrite(facts, {
      harnessSelection: {
        defaultHarness: "codex",
        selected: facts.harnesses,
      },
      installHarnessHooks: ["codex", "opencode"],
    });

    expect(write.operation).toBe("update");
    if (write.operation !== "update") throw new Error("expected update plan");
    expect(write.content.match(/\["harness"\."codex"\]/g)).toHaveLength(1);
    expect(write.content).toContain(
      '["harness"."codex"]\ninstall_hooks = true\nenabled = true\ncommand = """codex\n[harness.opencode]\ninstall_hooks = false"""',
    );
    expect(write.content.match(/install_hooks = true/g)).toHaveLength(2);
    expect(write.content.match(/install_hooks = false/g)).toHaveLength(1);
    await expect(
      loadConfigFromToml(write.content, { configPath: write.path, homeDir: root }),
    ).resolves.toBeDefined();
  });

  it("adds hook intent to an existing harness block", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const source = existingConfigToml(root, { projectRoot: repo, includeHarness: true });
    const facts = setupFacts(repo, {
      config: {
        status: "valid",
        path: join(root, "config.toml"),
        source,
        observerStateDir: join(root, "state"),
        hasProjectForRoot: false,
        configuredHarnesses: ["codex"],
        configuredHookHarnesses: [],
        defaults: {
          worktreeProvider: "worktrunk",
          terminal: "tmux",
          harness: "codex",
        },
      },
    });

    const write = await planSetupConfigWrite(facts, { installHarnessHooks: ["codex"] });

    expect(write.operation).toBe("update");
    if (write.operation !== "update") throw new Error("expected update plan");
    expect(write.content).toContain(
      '[harness.codex]\ninstall_hooks = true\nenabled = true\ncommand = "codex"',
    );
    await expect(
      loadConfigFromToml(write.content, { configPath: write.path, homeDir: root }),
    ).resolves.toMatchObject({
      config: { harness: { codex: { installHooks: true } } },
    });
  });

  it("blocks invalid existing config without a write action", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const facts = setupFacts(repo, {
      config: {
        status: "invalid",
        path: join(root, "config.toml"),
        source: "schema_version = 1\n[defaults\n",
        message: "STATION config file is not valid TOML.",
      },
    });

    await expect(planSetupConfigWrite(facts)).resolves.toEqual({
      operation: "blocked",
      path: join(root, "config.toml"),
      reason: "STATION config file is not valid TOML.",
    });
  });

  it("preserves custom detected Worktrunk and tmux commands in new config", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const facts = setupFacts(repo, {
      worktrunk: {
        status: "ok",
        command: "/custom/bin/wt",
        resolvedPath: "/custom/bin/wt",
      },
      tmux: {
        status: "ok",
        command: "/custom/bin/tmux",
        resolvedPath: "/custom/bin/tmux",
      },
      config: {
        status: "missing",
        path: join(root, "config.toml"),
        message: "missing",
      },
    });

    const write = await planSetupConfigWrite(facts);

    expect(write.operation).toBe("create");
    if (write.operation !== "create") throw new Error("expected create plan");
    expect(write.content).toContain('command = "/custom/bin/wt"');
    expect(write.content).toContain('[terminal.tmux]\ncommand = "/custom/bin/tmux"');
  });

  it("blocks appending a harness when the existing defaults are outside the core path", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const otherRepo = join(root, "other");
    await mkdir(repo, { recursive: true });
    await mkdir(otherRepo, { recursive: true });
    const source = existingConfigToml(root, { projectRoot: otherRepo });
    const facts = setupFacts(repo, {
      config: {
        status: "valid",
        path: join(root, "config.toml"),
        source,
        hasProjectForRoot: false,
        configuredHarnesses: ["codex"],
        configuredHookHarnesses: [],
        defaults: {
          worktreeProvider: "noop-worktree",
          terminal: "tmux",
          harness: "codex",
        },
      },
    });

    await expect(planSetupConfigWrite(facts)).resolves.toMatchObject({
      operation: "blocked",
      reason: expect.stringContaining("noop-worktree"),
    });
  });
});

async function tempRoot(tempRoots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-setup-config-"));
  tempRoots.push(root);
  return root;
}

function setupFacts(repo: string, overrides: Partial<SetupFacts>): SetupFacts {
  return {
    generatedAt: "2026-06-08T12:00:00.000Z",
    mode: "plan",
    configPath: "/tmp/config.toml",
    homeDir: "/tmp/home",
    compiled: false,
    stateDir: { status: "ok", path: "/tmp/home/.local/state/station" },
    socketEvidence: { status: "ok", command: "/usr/bin/lsof" },
    worktrunk: { status: "ok", command: "wt" },
    worktrunkAutomation: {
      status: "ok",
      automationMode: "preapprove-hooks",
      flag: "--yes",
      message:
        "Lifecycle hooks are enabled; automated Worktrunk mutations pass --yes to pre-approve prompts.",
    },
    worktrunkShellIntegration: {
      status: "warning",
      shell: "zsh",
      rcPath: "/tmp/home/.zshrc",
      message: "Worktrunk shell integration is not installed for zsh.",
    },
    tmux: { status: "ok", command: "tmux" },
    bun: { status: "ok", command: "bun" },
    stationUi: { status: "installed" },
    diffnav: { status: "ok", command: "diffnav" },
    gitDelta: { status: "ok", command: "delta" },
    brew: { status: "ok", command: "brew" },
    xcode: { status: "ok", applicable: true },
    launchers: {
      packageRoot: "/tmp/station",
      station: {
        status: "ok",
        source: "path",
        command: "stn",
        resolvedPath: "/tmp/bin/stn",
        checkoutPath: "/tmp/station/bin/stn",
      },
      ingress: {
        status: "ok",
        source: "path",
        command: "stn-ingress",
        resolvedPath: "/tmp/bin/stn-ingress",
        checkoutPath: "/tmp/station/bin/stn-ingress",
      },
      tmuxPopup: {
        status: "ok",
        source: "path",
        command: "stn-tmux-popup",
        resolvedPath: "/tmp/bin/stn-tmux-popup",
        checkoutPath: "/tmp/station/integrations/terminal/tmux/bin/stn-popup",
      },
    },
    git: {
      status: "ok",
      root: repo,
      repoName: "repo",
      defaultBranch: "main",
    },
    harnesses: [
      { id: "codex", label: "Codex", status: "ok", command: "codex" },
      { id: "cursor", label: "Cursor Agent", status: "missing", command: "agent" },
      { id: "opencode", label: "OpenCode", status: "missing", command: "opencode" },
      { id: "pi", label: "Pi", status: "missing", command: "pi" },
    ],
    config: {
      status: "missing",
      path: "/tmp/config.toml",
      message: "missing",
    },
    tmuxBinding: {
      status: "missing",
      path: "/tmp/home/.tmux.conf",
      marker: "# >>> station popup binding >>>",
      launcherCommand: "stn-tmux-popup",
      runShellCommand:
        "env STATION_FOCUS_PROVIDER=tmux STATION_FOCUS_CLIENT_ID=#{q:client_name} 'stn-tmux-popup'",
      bindingKey: "Space",
      insideTmux: false,
      liveStatus: "unknown",
      message: "Optional tmux popup binding is not installed.",
    },
    ...overrides,
  };
}

function existingConfigToml(
  root: string,
  options: { projectRoot?: string; includeHarness?: boolean } = {},
): string {
  return [
    "schema_version = 1",
    "",
    "[observer]",
    `socket_path = ${JSON.stringify(join(root, "observer.sock"))}`,
    `state_dir = ${JSON.stringify(join(root, "state"))}`,
    "",
    "[defaults]",
    'worktree_provider = "worktrunk"',
    'terminal = "tmux"',
    'harness = "codex"',
    'layout = "agent-shell"',
    "",
    "[worktree.worktrunk]",
    'managed_root = "~/.worktrees"',
    "",
    ...(options.includeHarness === true
      ? ["[harness.codex]", "enabled = true", 'command = "codex"', ""]
      : []),
    ...(options.projectRoot === undefined
      ? []
      : [
          "[[projects]]",
          `id = ${JSON.stringify(options.projectRoot.endsWith("/other") ? "other" : "repo")}`,
          `label = ${JSON.stringify(options.projectRoot.endsWith("/other") ? "other" : "repo")}`,
          `root = ${JSON.stringify(options.projectRoot)}`,
          "",
        ]),
  ].join("\n");
}
