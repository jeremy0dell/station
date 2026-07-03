import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ClaudeHarnessProviderOptions,
  claudeHookAdapter,
  createClaudeHarnessProvider,
} from "@station/claude";
import {
  type CodexHarnessProviderOptions,
  codexHookAdapter,
  createCodexHarnessProvider,
} from "@station/codex";
import {
  type ClaudeHarnessProviderConfig,
  type HarnessProviderConfig,
  resolveObserverPaths,
  type StationConfig,
  stationHostSocketPath,
} from "@station/config";
import type {
  HarnessCapabilities,
  HarnessPermissionMode,
  HarnessProvider,
  HarnessRunObservation,
  ProviderHealth,
  RepositoryCapabilities,
  RepositoryProvider,
  SafeError,
  TerminalCapabilities,
  TerminalProvider,
  TerminalTargetObservation,
  WorktreeCapabilities,
  WorktreeObservation,
  WorktreeProvider,
} from "@station/contracts";
import {
  type CursorHarnessProviderOptions,
  createCursorHarnessProvider,
  cursorHookAdapter,
} from "@station/cursor";
import { GithubRepositoryProvider } from "@station/github-repository";
import type { JsonlLogger } from "@station/observability";
import { createTerminalIntentRunner, ProviderRegistry } from "@station/observer/internal";
import {
  createOpenCodeHarnessProvider,
  type OpenCodeHarnessProviderOptions,
} from "@station/opencode";
import { createPiHarnessProvider, type PiHarnessProviderOptions, piHookAdapter } from "@station/pi";
import { type RuntimeClock, systemClock, toIsoTimestamp } from "@station/runtime";
import { ScriptedAgentHarnessProvider } from "@station/scripted-harness";
import { createStationHostController, StationTerminalProvider } from "@station/terminal";
import { TmuxProvider } from "@station/tmux";
import { WorktrunkProvider, worktrunkHookAdapter } from "@station/worktrunk";

export type CreateProviderRegistryOptions = {
  configPath?: string | undefined;
  clock?: RuntimeClock | undefined;
  logger?: JsonlLogger | undefined;
  commandTimeoutMs?: number | undefined;
};

export function createProviderRegistry(
  config: StationConfig,
  options: CreateProviderRegistryOptions = {},
): ProviderRegistry {
  const worktree = createWorktreeProvider(config);
  const terminal = createTerminalProvider(config);
  const harnesses = createHarnessProviders(config, options);
  const repositories = createRepositoryProviders(config);
  const harnessMap = new Map(harnesses.map((provider) => [provider.id, provider]));
  // The externally-hosted native provider registers Station-owned terminal
  // targets; the default terminal provider stays the project default (e.g. tmux).
  // Behind stationPersistentAgents it is host-backed (spawns into / drives the
  // standalone station-station-host); otherwise the Station UI owns the PTYs.
  const station = config.featureFlags?.stationPersistentAgents
    ? new StationTerminalProvider({
        host: createStationHostController({
          socketPath: stationHostSocketPath(config),
          stateDir: resolveObserverPaths(config).stateDir,
          hostEntry: resolveStationHostEntry(),
        }),
      })
    : new StationTerminalProvider();
  const terminalMap = new Map<string, TerminalProvider>([
    [terminal.id, terminal],
    [station.id, station],
  ]);
  const terminalIntentRunner = createTerminalIntentRunner({
    providers: {
      terminals: terminalMap,
      harnesses: harnessMap,
    },
    clock: options.clock,
    logger: options.logger,
    commandTimeoutMs: options.commandTimeoutMs,
  });
  return new ProviderRegistry({
    worktree,
    terminal,
    terminals: [station],
    harnesses: harnessMap,
    repositories,
    hookAdapters: [
      claudeHookAdapter,
      codexHookAdapter,
      cursorHookAdapter,
      piHookAdapter,
      worktrunkHookAdapter,
    ],
    terminalIntentRunner,
  });
}

