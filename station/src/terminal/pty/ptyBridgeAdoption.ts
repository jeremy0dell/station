import net from "node:net";
import {
  type PtyBridgeStatus,
  PtyBridgeStatusSchema,
  PtyInstanceIdSchema,
} from "@station/contracts";
import { z } from "zod";
import type {
  StationTerminalDisposable,
  StationTerminalExit,
  StationTerminalProcess,
  StationTerminalSize,
  StationTerminalUnavailable,
} from "../types.js";
import {
  MIN_COLS,
  MIN_ROWS,
  normalizeDimension,
  normalizeSize,
} from "./localPtyTerminal.js";
import {
  createJsonLineFeed,
  parseBridgeLine,
  type PtyBridgeStreamMessage,
  toTerminalExit,
} from "./ptyBridgeChannel.js";
import { TerminalProcessEmitter } from "./terminalProcessEmitter.js";

type BridgeControlMessage =
  | PtyBridgeStatus
  | PtyBridgeStreamMessage;

const BridgeControlErrorSchema = z
  .object({
    type: z.literal("error"),
    code: z.string().min(1).optional(),
    message: z.string().min(1),
  })
  .strict();

/** A parked bridge rebound as a live terminal; adoption extras ride beside the interface. */
export type AdoptedPtyBridge = StationTerminalProcess & {
  /** True when the bridge dropped parked output before adoption. */
  readonly parkedEvicted: boolean;
  /** Recorded exit when the PTY died before adoption; undefined while alive. */
  readonly recordedExit: StationTerminalExit | undefined;
};

export type AdoptLocalPtyBridgeOptions = {
  id: string;
  /** Exact PTY lifetime the bridge must prove before changing ownership. */
  ptyInstanceId: z.infer<typeof PtyInstanceIdSchema>;
  command: string;
  controlSocketPath: string;
  size: StationTerminalSize;
  /** Fail the adoption when the bridge does not answer in time. */
  timeoutMs?: number;
};

const DEFAULT_ADOPT_TIMEOUT_MS = 5_000;

/**
 * ADAPTER
 *
 * Rebinds a parked orphan bridge's control socket as a live terminal process so
 * a new host adopts the surviving PTY instead of respawning its payload.
 * Geometry comes from the bridge's status reply, which is the PTY's truth.
 */
export function adoptLocalPtyBridge(
  options: AdoptLocalPtyBridgeOptions,
): Promise<AdoptedPtyBridge> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options.controlSocketPath);
    let settled = false;
    const timer = setTimeout(() => {
      finishWithError(
        new Error(`Timed out adopting the parked bridge at ${options.controlSocketPath}.`),
      );
    }, options.timeoutMs ?? DEFAULT_ADOPT_TIMEOUT_MS);
    const finishWithError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", (error) => {
      finishWithError(error);
    });
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ type: "adopt", ptyInstanceId: options.ptyInstanceId })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      // The handshake keeps the remainder outside the shared feed: everything
      // after the status line already belongs to the adopted stream.
      const remainder = buffer.slice(newlineIndex + 1);
      let rawMessage: unknown;
      try {
        rawMessage = JSON.parse(line);
      } catch (error) {
        finishWithError(
          error instanceof Error ? error : new Error("Unparseable bridge adoption reply."),
        );
        return;
      }
      const errorReply = BridgeControlErrorSchema.safeParse(rawMessage);
      if (errorReply.success) {
        finishWithError(new Error(errorReply.data.message));
        return;
      }
      const parsedStatus = PtyBridgeStatusSchema.safeParse(rawMessage);
      if (!parsedStatus.success) {
        finishWithError(new Error("Invalid bridge adoption status reply."));
        return;
      }
      const message = parsedStatus.data;
      if (message.ptyInstanceId !== options.ptyInstanceId) {
        finishWithError(
          new Error("The parked bridge acknowledged a different PTY instance."),
        );
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("error");
      socket.removeAllListeners("data");
      resolve(
        new AdoptedLocalPtyBridgeProcess({
          id: options.id,
          command: options.command,
          size: {
            cols: normalizeDimension(message.cols, options.size.cols, MIN_COLS),
            rows: normalizeDimension(message.rows, options.size.rows, MIN_ROWS),
          },
          socket,
          status: message,
          initialBuffer: remainder,
        }),
      );
    });
  });
}

class AdoptedLocalPtyBridgeProcess implements StationTerminalProcess {
  readonly id: string;
  readonly command: string;
  readonly pid: number;
  readonly bridgePid: number;
  readonly parkedEvicted: boolean;
  readonly recordedExit: StationTerminalExit | undefined;

