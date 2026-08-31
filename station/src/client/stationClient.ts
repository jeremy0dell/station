import type { ObserverService, StationClientStateSource } from "@station/client";

/**
 * Identity-free Station boundary pairing canonical client state with the
 * service that updates it before snapshot loads and reconciliation resolve.
 * Mock mode exposes the same shape with fixture state and a rejecting service.
 */
export type StationClient = {
  state: StationClientStateSource;
  service: ObserverService;
  start(): void;
  stop(): Promise<void>;
};
