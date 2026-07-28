const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const DEL = 0x7f;
const DCS = 0x90;
const SOS = 0x98;
const CSI = 0x9b;
const ST = 0x9c;
const OSC = 0x9d;
const PM = 0x9e;
const APC = 0x9f;

export const TERMINAL_SEQUENCE_CONTINUATION_MAX_CODE_UNITS = 1024 * 1024;

type ParserState =
  | "ground"
  | "escape"
  | "escapeIntermediate"
  | "csiEntry"
  | "csiParam"
  | "csiIntermediate"
  | "csiIgnore"
  | "oscString"
  | "dcsEntry"
  | "dcsParam"
  | "dcsIntermediate"
  | "dcsIgnore"
  | "dcsPassthrough"
  | "sosPmApcString";

/**
 * Tracks the bounded prefix needed to recreate an unfinished xterm parser sequence.
 * Transitions mirror xterm's VT500 table; executed controls stay out because serialization
 * already captures their effects.
 */
export class TerminalSequenceContinuation {
  #state: ParserState = "ground";
  #sequence = "";
  #overflowed = false;
  #pendingHighSurrogate = "";
  #dcsPutRun = false;

  constructor(
    private readonly maxCodeUnits = TERMINAL_SEQUENCE_CONTINUATION_MAX_CODE_UNITS,
  ) {}