  #socket: net.Socket;
  #events = new TerminalProcessEmitter();
  #unavailableListeners = new Set<(event: StationTerminalUnavailable) => void>();
  #size: StationTerminalSize;
  #socketClosed = false;
  #disposed = false;
  #feed = createJsonLineFeed((line) => {
    const message = parseBridgeLine<BridgeControlMessage>(line, (diagnostic) =>
      this.#events.emitDiagnostic(diagnostic),
    );
    if (message !== undefined) {
      this.handleControlMessage(message);
    }
  });

  constructor(init: {
    id: string;
    command: string;
    size: StationTerminalSize;
    socket: net.Socket;
    status: PtyBridgeStatus;
    initialBuffer: string;
  }) {
    const { id, command, size, socket, status, initialBuffer } = init;
    this.id = id;
    this.command = command;
    this.pid = status.pid;
    this.bridgePid = status.bridgePid;
    this.parkedEvicted = status.parkedEvicted;
    if (status.exited) {
      this.recordedExit = toTerminalExit(status.exitCode ?? 1, status.signal);
    }
    this.#size = size;
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", this.#feed);
    socket.on("error", (error) => {
      this.#events.emitDiagnostic(`adopted bridge socket error: ${error.message}`);
    });
    socket.on("close", () => {
      this.handleSocketClose();
    });
    if (initialBuffer.length > 0) {
      this.#feed(initialBuffer);
    }
  }

  get size(): StationTerminalSize {
    return this.#size;
  }

  onData(listener: (data: string) => void): StationTerminalDisposable {
    return this.#events.onData(listener);
  }

  onExit(listener: (event: StationTerminalExit) => void): StationTerminalDisposable {
    return this.#events.onExit(listener);
  }

  onDiagnostic(listener: (message: string) => void): StationTerminalDisposable {
    return this.#events.onDiagnostic(listener);
  }

  onUnavailable(
    listener: (event: StationTerminalUnavailable) => void,
  ): StationTerminalDisposable {
    this.#events.assertActive("subscribe to terminal unavailability");
    this.#unavailableListeners.add(listener);
    return {
      dispose: () => {
        this.#unavailableListeners.delete(listener);
      },
    };
  }

  write(data: string): void {
    this.#events.assertActive("write to terminal");
    if (this.#events.exited || this.#socketClosed) {
      return;
    }
    this.sendControl({ type: "write", data });
  }

  resize(size: StationTerminalSize): void {
    this.#events.assertActive("resize terminal");
    if (this.#events.exited || this.#socketClosed) {
      return;
    }
    this.#size = normalizeSize(size);
    this.sendControl({ type: "resize", cols: this.#size.cols, rows: this.#size.rows });
  }

  kill(signal?: string): void {
    if (this.#disposed || this.#events.exited || this.#socketClosed) {
      return;
    }
    this.sendControl({ type: "kill", signal });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const exited = this.#events.exited;
    this.#events.dispose();
    this.#unavailableListeners.clear();
    if (!exited && !this.#socketClosed) {
      // Kill before ending the socket: an EOF without a kill tells the bridge
      // its adopter died, which re-parks the PTY instead of tearing it down.
      this.sendControl({ type: "kill" });
    }
    this.#socket.end();
  }

  private handleControlMessage(message: BridgeControlMessage): void {
    switch (message.type) {
      case "data":
        this.#events.emitData(message.data);
        return;
      case "exit":
        this.#events.emitExit(toTerminalExit(message.exitCode, message.signal));
        return;
      case "error":
        this.#events.emitDiagnostic(`adopted bridge command error: ${message.message}`);
        return;
      case "status":
        // A status frame after adoption is a stray probe reply; nothing to do.
        return;
    }
  }

  private handleSocketClose(): void {
    this.#socketClosed = true;
    if (this.#disposed || this.#events.exited) {
      return;
    }
    // The bridge vanished or re-parked without an exit frame: attachment is
    // lost, but no exit evidence exists, so report unavailability, not death.
    this.#events.emitDiagnostic("adopted bridge socket closed before terminal exit.");
    for (const listener of [...this.#unavailableListeners]) {
      listener({
        code: "ADOPTED_BRIDGE_LOST",
        message: "The adopted bridge connection closed before the terminal exited.",
      });
    }
  }

  private sendControl(command: object): void {
    this.#socket.write(`${JSON.stringify(command)}\n`, (error) => {
      if (error !== undefined && error !== null) {
        this.#events.emitDiagnostic(`adopted bridge send failed: ${error.message}`);
      }
    });
  }
}
