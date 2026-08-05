import type {
  StationClientConnectionState,
  StationClientState,
  StationClientStateSource,
} from "@station/client";
import type { StationSnapshot } from "@station/contracts";
import {
  createDashboardRuntime,
  type DashboardRuntime,
  type DashboardRuntimeOptions,
} from "../../src/state/runtime.js";

export type TestDashboardRuntimeOptions = Omit<DashboardRuntimeOptions, "source"> & {
  source?: StationClientStateSource;
  initialSnapshot?: StationSnapshot;
};

/** Build a dashboard projection test runtime with an explicit canonical client source. */
export function createTestDashboardRuntime(options: TestDashboardRuntimeOptions): DashboardRuntime {
  const { initialSnapshot, ...runtimeOptions } = options;
  return createDashboardRuntime({
    ...runtimeOptions,
    source: options.source ?? new FakeClientStateSource(initialSnapshot),
  });
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