/** Default Station host entry is outside the built CLI, under station/. */
function resolveStationHostEntry(): string {
  const fromEnv = process.env.STATION_HOST_ENTRY;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return join(repoRoot, "station/src/host/hostMain.ts");
}

function createWorktreeProvider(config: StationConfig): WorktreeProvider {
  if (config.defaults.worktreeProvider === "worktrunk") {
    const options: ConstructorParameters<typeof WorktrunkProvider>[0] = {};
    if (config.worktree?.worktrunk?.command !== undefined) {
      options.command = config.worktree.worktrunk.command;
    }
    if (config.worktree?.worktrunk?.configPath !== undefined) {
      options.configPath = config.worktree.worktrunk.configPath;
    }
    if (config.worktree?.worktrunk?.useLifecycleHooks !== undefined) {
      options.useLifecycleHooks = config.worktree.worktrunk.useLifecycleHooks;
    }
    return new WorktrunkProvider(options);
  }

  if (config.defaults.worktreeProvider === "noop-worktree") {
    return new NoopWorktreeProvider(config.defaults.worktreeProvider);
  }

  return new UnavailableWorktreeProvider(config.defaults.worktreeProvider);
}

function createTerminalProvider(config: StationConfig): TerminalProvider {
  if (config.defaults.terminal === "tmux") {
    const options: ConstructorParameters<typeof TmuxProvider>[0] = {};
    if (config.terminal?.tmux !== undefined) {
      options.config = config.terminal.tmux;
      if (config.terminal.tmux.command !== undefined) {
        options.command = config.terminal.tmux.command;
      }
    }
    return new TmuxProvider(options);
  }

  if (config.defaults.terminal === "noop-terminal") {
    return new NoopTerminalProvider(config.defaults.terminal);
  }

  return new UnavailableTerminalProvider(config.defaults.terminal);
}

function createHarnessProviders(
  config: StationConfig,
  options: CreateProviderRegistryOptions,
): HarnessProvider[] {
  const ids = new Set<string>();
  ids.add(config.defaults.harness);
  for (const project of config.projects) {
    ids.add(project.defaults.harness);
  }
  for (const providerId of Object.keys(config.harness ?? {})) {
    ids.add(providerId);
  }
  return Array.from(ids).map((id) => createHarnessProvider(id, config, options));
}

