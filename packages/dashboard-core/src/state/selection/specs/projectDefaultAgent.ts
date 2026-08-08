import type { ProviderId } from "@station/contracts";
import { buildSetProjectDefaultHarnessCommand } from "../../commandBuilders.js";
import { closeProjectDefaultAgent } from "../../screens/projectDefaultAgent.js";
import type { TuiTransition } from "../../transition.js";
import type { DashboardState } from "../../types.js";
import { harnessPickerSpec } from "./harnessPicker.js";

function commitProjectDefaultAgent(state: DashboardState, harness: ProviderId): TuiTransition {
  if (state.screen.name !== "projectDefaultAgent" || state.snapshot === undefined) {
    return { state: closeProjectDefaultAgent(state) };
  }
  const { projectId } = state.screen;
  const project = state.snapshot.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined || harness === project.defaults.harness) {
    return { state: closeProjectDefaultAgent(state) };
  }
  return {
    state: closeProjectDefaultAgent(state),
    operations: [
      {
        type: "setProjectDefaultHarness",
        command: buildSetProjectDefaultHarnessCommand({ projectId: project.id, harness }),
      },
    ],
  };
}

export const projectDefaultAgentListSpec = harnessPickerSpec({
  listId: "projectDefaultAgent",
  resolveProject: (snapshot, state) => {
    if (state.screen.name !== "projectDefaultAgent") {
      return undefined;
    }
    const { projectId } = state.screen;
    return snapshot.projects.find((candidate) => candidate.id === projectId);
  },
  commit: commitProjectDefaultAgent,
});
