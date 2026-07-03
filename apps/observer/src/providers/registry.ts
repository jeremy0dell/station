import type {
  HarnessProvider,
  HarnessVersionInfo,
  ProviderHookAdapter,
  ProviderId,
  RepositoryProvider,
  TerminalProvider,
  WorktreeProvider,
} from "@station/contracts";
import { createTerminalIntentRunner, type TerminalIntentRunner } from "./terminalIntentRunner.js";

export type ProviderRegistryInput = {
  worktree: WorktreeProvider;
  /** The default terminal provider (used for project-config back-compat). */
  terminal: TerminalProvider;
  /**
   * Additional terminal providers beyond the default (e.g. the externally-hosted
   * "station" provider). The default is always registered; extras are merged in.
   */
  terminals?: Iterable<TerminalProvider> | undefined;
  harnesses: Iterable<HarnessProvider> | Map<string, HarnessProvider>;
  repositories?: Iterable<RepositoryProvider> | Map<string, RepositoryProvider>;
  hookAdapters?: Iterable<ProviderHookAdapter> | undefined;
  terminalIntentRunner?: TerminalIntentRunner | undefined;
};

export class ProviderRegistry {
  readonly worktree: WorktreeProvider;
  /** All registered terminal providers, keyed by provider id. */
  readonly terminals: Map<string, TerminalProvider>;
  /** The default terminal provider id (project-config back-compat). */
  readonly defaultTerminalId: ProviderId;
  readonly harnesses: Map<string, HarnessProvider>;
  readonly repositories: Map<string, RepositoryProvider>;
  readonly hookAdapters: Map<string, ProviderHookAdapter>;
  readonly terminalIntentRunner: TerminalIntentRunner;

  constructor(input: ProviderRegistryInput) {
    this.worktree = input.worktree;

    this.defaultTerminalId = input.terminal.id;
    this.terminals = new Map([[input.terminal.id, input.terminal]]);
    for (const provider of input.terminals ?? []) {
      if (this.terminals.has(provider.id)) {
        throw new Error(`Duplicate terminal provider id: ${provider.id}`);
      }
      this.terminals.set(provider.id, provider);
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

    this.terminalIntentRunner =
      input.terminalIntentRunner ??
      createTerminalIntentRunner({
        providers: {
          terminals: this.terminals,
          harnesses: this.harnesses,
        },
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
        if (provider.versionInfo === undefined) {
          return;
        }
        try {
          const info = await withTimeout(provider.versionInfo(), timeoutMs);
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("version probe timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
