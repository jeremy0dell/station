import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import * as timers from "node:timers/promises";
import { isSameHostPtyIdentity, isSameHostPtyRef } from "@station/host";
import { WebSocket } from "ws";
import { requestTerminalGrant } from "./terminalBroker.js";
import {
  INPUT_FRAME_BYTES,
  INPUT_WINDOW_BYTES,
  MAX_PENDING_BYTES,
  type TerminalOperation,
  TerminalServerFrameSchema,
} from "./terminalProtocol.js";

/** Ordered input/resize sender; acknowledgements release capacity, never trigger retransmission. */
export class TerminalInputWindow {
  private queue: Array<
    | Omit<Extract<TerminalOperation, { type: "input" }>, "seq">
    | Omit<Extract<TerminalOperation, { type: "resize" }>, "seq">
  > = [];
  private outstanding: Array<{ seq: number; bytes: number }> = [];
  private queuedBytes = 0;
  private unacknowledged = 0;
  private sequence = 0;
  private accepted = 0;
  private sentBytes = 0;
  private pendingHighWater = 0;
  private unacknowledgedHighWater = 0;
  get highWaterMarks() {
    return {
      pendingInputBytes: this.pendingHighWater,
      unacknowledgedInputBytes: this.unacknowledgedHighWater,
    };
  }
  constructor(private readonly send: (operation: TerminalOperation) => void) {}
  input(data: string): void {
    let chunk = "";
    let bytes = 0;
    for (const character of data) {
      const length = Buffer.byteLength(character);
      if (bytes + length > INPUT_FRAME_BYTES) {
        this.enqueue({ type: "input", data: chunk });
        chunk = "";
        bytes = 0;
      }
      chunk += character;
      bytes += length;
    }
    if (chunk) this.enqueue({ type: "input", data: chunk });
  }
  resize(cols: number, rows: number): void {
    this.enqueue({ type: "resize", cols, rows });
  }
  acknowledge(seq: number, bytes: number): void {
    const index = this.outstanding.findIndex((item) => item.seq === seq);
    if (index < 0 || bytes < this.accepted || bytes > this.sentBytes)
      throw new Error("Invalid terminal acknowledgement.");
    const acknowledged = this.outstanding
      .slice(0, index + 1)
      .reduce((sum, item) => sum + item.bytes, 0);
    if (bytes !== this.accepted + acknowledged)
      throw new Error("Terminal byte acknowledgement mismatch.");
    this.outstanding.splice(0, index + 1);
    this.accepted = bytes;
    this.unacknowledged -= acknowledged;
    this.pump();
  }
  disconnect(): boolean {
    const uncertain = this.outstanding.length > 0;
    this.queue = [];
    this.outstanding = [];
    this.queuedBytes = 0;
    this.unacknowledged = 0;
    return uncertain;
  }
  private enqueue(operation: (typeof this.queue)[number]): void {
    const bytes = Buffer.byteLength(JSON.stringify(operation));
    if (this.queuedBytes + bytes > MAX_PENDING_BYTES)
      throw new Error("Terminal input queue exceeded 1 MiB.");
    this.queue.push(operation);
    this.queuedBytes += bytes;
    this.pendingHighWater = Math.max(this.pendingHighWater, this.queuedBytes);
    this.pump();
  }
  private pump(): void {
    while (this.queue.length > 0) {
      const operation = this.queue[0];
      if (operation === undefined) break;
      const bytes = operation.type === "input" ? Buffer.byteLength(operation.data) : 0;
      if (this.unacknowledged + bytes > INPUT_WINDOW_BYTES || this.outstanding.length >= 1024)
        break;
      this.queue.shift();
      this.queuedBytes -= Buffer.byteLength(JSON.stringify(operation));
      this.sequence++;
      this.sentBytes += bytes;
      this.unacknowledged += bytes;
      this.unacknowledgedHighWater = Math.max(this.unacknowledgedHighWater, this.unacknowledged);
      this.outstanding.push({ seq: this.sequence, bytes });
      this.send({ ...operation, seq: this.sequence });
    }
  }
}

/**
 * ADAPTER
 *
 * Runs as a local Host child and streams directly to the remote attachment gateway.
 * Disconnect clears all pending input; each retry obtains a new single-use ticket.
 */
