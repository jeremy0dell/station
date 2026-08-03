import { VtPrefix } from "./syntax.js";

/** Named legacy key sequences emitted or recognized directly by Station. */
export const LegacyKeySequence = {
  Backspace: "\x7f",
  ShiftTab: `${VtPrefix.Csi}Z`,
  PageUp: `${VtPrefix.Csi}5~`,
  PageDown: `${VtPrefix.Csi}6~`,
  Home: `${VtPrefix.Csi}H`,
  End: `${VtPrefix.Csi}F`,
  Insert: `${VtPrefix.Csi}2~`,
  Delete: `${VtPrefix.Csi}3~`,
} as const;
