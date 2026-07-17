import type { SafeError, StationEvent, StationSnapshot } from "@station/contracts";
import { Duration, Effect, Fiber, Schedule } from "@station/runtime";
import {
  connectedConnectionState,
  failureConnectionState,
  haltedConnectionState,
  isObserverConnectError,
} from "./connectionState.js";
import { isPermanentObserverError, type ToSafeErrorOptions, toSafeError } from "./errors.js";
import { createObserverService } from "./observerService.js";
import { applyStationEvent } from "./snapshotReducer.js";
import type {
  ObserverService,
  StationClientRuntime,
  StationClientRuntimeHooks,
  StationClientRuntimeOptions,
  StationClientRuntimeState,
} from "./types.js";

const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 100;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5_000;

type CycleEnding = "clean" | "failure" | "halted";

type RefreshSource = "managed" | "caller";

type RefreshFlightRequest = {
  source: RefreshSource;
  resolve(outcome: RefreshFlightOutcome): void;
};

type RefreshFlightOutcome =
  | { status: "loaded"; snapshot: StationSnapshot }
  | { status: "connectFailure"; error: SafeError; raw: unknown }
  | { status: "failure"; error: SafeError; raw: unknown; permanent: boolean };

/**
 * USE CASE
 *
 * Maintains one live Observer projection through either an injected service or
 * a socket transport pinned to the build selector already accepted by its caller.
 */
