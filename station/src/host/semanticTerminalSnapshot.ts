import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { MAX_SCROLLBACK_LINES } from "../config/stationConfig.js";
import {
  ControlByte,
  CsiFinal,
  EraseInDisplayMode,
} from "../terminal/protocol/controlBytes.js";
import { TerminalSupplementalState } from "./terminalSupplementalState.js";

const RIS = `${ControlByte.Esc}c`;
const OSC_TITLE = `${ControlByte.Esc}]2;`;
const STRING_TERMINATOR = ControlByte.Bel;
const XTERM_GROUND_STATE = 0;

type PinnedXtermParserState = {
  _core: {
    _inputHandler: {
      _parser: { currentState: number };
      _stringDecoder: { _interim: number };
    };
  };
};

export type SemanticTerminalModel = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  capture(): Promise<string[]>;
  dispose(): void;
};

/** Capture can be retried after later PTY output finishes the current parser sequence. */
export class TerminalSnapshotPendingError extends Error {}

/**
 * A bounded headless terminal whose write, resize, and capture operations share
 * one queue. Enqueuing capture establishes the attachment boundary: later PTY
 * output cannot mutate the model until serialization has completed.
 */
export class SemanticTerminalSnapshot implements SemanticTerminalModel {
  readonly #terminal: Terminal;
  readonly #serializer: SerializeAddon;
  readonly #supplementalState: TerminalSupplementalState;
  readonly #subscriptions: Array<{ dispose(): void }>;
  #tail = Promise.resolve();
  #failure: unknown;
  #disposed = false;
  #title = "";

  constructor(cols: number, rows: number) {
    this.#terminal = new Terminal({
      cols,
      rows,
      scrollback: MAX_SCROLLBACK_LINES,
      allowProposedApi: true,
      logLevel: "off",
    });
    this.#terminal.loadAddon(new Unicode11Addon() as never);
    this.#terminal.unicode.activeVersion = "11";
    this.#serializer = new SerializeAddon();
    this.#terminal.loadAddon(this.#serializer as never);
    this.#supplementalState = new TerminalSupplementalState(this.#terminal);
    let normalBufferIsSynchronizedFrame = false;
    this.#subscriptions = [
      this.#terminal.onTitleChange((title) => {
        this.#title = title;
      }),
      this.#terminal.parser.registerCsiHandler({ final: CsiFinal.EraseInDisplay }, (params) => {
        const isNormalBufferFullErase =
          params[0] === EraseInDisplayMode.EntireDisplay &&
          this.#terminal.buffer.active.type === "normal";
        const isSynchronizedFullErase =
          isNormalBufferFullErase && this.#terminal.modes.synchronizedOutputMode;
        // Match StationVtScreen's one-time archive of the screen replaced by a sync frame.
        this.#terminal.options.scrollOnEraseInDisplay =
          isSynchronizedFullErase && !normalBufferIsSynchronizedFrame;
        if (isNormalBufferFullErase) {
          normalBufferIsSynchronizedFrame = isSynchronizedFullErase;
        }
        return false;
      }),
      this.#terminal.parser.registerEscHandler({ final: "c" }, () => {
        this.#title = "";
        normalBufferIsSynchronizedFrame = false;
        return false;
      }),
      this.#terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
        normalBufferIsSynchronizedFrame = false;
        return false;
      }),
      this.#terminal.onWriteParsed(() => {
        this.#terminal.options.scrollOnEraseInDisplay = false;
      }),
    ];
  }

  write(data: string): void {
    void this.#schedule(async () => {
      await new Promise<void>((resolve) => this.#terminal.write(data, resolve));
    }).catch(() => undefined);
  }

  resize(cols: number, rows: number): void {
    void this.#schedule(() => {
      this.#terminal.resize(cols, rows);
    }).catch(() => undefined);
  }

  capture(): Promise<string[]> {
    return this.#schedule(() => {
      assertXtermParserBoundary(this.#terminal);
      const title = OSC_TITLE + this.#title + STRING_TERMINATOR;
      const restore =
        RIS +
        this.#supplementalState.restoreSerialization(this.#serializer.serialize(), title);
      return [restore];
    }, false);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    void this.#tail.finally(() => {
      for (const subscription of this.#subscriptions) {
        subscription.dispose();
      }
      this.#supplementalState.dispose();
      this.#terminal.dispose();
    });
  }

  #schedule<T>(operation: () => T | Promise<T>, poisonOnFailure = true): Promise<T> {
    const scheduled = this.#tail.then(() => {
      if (this.#disposed) {
        throw new Error("Semantic terminal snapshot is disposed.");
      }
      if (this.#failure !== undefined) {
        throw this.#failure;
      }
      return operation();
    });
    this.#tail = scheduled.then(
      () => undefined,
      (error) => {
        if (poisonOnFailure) {
          this.#failure = error;
        }
      },
    );
    return scheduled;
  }
}

function assertXtermParserBoundary(terminal: Terminal): void {
  // Semantic capture may retry after later PTY output completes the sequence; replaying a
  // guessed prefix would duplicate parser work already applied by xterm.
  const input = (terminal as unknown as PinnedXtermParserState)._core._inputHandler;
  if (input._parser.currentState !== XTERM_GROUND_STATE || input._stringDecoder._interim !== 0) {
    throw new TerminalSnapshotPendingError(
      "Cannot capture terminal state in the middle of an input sequence.",
    );
  }
}

export function createSemanticTerminalSnapshot(
  cols: number,
  rows: number,
): SemanticTerminalModel {
  return new SemanticTerminalSnapshot(cols, rows);
}
