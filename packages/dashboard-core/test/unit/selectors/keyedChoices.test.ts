import { describe, expect, it } from "vitest";
import {
  choiceValueByKey,
  isSelectionKey,
  keyedSelectionChoices,
  SELECTION_KEYS,
  selectionChoices,
} from "../../../src/selectors/keyedChoices.js";

describe("keyed choices", () => {
  it("keeps every semantic choice while assigning the available shortcut keys", () => {
    const choices = selectionChoices(Array.from({ length: 36 }, (_, index) => index + 1));
    const keyed = keyedSelectionChoices(choices);

    expect(SELECTION_KEYS).toHaveLength(35);
    expect(choices.at(8)).toEqual({ key: "9", value: 9 });
    expect(choices.at(9)).toEqual({ key: "a", value: 10 });
    expect(choices.at(-2)).toEqual({ key: "z", value: 35 });
    expect(choices.at(-1)).toEqual({ value: 36 });
    expect(keyed).toHaveLength(35);
    expect(isSelectionKey("0")).toBe(false);
    expect(isSelectionKey("A")).toBe(false);
    expect(choiceValueByKey(keyed, "0")).toBeUndefined();
    expect(choiceValueByKey(keyed, "a")).toBe(10);
  });
});
