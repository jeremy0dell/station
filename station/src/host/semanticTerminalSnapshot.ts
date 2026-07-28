import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { MAX_SCROLLBACK_LINES } from "../config/stationConfig.js";
import { ControlByte } from "../terminal/protocol/controlBytes.js";
import { TerminalSequenceContinuation } from "./terminalSequenceContinuation.js";
import { TerminalRestoreState } from "./terminalRestoreState.js";

const RIS = `${ControlByte.Esc}c`;
const OSC_TITLE = `${ControlByte.Esc}]2;`;
const STRING_TERMINATOR = ControlByte.Bel;

export type SemanticTerminalModel = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  capture(): Promise<string[]>;
  dispose(): void;
};

/**
 * A bounded headless terminal whose write, resize, and capture operations share
 * one queue. Enqueuing capture establishes the attachment boundary: later PTY
 * output cannot mutate the model until serialization has completed.
 */
export class SemanticTerminalSnapshot implements SemanticTerminalModel {
  readonly #terminal: Terminal;
  readonly #serializer: SerializeAddon;
  readonly #restoreState: TerminalRestoreState;
  readonly #continuation = new TerminalSequenceContinuation();
  readonly #titleSubscription: { dispose(): void };
  readonly #risSubscription: { dispose(): void };
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
    this.#restoreState = new TerminalRestoreState(this.#terminal, this.#serializer);
    this.#titleSubscription = this.#terminal.onTitleChange((title) => {
      this.#title = title;
    });
    this.#risSubscription = this.#terminal.parser.registerEscHandler({ final: "c" }, () => {
      this.#title = "";
      return false;
    });
  }

  write(data: string): void {
    void this.#schedule(async () => {
      this.#continuation.feed(data);
      await this.#restoreState.write(data);
    }).catch(() => undefined);
  }

  resize(cols: number, rows: number): void {
    void this.#schedule(() => {
      this.#terminal.resize(cols, rows);
    }).catch(() => undefined);
  }

  capture(): Promise<string[]> {
    return this.#schedule(() => {
      const continuation = this.#continuation.captureSequence();
      const title = OSC_TITLE + this.#title + STRING_TERMINATOR;
      const restore =
        RIS +
        this.#restoreState.restoreSerialization(this.#serializer.serialize(), title) +
        continuation;
      return [restore];
    }, false);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    void this.#tail.finally(() => {
      this.#titleSubscription.dispose();
      this.#risSubscription.dispose();
      this.#restoreState.dispose();
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

export function createSemanticTerminalSnapshot(
  cols: number,
  rows: number,
): SemanticTerminalModel {
  return new SemanticTerminalSnapshot(cols, rows);
}