  feed(data: string): void {
    // xterm's DCS read-ahead is scoped to one write buffer.
    this.#dcsPutRun = false;
    const decoded = this.#pendingHighSurrogate + data;
    this.#pendingHighSurrogate = "";

    for (let index = 0; index < decoded.length; index += 1) {
      const code = decoded.charCodeAt(index);
      const char = decoded.charAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        index += 1;
        if (index >= decoded.length) {
          this.#pendingHighSurrogate = char;
          return;
        }

        const secondCode = decoded.charCodeAt(index);
        const secondChar = decoded.charAt(index);
        if (secondCode >= 0xdc00 && secondCode <= 0xdfff) {
          const codePoint =
            (code - 0xd800) * 0x400 + secondCode - 0xdc00 + 0x10000;
          this.#advance(char + secondChar, codePoint);
        } else {
          // xterm emits both invalid UCS-2 units here, including a second-position BOM.
          this.#advance(char, code);
          this.#advance(secondChar, secondCode);
        }
        continue;
      }
      if (code === 0xfeff) {
        continue;
      }
      this.#advance(char, code);
    }
  }

  /** Returns the exact unfinished prefix, rejecting unsafe partial replay after overflow. */
  captureSequence(): string {
    const decoderFlush =
      this.#pendingHighSurrogate.length === 0 && endsWithHighSurrogate(this.#sequence)
        ? "\0"
        : "";
    if (
      this.#overflowed ||
      this.#sequence.length + decoderFlush.length + this.#pendingHighSurrogate.length >
        this.maxCodeUnits
    ) {
      throw new Error(
        `Unfinished terminal sequence exceeds the ${this.maxCodeUnits}-code-unit capture limit.`,
      );
    }
    return this.#sequence + decoderFlush + this.#pendingHighSurrogate;
  }

  #advance(char: string, code: number): void {
    if (this.#state === "dcsPassthrough" && code === DEL) {
      if (this.#dcsPutRun) {
        this.#append(char);
      }
      return;
    }
    if (this.#applyAnywhereTransition(char, code)) {
      return;
    }

    switch (this.#state) {
      case "ground":
        return;
      case "escape":
        this.#advanceEscape(char, code);
        return;
      case "escapeIntermediate":
        this.#advanceEscapeIntermediate(char, code);
        return;
      case "csiEntry":
        this.#advanceCsiEntry(char, code);
        return;
      case "csiParam":
        this.#advanceCsiParam(char, code);
        return;
      case "csiIntermediate":
        this.#advanceCsiIntermediate(char, code);
        return;
      case "csiIgnore":
        this.#advanceCsiIgnore(code);
        return;
      case "oscString":
        this.#advanceOscString(char, code);
        return;
      case "dcsEntry":
        this.#advanceDcsEntry(char, code);
        return;
      case "dcsParam":
        this.#advanceDcsParam(char, code);
        return;
      case "dcsIntermediate":
        this.#advanceDcsIntermediate(char, code);
        return;
      case "dcsIgnore":
        return;
      case "dcsPassthrough":
        this.#append(char);
        this.#dcsPutRun = true;
        return;
      case "sosPmApcString":
        if (code >= 0xa0) {
          this.#finish();
        }
        return;
    }
  }

  #applyAnywhereTransition(char: string, code: number): boolean {
    if (code === ESC) {
      this.#start("escape", char);
      return true;
    }
    if (code === CSI) {
      this.#start("csiEntry", char);
      return true;
    }
    if (code === OSC) {
      this.#start("oscString", char);
      return true;
    }
    if (code === DCS) {
      this.#start("dcsEntry", char);
      return true;
    }
    if (code === SOS || code === PM || code === APC) {
      this.#start("sosPmApcString", char);
      return true;
    }
    if (
      code === CAN ||
      code === SUB ||
      code === ST ||
      code === 0x99 ||
      code === 0x9a ||
      (code >= 0x80 && code <= 0x97)
    ) {
      this.#finish();
      return true;
    }
    return false;
  }

  #advanceEscape(char: string, code: number): void {
    if (isExecutable(code) || code === DEL) {
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.#append(char);
      this.#state = "escapeIntermediate";
      return;
    }
    if (code === 0x5b) {
      this.#append(char);
      this.#state = "csiEntry";
      return;
    }
    if (code === 0x5d) {
      this.#append(char);
      this.#state = "oscString";
      return;
    }
    if (code === 0x50) {
      this.#append(char);
      this.#state = "dcsEntry";
      return;
    }
    if (code === 0x58 || code === 0x5e || code === 0x5f) {
      this.#append(char);
      this.#state = "sosPmApcString";
      return;
    }
    this.#finish();
  }

  #advanceEscapeIntermediate(char: string, code: number): void {
    if (isExecutable(code) || code === DEL) {
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.#append(char);
      return;
    }
    this.#finish();
  }

  #advanceCsiEntry(char: string, code: number): void {
    if (isExecutable(code) || code === DEL) {
      return;
    }
    if (code >= 0x30 && code <= 0x3f) {
      this.#append(char);
      this.#state = "csiParam";
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.#append(char);
      this.#state = "csiIntermediate";
      return;
    }
    this.#finish();
  }

  #advanceCsiParam(char: string, code: number): void {
    if (isExecutable(code) || code === DEL) {
      return;
    }
    if (code >= 0x30 && code <= 0x3b) {
      this.#append(char);
      return;
    }
    if (code >= 0x3c && code <= 0x3f) {
      this.#append(char);
      this.#state = "csiIgnore";
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.#append(char);
      this.#state = "csiIntermediate";
      return;
    }
    this.#finish();
  }

  #advanceCsiIntermediate(char: string, code: number): void {
    if (isExecutable(code) || code === DEL) {
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.#append(char);
      return;
    }
    if (code >= 0x30 && code <= 0x3f) {
      this.#append(char);
      this.#state = "csiIgnore";
      return;
    }
    this.#finish();
  }

  #advanceCsiIgnore(code: number): void {
    if (code >= 0x40 && code <= 0x7e) {
      this.#finish();
    }
  }

  #advanceOscString(char: string, code: number): void {
    if (code === BEL) {
      this.#finish();
      return;
    }
    if (code >= 0x20) {
      this.#append(char);
    }
  }

  #advanceDcsEntry(char: string, code: number): void {
    if (isExecutable(code) || code === DEL) {
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.#append(char);
      this.#state = "dcsIntermediate";
      return;
    }
    if (code >= 0x30 && code <= 0x3f) {
      this.#append(char);
      this.#state = "dcsParam";
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      this.#append(char);
      this.#state = "dcsPassthrough";
      return;
    }
    this.#finish();
  }

  #advanceDcsParam(char: string, code: number): void {
    if (isExecutable(code) || code === DEL) {
      return;
    }
    if (code >= 0x30 && code <= 0x3b) {
      this.#append(char);
      return;
    }
    if (code >= 0x3c && code <= 0x3f) {
      this.#append(char);
      this.#state = "dcsIgnore";
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.#append(char);
      this.#state = "dcsIntermediate";
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      this.#append(char);
      this.#state = "dcsPassthrough";
      return;
    }
    this.#finish();
  }

  #advanceDcsIntermediate(char: string, code: number): void {
    if (isExecutable(code) || code === DEL) {
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.#append(char);
      return;
    }
    if (code >= 0x30 && code <= 0x3f) {
      this.#append(char);
      this.#state = "dcsIgnore";
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      this.#append(char);
      this.#state = "dcsPassthrough";
      return;
    }
    this.#finish();
  }

  #start(state: ParserState, char: string): void {
    this.#dcsPutRun = false;
    this.#state = state;
    this.#sequence = char;
    this.#overflowed = char.length > this.maxCodeUnits;
    if (this.#overflowed) {
      this.#sequence = "";
    }
  }

  #append(char: string): void {
    if (this.#overflowed) {
      return;
    }
    if (this.#sequence.length + char.length > this.maxCodeUnits) {
      // Never replay a truncated control sequence as printable terminal input.
      this.#sequence = "";
      this.#overflowed = true;
      return;
    }
    this.#sequence += char;
  }

  #finish(): void {
    this.#dcsPutRun = false;
    this.#state = "ground";
    this.#sequence = "";
    this.#overflowed = false;
  }
}

function isExecutable(code: number): boolean {
  return code <= 0x17 || code === 0x19 || (code >= 0x1c && code <= 0x1f);
}

function endsWithHighSurrogate(value: string): boolean {
  const code = value.charCodeAt(value.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
}
