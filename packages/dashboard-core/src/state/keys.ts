export type TuiKey = {
  input: string;
  ctrl?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  mouseScroll?: "up" | "down";
};

export type InkKeyInput = {
  ctrl?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
};

export function normalizeTuiKey(input: string, key: InkKeyInput): TuiKey {
  const tuiKey: TuiKey = { input };
  if (key.ctrl === true) tuiKey.ctrl = true;
  if (key.return === true) tuiKey.return = true;
  if (key.escape === true) tuiKey.escape = true;
  if (key.backspace === true) tuiKey.backspace = true;
  if (key.delete === true) tuiKey.delete = true;
  if (key.upArrow === true) tuiKey.upArrow = true;
  if (key.downArrow === true) tuiKey.downArrow = true;
  if (key.leftArrow === true) tuiKey.leftArrow = true;
  if (key.rightArrow === true) tuiKey.rightArrow = true;
  return tuiKey;
}

export function isReturnKey(key: TuiKey): boolean {
  return key.return === true || key.input === "\r" || key.input === "\n";
}
