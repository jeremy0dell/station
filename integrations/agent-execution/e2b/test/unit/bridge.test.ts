import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createExecutionBridge, type RemoteAttachment } from "../../src/bridge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(attach: Parameters<typeof createExecutionBridge>[1]) {
  const root = await mkdtemp(join(tmpdir(), "stn-bridge-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bridge = await createExecutionBridge(root, attach);
  cleanups.push(() => bridge.dispose());
  return bridge;
}
async function client(path: string) {
  const socket = createConnection(path);
  socket.on("error", () => {});
  await once(socket, "connect");
  cleanups.push(async () => {
    socket.destroy();
  });
  return socket;
}
function send(socket: Socket, value: object) {
  socket.write(`${JSON.stringify(value)}\n`);
}
function remote(): RemoteAttachment {
  return {
    input: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
  };
}
it("detaches an attachment that arrives after local revocation without accepting queued input", async () => {
  const attachment = remote();
  let resolve: ((value: RemoteAttachment) => void) | undefined;
  const attach = vi.fn(
    () =>
      new Promise<RemoteAttachment>((done) => {
        resolve = done;
      }),
  );
  const bridge = await fixture(attach);
  const socket = await client(bridge.path);
  send(socket, { type: "attach", sessionId: "ses_test", cols: 80, rows: 24 });
  send(socket, { type: "input", data: Buffer.from("forbidden").toString("base64") });
  await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
  bridge.revoke("ses_test");
  await once(socket, "close");
  resolve?.(attachment);
  await vi.waitFor(() => expect(attachment.detach).toHaveBeenCalledTimes(1));
  expect(attachment.input).not.toHaveBeenCalled();
});
it("replaces only the terminal attachment and relays input and resize to its current controller", async () => {
  const old = remote();
  const current = remote();
  const attach = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(current);
  const bridge = await fixture(attach);
  const first = await client(bridge.path);
  const ready = once(first, "data");
  send(first, { type: "attach", sessionId: "ses_test", cols: 80, rows: 24 });
  await ready;
  const second = await client(bridge.path);
  const nextReady = once(second, "data");
  send(second, { type: "attach", sessionId: "ses_test", cols: 100, rows: 30 });
  await nextReady;
  send(second, { type: "input", data: Buffer.from("hello").toString("base64") });
  send(second, { type: "resize", cols: 120, rows: 35 });
  await vi.waitFor(() => expect(current.resize).toHaveBeenCalledWith(120, 35));
  expect(current.input).toHaveBeenCalledWith(Buffer.from("hello"));
  expect(old.detach).toHaveBeenCalledTimes(1);
  expect(old.input).not.toHaveBeenCalled();
});
it("rejects oversized input before opening a remote terminal", async () => {
  const attach = vi.fn();
  const bridge = await fixture(attach);
  const socket = await client(bridge.path);
  socket.write("x".repeat(70_000));
  await once(socket, "close");
  expect(attach).not.toHaveBeenCalled();
});
