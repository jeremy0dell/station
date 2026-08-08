/**
 * Injected service contracts for dashboard runtime construction, relayed
 * from @station/client so dashboard declarations never reference the host
 * composition directly.
 */
export type {
  ClientNotice,
  ObserverService,
  StationClientCommandCompletion,
} from "@station/client";