export function createStationClientRuntime(
  options: StationClientRuntimeOptions,
): StationClientRuntime {
  const service = resolveService(options);
  const hooks: StationClientRuntimeHooks = options.hooks ?? {};
  const initialDelayMs = options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
  const maxDelayMs = options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  const safeErrorOptions = createSafeErrorOptions(options.clientLabel);

  let state = initialRuntimeState(options.initialSnapshot);
  const listeners = new Set<() => void>();
  let active = false;
  let started = false;
  let stopPromise: Promise<void> | undefined;
  let currentIterator: AsyncIterator<StationEvent> | undefined;
  let reportedSubscriptionError = false;
  // Resync contract: events carry no sequence numbers, so missed events are
  // undetectable. After every subscription gap a full snapshot load must
  // complete while the new subscription is live before the runtime may report
  // connected again. A caller-provided initial snapshot is trusted.
  let resynced = options.initialSnapshot !== undefined;
  let subscriptionEpoch = 0;
  let activeEpoch: number | undefined;
  let cycleFault = false;
  let haltedFlag = false;
  let stopRequested = false;
  let refreshChainRunning = false;
  let mutationCounter = 0;
  const pendingRefreshRequests: RefreshFlightRequest[] = [];
  let loopFiber: Fiber.RuntimeFiber<void> | undefined;

  const isActive = (): boolean => active;

  // Once stop() has been requested the state is frozen: no replacement and no
  // listener notification may happen after stop() resolves.
  function swapState(next: StationClientRuntimeState): void {
    if (stopRequested) {
      return;
    }
    state = next;
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function applyConnectionFailure(error: ReturnType<typeof toSafeError>): void {
    swapState({
      ...state,
      connection: failureConnectionState(
        state.connection,
        error,
        state.snapshot !== undefined,
        Date.now(),
      ),
    });
  }

  function applyLoadedSnapshot(snapshot: StationSnapshot): void {
    swapState({
      ...state,
      snapshot,
      connection: connectedConnectionState(state.connection, Date.now()),
    });
  }

  // Terminal halt for permanent errors: stop retrying, keep the last good
  // snapshot, and unpark a live subscription so the loop observes the halt.
  function haltRuntime(error: SafeError): void {
    if (haltedFlag) {
      return;
    }
    haltedFlag = true;
    swapState({ ...state, connection: haltedConnectionState(error, Date.now()) });
    void currentIterator?.return?.();
  }

  // A loaded snapshot proves resync only if one subscription was live for the
  // whole load: started after the subscribe and applied while it still runs.
  // Loads that did not span a live subscription still update the snapshot but
  // may not enter connected; the current gap's own resync remains owed.
  function applyLoadedOutcome(snapshot: StationSnapshot, epochAtStart: number | undefined): void {
    const subscribedThroughout =
      !haltedFlag && epochAtStart !== undefined && epochAtStart === activeEpoch;
    if (subscribedThroughout) {
      resynced = true;
    }
    if (subscribedThroughout || state.connection.state === "connected") {
      applyLoadedSnapshot(snapshot);
      return;
    }
    swapState({ ...state, snapshot });
  }

  function setInFlightRefresh(value: boolean): void {
    if (state.inFlightRefresh !== value) {
      swapState({ ...state, inFlightRefresh: value });
    }
  }

  // One snapshot request flies at a time. Requests landing while a flight is
  // airborne are served by the next flight, which by construction starts at
  // or after the request. A flight whose response raced applied events chains
  // one more managed flight so a stale response is never the final word.
  function requestRefresh(source: RefreshSource): Promise<RefreshFlightOutcome> {
    return new Promise((resolve) => {
      pendingRefreshRequests.push({ source, resolve });
      if (!refreshChainRunning) {
        refreshChainRunning = true;
        setInFlightRefresh(true);
        void runRefreshChain();
      }
    });
  }

  async function runRefreshChain(): Promise<void> {
    try {
      while (pendingRefreshRequests.length > 0) {
        const requests = pendingRefreshRequests.splice(0);
        const flightSource: RefreshSource = requests.some((request) => request.source === "managed")
          ? "managed"
          : "caller";
        const mutationsAtStart = mutationCounter;
        const epochAtStart = activeEpoch;
        const outcome = await loadFlightOutcome();
        if (!stopRequested) {
          applyFlightOutcome(outcome, flightSource, epochAtStart);
        }
        for (const request of requests) {
          request.resolve(outcome);
        }
        const mutated = mutationCounter !== mutationsAtStart;
        if (
          !stopRequested &&
          !haltedFlag &&
          outcome.status === "loaded" &&
          mutated &&
          pendingRefreshRequests.length === 0
        ) {
          pendingRefreshRequests.push({ source: "managed", resolve: () => undefined });
        }
      }
    } finally {
      refreshChainRunning = false;
      setInFlightRefresh(false);
    }
  }

  async function loadFlightOutcome(): Promise<RefreshFlightOutcome> {
    try {
      const snapshot = await service.loadSnapshot();
      return { status: "loaded", snapshot };
    } catch (raw: unknown) {
      const error = toSafeError(raw, safeErrorOptions);
      if (isObserverConnectError(error)) {
        return { status: "connectFailure", error, raw };
      }
      return { status: "failure", error, raw, permanent: isPermanentObserverError(error) };
    }
  }

  // Ports the TUI store refresh: loaded snapshots flip the connection to
  // connected, connect failures flip to displayOnly/reconnecting, and other
  // failures leave the connection untouched (apps surface them via the hook).
  // Caller-sourced flights apply the snapshot but fire no hooks and never
  // touch failure state; refresh() callers keep their own error handling.
  function applyFlightOutcome(
    outcome: RefreshFlightOutcome,
    source: RefreshSource,
    epochAtStart: number | undefined,
  ): void {
    if (outcome.status === "loaded") {
      applyLoadedOutcome(outcome.snapshot, epochAtStart);
      if (source === "managed") {
        hooks.onRefreshSettled?.({ status: "loaded", snapshot: outcome.snapshot });
      }
      return;
    }
    // A permanent error is global truth about the socket pair, so it halts
    // the runtime regardless of which source's flight discovered it; a caller
    // still receives the rethrown raw error.
    if (outcome.status === "failure" && outcome.permanent) {
      haltRuntime(outcome.error);
      if (source === "managed") {
        hooks.onRefreshSettled?.({ status: "failure", error: outcome.error });
      }
      return;
    }
    if (source === "caller") {
      return;
    }
    if (outcome.status === "connectFailure") {
      applyConnectionFailure(outcome.error);
      hooks.onRefreshSettled?.({ status: "connectFailure", error: outcome.error });
      return;
    }
    hooks.onRefreshSettled?.({ status: "failure", error: outcome.error });
  }

  // Events never change connection state: connected is entered only when a
  // resync load applies. Events before the first snapshot cannot be reduced;
  // the in-flight initial resync covers them.
  function applyEvent(event: StationEvent): void {
    reportedSubscriptionError = false;
    if (state.snapshot === undefined) {
      hooks.onEvent?.(event, undefined);
      return;
    }
    const application = applyStationEvent(state.snapshot, event);
    mutationCounter += 1;
    swapState({ ...state, snapshot: application.snapshot });
    hooks.onEvent?.(event, application);
    if (application.needsSnapshotRefresh) {
      void requestRefresh("managed");
    }
  }

  function handleSubscriptionFailure(error: unknown): CycleEnding {
    const safeError = toSafeError(error, safeErrorOptions);
    const permanent = isPermanentObserverError(safeError);
    if (permanent) {
      // The halted swap happens before the hook, preserving the contract that
      // hooks fire after the runtime's own state change.
      haltRuntime(safeError);
    }
    if (isObserverConnectError(safeError)) {
      if (!permanent) {
        applyConnectionFailure(safeError);
      }
      reportedSubscriptionError = false;
      hooks.onSubscriptionError?.(safeError, {
        isConnectError: true,
        alreadyReported: false,
        willRetry: !permanent,
      });
    } else {
      const alreadyReported = reportedSubscriptionError;
      reportedSubscriptionError = true;
      hooks.onSubscriptionError?.(safeError, {
        isConnectError: false,
        alreadyReported,
        willRetry: !permanent,
      });
    }
    return permanent ? "halted" : "failure";
  }

  function openIterator(): AsyncIterator<StationEvent> {
    const iterator = service.subscribeEvents()[Symbol.asyncIterator]();
    currentIterator = iterator;
    return iterator;
  }

  function releaseIterator(): void {
    const iterator = currentIterator;
    currentIterator = undefined;
    void iterator?.return?.();
  }

  // One cycle = subscribe, then resync concurrently with consumption. The
  // resync is tied to the new subscription (subscribe-first), so events
  // emitted between the snapshot response and the subscribe ack cannot be
  // lost; events applied while the resync flight is airborne are converged by
  // the chain's staleness follow-up.
  async function runCycle(): Promise<CycleEnding> {
    subscriptionEpoch += 1;
    const epoch = subscriptionEpoch;
    activeEpoch = epoch;
    cycleFault = false;
    try {
      const iterator = openIterator();
      if (!resynced) {
        void runResync(epoch);
      }
      await consumeCurrentSubscription(iterator, isActive, applyEvent);
      if (haltedFlag) {
        return "halted";
      }
      return cycleFault ? "failure" : "clean";
    } catch (error) {
      if (!active) {
        return "failure";
      }
      return handleSubscriptionFailure(error);
    } finally {
      activeEpoch = undefined;
      releaseIterator();
    }
  }

  async function runResync(epoch: number): Promise<void> {
    const outcome = await requestRefresh("managed");
    if (!active || haltedFlag || activeEpoch !== epoch || outcome.status === "loaded") {
      return;
    }
    // A subscription that cannot resync must not park as healthy: end the
    // cycle so the backoff loop retries subscribe and resync together.
    cycleFault = true;
    void currentIterator?.return?.();
  }

  // The driver feeds the jittered exponential schedule into the loop: a cycle
  // that ended cleanly or achieved resync during its lifetime resets the
  // sequence, while consecutive unhealthy cycles escalate the next sleep.
  const subscriptionLoop: Effect.Effect<void> = Effect.gen(function* () {
    const driver = yield* Schedule.driver(reconnectSchedule(initialDelayMs, maxDelayMs));
    while (active && !haltedFlag) {
      const ending = yield* Effect.promise(runCycle);
      if (!active || haltedFlag || ending === "halted") {
        return;
      }
      if (ending === "clean" || resynced) {
        yield* driver.reset;
      }
      // Every gap demands a fresh resync before connected can be reported.
      resynced = false;
      yield* driver.next(undefined);
    }
  }).pipe(Effect.orDie);

  function start(): void {
    if (started || stopPromise !== undefined) {
      return;
    }
    started = true;
    active = true;
    if (state.snapshot === undefined) {
      // The first cycle's resync is the initial load; loading -> connected
      // goes through the same path as every later gap.
      swapState({ ...state, connection: { state: "loading", since: Date.now() } });
    } else {
      swapState({ ...state, connection: connectedConnectionState(state.connection, Date.now()) });
    }
    loopFiber = Effect.runFork(subscriptionLoop);
  }

  async function performStop(): Promise<void> {
    stopRequested = true;
    active = false;
    // Returning the iterator first unblocks a pending next() so the loop fiber
    // reaches an interruption point instead of waiting out the subscription.
    const iterator = currentIterator;
    currentIterator = undefined;
    try {
      await iterator?.return?.();
    } catch {
      // Iterator cleanup failures must not block shutdown.
    }
    if (loopFiber !== undefined) {
      await Effect.runPromise(Fiber.interrupt(loopFiber)).catch(() => undefined);
    }
  }

  return {
    start,
    stop: (): Promise<void> => {
      stopPromise ??= performStop();
      return stopPromise;
    },
    getState: () => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: async (_reason?: string): Promise<void> => {
      // Caller-owned refresh joins the single-flight chain: the loaded
      // snapshot applies to runtime state, but no hooks fire and failures
      // rethrow untouched, so operation call sites keep their error handling.
      const outcome = await requestRefresh("caller");
      if (outcome.status !== "loaded") {
        throw outcome.raw;
      }
    },
    reconcile: async (reason?: string): Promise<void> => {
      // Reconcile is its own observer call rather than a chain flight, but it
      // participates in the same invariants: the returned snapshot counts as
      // a resync under epoch gating, and the mutation bump makes an airborne
      // flight schedule a follow-up instead of clobbering reconciled state.
      const epochAtStart = activeEpoch;
      const loaded = await service.reconcile(reason);
      if (stopRequested) {
        return;
      }
      mutationCounter += 1;
      applyLoadedOutcome(loaded, epochAtStart);
      hooks.onRefreshSettled?.({ status: "loaded", snapshot: loaded });
    },
    dispatch: (command) => service.dispatch(command),
    waitForCommand: (commandId) => service.waitForCommandCompletion(commandId),
  };
}

// Jitter before the union so maxDelayMs is a hard bound: the union sleeps the
// minimum of the jittered exponential delay and the constant cap.
function reconnectSchedule(initialDelayMs: number, maxDelayMs: number) {
  return Schedule.exponential(Duration.millis(initialDelayMs)).pipe(
    Schedule.jittered,
    Schedule.union(Schedule.spaced(Duration.millis(maxDelayMs))),
  );
}

function createSafeErrorOptions(clientLabel: string | undefined): ToSafeErrorOptions {
  return clientLabel === undefined ? {} : { clientLabel };
}

function resolveService(options: StationClientRuntimeOptions): ObserverService {
  if (options.service !== undefined) {
    return options.service;
  }
  if (options.socketPath === undefined) {
    throw new Error("createStationClientRuntime requires service or socketPath.");
  }
  if (options.expectedBuildVersion === undefined) {
    throw new Error(
      "createStationClientRuntime socketPath requires an accepted Observer build selector.",
    );
  }
  return createObserverService({
    socketPath: options.socketPath,
    expectedBuildVersion: options.expectedBuildVersion,
    ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
    ...(options.reconcileTimeoutMs === undefined
      ? {}
      : { reconcileTimeoutMs: options.reconcileTimeoutMs }),
    ...(options.commandWaitTimeoutMs === undefined
      ? {}
      : { commandWaitTimeoutMs: options.commandWaitTimeoutMs }),
    ...(options.clientLabel === undefined ? {} : { clientLabel: options.clientLabel }),
  });
}

function initialRuntimeState(
  initialSnapshot: StationSnapshot | undefined,
): StationClientRuntimeState {
  const base: StationClientRuntimeState = {
    connection: { state: "idle" },
    inFlightRefresh: false,
  };
  if (initialSnapshot !== undefined) {
    base.snapshot = initialSnapshot;
  }
  return base;
}

async function consumeCurrentSubscription(
  iterator: AsyncIterator<StationEvent>,
  isActive: () => boolean,
  handleEvent: (event: StationEvent) => void,
): Promise<void> {
  for (;;) {
    const next = await iterator.next();
    if (!isActive()) {
      return;
    }
    if (next.done) {
      return;
    }
    handleEvent(next.value);
  }
}