function createHarnessProvider(
  id: string,
  config: StationConfig,
  registryOptions: CreateProviderRegistryOptions,
): HarnessProvider {
  const providerConfig = harnessProviderConfig(config, id);

  if (id === "scripted") {
    const options: ConstructorParameters<typeof ScriptedAgentHarnessProvider>[0] = {
      stateDir: join(config.observer?.stateDir ?? process.cwd(), "scripted"),
    };
    if (providerConfig?.command !== undefined) {
      options.nodeCommand = providerConfig.command;
    }
    return new ScriptedAgentHarnessProvider(options);
  }

  if (id === "claude") {
    const options: ClaudeHarnessProviderOptions = {};
    if (providerConfig?.command !== undefined) {
      options.command = providerConfig.command;
    }
    if (providerConfig?.profile !== undefined) {
      options.profile = providerConfig.profile;
    }
    const permissionMode = resolveClaudePermissionMode(config);
    if (permissionMode !== undefined) {
      options.permissionMode = permissionMode;
    }
    if (providerConfig?.approvalPolicy !== undefined) {
      options.approvalPolicy = providerConfig.approvalPolicy;
    }
    if (providerConfig?.sandboxMode !== undefined) {
      options.sandboxMode = providerConfig.sandboxMode;
    }
    if (providerConfig?.installHooks !== undefined) {
      options.installHooks = providerConfig.installHooks;
    }
    if (providerConfig?.resume !== undefined) {
      options.resume = providerConfig.resume;
    }
    applyObserverPaths(options, config, true);
    return createClaudeHarnessProvider(options);
  }

  if (id === "codex") {
    const options: CodexHarnessProviderOptions = {};
    applyHarnessAgentOptions(options, providerConfig, resolveHarnessPermissionMode(config, id));
    if (providerConfig?.profile !== undefined) {
      options.profile = providerConfig.profile;
    }
    if (providerConfig?.resume !== undefined) {
      options.resume = providerConfig.resume;
    }
    applyObserverPaths(options, config, true);
    return createCodexHarnessProvider(options);
  }

  if (id === "cursor") {
    const options: CursorHarnessProviderOptions = {};
    if (providerConfig?.command !== undefined) {
      options.command = providerConfig.command;
    }
    if (providerConfig?.installHooks !== undefined) {
      options.installHooks = providerConfig.installHooks;
    }
    if (providerConfig?.resume !== undefined) {
      options.resume = providerConfig.resume;
    }
    if (registryOptions.configPath !== undefined) {
      options.configPath = registryOptions.configPath;
    }
    applyObserverPaths(options, config, true);
    return createCursorHarnessProvider(options);
  }

  if (id === "opencode") {
    const options: OpenCodeHarnessProviderOptions = {};
    applyHarnessAgentOptions(options, providerConfig, resolveHarnessPermissionMode(config, id));
    if (providerConfig?.profile !== undefined) {
      options.profile = providerConfig.profile;
    }
    if (providerConfig?.resume !== undefined) {
      options.resume = providerConfig.resume;
    }
    if (registryOptions.configPath !== undefined) {
      options.configPath = registryOptions.configPath;
    }
    applyObserverPaths(options, config, false);
    return createOpenCodeHarnessProvider(options);
  }

  if (id === "pi") {
    const options: PiHarnessProviderOptions = {};
    if (providerConfig?.command !== undefined) {
      options.command = providerConfig.command;
    }
    if (providerConfig?.resume !== undefined) {
      options.resume = providerConfig.resume;
    }
    if (registryOptions.configPath !== undefined) {
      options.configPath = registryOptions.configPath;
    }
    applyObserverPaths(options, config, false);
    return createPiHarnessProvider(options);
  }

  if (id === "noop-harness") {
    return new NoopHarnessProvider(id);
  }

  return new UnavailableHarnessProvider(id);
}

function createRepositoryProviders(config: StationConfig): RepositoryProvider[] {
  if (config.repository?.github?.enabled === false) {
    return [];
  }

  const options: ConstructorParameters<typeof GithubRepositoryProvider>[0] = {};
  if (config.repository?.github?.command !== undefined) {
    options.command = config.repository.github.command;
  }
  if (config.repository?.github?.timeoutMs !== undefined) {
    options.timeoutMs = config.repository.github.timeoutMs;
  }
  return [new GithubRepositoryProvider(options)];
}

function harnessProviderConfig(
  config: StationConfig,
  id: string,
): HarnessProviderConfig | undefined {
  return config.harness?.[id];
}

function resolveClaudePermissionMode(
  config: StationConfig,
): ClaudeHarnessProviderConfig["permissionMode"] | undefined {
  const providerConfig = config.harness?.claude;
  if (providerConfig?.permissionMode !== undefined) {
    return providerConfig.permissionMode;
  }
  if (config.defaults.harnessPermissionMode !== undefined) {
    return config.defaults.harnessPermissionMode;
  }
  return undefined;
}

function resolveHarnessPermissionMode(
  config: StationConfig,
  id: string,
): HarnessPermissionMode | undefined {
  const providerConfig = harnessProviderConfig(config, id);
  if (providerConfig?.permissionMode !== undefined) {
    return providerConfig.permissionMode;
  }
  if (config.defaults.harnessPermissionMode !== undefined) {
    return config.defaults.harnessPermissionMode;
  }
  return undefined;
}

