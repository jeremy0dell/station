import type { TuiKey } from "../keys.js";
import { handleLegacyDashboardSearchKey, openLegacyDashboardSearch } from "../screens/search.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

/**
 * Selected once at composition so reducers and render/input leaves receive resolved behavior; downstream feature-flag checks are forbidden.
 */
export type DashboardSearchExperience = {
  open(state: TuiState): TuiTransition;
  handleKey(state: TuiState, key: TuiKey): TuiTransition;
};

export const legacySearchExperience: DashboardSearchExperience = {
  open: openLegacyDashboardSearch,
  handleKey: handleLegacyDashboardSearchKey,
};

// Keep a separate identity so #395 can change this selected arm without changing #394 behavior.
export const persistentFilterExperience: DashboardSearchExperience = {
  open: openLegacyDashboardSearch,
  handleKey: handleLegacyDashboardSearchKey,
};
