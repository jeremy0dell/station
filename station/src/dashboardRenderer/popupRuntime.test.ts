import {
  TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
  type TuiRendererControlRequest,
} from "@station/contracts";
import { describe, expect, it } from "bun:test";
import {
  createPopupRuntime,
  type RendererControlChannel,
} from "./popupRuntime.js";

describe("createPopupRuntime", () => {
  it("keeps fullscreen and transient popup exit behavior separate from persistent IPC", () => {
    const fullscreenChannel = new FakeRendererControlChannel();
    const fullscreen = createPopupRuntime({}, fullscreenChannel);
    const transient = createPopupRuntime(
      {
        STATION_TUI_POPUP: "1",
        STATION_FOCUS_PROVIDER: "tmux",
        STATION_FOCUS_CLIENT_ID: "client-startup",
      },
      undefined,
    );

    expect(fullscreen.storeOptions).toEqual({});
    expect(fullscreenChannel.subscribeCount).toBe(0);
    expect(transient.storeOptions).toEqual({
      exitOnFocusSuccess: true,
      focusOrigin: { provider: "tmux", clientId: "client-startup" },
    });
  });

  it("makes a popup persistent only when the CLI control channel is connected", async () => {
    const channel = new FakeRendererControlChannel();
    let controlLossCount = 0;
    const runtime = createPopupRuntime({ STATION_TUI_POPUP: "1" }, channel, () => {
      controlLossCount += 1;
    });

    expect(runtime.storeOptions).toMatchObject({
      exitOnFocusSuccess: false,
      persistentPopup: true,
    });
    expect(runtime.storeOptions.focusOrigin).toBeUndefined();

    const dismiss = runtime.storeOptions.onDismiss?.();
    expect(dismiss).toBeDefined();
    const dismissRequest = channel.requests.at(-1);
    expect(dismissRequest).toMatchObject({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      type: "dismiss",
    });
    channel.respond({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      requestId: requiredRequest(dismissRequest).requestId,
      type: "dismissed",
    });
    await dismiss;

    const focusSuccessDismiss = runtime.storeOptions.onFocusSuccess?.();
    expect(focusSuccessDismiss).toBeDefined();
    const focusSuccessRequest = requiredRequest(channel.requests.at(-1));
    expect(focusSuccessRequest.type).toBe("dismiss");
    channel.respond({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      requestId: focusSuccessRequest.requestId,
      type: "dismissed",
    });
    await focusSuccessDismiss;
    expect(controlLossCount).toBe(0);
  });

  it("resolves the current focus origin for every request", async () => {
    const channel = new FakeRendererControlChannel();
    const runtime = createPopupRuntime({ STATION_TUI_POPUP: "1" }, channel);
    const resolveFocusOrigin = runtime.storeOptions.resolveFocusOrigin;
    expect(resolveFocusOrigin).toBeDefined();

    const first = resolveFocusOrigin?.();
    const firstRequest = requiredRequest(channel.requests.at(-1));
    channel.respond({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      requestId: firstRequest.requestId,
      type: "focus-origin",
      origin: { provider: "tmux", clientId: "client-a" },
    });
    await expect(first).resolves.toEqual({ provider: "tmux", clientId: "client-a" });

    const second = resolveFocusOrigin?.();
    const secondRequest = requiredRequest(channel.requests.at(-1));
    channel.respond({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      requestId: secondRequest.requestId,
      type: "focus-origin",
      origin: { provider: "tmux", clientId: "client-b" },
    });
    await expect(second).resolves.toEqual({ provider: "tmux", clientId: "client-b" });
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
  });

  it("correlates concurrent dismiss and focus-origin responses", async () => {
    const channel = new FakeRendererControlChannel();
    const runtime = createPopupRuntime({ STATION_TUI_POPUP: "1" }, channel);

    const dismiss = runtime.storeOptions.onDismiss?.();
    const focusOrigin = runtime.storeOptions.resolveFocusOrigin?.();
    const dismissRequest = requiredRequest(channel.requests[0]);
    const focusRequest = requiredRequest(channel.requests[1]);

    channel.respond({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      requestId: focusRequest.requestId,
      type: "focus-origin",
      origin: { provider: "tmux", clientId: "client-current" },
    });
    channel.respond({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      requestId: dismissRequest.requestId,
      type: "dismissed",
    });

    await expect(focusOrigin).resolves.toEqual({ provider: "tmux", clientId: "client-current" });
    await expect(dismiss).resolves.toEqual(undefined);
  });

  it("surfaces correlated parent errors without closing the channel", async () => {
    const channel = new FakeRendererControlChannel();
    let controlLossCount = 0;
    const runtime = createPopupRuntime({ STATION_TUI_POPUP: "1" }, channel, () => {
      controlLossCount += 1;
    });

    const dismiss = runtime.storeOptions.onDismiss?.();
    const request = requiredRequest(channel.requests.at(-1));
    channel.respond({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      requestId: request.requestId,
      type: "error",
      error: {
        tag: "TuiRendererControlError",
        code: "TUI_POPUP_DISMISS_FAILED",
        message: "The tmux popup could not be dismissed.",
      },
    });

    await expect(dismiss).rejects.toMatchObject({ code: "TUI_POPUP_DISMISS_FAILED" });
    expect(channel.closeCount).toBe(0);
    expect(controlLossCount).toBe(0);
  });

  it("fails closed on malformed, uncorrelated, or mismatched responses", async () => {
    for (const responseFor of [
      () => ({
        protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
        requestId: "wrong",
        type: "dismissed",
      }),
      (request: TuiRendererControlRequest) => ({
        protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
        requestId: request.requestId,
        type: "dismissed",
        command: "tmux kill-popup",
      }),
      (request: TuiRendererControlRequest) => ({
        protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
        requestId: request.requestId,
        type: "focus-origin",
        origin: { provider: "tmux" },
      }),
    ]) {
      const channel = new FakeRendererControlChannel();
      let controlLossCount = 0;
      const runtime = createPopupRuntime({ STATION_TUI_POPUP: "1" }, channel, () => {
        controlLossCount += 1;
      });
      const dismiss = runtime.storeOptions.onDismiss?.();
      const request = requiredRequest(channel.requests.at(-1));

      channel.respond(responseFor(request));

      await expect(dismiss).rejects.toMatchObject({
        tag: "TuiRendererControlError",
      });
      expect(channel.closeCount).toBe(1);
      expect(controlLossCount).toBe(1);
    }
  });

  it("reports idle control loss and removes listeners on disconnect or disposal", async () => {
    const disconnectedChannel = new FakeRendererControlChannel();
    let disconnectedControlLossCount = 0;
    const disconnected = createPopupRuntime(
      { STATION_TUI_POPUP: "1" },
      disconnectedChannel,
      () => {
        disconnectedControlLossCount += 1;
      },
    );
    disconnectedChannel.disconnect();
    const afterDisconnect = disconnected.storeOptions.resolveFocusOrigin?.();

    await expect(afterDisconnect).rejects.toMatchObject({
      code: "TUI_RENDERER_CONTROL_DISCONNECTED",
    });
    expect(disconnectedChannel.unsubscribeCount).toBe(1);
    expect(disconnectedControlLossCount).toBe(1);

    const disposedChannel = new FakeRendererControlChannel();
    let disposedControlLossCount = 0;
    const disposed = createPopupRuntime({ STATION_TUI_POPUP: "1" }, disposedChannel, () => {
      disposedControlLossCount += 1;
    });
    const pendingDispose = disposed.storeOptions.onDismiss?.();

    disposed.dispose();

    await expect(pendingDispose).rejects.toMatchObject({
      code: "TUI_RENDERER_CONTROL_DISPOSED",
    });
    expect(disposedChannel.unsubscribeCount).toBe(1);
    expect(disposedControlLossCount).toBe(0);
  });
});

