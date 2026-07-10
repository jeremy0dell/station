import type {
  HarnessProvider,
  HarnessVersionInfo,
  ManagedTerminalLifecycle,
  ProviderHealth,
  ProviderHookAdapter,
  ProviderId,
  RepositoryProvider,
  TerminalProvider,
  WorktreeProvider,
} from "@station/contracts";
import { withTimeout } from "@station/runtime";
import {
  ProviderHealthCache,
  type ProviderHealthCacheTuning,
  type ProviderHealthProbeTarget,
} from "./healthCache.js";

function registerTerminal(
  terminals: Map<string, TerminalProvider>,
  provider: TerminalProvider,
): void {
  const registered = terminals.get(provider.id);
  if (registered !== undefined && registered !== provider) {
    throw new Error(`Duplicate terminal provider id: ${provider.id}`);
  }
  terminals.set(provider.id, provider);
}

export type ProviderRegistryInput = {
  worktree: WorktreeProvider;
  /** The default terminal provider (used for project-config back-compat). */
  terminal: TerminalProvider;
  /** Terminal lifecycle used by Station's external-launch handshake. */
  managedTerminal?: ManagedTerminalLifecycle | undefined;
  /**
   * Additional general terminal providers beyond the default. The default and
   * managed lifecycle are always registered; extras are merged in.
   */
  terminals?: Iterable<TerminalProvider> | undefined;
  harnesses: Iterable<HarnessProvider> | Map<string, HarnessProvider>;
  repositories?: Iterable<RepositoryProvider> | Map<string, RepositoryProvider>;
  hookAdapters?: Iterable<ProviderHookAdapter> | undefined;
  healthCache?: ProviderHealthCacheTuning | undefined;
};

export class ProviderRegistry {
  readonly worktree: WorktreeProvider;
  /** All registered terminal providers, keyed by provider id. */
  readonly terminals: Map<string, TerminalProvider>;
  /** The default terminal provider id (project-config back-compat). */
  readonly defaultTerminalId: ProviderId;
  readonly managedTerminal: ManagedTerminalLifecycle | undefined;
  readonly harnesses: Map<string, HarnessProvider>;
  readonly repositories: Map<string, RepositoryProvider>;
  readonly hookAdapters: Map<string, ProviderHookAdapter>;
  readonly healthCache: ProviderHealthCache;

  constructor(input: ProviderRegistryInput) {
    this.worktree = input.worktree;

    this.defaultTerminalId = input.terminal.id;
    this.terminals = new Map();
    registerTerminal(this.terminals, input.terminal);
    for (const provider of input.terminals ?? []) {
      registerTerminal(this.terminals, provider);
    }
    this.managedTerminal = input.managedTerminal;
    if (this.managedTerminal !== undefined) {
      registerTerminal(this.terminals, this.managedTerminal);
    }

    if (input.harnesses instanceof Map) {
      this.harnesses = new Map(input.harnesses);
    } else {
      this.harnesses = new Map();
      for (const provider of input.harnesses) {
        if (this.harnesses.has(provider.id)) {
          throw new Error(`Duplicate harness provider id: ${provider.id}`);
        }
        this.harnesses.set(provider.id, provider);
      }
    }

    if (input.repositories instanceof Map) {
      this.repositories = new Map(input.repositories);
    } else {
      this.repositories = new Map();
      for (const provider of input.repositories ?? []) {
        if (this.repositories.has(provider.id)) {
          throw new Error(`Duplicate repository provider id: ${provider.id}`);
        }
        this.repositories.set(provider.id, provider);
      }
    }

    this.hookAdapters = new Map();
    for (const adapter of input.hookAdapters ?? []) {
      if (this.hookAdapters.has(adapter.provider)) {
        throw new Error(`Duplicate provider hook adapter id: ${adapter.provider}`);
      }
      this.hookAdapters.set(adapter.provider, adapter);
    }

    this.healthCache = new ProviderHealthCache({
      targets: healthProbeTargets(this),
      ...(input.healthCache ?? {}),
    });
  }

  /** The default terminal provider. Retained for single-provider back-compat. */
  get terminal(): TerminalProvider {
    const provider = this.terminals.get(this.defaultTerminalId);
    if (provider === undefined) {
      throw new Error(`Default terminal provider is not registered: ${this.defaultTerminalId}`);
    }
    return provider;
  }

  /** Version probe results; snapshots read this synchronously and omit absentees. */
  readonly harnessVersions = new Map<string, HarnessVersionInfo>();

  /**
   * Best-effort background probe (D17): fire-and-forget at boot. Each probe is
   * timeboxed and a failure simply leaves the harness out of the cache, so
   * reconciliation never waits on a CLI or the network.
   */
  async refreshHarnessVersions(options?: { timeoutMs?: number }): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 15_000;
    await Promise.all(
      Array.from(this.harnesses.values()).map(async (provider) => {
        const versionInfo = provider.versionInfo;
        if (versionInfo === undefined) {
          return;
        }
        try {
          const info = await withTimeout(() => versionInfo(), {
            timeoutMs,
            error: {
              tag: "RuntimeError",
              code: "HARNESS_VERSION_PROBE_FAILED",
              message: "Harness version probe failed.",
              provider: provider.id,
            },
            timeoutError: {
              tag: "TimeoutError",
              code: "HARNESS_VERSION_PROBE_TIMEOUT",
              message: "Harness version probe timed out.",
              provider: provider.id,
            },
          });
          if (info.installedVersion !== undefined || info.latestVersion !== undefined) {
            this.harnessVersions.set(provider.id, info);
          }
        } catch {
          // Unknown stays unknown; consumers omit the badge.
        }
      }),
    );
  }
}

type HealthProbeCapableProvider = {
  id: ProviderId;
  capabilities(): Record<string, boolean>;
  health(): Promise<ProviderHealth>;
};

function healthProbeTargets(registry: ProviderRegistry): ProviderHealthProbeTarget[] {
  const targets: ProviderHealthProbeTarget[] = [probeTarget(registry.worktree, "worktree")];
  for (const provider of registry.terminals.values()) {
    targets.push(probeTarget(provider, "terminal"));
  }
  for (const provider of registry.harnesses.values()) {
    targets.push(probeTarget(provider, "harness"));
  }
  for (const provider of registry.repositories.values()) {
    targets.push(probeTarget(provider, "repository"));
  }
  return targets;
}

function probeTarget(
  provider: HealthProbeCapableProvider,
  providerType: ProviderHealth["providerType"],
): ProviderHealthProbeTarget {
  return {
    providerId: provider.id,
    providerType,
    capabilities: () => provider.capabilities(),
    health: () => provider.health(),
  };
}
