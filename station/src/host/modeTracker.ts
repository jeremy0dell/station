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
// several modes. Built from a string so the ESC byte isn't a control char in a
// regex literal (matches the style in input/terminalReplies.ts).
const DECSET_PATTERN = "\\x1b\\[\\?([0-9;]+)([hl])";
// A still-incomplete DECSET prefix at a chunk's tail, carried into the next
// chunk so a sequence split across PTY reads ("\x1b[?10" then "49h") is matched.
const PARTIAL_DECSET = new RegExp("\\x1b(?:\\[(?:\\?[0-9;]*)?)?$");
const MAX_CARRY = 24;

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
  #cursorHidden = false;
  #carry = "";

  feed(chunk: string): void {
    // Prepend any partial escape held back from the previous chunk.
    const data = this.#carry + chunk;
    const re = new RegExp(DECSET_PATTERN, "g");
    let lastEnd = 0;
    let match: RegExpExecArray | null = re.exec(data);
    while (match !== null) {
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
      lastEnd = re.lastIndex;
      match = re.exec(data);
    }
    // Hold back a trailing, still-incomplete DECSET prefix (only one that hasn't
    // been consumed by a match) for the next chunk; bounded so a stray ESC can't
    // grow it without limit.
    const escIndex = data.lastIndexOf(ControlByte.Esc);
    const tail = escIndex >= lastEnd ? data.slice(escIndex) : "";
    this.#carry = tail.length > 0 && tail.length <= MAX_CARRY && PARTIAL_DECSET.test(tail) ? tail : "";
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
    return parts.join("");
  }
}