/** Observer socket/state/spool paths are wired identically into every harness adapter. */
function applyObserverPaths(
  options: {
    observerSocketPath?: string;
    stateDir?: string;
    hookSpoolDir?: string;
    autoStartFromHooks?: boolean;
  },
  config: StationConfig,
  withAutoStart: boolean,
): void {
  const observerPaths = resolveObserverPaths(config);
  options.observerSocketPath = observerPaths.socketPath;
  options.stateDir = observerPaths.stateDir;
  options.hookSpoolDir = observerPaths.hookSpoolDir;
  if (withAutoStart) {
    options.autoStartFromHooks = config.observer?.autoStartFromHooks !== false;
  }
}

/** Permission/approval/sandbox/hook fields shared by the codex and opencode adapters. */
function applyHarnessAgentOptions(
  options: {
    command?: string;
    permissionMode?: HarnessPermissionMode;
    approvalPolicy?: string;
    sandboxMode?: string;
    installHooks?: boolean;
  },
  providerConfig: HarnessProviderConfig | undefined,
  permissionMode: HarnessPermissionMode | undefined,
): void {
  if (providerConfig?.command !== undefined) options.command = providerConfig.command;
  if (permissionMode !== undefined) options.permissionMode = permissionMode;
  if (providerConfig?.approvalPolicy !== undefined) {
    options.approvalPolicy = providerConfig.approvalPolicy;
  }
  if (providerConfig?.sandboxMode !== undefined) options.sandboxMode = providerConfig.sandboxMode;
  if (providerConfig?.installHooks !== undefined)
    options.installHooks = providerConfig.installHooks;
}

function health(providerId: string, providerType: ProviderHealth["providerType"]): ProviderHealth {
  return {
    providerId,
    providerType,
    status: "healthy",
    lastCheckedAt: toIsoTimestamp(systemClock.now()),
  };
}

function unavailableHealth(
  providerId: string,
  providerType: ProviderHealth["providerType"],
  capabilities: Record<string, boolean>,
): ProviderHealth {
  return {
    providerId,
    providerType,
    status: "unavailable",
    lastCheckedAt: toIsoTimestamp(systemClock.now()),
    lastError: providerUnavailableError(providerId),
    capabilities,
  };
}

function providerUnavailableError(providerId: string): SafeError {
  return {
    tag: "ProviderUnavailableError",
    code: "PROVIDER_NOT_REGISTERED",
    message: "The configured provider is not registered.",
    provider: providerId,
  };
}

class NoopWorktreeProvider implements WorktreeProvider {
  constructor(readonly id: string) {}

  capabilities(): WorktreeCapabilities {
    return {
      canCreate: false,
      canRemove: false,
      canList: true,
      canEmitLifecycleEvents: true,
      canExposeDirtyState: false,
      canSeedWorkingTree: false,
    };
  }

  async health(): Promise<ProviderHealth> {
    return health(this.id, "worktree");
  }

  async listWorktrees(): Promise<WorktreeObservation[]> {
    return [];
  }

  async createWorktree(): Promise<WorktreeObservation> {
    throw new Error("No worktree provider is configured.");
  }

  async removeWorktree(): Promise<{ worktreeId: string; removed: boolean; reason?: string }> {
    return { worktreeId: "unknown", removed: false, reason: "No worktree provider is configured." };
  }
}

class UnavailableWorktreeProvider implements WorktreeProvider {
  constructor(readonly id: string) {}

  capabilities(): WorktreeCapabilities {
    return {
      canCreate: false,
      canRemove: false,
      canList: false,
      canEmitLifecycleEvents: false,
      canExposeDirtyState: false,
      canSeedWorkingTree: false,
    };
  }

  async health(): Promise<ProviderHealth> {
    return unavailableHealth(this.id, "worktree", this.capabilities());
  }

  async listWorktrees(): Promise<WorktreeObservation[]> {
    return [];
  }

  async createWorktree(): Promise<never> {
    throw providerUnavailableError(this.id);
  }

  async removeWorktree(): Promise<never> {
    throw providerUnavailableError(this.id);
  }
}

class NoopTerminalProvider implements TerminalProvider {
  constructor(readonly id: string) {}

