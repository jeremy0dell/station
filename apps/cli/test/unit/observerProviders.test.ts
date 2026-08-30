import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeHarnessProvider } from "@station/claude";
import { createCodexHarnessProvider } from "@station/codex";
import {
  DEFAULT_WORKSPACE_CONFIG,
  HarnessProvidersConfigSchema,
  loadConfig,
  resolveObserverPaths,
  type StationConfig,
} from "@station/config";
import * as contracts from "@station/contracts";
import { createCursorHarnessProvider, installCursorHooks } from "@station/cursor";
import { createOpenCodeHarnessProvider, openCodeHookAdapter } from "@station/opencode";
import { createPiHarnessProvider } from "@station/pi";
import { ScriptedAgentHarnessProvider } from "@station/scripted-harness";
import { createStationHostController } from "@station/terminal";
import { assertPathInsideTestMachineRoot } from "@station/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderRegistry, probeHarnessHooksStatus } from "../../src/observerProviders";

vi.mock("@station/claude", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@station/claude")>();
  return {
    ...actual,
    createClaudeHarnessProvider: vi.fn(actual.createClaudeHarnessProvider),
  };
});

vi.mock("@station/codex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@station/codex")>();
  return {
    ...actual,
    createCodexHarnessProvider: vi.fn(actual.createCodexHarnessProvider),
  };
});

vi.mock("@station/cursor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@station/cursor")>();
  return {
    ...actual,
    createCursorHarnessProvider: vi.fn(actual.createCursorHarnessProvider),
  };
});

vi.mock("@station/opencode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@station/opencode")>();
  return {
    ...actual,
    createOpenCodeHarnessProvider: vi.fn(actual.createOpenCodeHarnessProvider),
  };
});

vi.mock("@station/terminal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@station/terminal")>();
  return {
    ...actual,
    createStationHostController: vi.fn(actual.createStationHostController),
  };
});

vi.mock("@station/pi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@station/pi")>();
  return {
    ...actual,
    createPiHarnessProvider: vi.fn(actual.createPiHarnessProvider),
  };
});

const now = "2026-05-21T12:00:00.000Z";
const usesSharedTestMachine = process.env.STATION_TEST_MACHINE_ROOT !== undefined;

if (!usesSharedTestMachine) {
  // Focused test runners can execute this file without loading the suite-level setup.
  afterEach(() => vi.unstubAllEnvs());
}

