import type {
  StationClientConnectionState,
  StationClientState,
  StationClientStateSource,
} from "@station/client";
import type { StationSnapshot, TerminalFocusOrigin } from "@station/contracts";
import type { TuiFolderService } from "../../src/services/folderService.js";
import {
  createObserverActivationCapabilities,
  type DashboardFocusTarget,
} from "../../src/state/capabilities/activation.js";
import type { DashboardCapabilities } from "../../src/state/capabilities/execution.js";
import { dashboardExecution } from "../../src/state/capabilities/execution.js";
import { createObserverManagedSessionCapabilities } from "../../src/state/capabilities/managedSessions.js";
import { createObserverWorktreeRemovalCapabilities } from "../../src/state/capabilities/worktreeRemoval.js";
import {
  createDashboardRuntime,
  type DashboardRuntime,
  type DashboardRuntimeOptions,
} from "../../src/state/runtime.js";
import { createFakeDashboardCapabilities } from "./fakeDashboardCapabilities.js";

export type TestDashboardRuntimeOptions = Omit<
  DashboardRuntimeOptions,
  "source" | "capabilities" | "folderService"
> & {
  source?: StationClientStateSource;
  initialSnapshot?: StationSnapshot;
  capabilities?: DashboardRuntimeOptions["capabilities"];
  folderService?: TuiFolderService;
  persistentPopup?: boolean;
  focusOrigin?: TerminalFocusOrigin;
  resolveFocusTarget?: () => Promise<DashboardFocusTarget | undefined>;
  onFocusSuccess?: () => Promise<void>;
  onDismiss?: () => Promise<void>;
  onExit?: (code: number) => void;
  exitOnFocusSuccess?: boolean;
};

/** Build a dashboard projection test runtime with an explicit canonical client source. */
export function createTestDashboardRuntime(options: TestDashboardRuntimeOptions): DashboardRuntime {
  const {
    initialSnapshot,
    capabilities,
    persistentPopup,
    focusOrigin,
    resolveFocusTarget,
    onFocusSuccess,
    onDismiss,
    onExit,
    exitOnFocusSuccess,
    ...runtimeOptions
  } = options;
  const source = options.source ?? new FakeClientStateSource(initialSnapshot);
  return createDashboardRuntime({
    ...runtimeOptions,
    source,
    folderService: options.folderService ?? createFakeFolderService(),
    capabilities:
      capabilities ??
      createLegacyTestCapabilities({
        source,
        service: options.service,
        persistentPopup: persistentPopup === true,
        exitOnFocusSuccess: exitOnFocusSuccess === true,
        ...(focusOrigin === undefined ? {} : { focusOrigin }),
        ...(resolveFocusTarget === undefined ? {} : { resolveFocusTarget }),
        ...(onFocusSuccess === undefined ? {} : { onFocusSuccess }),
        ...(onDismiss === undefined ? {} : { onDismiss }),
        ...(onExit === undefined ? {} : { onExit }),
      }),
  });
}

function createFakeFolderService(): TuiFolderService {
  return {
    cwd: () => "/workspace/station",
    homeDir: () => "/Users/example",
    parent: (path) => path,
    readDirectory: async (path) => ({ path, entries: [] }),
    searchDirectories: async (query) => ({ query, entries: [], truncated: false }),
    reviewFolder: async (path) => ({ selectedPath: path, id: "project", label: "project" }),
  };
}

function createLegacyTestCapabilities(options: {
  source: StationClientStateSource;
  service: DashboardRuntimeOptions["service"];
  persistentPopup: boolean;
  exitOnFocusSuccess: boolean;
  focusOrigin?: TerminalFocusOrigin;
  resolveFocusTarget?: () => Promise<DashboardFocusTarget | undefined>;
  onFocusSuccess?: () => Promise<void>;
  onDismiss?: () => Promise<void>;
  onExit?: (code: number) => void;
}): DashboardCapabilities {
  const activationOptions: Parameters<typeof createObserverActivationCapabilities>[0] = {
    source: options.source,
    service: options.service,
    clientLabel: "TUI test",
    waitForFocusCompletion: options.persistentPopup || options.exitOnFocusSuccess,
  };
  if (options.focusOrigin !== undefined) activationOptions.focusOrigin = options.focusOrigin;
  if (options.resolveFocusTarget !== undefined) {
    activationOptions.resolveFocusTarget = options.resolveFocusTarget;
  }
  if (options.onFocusSuccess !== undefined)
    activationOptions.onFocusSuccess = options.onFocusSuccess;
  const managedOptions: Parameters<typeof createObserverManagedSessionCapabilities>[0] = {
    service: options.service,
    clientLabel: "TUI test",
  };
  if (options.focusOrigin !== undefined) managedOptions.focusOrigin = options.focusOrigin;
  if (options.resolveFocusTarget !== undefined) {
    managedOptions.resolveFocusTarget = options.resolveFocusTarget;
  }
  return {
    activation: createObserverActivationCapabilities(activationOptions),
    managedSessions: createObserverManagedSessionCapabilities(managedOptions),
    worktreeRemoval: createObserverWorktreeRemovalCapabilities({
      service: options.service,
      clientLabel: "TUI test",
    }),
    shell: createFakeDashboardCapabilities().shell,
    dismissal: {
      dismissDashboard: () =>
        dashboardExecution(
          (options.onDismiss?.() ?? Promise.resolve()).then(() => ({ kind: "success" }) as const),
        ),
      exitRenderer: ({ exitCode }) => {
        if (options.persistentPopup && options.onDismiss !== undefined) {
          return dashboardExecution(options.onDismiss().then(() => ({ kind: "success" }) as const));
        }
        options.onExit?.(exitCode);
        return dashboardExecution({ kind: "success" });
      },
    },
  };
}

/** Mutable canonical client source for dashboard projection tests. */
export class FakeClientStateSource implements StationClientStateSource {
  subscribeCount = 0;
  unsubscribeCount = 0;
  private state: StationClientState;
  private readonly listeners = new Set<() => void>();

  constructor(
    snapshot?: StationSnapshot,
    connection: StationClientConnectionState = { state: "connected", since: Date.now() },
  ) {
    this.state = {
      ...(snapshot === undefined ? {} : { snapshot }),
      connection,
    };
  }

  getState(): StationClientState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.subscribeCount += 1;
    this.listeners.add(listener);
    return () => {
      if (this.listeners.delete(listener)) {
        this.unsubscribeCount += 1;
      }
    };
  }

  setSnapshot(snapshot: StationSnapshot): void {
    this.setState({ ...this.state, snapshot });
  }

  setConnection(connection: StationClientConnectionState): void {
    this.setState({ ...this.state, connection });
  }

  setState(state: StationClientState): void {
    this.state = state;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
