import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import * as contracts from "@station/contracts";
import { installCrushHooks } from "@station/crush";
import { installCursorHooks } from "@station/cursor";
import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../../src/observerProviders";

const now = "2026-05-21T12:00:00.000Z";

describe("observer providers", () => {
  it("keeps explicit noop providers healthy for empty/test startup", async () => {
    const registry = createProviderRegistry({
      ...config,
      defaults: {
        worktreeProvider: "noop-worktree",
        terminal: "noop-terminal",
        harness: "noop-harness",
        layout: "agent-shell",
      },
      projects: [],
    });
    const harness = registry.harnesses.get("noop-harness");
    if (harness === undefined) {
      throw new Error("noop harness provider was not registered.");
    }
    const project = firstProject();

    await expect(registry.worktree.health()).resolves.toMatchObject({
      providerId: "noop-worktree",
      status: "healthy",
    });
    await expect(registry.terminal.health()).resolves.toMatchObject({
      providerId: "noop-terminal",
      status: "healthy",
    });
    await expect(harness.health()).resolves.toMatchObject({
      providerId: "noop-harness",
      status: "healthy",
    });
    expect(registry.terminalIntentRunner).toBeDefined();
    expect(await registry.worktree.listWorktrees(project)).toEqual([]);
    expect(await registry.terminal.listTargets()).toEqual([]);
    expect(
      await harness.discoverRuns({ projects: [], worktrees: [], terminalTargets: [] }),
    ).toEqual([]);
  });

  it("reports unknown configured provider ids as unavailable", async () => {
    const registry = createProviderRegistry({
      ...config,
      defaults: {
        worktreeProvider: "codxe",
        terminal: "tmxu",
        harness: "harnes",
        layout: "agent-shell",
      },
      projects: [
        {
          ...firstProject(),
          defaults: {
            harness: "harnes",
            terminal: "tmxu",
            layout: "agent-shell",
          },
        },
      ],
    });
    const harness = registry.harnesses.get("harnes");
    if (harness === undefined) {
      throw new Error("unknown harness provider was not registered.");
    }

    await expect(registry.worktree.health()).resolves.toMatchObject({
      providerId: "codxe",
      providerType: "worktree",
      status: "unavailable",
      lastError: {
        tag: "ProviderUnavailableError",
        code: "PROVIDER_NOT_REGISTERED",
        provider: "codxe",
      },
      capabilities: {
        canList: false,
      },
    });
    await expect(registry.terminal.health()).resolves.toMatchObject({
      providerId: "tmxu",
      providerType: "terminal",
      status: "unavailable",
      lastError: {
        tag: "ProviderUnavailableError",
        code: "PROVIDER_NOT_REGISTERED",
        provider: "tmxu",
      },
    });
    await expect(harness.health()).resolves.toMatchObject({
      providerId: "harnes",
      providerType: "harness",
      status: "unavailable",
      lastError: {
        tag: "ProviderUnavailableError",
        code: "PROVIDER_NOT_REGISTERED",
        provider: "harnes",
      },
      capabilities: {
        canDiscoverRuns: false,
      },
    });
    expect(registry.terminalIntentRunner).toBeDefined();
    await expect(registry.worktree.listWorktrees(firstProject())).resolves.toEqual([]);
    await expect(registry.terminal.listTargets()).resolves.toEqual([]);
    await expect(
      harness.discoverRuns({ projects: [], worktrees: [], terminalTargets: [] }),
    ).resolves.toEqual([]);
    await expect(registry.terminal.openWorkspace({} as never)).rejects.toMatchObject({
      code: "PROVIDER_NOT_REGISTERED",
      provider: "tmxu",
    });
    await expect(harness.buildLaunch({} as never)).rejects.toMatchObject({
      code: "PROVIDER_NOT_REGISTERED",
      provider: "harnes",
    });
  });

  it("orders harness providers from defaults, project defaults, and harness config", () => {
    const registry = createProviderRegistry({
      ...config,
      projects: [
        firstProject(),
        {
          id: "api",
          label: "api",
          root: "/tmp/station/api",
          defaults: {
            harness: "opencode",
            terminal: "fake-terminal",
            layout: "agent-shell",
          },
          worktrunk: {
            enabled: true,
          },
        },
      ],
      harness: {
        pi: {},
        scripted: {},
      },
    });

    expect([...registry.harnesses.keys()]).toEqual(["codex", "opencode", "pi", "scripted"]);
    expect(registry.terminalIntentRunner).toBeDefined();
  });

  it("keeps the observer terminal intent runner out of contracts exports", () => {
    expect("TerminalIntentRunner" in contracts).toBe(false);
    expect("DefaultTerminalIntentRunner" in contracts).toBe(false);
  });

  it("omits unconfigured built-in harnesses and shows configured Codex, Crush, Pi, OpenCode, and Cursor", () => {
    const codexOnly = createProviderRegistry(config);

    expect([...codexOnly.harnesses.keys()]).toEqual(["codex"]);

    const allBuiltIns = createProviderRegistry({
      ...config,
      harness: {
        codex: {},
        crush: {},
        cursor: {},
        pi: {},
        opencode: {},
      },
    });

    expect([...allBuiltIns.harnesses.keys()]).toEqual([
      "codex",
      "crush",
      "cursor",
      "pi",
      "opencode",
    ]);
  });

  it("passes tmux command config into the tmux terminal provider", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "station-tmux-command-"));
    try {
      const tmuxCommand = join(tempDir, "custom-tmux");
      await writeFile(
        tmuxCommand,
        '#!/bin/sh\nif [ "$1" = "-V" ]; then echo "tmux 3.5a"; exit 0; fi\nexit 2\n',
        "utf8",
      );
      await chmod(tmuxCommand, 0o700);
      const registry = createProviderRegistry({
        ...config,
        defaults: {
          ...config.defaults,
          terminal: "tmux",
        },
        terminal: {
          tmux: {
            command: tmuxCommand,
          },
        },
      });

      await expect(registry.terminal.health()).resolves.toMatchObject({
        providerId: "tmux",
        status: "healthy",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes Worktrunk lifecycle automation config into create and remove provider calls", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "station-worktrunk-command-"));
    try {
      const worktrunkCommand = join(tempDir, "wt");
      const logPath = join(tempDir, "wt.log");
      const projectRoot = join(tempDir, "web");
      const createdWorktreePath = join(projectRoot, "feature");
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        worktrunkCommand,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
          'if [ "$1" = "switch" ]; then',
          `  printf '%s' ${JSON.stringify(
            JSON.stringify([{ path: createdWorktreePath, branch: "feature" }]),
          )}`,
          "  exit 0",
          "fi",
          'if [ "$1" = "remove" ]; then',
          "  printf '{}'",
          "  exit 0",
          "fi",
          "printf '[]'",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(worktrunkCommand, 0o700);
      const registry = createProviderRegistry({
        ...config,
        defaults: {
          ...config.defaults,
          worktreeProvider: "worktrunk",
        },
        worktree: {
          worktrunk: {
            command: worktrunkCommand,
            useLifecycleHooks: false,
          },
        },
        projects: [
          {
            ...firstProject(),
            root: projectRoot,
            worktrunk: {
              ...firstProject().worktrunk,
              base: "main",
            },
          },
        ],
      });
      const project = {
        ...firstProject(),
        root: projectRoot,
        worktrunk: {
          ...firstProject().worktrunk,
          base: "main",
        },
      };

      const created = await registry.worktree.createWorktree({
        project,
        branch: "feature",
      });
      await mkdir(createdWorktreePath, { recursive: true });
      await registry.worktree.removeWorktree({ worktreeId: created.id });

      await expect(readFile(logPath, "utf8")).resolves.toBe(
        [
          "switch --no-hooks --create feature --base main --no-cd --format=json",
          "remove --no-hooks feature --foreground --format=json",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes Cursor command config into the Cursor harness provider", async () => {
    const registry = createProviderRegistry({
      ...config,
      defaults: {
        ...config.defaults,
        harness: "cursor",
      },
      harness: {
        cursor: {
          command: "agent-custom",
        },
      },
    });
    const provider = registry.harnesses.get("cursor");
    const project = config.projects[0];
    if (project === undefined) {
      throw new Error("provider factory fixture is missing a project.");
    }

    await expect(
      provider?.buildLaunch({
        project: {
          ...project,
          defaults: {
            ...project.defaults,
            harness: "cursor",
          },
        },
        worktree: {
          id: "wt_web_task",
          provider: "worktrunk",
          projectId: "web",
          branch: "task",
          path: "/tmp/station/web/task",
          state: "exists",
          source: "worktrunk",
          observedAt: now,
        },
        mode: "interactive",
      }),
    ).resolves.toMatchObject({
      provider: "cursor",
      command: "agent-custom",
      args: ["--workspace", "/tmp/station/web/task"],
      env: {
        STATION_HARNESS_PROVIDER: "cursor",
      },
    });
  });

  it("passes Cursor hook config and observer paths into the Cursor harness provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-factory-"));
    const stateDir = join(root, "state");
    const observerSocketPath = join(root, "run", "observer.sock");
    const hookSpoolDir = join(stateDir, "spool", "hooks");
    const hookScriptPath = join(stateDir, "hooks", "station-cursor-hook.sh");
    const configPath = join(root, "station.config.toml");

    await installCursorHooks({
      hookScriptPath,
      stationConfigPath: configPath,
      observerSocketPath,
      stateDir,
      hookSpoolDir,
      autoStartFromHooks: false,
      homeDir: root,
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const registry = createProviderRegistry(
        {
          ...config,
          observer: {
            stateDir,
            socketPath: observerSocketPath,
            autoStartFromHooks: false,
          },
          defaults: {
            ...config.defaults,
            harness: "cursor",
          },
          harness: {
            cursor: {
              installHooks: true,
            },
          },
        },
        { configPath },
      );
      const provider = registry.harnesses.get("cursor");

      await expect(provider?.doctorChecks?.()).resolves.toContainEqual(
        expect.objectContaining({
          name: "cursor-hooks",
          status: "ok",
        }),
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("passes Codex config defaults into the Codex harness provider", async () => {
    const registry = createProviderRegistry({
      ...config,
      harness: {
        codex: {
          command: "codex-custom",
          profile: "team-profile",
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
          installHooks: true,
        },
      },
    });
    const provider = registry.harnesses.get("codex");
    const project = config.projects[0];
    if (project === undefined) {
      throw new Error("provider factory fixture is missing a project.");
    }

    await expect(
      provider?.buildLaunch({
        project,
        worktree: {
          id: "wt_web_task",
          provider: "worktrunk",
          projectId: "web",
          branch: "task",
          path: "/tmp/station/web/task",
          state: "exists",
          source: "worktrunk",
          observedAt: now,
        },
        mode: "interactive",
      }),
    ).resolves.toMatchObject({
      command: "codex-custom",
      args: [
        "--cd",
        "/tmp/station/web/task",
        "--profile",
        "station",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
      ],
    });
  });

  it("passes Claude config defaults into the Claude harness provider", async () => {
    const registry = createProviderRegistry({
      ...config,
      harness: {
        claude: {
          command: "claude-custom",
          profile: "team-profile",
          permissionMode: "auto",
        },
      },
    });
    const provider = registry.harnesses.get("claude");
    const project = config.projects[0];
    if (project === undefined) {
      throw new Error("provider factory fixture is missing a project.");
    }

    await expect(
      provider?.buildLaunch({
        project,
        worktree: {
          id: "wt_web_task",
          provider: "worktrunk",
          projectId: "web",
          branch: "task",
          path: "/tmp/station/web/task",
          state: "exists",
          source: "worktrunk",
          observedAt: now,
        },
        mode: "interactive",
      }),
    ).resolves.toMatchObject({
      provider: "claude",
      command: "claude-custom",
      args: ["--agent", "team-profile", "--permission-mode", "auto"],
      cwd: "/tmp/station/web/task",
      env: {
        STATION_HARNESS_PROVIDER: "claude",
      },
      providerData: {
        permissionMode: "auto",
      },
    });
  });

  it("falls back to the global yolo harness permission mode for Claude launches", async () => {
    const registry = createProviderRegistry({
      ...config,
      defaults: {
        ...config.defaults,
        harnessPermissionMode: "yolo",
      },
      harness: {
        claude: {},
      },
    });
    const provider = registry.harnesses.get("claude");
    const project = config.projects[0];
    if (project === undefined) {
      throw new Error("provider factory fixture is missing a project.");
    }

    const plan = await provider?.buildLaunch({
      project,
      worktree: {
        id: "wt_web_task",
        provider: "worktrunk",
        projectId: "web",
        branch: "task",
        path: "/tmp/station/web/task",
        state: "exists",
        source: "worktrunk",
        observedAt: now,
      },
      mode: "interactive",
    });

    expect(plan?.args).toEqual(["--dangerously-skip-permissions"]);
    expect(plan?.providerData).toMatchObject({
      permissionMode: "yolo",
    });
  });

  it("registers Pi harness provider with command and observer config path", async () => {
    const registry = createProviderRegistry(
      {
        ...config,
        defaults: {
          ...config.defaults,
          harness: "pi",
        },
        harness: {
          pi: {
            command: "pi-custom",
          },
        },
        projects: [
          {
            ...firstProject(),
            defaults: {
              harness: "pi",
              terminal: "fake-terminal",
              layout: "agent-shell",
            },
          },
        ],
      },
      { configPath: "/tmp/station/config.toml" },
    );
    const provider = registry.harnesses.get("pi");
    const project = firstProject();

    await expect(
      provider?.buildLaunch({
        project: {
          ...project,
          defaults: {
            harness: "pi",
            terminal: "fake-terminal",
            layout: "agent-shell",
          },
        },
        worktree: {
          id: "wt_web_task",
          provider: "worktrunk",
          projectId: "web",
          branch: "task",
          path: "/tmp/station/web/task",
          state: "exists",
          source: "worktrunk",
          observedAt: now,
        },
        mode: "interactive",
      }),
    ).resolves.toMatchObject({
      provider: "pi",
      command: "pi-custom",
      args: expect.arrayContaining(["--extension"]),
      env: {
        STATION_CONFIG_PATH: "/tmp/station/config.toml",
      },
    });
  });

  it("registers Crush harness provider with command and observer config path", async () => {
    const registry = createProviderRegistry(
      {
        ...config,
        defaults: {
          ...config.defaults,
          harness: "crush",
        },
        harness: {
          crush: {
            command: "crush-custom",
          },
        },
        projects: [
          {
            ...firstProject(),
            defaults: {
              harness: "crush",
              terminal: "fake-terminal",
              layout: "agent-shell",
            },
          },
        ],
      },
      { configPath: "/tmp/station/config.toml" },
    );
    const provider = registry.harnesses.get("crush");
    const project = firstProject();

    await expect(
      provider?.buildLaunch({
        project: {
          ...project,
          defaults: {
            harness: "crush",
            terminal: "fake-terminal",
            layout: "agent-shell",
          },
        },
        worktree: {
          id: "wt_web_task",
          provider: "worktrunk",
          projectId: "web",
          branch: "task",
          path: "/tmp/station/web/task",
          state: "exists",
          source: "worktrunk",
          observedAt: now,
        },
        mode: "exec",
        initialPrompt: "Review the task.",
      }),
    ).resolves.toMatchObject({
      provider: "crush",
      command: "crush-custom",
      args: ["run", "--quiet", "Review the task."],
      env: {
        STATION_CONFIG_PATH: "/tmp/station/config.toml",
      },
    });
  });

  it("passes Crush hook config and observer paths into the Crush harness provider", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "station-crush-factory-")));
    const stateDir = join(root, "state");
    const observerSocketPath = join(root, "run", "observer.sock");
    const hookSpoolDir = join(stateDir, "spool", "hooks");
    const configPath = join(root, "station.config.toml");
    const previousCwd = process.cwd();

    await installCrushHooks({
      stationConfigPath: configPath,
      observerSocketPath,
      stateDir,
      hookSpoolDir,
      autoStartFromHooks: false,
      cwd: root,
    });

    process.chdir(root);
    try {
      const registry = createProviderRegistry(
        {
          ...config,
          observer: {
            stateDir,
            socketPath: observerSocketPath,
            autoStartFromHooks: false,
          },
          defaults: {
            ...config.defaults,
            harness: "crush",
          },
          harness: {
            crush: {
              installHooks: true,
            },
          },
        },
        { configPath },
      );
      const provider = registry.harnesses.get("crush");

      await expect(provider?.doctorChecks?.()).resolves.toContainEqual(
        expect.objectContaining({
          name: "crush-hooks",
          status: "ok",
        }),
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("registers GitHub as an optional repository provider without eager health alerts", async () => {
    const registry = createProviderRegistry(config);
    const provider = registry.repositories.get("github");

    await expect(provider?.health()).resolves.toMatchObject({
      providerId: "github",
      providerType: "repository",
      status: "unknown",
    });
  });

  it("allows GitHub repository enrichment to be disabled", () => {
    const registry = createProviderRegistry({
      ...config,
      repository: {
        github: {
          enabled: false,
        },
      },
    });

    expect(registry.repositories.size).toBe(0);
  });

  it("applies global yolo harness permission mode to Codex launches", async () => {
    const registry = createProviderRegistry({
      ...config,
      defaults: {
        ...config.defaults,
        harnessPermissionMode: "yolo",
      },
      harness: {
        codex: {
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
        },
      },
    });
    const provider = registry.harnesses.get("codex");
    const project = config.projects[0];
    if (project === undefined) {
      throw new Error("provider factory fixture is missing a project.");
    }

    const plan = await provider?.buildLaunch({
      project,
      worktree: {
        id: "wt_web_task",
        provider: "worktrunk",
        projectId: "web",
        branch: "task",
        path: "/tmp/station/web/task",
        state: "exists",
        source: "worktrunk",
        observedAt: now,
      },
      mode: "interactive",
    });

    expect(plan?.args).toEqual([
      "--cd",
      "/tmp/station/web/task",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(plan?.providerData).toMatchObject({
      permissionMode: "yolo",
    });
    expect(plan?.args).not.toContain("--sandbox");
    expect(plan?.args).not.toContain("--ask-for-approval");
  });

  it("lets provider permission mode override the global harness permission mode", async () => {
    const registry = createProviderRegistry({
      ...config,
      defaults: {
        ...config.defaults,
        harnessPermissionMode: "yolo",
      },
      harness: {
        codex: {
          permissionMode: "standard",
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
        },
      },
    });
    const provider = registry.harnesses.get("codex");
    const project = config.projects[0];
    if (project === undefined) {
      throw new Error("provider factory fixture is missing a project.");
    }

    await expect(
      provider?.buildLaunch({
        project,
        worktree: {
          id: "wt_web_task",
          provider: "worktrunk",
          projectId: "web",
          branch: "task",
          path: "/tmp/station/web/task",
          state: "exists",
          source: "worktrunk",
          observedAt: now,
        },
        mode: "interactive",
      }),
    ).resolves.toMatchObject({
      args: [
        "--cd",
        "/tmp/station/web/task",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
      ],
      providerData: {
        permissionMode: "standard",
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
      },
    });
  });
});

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "codex",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "codex",
        terminal: "fake-terminal",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
  ],
};

function firstProject(): StationConfig["projects"][number] {
  const project = config.projects[0];
  if (project === undefined) {
    throw new Error("provider factory fixture is missing a project.");
  }
  return project;
}