  capabilities(): TerminalCapabilities {
    return {
      canOpenWorkspace: false,
      canFocusTarget: false,
      canCloseTarget: false,
      canCaptureOutput: false,
      canSendInput: false,
      canPersistIdentityBinding: false,
      canDisplayPopup: false,
    };
  }

  async health(): Promise<ProviderHealth> {
    return health(this.id, "terminal");
  }

  async listTargets(): Promise<TerminalTargetObservation[]> {
    return [];
  }

  async openWorkspace(): Promise<never> {
    throw new Error("No terminal provider is configured.");
  }

  async focusTarget(): Promise<void> {}

  async closeTarget(): Promise<void> {}
}

class UnavailableTerminalProvider implements TerminalProvider {
  constructor(readonly id: string) {}

  capabilities(): TerminalCapabilities {
    return {
      canOpenWorkspace: false,
      canFocusTarget: false,
      canCloseTarget: false,
      canCaptureOutput: false,
      canSendInput: false,
      canPersistIdentityBinding: false,
      canDisplayPopup: false,
    };
  }

  async health(): Promise<ProviderHealth> {
    return unavailableHealth(this.id, "terminal", this.capabilities());
  }

  async listTargets(): Promise<TerminalTargetObservation[]> {
    return [];
  }

  async openWorkspace(): Promise<never> {
    throw providerUnavailableError(this.id);
  }

  async focusTarget(): Promise<never> {
    throw providerUnavailableError(this.id);
  }

  async closeTarget(): Promise<never> {
    throw providerUnavailableError(this.id);
  }
}

class NoopHarnessProvider implements HarnessProvider {
  constructor(readonly id: string) {}

  capabilities(): HarnessCapabilities {
    return {
      canLaunch: false,
      canDiscoverRuns: true,
      canEmitEvents: true,
      canClassifyStatus: false,
      canReceivePrompt: false,
      canResume: false,
      canStop: false,
      canRunNonInteractive: false,
      canExposeApprovalState: false,
      supportsModifiedEnterSoftNewline: false,
    };
  }

  async health(): Promise<ProviderHealth> {
    return health(this.id, "harness");
  }

  async buildLaunch(): Promise<never> {
    throw new Error("No harness provider is configured.");
  }

  async discoverRuns(): Promise<HarnessRunObservation[]> {
    return [];
  }

  async classifyRun(): Promise<never> {
    throw new Error("No harness provider is configured.");
  }
}

class UnavailableHarnessProvider implements HarnessProvider {
  constructor(readonly id: string) {}

  capabilities(): HarnessCapabilities {
    return {
      canLaunch: false,
      canDiscoverRuns: false,
      canEmitEvents: false,
      canClassifyStatus: false,
      canReceivePrompt: false,
      canResume: false,
      canStop: false,
      canRunNonInteractive: false,
      canExposeApprovalState: false,
      supportsModifiedEnterSoftNewline: false,
    };
  }

  async health(): Promise<ProviderHealth> {
    return unavailableHealth(this.id, "harness", this.capabilities());
  }

  async buildLaunch(): Promise<never> {
    throw providerUnavailableError(this.id);
  }

  async discoverRuns(): Promise<HarnessRunObservation[]> {
    return [];
  }

  async classifyRun(): Promise<never> {
    throw providerUnavailableError(this.id);
  }
}

export class UnavailableRepositoryProvider implements RepositoryProvider {
  constructor(readonly id: string) {}

  capabilities(): RepositoryCapabilities {
    return {
      canDiscoverPullRequests: false,
      canReadChecks: false,
      canUseCliAuth: false,
    };
  }

  async health(): Promise<ProviderHealth> {
    return unavailableHealth(this.id, "repository", this.capabilities());
  }

  async discoverPullRequest(): Promise<never> {
    throw providerUnavailableError(this.id);
  }

  async readChecks(): Promise<never> {
    throw providerUnavailableError(this.id);
  }
}
