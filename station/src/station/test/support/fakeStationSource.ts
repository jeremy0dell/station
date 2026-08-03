import type { StationClientConnectionState } from "@station/client";
import type { StationSnapshot } from "@station/contracts";
import type { StationState, StationStateSource } from "../../../sources/types.js";

/**
 * Controllable source for tests: drives source state (setSnapshot/setConnection),
 * one boundary up from FakeTuiObserverService, which drives observer events.
 */
export class FakeStationSource implements StationStateSource {
  started = 0;
  stopped = 0;
  private state: StationState;
  private readonly listeners = new Set<() => void>();

  constructor(snapshot?: StationSnapshot, connection?: StationClientConnectionState) {
    this.state = {
      ...(snapshot === undefined ? {} : { snapshot }),
      connection: connection ?? { state: "connected", since: Date.now() },
    };
  }

  start(): void {
    this.started += 1;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }

  getState(): StationState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setSnapshot(snapshot: StationSnapshot): void {
    this.state = { ...this.state, snapshot };
    this.notify();
  }

  setConnection(connection: StationClientConnectionState): void {
    this.state = { ...this.state, connection };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
