import type { ProjectView, ProviderId, StationSnapshot } from "@station/contracts";
import { selectNewSessionHarnessChoices } from "../../../selectors/selectors.js";
import type { TuiTransition } from "../../transition.js";
import type { TuiState } from "../../types.js";
import { flatPickerSpec } from "../flatPicker.js";
import type { RegisteredListSpec } from "../types.js";

/**
 * The one "pick a harness/agent" list behind all three agent surfaces
 * (new-session agent, project default, project-settings default). They are the
 * same list — cursor, slot, and the shared AgentChoiceListView view — and
 * differ only in which project the choices come from (`resolveProject`), what
 * committing one does (`commit`), and whether it is gated to a sub-pane
 * (`active`). Those are the props; everything else is identical.
 */
export function harnessPickerSpec(config: {
  listId: string;
  resolveProject: (snapshot: StationSnapshot, state: TuiState) => ProjectView | undefined;
  commit: (state: TuiState, harness: ProviderId) => TuiTransition;
  active?: (state: TuiState) => boolean;
}): RegisteredListSpec {
  return flatPickerSpec<ProviderId>({
    listId: config.listId,
    ...(config.active === undefined ? {} : { active: config.active }),
    choices: (state) => {
      if (state.snapshot === undefined) {
        return [];
      }
      const project = config.resolveProject(state.snapshot, state);
      if (project === undefined) {
        return [];
      }
      return selectNewSessionHarnessChoices(state.snapshot, project).map((choice) => ({
        key: choice.key,
        value: choice.value.id,
      }));
    },
    commit: config.commit,
  });
}
