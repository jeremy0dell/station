import type {
  AgentPrepareExternalLaunchParams,
  AgentPrepareExternalLaunchResult,
  AgentReportExternalExitParams,
  AgentReportExternalExitResult,
  CommandId,
  CommandReceipt,
  SafeError,
  StationCommand,
  StationEvent,
  StationSnapshot,
} from "@station/contracts";

export type {
  AgentPrepareExternalLaunchParams,
  AgentPrepareExternalLaunchResult,
  AgentReportExternalExitParams,
  AgentReportExternalExitResult,
} from "@station/contracts";

export type StationClientCommandCompletion =
  | {
      status: "succeeded";
      commandId: CommandId;
    }
  | {
      status: "failed";
      commandId: CommandId;
      error: SafeError;
    };

/**
 * App-facing observer API with timeout and safe-error normalization applied.
 * Distinct from protocol's `ObserverClient`, which is the raw socket transport.
 */
export type ObserverService = {
  loadSnapshot(): Promise<StationSnapshot>;
  subscribeEvents(): AsyncIterable<StationEvent>;
  dispatch(command: StationCommand): Promise<CommandReceipt>;
  waitForCommandCompletion(commandId: CommandId): Promise<StationClientCommandCompletion>;
  reconcile(reason?: string): Promise<StationSnapshot>;
  /**
   * Ask the observer to mint a STATION identity for an externally-hosted (e.g.
   * Station-owned) primary agent and return its launch plan. Does not spawn.
   */
  prepareExternalLaunch(
    params: AgentPrepareExternalLaunchParams,
  ): Promise<AgentPrepareExternalLaunchResult>;
  /** Report that an externally-hosted agent's process exited. */
  reportExternalExit(params: AgentReportExternalExitParams): Promise<AgentReportExternalExitResult>;
};

export type ClientNotice = {
  kind: "info" | "success" | "error";
  message: string;
  hint?: string;
  commandId?: string;
  traceId?: string;
  diagnosticId?: string;
};

export type ApplyStationEventResult = {
  snapshot: StationSnapshot;
  needsSnapshotRefresh: boolean;
  notices: ClientNotice[];
};

export type StationClientConnectionState =
  | { state: "idle" }
  | { state: "loading"; since: number }
  | { state: "connected"; since: number }
  | { state: "reconnecting"; since: number; lastError: SafeError }
  | { state: "displayOnly"; since: number; lastError: SafeError }
  | { state: "halted"; since: number; lastError: SafeError };

export type StationClientRuntimeState = {
  snapshot?: StationSnapshot;
  connection: StationClientConnectionState;
  inFlightRefresh: boolean;
};

export type StationClientRefreshOutcome =
  | { status: "loaded"; snapshot: StationSnapshot }
  | { status: "connectFailure"; error: SafeError }
  | { status: "failure"; error: SafeError };

/**
 * Bridge callbacks for apps that need per-event and per-refresh side effects
 * (toasts, local-operation reconciliation). Hooks fire synchronously after the
 * runtime swaps its own state and before listeners are notified, and only for
 * runtime-initiated work; the public `refresh()` fires no hooks.
 */
export type StationClientRuntimeHooks = {
  onEvent?(event: StationEvent, application: ApplyStationEventResult | undefined): void;
  onSubscriptionError?(
    error: SafeError,
    info: { isConnectError: boolean; alreadyReported: boolean; willRetry: boolean },
  ): void;
  onRefreshSettled?(outcome: StationClientRefreshOutcome): void;
};

/**
 * Reconnect delays grow exponentially with jitter from `initialDelayMs`
 * (default 100) up to a hard `maxDelayMs` cap (default 5000), resetting after
 * a successful resubscribe.
 */
export type StationClientReconnectOptions = {
  initialDelayMs?: number;
  maxDelayMs?: number;
};

export type StationClientRuntimeOptions = {
  socketPath?: string;
  service?: ObserverService;
  initialSnapshot?: StationSnapshot;
  requestTimeoutMs?: number;
  commandWaitTimeoutMs?: number;
  reconcileTimeoutMs?: number;
  clientLabel?: string;
  reconnect?: StationClientReconnectOptions;
  hooks?: StationClientRuntimeHooks;
};

export type StationClientRuntime = {
  start(): void;
  stop(): Promise<void>;
  getState(): StationClientRuntimeState;
  subscribe(listener: () => void): () => void;
  refresh(reason?: string): Promise<void>;
  reconcile(reason?: string): Promise<void>;
  dispatch(command: StationCommand): Promise<CommandReceipt>;
  waitForCommand(commandId: CommandId): Promise<StationClientCommandCompletion>;
};
