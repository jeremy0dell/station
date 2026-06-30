import type { ProjectView } from "@station/contracts";
import {
  choiceValueByKey,
  type KeyedChoice,
  selectProjectChoices,
} from "../../selectors/selectors.js";
import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

/**
 * Shared skeleton for the dashboard's slot-key project choosers (`C` collapse,
 * `P` settings). They differ only in what a picked project does, so the screen
 * name and the on-pick transition are the parameters; everything else — the
 * snapshot guard, esc-to-dashboard, and slot resolution — stays in one place so
 * the pickers cannot drift apart.
 */
export type ProjectPickerScreen = "projectCollapse" | "projectSettingsPicker";

export function formatProjectChoicePrompt(
  choices: ReadonlyArray<KeyedChoice<{ label: string }>>,
): string {
  return choices.map((choice) => `${choice.key}:${choice.value.label}`).join(" ");
}

export function openProjectSlotPicker(state: TuiState, name: ProjectPickerScreen): TuiTransition {
  if (state.snapshot === undefined) {
    return { state };
  }
  return {
    state: {
      ...state,
      screen: {
        name,
        value: formatProjectChoicePrompt(selectProjectChoices(state.snapshot, state)),
      },
    },
  };
}

export function handleProjectSlotPickerKey(
  state: TuiState,
  key: TuiKey,
  name: ProjectPickerScreen,
  onPick: (state: TuiState, project: ProjectView) => TuiTransition,
): TuiTransition {
  if (state.screen.name !== name) {
    return { state };
  }
  if (key.escape === true) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }
  if (state.snapshot === undefined) {
    return { state };
  }
  const project = choiceValueByKey(selectProjectChoices(state.snapshot, state), key.input);
  if (project === undefined) {
    return { state };
  }
  return onPick(state, project);
}
