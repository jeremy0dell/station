// Station's outer terminal may send enhanced keyboard encodings (kitty CSI-u
// or xterm modifyOtherKeys), but pane children that never opted in still expect
// legacy bytes: forwarding `\x1b[99;5u` instead of `\x03` breaks Ctrl-C, Esc,
// and friends inside every pane. This is a best-effort de-escalation of those
// sequences to the bytes a legacy terminal would have sent.

import { ARROW_KEYS } from "../protocol/cursorKeys.js";
import { KittyEvent, KittyKey, KittyModifierBit } from "../protocol/kitty.js";

const CSI_U_PATTERN = /^\x1b\[([0-9:]+)(?:;([0-9:]+))?u$/;
const XTERM_MODIFY_OTHER_KEYS_PATTERN = /^\x1b\[27;([0-9]+);([0-9]+)~$/;

type ModifiedKeySequence = {
  codePoint: number;
  codeParts: string[];
  modifierValue: number;
  eventType: number;
};

/**
 * Translates enhanced-keyboard sequences into the legacy byte string a
 * non-kitty terminal would send. Unmatched sequences pass through unchanged;
 * key-release events translate to "" (drop, do not forward).
 */
export function kittySequenceToLegacy(
  sequence: string,
  options?: { preserveModifiedEnter?: boolean },
): string {
  const parsed = parseModifiedKeySequence(sequence);
  if (parsed === undefined) {
    return sequence;
  }

  if (!Number.isFinite(parsed.codePoint)) {
    return sequence;
  }
  if (parsed.eventType === KittyEvent.Release) {
    return "";
  }

  const modifiers = (Number.isFinite(parsed.modifierValue) ? parsed.modifierValue : 1) - 1;
  const shift = (modifiers & KittyModifierBit.Shift) !== 0;
  const alt = (modifiers & KittyModifierBit.Alt) !== 0;
  const ctrl = (modifiers & KittyModifierBit.Ctrl) !== 0;

  // A focused modern-TUI agent pane (Codex) reads CSI-u Shift+Enter as a
  // newline-without-submit, so pass it through raw there. A plain shell never
  // enabled kitty mode, so it still gets a legacy CR (the default below).
  if (
    options?.preserveModifiedEnter === true &&
    parsed.codePoint === KittyKey.Enter &&
    shift &&
    !alt &&
    !ctrl
  ) {
    return modifiedEnterSequence(sequence, parsed);
  }

  const base = legacyBaseBytes(parsed.codePoint, parsed.codeParts, { shift, ctrl });
  if (base === undefined) {
    // Unknown functional key: dropping it beats leaking enhanced-key bytes into
    // a child that will render them as garbage input.
    return "";
  }
  return alt ? `\x1b${base}` : base;
}

function parseModifiedKeySequence(sequence: string): ModifiedKeySequence | undefined {
  const xterm = XTERM_MODIFY_OTHER_KEYS_PATTERN.exec(sequence);
  if (xterm !== null) {
    const modifierValue = Number.parseInt(xterm[1] ?? "1", 10);
    const codePoint = Number.parseInt(xterm[2] ?? "", 10);
    return {
      codePoint,
      codeParts: [String(codePoint)],
      modifierValue,
      eventType: 1,
    };
  }

  const csiU = CSI_U_PATTERN.exec(sequence);
  if (csiU === null) {
    return undefined;
  }

  const codeField = csiU[1] ?? "";
  const modifierField = csiU[2] ?? "1";
  const codeParts = codeField.split(":");
  const modifierParts = modifierField.split(":");

  return {
    codePoint: Number.parseInt(codeParts[0] ?? "", 10),
    codeParts,
    modifierValue: Number.parseInt(modifierParts[0] ?? "1", 10),
    eventType: Number.parseInt(modifierParts[1] ?? "1", 10),
  };
}

function modifiedEnterSequence(sequence: string, parsed: ModifiedKeySequence): string {
  return XTERM_MODIFY_OTHER_KEYS_PATTERN.test(sequence)
    ? `\x1b[${parsed.codePoint};${parsed.modifierValue}u`
    : sequence;
}

function legacyBaseBytes(
  codePoint: number,
  codeParts: string[],
  state: { shift: boolean; ctrl: boolean },
): string | undefined {
  switch (codePoint) {
    case KittyKey.Escape:
      return "\x1b";
    case KittyKey.Enter:
      return "\r";
    case KittyKey.Tab:
      return state.shift ? "\x1b[Z" : "\t";
    case KittyKey.Backspace:
      return state.ctrl ? "\x08" : "\x7f";
    case KittyKey.Space:
      return state.ctrl ? "\x00" : " ";
    default:
      break;
  }

  if (state.ctrl) {
    const control = controlByteFor(codePoint);
    if (control !== undefined) {
      return control;
    }
  }

  // Kitty encodes functional keys in the Unicode private-use area. Keypad
  // keys have direct legacy equivalents (a numpad Enter must type Enter);
  // the rest (F-keys, media keys, modifiers-as-keys) are dropped.
  const keypad = KEYPAD_LEGACY.get(codePoint);
  if (keypad !== undefined) {
    return keypad;
  }
  if (codePoint >= 0xe000 && codePoint <= 0xf8ff) {
    return undefined;
  }
  // Malformed sequences can carry fields beyond the Unicode range;
  // String.fromCodePoint would throw inside the input dispatch path.
  if (codePoint > 0x10ffff) {
    return undefined;
  }

  if (codePoint >= 0x20 && codePoint !== KittyKey.Backspace) {
    // With shift, kitty reports the shifted character as the first alternate
    // (`code:shifted`); prefer it so Shift+1 emits "!" not "1".
    if (state.shift && codeParts.length > 1) {
      const shifted = Number.parseInt(codeParts[1] ?? "", 10);
      if (Number.isFinite(shifted) && shifted >= 0x20 && shifted <= 0x10ffff) {
        return String.fromCodePoint(shifted);
      }
    }
    if (state.shift) {
      const shifted = shiftedAscii(codePoint);
      if (shifted !== undefined) {
        return shifted;
      }
    }
    return String.fromCodePoint(codePoint);
  }

  return undefined;
}

function shiftedAscii(codePoint: number): string | undefined {
  if (codePoint >= 0x61 && codePoint <= 0x7a) {
    return String.fromCharCode(codePoint - 0x20);
  }
  return SHIFTED_ASCII.get(codePoint);
}

const SHIFTED_ASCII = new Map<number, string>([
  [0x31, "!"],
  [0x32, "@"],
  [0x33, "#"],
  [0x34, "$"],
  [0x35, "%"],
  [0x36, "^"],
  [0x37, "&"],
  [0x38, "*"],
  [0x39, "("],
  [0x30, ")"],
  [0x60, "~"],
  [0x2d, "_"],
  [0x3d, "+"],
  [0x5b, "{"],
  [0x5d, "}"],
  [0x5c, "|"],
  [0x3b, ":"],
  [0x27, '"'],
  [0x2c, "<"],
  [0x2e, ">"],
  [0x2f, "?"],
]);

// Kitty keypad PUA assignments -> the bytes a legacy terminal sends.
const KEYPAD_LEGACY = new Map<number, string>([
  [57399, "0"],
  [57400, "1"],
  [57401, "2"],
  [57402, "3"],
  [57403, "4"],
  [57404, "5"],
  [57405, "6"],
  [57406, "7"],
  [57407, "8"],
  [57408, "9"],
  [57409, "."],
  [57410, "/"],
  [57411, "*"],
  [57412, "-"],
  [57413, "+"],
  [57414, "\r"], // keypad Enter
  [57415, "="],
  [57417, ARROW_KEYS.left.normal], // keypad left
  [57418, ARROW_KEYS.right.normal], // keypad right
  [57419, ARROW_KEYS.up.normal], // keypad up
  [57420, ARROW_KEYS.down.normal], // keypad down
  [57421, "\x1b[5~"], // keypad page up
  [57422, "\x1b[6~"], // keypad page down
  [57423, "\x1b[H"], // keypad home
  [57424, "\x1b[F"], // keypad end
  [57425, "\x1b[2~"], // keypad insert
  [57426, "\x1b[3~"], // keypad delete
]);

function controlByteFor(codePoint: number): string | undefined {
  // Ctrl+a..z -> 0x01..0x1a
  if (codePoint >= 0x61 && codePoint <= 0x7a) {
    return String.fromCharCode(codePoint - 0x60);
  }
  // Ctrl+A..Z (shift held) -> same control bytes
  if (codePoint >= 0x41 && codePoint <= 0x5a) {
    return String.fromCharCode(codePoint - 0x40);
  }
  // Ctrl+@ [ \ ] ^ _ -> 0x00, 0x1b..0x1f
  if (codePoint === 0x40 || (codePoint >= 0x5b && codePoint <= 0x5f)) {
    return String.fromCharCode(codePoint - 0x40);
  }
  // xterm legacy quirks for the remaining punctuation/digit chords.
  switch (codePoint) {
    case 0x2f: // Ctrl+/
      return "\x1f";
    case 0x3f: // Ctrl+?
      return "\x7f";
    case 0x32: // Ctrl+2
      return "\x00";
    case 0x33: // Ctrl+3
      return "\x1b";
    case 0x34: // Ctrl+4
      return "\x1c";
    case 0x35: // Ctrl+5
      return "\x1d";
    case 0x36: // Ctrl+6
      return "\x1e";
    case 0x37: // Ctrl+7
      return "\x1f";
    case 0x38: // Ctrl+8
      return "\x7f";
    default:
      return undefined;
  }
}
