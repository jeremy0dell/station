import { scenarioState, type StationScenarioName } from "../station/fixtures/scenarios.js";
import { createStationStubObserverService } from "../station/store/stubObserverService.js";
import type { StationClient, StationState, StationStateSource } from "./types.js";

export function createMockStationClient(scenario: StationScenarioName = "baseline"): StationClient {
  const state = createStaticStateSource(scenarioState(scenario));

  return {
    state,
    service: createStationStubObserverService(state),
    start: () => {},
    stop: async () => {},
  };
}

function createStaticStateSource(state: StationState): StationStateSource {
  return {
    getState: () => state,
    subscribe: () => () => {},
  };
}
