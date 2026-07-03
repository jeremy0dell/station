/**
 * Tracks the sticky terminal modes a reattaching client must see re-established
 * when older scrollback that set them has been dropped. It scans data for the
 * DECSET/DECRST sequences of those modes and can emit a "restore preamble" that
 * re-asserts whatever is currently on.
 *
 * Fed only the chunks the scrollback ring DROPS, so the preamble represents
 * exactly the mode state lost to truncation; retained chunks replay after it and
 * override as needed (e.g. a later alt-screen exit still wins). Full SGR/color
 * state is intentionally out of scope — it self-heals on the next repaint.
 */
import { ControlByte } from "../terminal/protocol/controlBytes.js";
import { DecMode } from "../terminal/protocol/decset.js";

// CSI ? <param(;param)*> (h|l) — DECSET (h) / DECRST (l), possibly batching
// several modes. Built from strings so the ESC byte isn't a control char in
// regex literals (matches the style in input/terminalReplies.ts).
const DECSET_PATTERN = "\\x1b\\[\\?([0-9;]+)([hl])";
const KITTY_KEYBOARD_PATTERN = "\\x1b\\[([<>=])([0-9]*)u";
const STICKY_SEQUENCE_PATTERN = new RegExp(`${DECSET_PATTERN}|${KITTY_KEYBOARD_PATTERN}`, "g");
// A still-incomplete sticky-mode prefix at a chunk's tail, carried into the
// next chunk so a sequence split across PTY reads ("\x1b[?10" then "49h") is matched.
const PARTIAL_STICKY_SEQUENCE = new RegExp("\\x1b(?:\\[(?:\\?[0-9;]*|[<>=][0-9]*)?)?$");
// Big enough to hold the longest realistic semicolon-batched DECSET split across
// a read boundary (e.g. ?1049;1000;1002;1003;1006;2004h); the partial matcher
// still rejects unrelated tails of any length, so this only bounds a stray ESC run.
const MAX_CARRY = 64;
// RIS (ESC c) — a full terminal reset clears every DEC private mode.
const RIS = `${ControlByte.Esc}c`;

// DECSET private-mode numbers this tracker recognizes. SGR-mouse and cursor
// visibility reuse the shared DecMode catalog; the rest are tracked only here
// (xterm surfaces them on the client, but the host has no VT to ask).
const Decset = {
  AltScreen: 1049, // ?1049: alt buffer + save/restore cursor
  AltScreenNoSave: 1047, // ?1047: alt buffer, no cursor save
  AltScreenLegacy: 47, // ?47: oldest alt-buffer synonym
  MouseX10: 9, // ?9: press-only
  MouseVt200: 1000, // ?1000: press + release
  MouseDrag: 1002, // ?1002: button-event (motion while held)
  MouseAny: 1003, // ?1003: any-event motion
  BracketedPaste: 2004, // ?2004
  AppCursorKeys: 1, // ?1: DECCKM
} as const;

// Alt-screen variants, most-preferred first; only one is ever re-emitted.
const ALT_SCREEN_MODES = [Decset.AltScreen, Decset.AltScreenNoSave, Decset.AltScreenLegacy] as const;
const MOUSE_TRACKING_MODES = [
  Decset.MouseX10,
  Decset.MouseVt200,
  Decset.MouseDrag,
  Decset.MouseAny,
] as const;
// Modes that default OFF: re-emit a "set" on restore when currently on. Cursor
// visibility (DecMode.CursorVisible) defaults ON and is handled separately.
const STICKY_ON_MODES: readonly number[] = [
  ...ALT_SCREEN_MODES,
  ...MOUSE_TRACKING_MODES,
  DecMode.SgrMouse,
  Decset.BracketedPaste,
  Decset.AppCursorKeys,
];

export class TerminalModeTracker {
  readonly #on = new Set<number>();
  readonly #kittyKeyboardFlagStack: number[] = [];
  #cursorHidden = false;
  #kittyKeyboardFlags = 0;
  #carry = "";

