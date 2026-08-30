import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { DEFAULT_SCROLLBACK_LINES } from "../config/stationConfig.js";
import { EraseDisplayMode } from "../terminal/protocol/csi.js";
import { EscSequence } from "../terminal/protocol/esc.js";
import { CsiCommand, EscCommand } from "../terminal/protocol/identifiers.js";
import { OscCommand } from "../terminal/protocol/osc.js";
import { VtPrefix, VtTerminator } from "../terminal/protocol/syntax.js";
import {
  TerminalSnapshotUnsupportedStateError,
  TerminalSupplementalState,
  type TerminalSnapshotUnsupportedStateDetail,
} from "./terminalSupplementalState.js";

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
  /**
   * Capture exact restoration VT, or reject with classified, content-free
   * diagnostics and recovery data sampled at the same queue boundary.
   */
  capture(): Promise<string[]>;
  dispose(): void;
};

/** Retry-only capture state; later PTY output may finish the parser sequence. */
export class TerminalSnapshotPendingError extends Error {}

export type TerminalSnapshotFailureReason =
  | "model-update-failed"
  | "serialization-failed"
  | "unsupported-state";

export type TerminalSnapshotFailure =
  | { reason: "model-update-failed" }
  | { reason: "serialization-failed" }
  | { reason: "unsupported-state"; detail: TerminalSnapshotUnsupportedStateDetail };

/**
 * Classified exact-capture failure with provider-private diagnostics and
 * control-only recovery sampled at the capture boundary.
 */
export class TerminalSnapshotUnavailableError extends Error {
  constructor(
    readonly diagnostic: TerminalSnapshotFailure,
    readonly resetData: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }

  get reason(): TerminalSnapshotFailureReason {
    return this.diagnostic.reason;
  }
}

/** Normalizes unknown capture failures to a safe, content-free diagnostic. */
export function terminalSnapshotFailure(error: unknown): TerminalSnapshotFailure {
  return error instanceof TerminalSnapshotUnavailableError
    ? error.diagnostic
    : { reason: "serialization-failed" };
}

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

  constructor(cols: number, rows: number, serializer = new SerializeAddon()) {
    this.#terminal = new Terminal({
      cols,
      rows,
      scrollback: DEFAULT_SCROLLBACK_LINES,
      allowProposedApi: true,
      logLevel: "off",
    });
    this.#terminal.loadAddon(new Unicode11Addon() as never);
    this.#terminal.unicode.activeVersion = "11";
    this.#serializer = serializer;
    this.#terminal.loadAddon(this.#serializer as never);
    this.#supplementalState = new TerminalSupplementalState(this.#terminal);
    let normalBufferIsSynchronizedFrame = false;
    this.#subscriptions = [
      this.#terminal.onTitleChange((title) => {
        this.#title = title;
      }),
      this.#terminal.parser.registerCsiHandler(CsiCommand.EraseInDisplay, (params) => {
        const isNormalBufferFullErase =
          params[0] === EraseDisplayMode.EntireDisplay &&
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
      this.#terminal.parser.registerEscHandler(EscCommand.ResetToInitialState, () => {
        this.#title = "";
        normalBufferIsSynchronizedFrame = false;
        return false;
      }),
      this.#terminal.parser.registerCsiHandler(CsiCommand.SoftReset, () => {
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
      if (this.#failure !== undefined) {
        throw new TerminalSnapshotUnavailableError(
          { reason: "model-update-failed" },
          this.#supplementalState.liveResetSequence(),
          "Could not update the semantic terminal model.",
          this.#failure,
        );
      }
      assertXtermParserBoundary(this.#terminal);
      const resetData = this.#supplementalState.liveResetSequence();
      const title = `${VtPrefix.Osc}${OscCommand.WindowTitle};${this.#title}${VtTerminator.Bell}`;
      let serialized: string;
      try {
        serialized = this.#serializer.serialize();
      } catch (error) {
        throw new TerminalSnapshotUnavailableError(
          { reason: "serialization-failed" },
          resetData,
          "Could not serialize the semantic terminal model.",
          error,
        );
      }
      try {
        return [
          EscSequence.ResetToInitialState +
            this.#supplementalState.restoreSerialization(serialized, title),
        ];
      } catch (error) {
        if (error instanceof TerminalSnapshotUnsupportedStateError) {
          throw new TerminalSnapshotUnavailableError(
            { reason: "unsupported-state", detail: error.detail },
            resetData,
            error.message,
            error,
          );
        }
        throw new TerminalSnapshotUnavailableError(
          { reason: "serialization-failed" },
          resetData,
          "Could not serialize the semantic terminal model.",
          error,
        );
      }
    }, { poisonOnFailure: false, allowPoisonedModel: true });
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

  #schedule<T>(
    operation: () => T | Promise<T>,
    options: { poisonOnFailure?: boolean; allowPoisonedModel?: boolean } = {},
  ): Promise<T> {
    const scheduled = this.#tail.then(() => {
      if (this.#disposed) {
        throw new Error("Semantic terminal snapshot is disposed.");
      }
      if (this.#failure !== undefined && options.allowPoisonedModel !== true) {
        throw this.#failure;
      }
      return operation();
    });
    this.#tail = scheduled.then(
      () => undefined,
      (error) => {
        if (options.poisonOnFailure !== false && this.#failure === undefined) {
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
