/** Complete CSI function identity, independent of any terminal-engine API. */
export type CsiFunctionIdentifier = Readonly<{
  prefix?: string;
  intermediates?: string;
  final: string;
}>;

/** Complete ESC function identity, independent of any terminal-engine API. */
export type EscFunctionIdentifier = Readonly<{
  intermediates?: string;
  final: string;
}>;

/** Narrow an xterm CSI parameter to its primary numeric value. */
export const isPrimaryCsiParameter = (
  parameter: number | number[],
): parameter is number => !Array.isArray(parameter);

/** CSI commands Station registers or emits directly. */
export const CsiCommand = {
  SetAnsiMode: { final: "h" },
  ResetAnsiMode: { final: "l" },
  SetDecPrivateMode: { prefix: "?", final: "h" },
  ResetDecPrivateMode: { prefix: "?", final: "l" },
  CursorPosition: { final: "H" },
  EraseInDisplay: { final: "J" },
  EraseCharacters: { final: "X" },
  SelectGraphicRendition: { final: "m" },
  SetScrollingRegion: { final: "r" },
  ScrollUp: { final: "S" },
  SelectCursorStyle: { intermediates: " ", final: "q" },
  SoftReset: { intermediates: "!", final: "p" },
  SaveCursor: { final: "s" },
  KittyPushFlags: { prefix: ">", final: "u" },
  KittyUpdateFlags: { prefix: "=", final: "u" },
  KittyPopFlags: { prefix: "<", final: "u" },
  KittyQueryFlags: { prefix: "?", final: "u" },
  KittyKeyEvent: { final: "u" },
} as const satisfies Record<string, CsiFunctionIdentifier>;

/** ESC commands Station registers or emits directly. */
export const EscCommand = {
  /** RIS — Reset to Initial State. */
  ResetToInitialState: { final: "c" },
  /** DECSC — save cursor and presentation state. */
  SaveCursor: { final: "7" },
} as const satisfies Record<string, EscFunctionIdentifier>;
