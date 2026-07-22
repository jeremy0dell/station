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

export function isReturnKey(key: TuiKey): boolean {
  return key.return === true || key.input === "\r" || key.input === "\n";
}
