import type { ObserverService, StationClientConnectionState } from "@station/client";
import type { StationSnapshot } from "@station/contracts";

/**
 * What the overlay renders: the latest observer truth plus how trustworthy it
 * is. `snapshot` stays populated with the last good snapshot while the
 * connection is reconnecting/display-only/halted.
 */
export type StationState = {
  snapshot?: StationSnapshot;
  connection: StationClientConnectionState;
};

/**
 * Source-swappable STATION state boundary with no source identity; live vs mock is
 * chosen once at construction, and downstream code sees the same shape.
 */
export interface StationStateSource {
  getState(): StationState;
  subscribe(listener: () => void): () => void;
}

/**
 * Identity-free Station boundary for STATION dashboard state and commands.
 * Live mode uses one ObserverService for both runtime state and dispatch;
 * mock mode exposes the same shape with fixture state and the rejecting
 * command service.
 */
export type StationClient = {
  state: StationStateSource;
  service: ObserverService;
  start(): void;
  stop(): Promise<void>;
};
