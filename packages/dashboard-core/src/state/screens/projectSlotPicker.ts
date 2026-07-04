import { type KeyedChoice, selectProjectChooserChoices } from "../../selectors/selectors.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

/**
 * Opens the dashboard's project choosers (`C` collapse, `P` settings). Both
 * register on the shared selection engine, which owns arrows/↵/slot/mouse; each
 * chooser's screen-name is its list id and the difference is only its spec's
 * commit (toggle collapse vs open settings).
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
  const choices = selectProjectChooserChoices(state.snapshot);
  // Seed the cursor to the first project so ↑↓ starts from the highlighted row;
  // the shared selectionMiddleware then owns arrows/↵/slot for this list.
  const selection = new Map(state.selection);
  const first = choices[0];
  if (first !== undefined) {
    selection.set(name, first.value.id);
  }
  return {
    state: {
      ...state,
      selection,
      screen: { name, value: formatProjectChoicePrompt(choices) },
    },
  };
}