  feed(chunk: string): void {
    // Prepend any partial escape held back from the previous chunk.
    const data = this.#carry + chunk;
    // A full reset wipes every prior mode; only state set AFTER the last RIS
    // survives, so drop accumulated state and scan from just past it.
    const risIndex = data.lastIndexOf(RIS);
    const scanFrom = risIndex >= 0 ? risIndex + RIS.length : 0;
    if (risIndex >= 0) {
      this.#on.clear();
      this.#kittyKeyboardFlagStack.length = 0;
      this.#cursorHidden = false;
      this.#kittyKeyboardFlags = 0;
    }
    STICKY_SEQUENCE_PATTERN.lastIndex = scanFrom;
    let lastEnd = scanFrom;
    let match: RegExpExecArray | null = STICKY_SEQUENCE_PATTERN.exec(data);
    while (match !== null) {
      if (match[1] !== undefined && match[2] !== undefined) {
        const set = match[2] === "h";
        for (const param of match[1].split(";")) {
          const mode = Number(param);
          if (mode === DecMode.CursorVisible) {
            this.#cursorHidden = !set;
          } else if (STICKY_ON_MODES.includes(mode)) {
            if (set) {
              this.#on.add(mode);
            } else {
              this.#on.delete(mode);
            }
          }
        }
      } else {
        this.#applyKittyKeyboardSequence(match[3] ?? "", match[4] ?? "");
      }
      lastEnd = STICKY_SEQUENCE_PATTERN.lastIndex;
      match = STICKY_SEQUENCE_PATTERN.exec(data);
    }
    // Hold back a trailing, still-incomplete sticky prefix (only one that hasn't
    // been consumed by a match) for the next chunk; bounded so a stray ESC can't
    // grow it without limit.
    const escIndex = data.lastIndexOf(ControlByte.Esc);
    const tail = escIndex >= lastEnd ? data.slice(escIndex) : "";
    this.#carry =
      tail.length > 0 && tail.length <= MAX_CARRY && PARTIAL_STICKY_SEQUENCE.test(tail)
        ? tail
        : "";
  }

  /** Sequences re-asserting every currently-on mode, or "" when none are set. */
  restoreSequence(): string {
    const parts: string[] = [];
    const altMode = ALT_SCREEN_MODES.find((mode) => this.#on.has(mode));
    if (altMode !== undefined) {
      parts.push(`${ControlByte.Csi}?${altMode}h`);
    }
    const otherModes = [
      ...MOUSE_TRACKING_MODES,
      DecMode.SgrMouse,
      Decset.BracketedPaste,
      Decset.AppCursorKeys,
    ];
    for (const mode of otherModes) {
      if (this.#on.has(mode)) {
        parts.push(`${ControlByte.Csi}?${mode}h`);
      }
    }
    if (this.#cursorHidden) {
      parts.push(`${ControlByte.Csi}?${DecMode.CursorVisible}l`);
    }
    const kittyKeyboard = this.#kittyKeyboardRestoreSequence();
    if (kittyKeyboard.length > 0) {
      parts.push(kittyKeyboard);
    }
    return parts.join("");
  }

  #applyKittyKeyboardSequence(operator: string, rawFlags: string): void {
    if (operator === "<") {
      this.#kittyKeyboardFlags = this.#kittyKeyboardFlagStack.pop() ?? 0;
      return;
    }
    const flags = Number(rawFlags);
    if (operator === ">") {
      this.#kittyKeyboardFlagStack.push(this.#kittyKeyboardFlags);
      if (rawFlags.length > 0 && Number.isFinite(flags)) {
        this.#kittyKeyboardFlags = flags;
      }
      return;
    }
    if (operator === "=") {
      this.#kittyKeyboardFlags = rawFlags.length > 0 && Number.isFinite(flags) ? flags : 0;
    }
  }

  #kittyKeyboardRestoreSequence(): string {
    if (this.#kittyKeyboardFlagStack.length === 0) {
      return this.#kittyKeyboardFlags === 0 ? "" : `${ControlByte.Csi}=${this.#kittyKeyboardFlags}u`;
    }

    const parts: string[] = [];
    const baseline = this.#kittyKeyboardFlagStack[0] ?? 0;
    if (baseline !== 0) {
      parts.push(`${ControlByte.Csi}=${baseline}u`);
    }
    for (const flags of [...this.#kittyKeyboardFlagStack.slice(1), this.#kittyKeyboardFlags]) {
      parts.push(`${ControlByte.Csi}>${flags}u`);
    }
    return parts.join("");
  }
}
