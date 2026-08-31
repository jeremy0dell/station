export const SELECTION_KEYS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
] as const;

export type SelectionKey = (typeof SELECTION_KEYS)[number];

export type KeyedChoice<T> = {
  key: SelectionKey;
  value: T;
};

/** One semantic picker item; shortcuts are accelerators, not list membership. */
export type SelectionChoice<T> = {
  key?: SelectionKey;
  value: T;
};

export function selectionChoices<T>(values: readonly T[]): Array<SelectionChoice<T>> {
  return values.map((value, index) => {
    const key = SELECTION_KEYS[index];
    return key === undefined ? { value } : { key, value };
  });
}

export function keyedSelectionChoices<T>(
  choices: readonly SelectionChoice<T>[],
): Array<KeyedChoice<T>> {
  return choices.flatMap((choice) =>
    choice.key === undefined ? [] : [{ key: choice.key, value: choice.value }],
  );
}

export function choiceValueByKey<T>(
  choices: readonly KeyedChoice<T>[],
  input: string,
): T | undefined {
  return choices.find((choice) => choice.key === input)?.value;
}

export function isSelectionKey(input: string): input is SelectionKey {
  return SELECTION_KEYS.includes(input as SelectionKey);
}
