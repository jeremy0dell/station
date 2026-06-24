import { useSyncExternalStore } from "react";
import type { StationState, StationStateSource } from "../sources/types.js";

export function useStationState(source: StationStateSource): StationState {
  return useSyncExternalStore(source.subscribe, source.getState, source.getState);
}