export async function runTerminalRelay(path: string, sessionId: string): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("Cloud attachment requires an interactive terminal.");
  let stopped = false;
  let active: TerminalInputWindow | undefined;
  let websocket: WebSocket | undefined;
  let decoder = new StringDecoder("utf8");
  const raw = process.stdin.isRaw;
  const notice = (message: string) => {
    process.stderr.write(`\r\n[Station] ${message}\r\n`);
  };
  const stop = () => {
    stopped = true;
    websocket?.terminate();
  };
  const input = (data: Buffer) => {
    if (active === undefined) {
      notice("Disconnected: input was not sent.");
      return;
    }
    try {
      active.input(decoder.write(data));
    } catch {
      notice("Input queue overflow: attachment disconnected; pending input will not be replayed.");
      websocket?.terminate();
    }
  };
  const resize = () => {
    try {
      active?.resize(
        Math.min(1000, process.stdout.columns || 80),
        Math.min(1000, process.stdout.rows || 24),
      );
    } catch {
      websocket?.terminate();
    }
  };
  process.stdin.setRawMode(true);
  process.stdin.on("data", input);
  process.stdin.resume();
  process.stdout.on("resize", resize);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  try {
    for (let attempt = 0; attempt < 6 && !stopped; attempt++) {
      let grantConnection: Awaited<ReturnType<typeof requestTerminalGrant>> | undefined;
      try {
        grantConnection = await requestTerminalGrant(path, sessionId, stop);
        const response = grantConnection.response;
        if (response.type !== "grant" || stopped) throw new Error("Grant unavailable");
        const grant = response.grant;
        if (Date.parse(grant.deadline) <= Date.now()) throw new Error("Expired grant");
        const socket = new WebSocket(grant.address, {
          headers: { "e2b-traffic-access-token": grant.trafficToken },
          maxPayload: MAX_PENDING_BYTES,
          perMessageDeflate: false,
          handshakeTimeout: 15000,
        });
        websocket = socket;
        let pending = Promise.resolve();
        let queuedBytes = 0;
        let attached = false;
        let connected = true;
        const send = (value: object) => {
          const data = JSON.stringify(value);
          if (
            socket.readyState !== WebSocket.OPEN ||
            socket.bufferedAmount + Buffer.byteLength(data) > MAX_PENDING_BYTES
          )
            throw new Error("Terminal send unavailable");
          socket.send(data, (error) => {
            if (error) socket.terminate();
          });
        };
        const closed = new Promise<void>((resolve) => {
          socket.once("close", () => {
            connected = false;
            resolve();
          });
        });
        const timeout = setTimeout(() => socket.terminate(), 15000);
        socket.on("error", () => socket.terminate());
        socket.on("open", () => {
          if (stopped) {
            socket.terminate();
            return;
          }
          send({
            type: "attach",
            version: 1,
            ticket: grant.ticket,
            execution: grant.execution,
            identity: grant.identity,
          });
        });
        const output = async (data: string) => {
          if (!process.stdout.write(data)) await once(process.stdout, "drain");
        };
        socket.on("message", (data, binary) => {
          const bytes = Buffer.byteLength(data.toString());
          queuedBytes += bytes;
          if (queuedBytes > MAX_PENDING_BYTES) {
            notice("Output queue overflow; reconnecting for terminal replay.");
            socket.terminate();
            return;
          }
          pending = pending
            .then(async () => {
              if (!connected) return;
              if (binary) throw new Error("Binary output");
              const frame = TerminalServerFrameSchema.parse(JSON.parse(data.toString()));
              if (frame.type === "attached") {
                if (
                  attached ||
                  !isSameHostPtyIdentity(frame.ack, grant.identity) ||
                  !isSameHostPtyRef(frame.ack, grant.identity)
                )
                  throw new Error("Terminal identity mismatch");
                attached = true;
                clearTimeout(timeout);
                await output(
                  frame.ack.replay.kind === "live-reset-recovery"
                    ? frame.ack.replay.resetData
                    : "\x1bc",
                );
                for (const event of frame.ack.replay.events)
                  if (event.type === "data") await output(event.data);
                if (frame.ack.replay.kind !== "raw-complete")
                  notice("Earlier output was truncated; terminal state was recovered.");
                if (!connected) return;
                active = new TerminalInputWindow(send);
                decoder = new StringDecoder("utf8");
                resize();
              } else if (frame.type === "accepted") {
                if (active === undefined) throw new Error("Acknowledgement before attachment");
                active.acknowledge(frame.seq, frame.bytes);
              } else if (frame.type === "failure") {
                notice(frame.message);
                if (frame.code === "revoked") stopped = true;
                socket.terminate();
              } else {
                if (!attached || frame.frame.ptyId !== grant.identity.ptyId)
                  throw new Error("Unexpected terminal frame");
                if (frame.frame.type === "data") await output(frame.frame.data);
                if (frame.frame.type === "exit") {
                  stopped = true;
                  socket.close();
                }
                if (frame.frame.type === "control-revoked") stop();
              }
            })
            .catch(() => socket.terminate())
            .finally(() => {
              queuedBytes -= bytes;
            });
        });
        await closed;
        clearTimeout(timeout);
        if (active?.disconnect())
          notice("Input delivery was unconfirmed. Pending input will not be replayed.");
        active = undefined;
      } catch {
        notice("Cloud attachment unavailable; no new agent was started.");
      } finally {
        grantConnection?.close();
        websocket?.terminate();
        active = undefined;
      }
      if (!stopped && attempt < 5) {
        notice("Reconnecting to the original cloud terminal…");
        await timers.setTimeout(Math.min(8000, 250 * 2 ** attempt));
      }
    }
    if (!stopped) notice("Reconnect attempts exhausted. Reopen this session to try again.");
  } finally {
    process.stdin.off("data", input);
    process.stdout.off("resize", resize);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
    process.stdin.setRawMode(raw);
    process.stdin.pause();
  }
}