describe("observer providers", () => {
  it("supplies a finalized source host command from CLI composition", () => {
    vi.stubEnv("STATION_BUN", "/opt/station/bun");
    vi.stubEnv("STATION_HOST_ENTRY", "/opt/station/hostMain.ts");
    createProviderRegistry({
      ...config,
      featureFlags: { stationPersistentAgents: true },
    });

    expect(vi.mocked(createStationHostController)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        hostCommand: ["/opt/station/bun", "/opt/station/hostMain.ts"],
      }),
    );
  });

  it("assigns one Station adapter to the managed lifecycle and terminal registry", () => {
    const registry = createProviderRegistry(config);
    const managedTerminal = registry.managedTerminal;

    expect(managedTerminal).toBeDefined();
    if (managedTerminal === undefined) {
      throw new Error("managed terminal lifecycle was not registered");
    }
    expect(registry.terminals.get(managedTerminal.id)).toBe(managedTerminal);
    expect(
      [...registry.terminals.values()].filter((provider) => provider === managedTerminal),
    ).toEqual([managedTerminal]);
    expect(registry.defaultTerminalId).toBe(config.defaults.terminal);
    expect(registry.terminal).not.toBe(managedTerminal);
    expect("terminalOperations" in registry).toBe(false);
  });

  it("registers tmux placement explicitly while Station remains ordinary-only", () => {
    const registry = createProviderRegistry({
      ...config,
      defaults: { ...config.defaults, terminal: "tmux" },
      terminal: {
        tmux: { workbenchSocketPath: "/tmp/station-workbench.sock" },
      },
      projects: config.projects.map((project) => ({
        ...project,
        defaults: { ...project.defaults, terminal: "tmux" },
      })),
    });

    expect(registry.terminalPlacements.get("tmux")).toMatchObject({
      id: "tmux",
      supportedIntents: ["sibling", "detached"],
    });
    expect(registry.terminalPlacements.has("native")).toBe(false);
  });

  it("registers OpenCode hook normalization at the CLI composition root", () => {
    const registry = createProviderRegistry(config);

    expect(registry.hookAdapters.get("opencode")).toBe(openCodeHookAdapter);
  });

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
      provider: "noop-worktree",
      status: "healthy",
    });
    await expect(registry.terminal.health()).resolves.toMatchObject({
      provider: "noop-terminal",
      status: "healthy",
    });
    await expect(harness.health()).resolves.toMatchObject({
      provider: "noop-harness",
      status: "healthy",
    });
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
      provider: "codxe",
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
      provider: "tmxu",
      providerType: "terminal",
      status: "unavailable",
      lastError: {
        tag: "ProviderUnavailableError",
        code: "PROVIDER_NOT_REGISTERED",
        provider: "tmxu",
      },
    });
    await expect(harness.health()).resolves.toMatchObject({
      provider: "harnes",
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
  });

  it("keeps observer terminal operations out of contracts exports", () => {
    expect("ensureAgentWorkspace" in contracts).toBe(false);
    expect("focusTerminal" in contracts).toBe(false);
    expect("closeTerminal" in contracts).toBe(false);
  });

  it("omits unconfigured built-in harnesses and shows configured Codex, Cursor, Pi, and OpenCode", () => {
    const codexOnly = createProviderRegistry(config);

    expect([...codexOnly.harnesses.keys()]).toEqual(["codex"]);

    const allBuiltIns = createProviderRegistry({
      ...config,
      harness: {
        codex: {},
        cursor: {},
        pi: {},
        opencode: {},
      },
    });

    expect([...allBuiltIns.harnesses.keys()]).toEqual(["codex", "cursor", "pi", "opencode"]);
  });

  it("dispatches every known harness id through its registered provider builder", async () => {
    vi.mocked(createClaudeHarnessProvider).mockClear();
    vi.mocked(createCodexHarnessProvider).mockClear();
    vi.mocked(createCursorHarnessProvider).mockClear();
    vi.mocked(createOpenCodeHarnessProvider).mockClear();
    vi.mocked(createPiHarnessProvider).mockClear();
    const registry = createProviderRegistry({
      ...config,
      defaults: { ...config.defaults, harness: "claude" },
      projects: [
        {
          ...firstProject(),
          defaults: { ...firstProject().defaults, harness: "codex" },
        },
      ],
      harness: {
        scripted: {},
        claude: {},
        codex: {},
        cursor: {},
        opencode: {},
        pi: {},
        "noop-harness": {},
      },
    });

    expect([...registry.harnesses.keys()]).toEqual([
      "claude",
      "codex",
      "scripted",
      "cursor",
      "opencode",
      "pi",
      "noop-harness",
    ]);
    expect(createClaudeHarnessProvider).toHaveBeenCalledTimes(1);
    expect(createCodexHarnessProvider).toHaveBeenCalledTimes(1);
    expect(createCursorHarnessProvider).toHaveBeenCalledTimes(1);
    expect(createOpenCodeHarnessProvider).toHaveBeenCalledTimes(1);
    expect(createPiHarnessProvider).toHaveBeenCalledTimes(1);
    expect(registry.harnesses.get("scripted")).toBeInstanceOf(ScriptedAgentHarnessProvider);
    await expect(registry.harnesses.get("noop-harness")?.health()).resolves.toMatchObject({
      provider: "noop-harness",
      status: "healthy",
    });
  });

  it("constructs only provider-supported runtime options", async () => {
    vi.mocked(createClaudeHarnessProvider).mockClear();
    vi.mocked(createCodexHarnessProvider).mockClear();
    vi.mocked(createCursorHarnessProvider).mockClear();
    vi.mocked(createOpenCodeHarnessProvider).mockClear();
    vi.mocked(createPiHarnessProvider).mockClear();
    const stateDir = "/tmp/station/provider-table-state";
    const observerSocketPath = "/tmp/station/provider-table-observer.sock";
    const configPath = "/tmp/station/provider-table-config.toml";
    const ingressLauncher = "/tmp/station/bin/stn-ingress";
    const artifactOwner: contracts.ProviderHookArtifactOwner = {
      schemaVersion: 1,
      launcher: ingressLauncher,
      runtimeKind: "source",
      version: "0.0.0-test",
      buildIdentity: "a".repeat(64),
    };
    const piExtensionPath = "/tmp/station/assets/pi-extension.mjs";
    const providerConfig: StationConfig = {
      ...config,
      observer: {
        stateDir,
        socketPath: observerSocketPath,
        autoStartFromHooks: false,
      },
      defaults: {
        ...config.defaults,
        harness: "claude",
        harnessPermissionMode: "yolo",
      },
      projects: [
        {
          ...firstProject(),
          defaults: { ...firstProject().defaults, harness: "codex" },
        },
      ],
      harness: {
        scripted: { command: "node-scripted" },
        claude: {
          command: "claude-custom",
          profile: "claude-profile",
          permissionMode: "standard",
          approvalPolicy: "claude-approval",
          sandboxMode: "claude-sandbox",
          installHooks: true,
          resume: true,
        },
        codex: {
          command: "codex-custom",
          profile: "codex-profile",
          permissionMode: "standard",
          approvalPolicy: "codex-approval",
          sandboxMode: "codex-sandbox",
          installHooks: true,
          resume: true,
        },
        cursor: { command: "cursor-custom", installHooks: true, resume: true },
        opencode: {
          command: "opencode-custom",
          profile: "opencode-profile",
          permissionMode: "standard",
          approvalPolicy: "opencode-approval",
          sandboxMode: "opencode-sandbox",
          installHooks: true,
          resume: true,
        },
        pi: { command: "pi-custom", resume: true },
      },
    };

    const registry = createProviderRegistry(providerConfig, {
      configPath,
      piExtensionPath,
      providerHookIngressLauncher: ingressLauncher,
      providerHookArtifactOwner: artifactOwner,
    });
    const observerPaths = resolveObserverPaths(providerConfig);
    expect(vi.mocked(createClaudeHarnessProvider).mock.calls.at(-1)?.[0]).toEqual({
      command: "claude-custom",
      profile: "claude-profile",
      permissionMode: "standard",
      approvalPolicy: "claude-approval",
      sandboxMode: "claude-sandbox",
      installHooks: true,
      resume: true,
      hookBin: ingressLauncher,
      artifactOwner,
      observerSocketPath: observerPaths.socketPath,
      stateDir: observerPaths.stateDir,
      hookSpoolDir: observerPaths.hookSpoolDir,
      autoStartFromHooks: false,
    });
    expect(vi.mocked(createCodexHarnessProvider).mock.calls.at(-1)?.[0]).toEqual({
      command: "codex-custom",
      profile: "codex-profile",
      permissionMode: "standard",
      approvalPolicy: "codex-approval",
      sandboxMode: "codex-sandbox",
      installHooks: true,
      resume: true,
      hookBin: ingressLauncher,
      artifactOwner,
      observerSocketPath: observerPaths.socketPath,
      stateDir: observerPaths.stateDir,
      hookSpoolDir: observerPaths.hookSpoolDir,
      autoStartFromHooks: false,
    });
    expect(vi.mocked(createCursorHarnessProvider).mock.calls.at(-1)?.[0]).toEqual({
      command: "cursor-custom",
      installHooks: true,
      resume: true,
      configPath,
      hookBin: ingressLauncher,
      artifactOwner,
      observerSocketPath: observerPaths.socketPath,
      stateDir: observerPaths.stateDir,
      hookSpoolDir: observerPaths.hookSpoolDir,
      autoStartFromHooks: false,
    });
    expect(vi.mocked(createOpenCodeHarnessProvider).mock.calls.at(-1)?.[0]).toEqual({
      command: "opencode-custom",
      profile: "opencode-profile",
      permissionMode: "standard",
      approvalPolicy: "opencode-approval",
      sandboxMode: "opencode-sandbox",
      installHooks: true,
      resume: true,
      configPath,
      artifactOwner,
      observerSocketPath: observerPaths.socketPath,
      stateDir: observerPaths.stateDir,
      hookSpoolDir: observerPaths.hookSpoolDir,
    });
    expect(vi.mocked(createPiHarnessProvider).mock.calls.at(-1)?.[0]).toEqual({
      command: "pi-custom",
      resume: true,
      configPath,
      extensionPath: piExtensionPath,
      hookBin: ingressLauncher,
      observerSocketPath: observerPaths.socketPath,
      stateDir: observerPaths.stateDir,
      hookSpoolDir: observerPaths.hookSpoolDir,
    });

    const scripted = registry.harnesses.get("scripted");
    await expect(scripted?.buildLaunch(launchRequest("scripted"))).resolves.toMatchObject({
      provider: "scripted",
      command: "node-scripted",
      env: { STATION_SCRIPTED_STATE_DIR: join(stateDir, "scripted") },
      providerData: { stateDir: join(stateDir, "scripted") },
    });
    await expect(
      registry.harnesses.get("opencode")?.buildLaunch(launchRequest("opencode")),
    ).resolves.toMatchObject({
      provider: "opencode",
      command: "opencode-custom",
    });
  });

  it("forwards a prepared extension path only to the Pi provider", () => {
    vi.mocked(createPiHarnessProvider).mockClear();

    createProviderRegistry(
      {
        ...config,
        harness: { codex: {}, pi: {} },
      },
      { piExtensionPath: "/state/assets/pi/station-pi-extension.mjs" },
    );

    expect(createPiHarnessProvider).toHaveBeenCalledTimes(1);
    expect(createPiHarnessProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionPath: "/state/assets/pi/station-pi-extension.mjs",
      }),
    );
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
        provider: "tmux",
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
          `  mkdir -p ${JSON.stringify(createdWorktreePath)}`,
          `  printf '%s\n' 'gitdir: fixture' > ${JSON.stringify(join(createdWorktreePath, ".git"))}`,
          `  printf '%s' ${JSON.stringify(
            JSON.stringify([{ path: createdWorktreePath, branch: "feature" }]),
          )}`,
          "  exit 0",
          "fi",
          'if [ "$1" = "list" ]; then',
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
      if (created.registrationIdentity === undefined) {
        throw new Error("Expected the created worktree registration identity.");
      }
      await mkdir(createdWorktreePath, { recursive: true });
      await registry.worktree.removeWorktree({
        project,
        worktreeId: created.id,
        expectedPath: created.path,
        expectedBranch: created.branch,
        expectedRegistrationIdentity: created.registrationIdentity,
      });

      await expect(readFile(logPath, "utf8")).resolves.toBe(
        [
          "switch --no-hooks --create feature --base main --no-cd --format=json",
          "list --format=json",
          `-C ${createdWorktreePath} remove --no-hooks --format=json`,
          "",
        ].join("\n"),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("probes the exact configured provider and requester hook runtime without Observer startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-setup-provider-probe-"));
    const configPath = join(root, "config.toml");
    const stateDir = join(root, "state");
    const observerSocketPath = join(root, "run", "observer.sock");
    const hookSpoolDir = join(stateDir, "spool", "hooks");
    const ingressLauncher = join(root, "bin", "stn-ingress");
    await writeFile(
      configPath,
      [
        "schema_version = 1",
        "projects = []",
        "",
        "[observer]",
        `state_dir = ${JSON.stringify(stateDir)}`,
        `socket_path = ${JSON.stringify(observerSocketPath)}`,
        "auto_start_from_hooks = false",
        "",
        "[defaults]",
        'worktree_provider = "worktrunk"',
        'terminal = "tmux"',
        'harness = "cursor"',
        'layout = "agent-shell"',
        "",
        "[harness.cursor]",
        "enabled = true",
        "install_hooks = true",
        "",
      ].join("\n"),
      "utf8",
    );

    stubCursorTestHome(root);
    await installCursorHooks({
      hookBin: ingressLauncher,
      stationConfigPath: configPath,
      observerSocketPath,
      stateDir,
      hookSpoolDir,
      autoStartFromHooks: false,
    });

    await expect(
      probeHarnessHooksStatus("cursor", configPath, { ingressLauncher }),
    ).resolves.toMatchObject({
      provider: "cursor",
      requested: true,
      installed: true,
    });
    const loaded = await loadConfig(configPath);
    const provider = createProviderRegistry(loaded.config, {
      configPath: loaded.configPath,
      providerHookIngressLauncher: ingressLauncher,
    }).harnesses.get("cursor");
    await expect(
      provider?.hooksStatus?.({ stationConfigPath: loaded.configPath }),
    ).resolves.toMatchObject({
      provider: "cursor",
      requested: true,
      installed: true,
    });
    await expect(probeHarnessHooksStatus("pi", configPath)).resolves.toBeUndefined();
  });

  it("normalizes setup hook probe failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-setup-provider-probe-failure-"));
    const configPath = join(root, "invalid.toml");
    await writeFile(configPath, "schema_version = 1\n[defaults\n", "utf8");

    await expect(probeHarnessHooksStatus("codex", configPath)).rejects.toMatchObject({
      tag: "SetupHarnessTrackingError",
      code: "SETUP_HARNESS_TRACKING_PROBE_FAILED",
      provider: "codex",
    });
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

    stubCursorTestHome(root);
    await installCursorHooks({
      hookScriptPath,
      stationConfigPath: configPath,
      observerSocketPath,
      stateDir,
      hookSpoolDir,
      autoStartFromHooks: false,
      homeDir: root,
    });

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
      harness: HarnessProvidersConfigSchema.parse({
        claude: {
          command: "claude-custom",
          profile: "team-profile",
          permissionMode: "auto",
        },
      }),
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
      {
        configPath: "/tmp/station/config.toml",
        providerHookIngressLauncher: "/tmp/station/bin/stn-ingress",
      },
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
        STATION_INGRESS_BIN: "/tmp/station/bin/stn-ingress",
      },
    });
  });

  it("reports removed Crush harness configs as unavailable", async () => {
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

    await expect(provider?.health()).resolves.toMatchObject({
      provider: "crush",
      providerType: "harness",
      status: "unavailable",
      lastError: {
        code: "PROVIDER_NOT_REGISTERED",
        provider: "crush",
      },
    });
    await expect(provider?.buildLaunch({} as never)).rejects.toMatchObject({
      code: "PROVIDER_NOT_REGISTERED",
      provider: "crush",
    });
  });

  it("registers GitHub as an optional repository provider without eager health alerts", async () => {
    const registry = createProviderRegistry(config);
    const provider = registry.repositories.get("github");

    await expect(provider?.health()).resolves.toMatchObject({
      provider: "github",
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
  workspace: DEFAULT_WORKSPACE_CONFIG,
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

function stubCursorTestHome(root: string): void {
  if (!usesSharedTestMachine) vi.stubEnv("STATION_TEST_MACHINE_ROOT", root);
  assertPathInsideTestMachineRoot(root, "Cursor test home");
  vi.stubEnv("STATION_CURSOR_HOME", root);
  vi.stubEnv("STATION_CURSOR_HOOKS_PATH", "");
}

function launchRequest(harness: string): Parameters<contracts.HarnessProvider["buildLaunch"]>[0] {
  const project = firstProject();
  return {
    project: {
      ...project,
      defaults: { ...project.defaults, harness },
    },
    worktree: {
      id: "wt_web_task",
      provider: "worktrunk",
      projectId: project.id,
      branch: "task",
      path: "/tmp/station/web/task",
      state: "exists",
      source: "worktrunk",
      observedAt: now,
    },
    mode: "interactive",
  };
}

function firstProject(): StationConfig["projects"][number] {
  const project = config.projects[0];
  if (project === undefined) {
    throw new Error("provider factory fixture is missing a project.");
  }
  return project;
}
