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

// CSI ? <param(;param)*> (h|l) — DECSET (h) / DECRST (l), possibly batching
// several modes. Built from a string so the ESC byte isn't a control char in a
// regex literal (matches the style in input/terminalReplies.ts).
const DECSET_PATTERN = "\\x1b\\[\\?([0-9;]+)([hl])";

// Alt-screen variants, most-preferred first; only one is ever re-emitted.
const ALT_SCREEN_MODES = [1049, 1047, 47] as const;
const MOUSE_TRACKING_MODES = [9, 1000, 1002, 1003] as const;
// Modes that default OFF: re-emit a "set" on restore when currently on. Cursor
// visibility (DECTCEM / ?25) defaults ON and is handled separately.
const STICKY_ON_MODES: readonly number[] = [
  ...ALT_SCREEN_MODES,
  ...MOUSE_TRACKING_MODES,
  1006, // SGR mouse encoding
  2004, // bracketed paste
  1, // DECCKM application cursor keys
];

export class TerminalModeTracker {
  readonly #on = new Set<number>();
  #cursorHidden = false;

  feed(chunk: string): void {
    const re = new RegExp(DECSET_PATTERN, "g");
    let match: RegExpExecArray | null = re.exec(chunk);
    while (match !== null) {
      const set = match[2] === "h";
      for (const param of match[1].split(";")) {
        const mode = Number(param);
        if (mode === 25) {
          this.#cursorHidden = !set;
        } else if (STICKY_ON_MODES.includes(mode)) {
          if (set) {
            this.#on.add(mode);
          } else {
            this.#on.delete(mode);
          }
        }
      }
      match = re.exec(chunk);
    }
  }

  /** Sequences re-asserting every currently-on mode, or "" when none are set. */
  restoreSequence(): string {
    const parts: string[] = [];
    const altMode = ALT_SCREEN_MODES.find((mode) => this.#on.has(mode));
    if (altMode !== undefined) {
      parts.push(`\x1b[?${altMode}h`);
    }
    for (const mode of [...MOUSE_TRACKING_MODES, 1006, 2004, 1]) {
      if (this.#on.has(mode)) {
        parts.push(`\x1b[?${mode}h`);
      }
    }
    if (this.#cursorHidden) {
      parts.push("\x1b[?25l");
    }
    return parts.join("");
  }
}