function requiredRequest(
  request: TuiRendererControlRequest | undefined,
): TuiRendererControlRequest {
  if (request === undefined) {
    throw new Error("Expected a renderer control request.");
  }
  return request;
}

class FakeRendererControlChannel implements RendererControlChannel {
  readonly requests: TuiRendererControlRequest[] = [];
  closeCount = 0;
  subscribeCount = 0;
  unsubscribeCount = 0;
  private handlers:
    | {
        onMessage(message: unknown): void;
        onDisconnect(): void;
      }
    | undefined;

  send(request: TuiRendererControlRequest): void {
    this.requests.push(request);
  }

  subscribe(handlers: {
    onMessage(message: unknown): void;
    onDisconnect(): void;
  }): () => void {
    this.subscribeCount += 1;
    this.handlers = handlers;
    return () => {
      if (this.handlers === handlers) {
        this.handlers = undefined;
      }
      this.unsubscribeCount += 1;
    };
  }

  close(): void {
    this.closeCount += 1;
  }

  respond(message: unknown): void {
    const handlers = this.handlers;
    if (handlers === undefined) {
      throw new Error("Renderer control channel has no subscriber.");
    }
    handlers.onMessage(message);
  }

  disconnect(): void {
    const handlers = this.handlers;
    if (handlers === undefined) {
      throw new Error("Renderer control channel has no subscriber.");
    }
    handlers.onDisconnect();
  }
}
