import {
  TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
  type TuiRendererControlRequest,
} from "@station/contracts";
import { describe, expect, it } from "bun:test";
import { createPopupRuntime, type RendererControlChannel } from "./popupRuntime.js";

describe("createPopupRuntime", () => {
  it("keeps fullscreen behavior separate while transient popups use parent IPC", () => {
    const fullscreenChannel = new FakeRendererControlChannel();
    const fullscreen = createPopupRuntime({}, fullscreenChannel);
    const transientChannel = new FakeRendererControlChannel();
    const transient = createPopupRuntime(
      {
        STATION_TUI_POPUP: "1",
        STATION_FOCUS_PROVIDER: "fixture-terminal",
        STATION_FOCUS_CLIENT_ID: "client-startup",
      },
      transientChannel,
    );

    expect(fullscreen.storeOptions).toEqual({});
    expect(fullscreenChannel.subscribeCount).toBe(0);
    expect(transient.storeOptions).toEqual({
      exitOnFocusSuccess: true,
      focusOrigin: { provider: "fixture-terminal", clientId: "client-startup" },
    });
    expect(transientChannel.subscribeCount).toBe(1);
    expect(transient.openShell).toBeDefined();
  });

  it("fails closed when a generated persistent renderer starts without live IPC", () => {
    let missingControlLossCount = 0;
    const missing = createPopupRuntime(persistentPopupEnv(), undefined, () => {
      missingControlLossCount += 1;
    });
    expect(missingControlLossCount).toBe(1);
    expect(missing.storeOptions).toMatchObject({
      exitOnFocusSuccess: false,
      persistentPopup: true,
    });

    const disconnectedChannel = new FakeRendererControlChannel();
    disconnectedChannel.connected = false;
    let disconnectedControlLossCount = 0;
    createPopupRuntime(persistentPopupEnv(), disconnectedChannel, () => {
      disconnectedControlLossCount += 1;
    });
    expect(disconnectedChannel.subscribeCount).toBe(1);
    expect(disconnectedChannel.unsubscribeCount).toBe(1);
    expect(disconnectedControlLossCount).toBe(1);
  });

  it("opens a shell through the parent using only its validated working directory", async () => {
    const channel = new FakeRendererControlChannel();
    const runtime = createPopupRuntime(persistentPopupEnv(), channel);

    const opened = runtime.openShell?.("/repo/station");
    const request = requiredRequest(channel.requests.at(-1));
    expect(request).toEqual({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      requestId: request.requestId,
      type: "open-shell",
      cwd: "/repo/station",
    });
    channel.respond({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      requestId: request.requestId,
      type: "shell-opened",
    });

    await opened;
  });

  it("uses manual dismissal and an exact one-shot focus target separately", async () => {
    const channel = new FakeRendererControlChannel();
    let controlLossCount = 0;
    const runtime = createPopupRuntime(persistentPopupEnv(), channel, () => {
      controlLossCount += 1;
    });

    expect(runtime.storeOptions).toMatchObject({
      exitOnFocusSuccess: false,
      persistentPopup: true,
    });

    const dismiss = runtime.storeOptions.onDismiss?.();
    const dismissRequest = requiredRequest(channel.requests.at(-1));
    expect(dismissRequest.type).toBe("dismiss");
    channel.respond(dismissedResponse(dismissRequest.requestId));
    await dismiss;

    const targetPromise = runtime.storeOptions.resolveFocusTarget?.();
    const focusRequest = requiredRequest(channel.requests.at(-1));
    expect(focusRequest.type).toBe("resolve-focus-target");
    channel.respond({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      requestId: focusRequest.requestId,
      type: "focus-target",
      origin: { provider: "fixture-terminal", clientId: "client-current" },
    });
    const target = await targetPromise;
    expect(target?.origin).toEqual({
      provider: "fixture-terminal",
      clientId: "client-current",
    });

    const focusDismiss = target?.onFocusSuccess?.();
    const focusDismissRequest = requiredRequest(channel.requests.at(-1));
    expect(focusDismissRequest).toMatchObject({
      type: "dismiss-focus-target",
      focusRequestId: focusRequest.requestId,
    });
    channel.respond(dismissedResponse(focusDismissRequest.requestId));
    await focusDismiss;
    expect(controlLossCount).toBe(0);
  });

  it("resolves a separately leased focus target for every request", async () => {
    const channel = new FakeRendererControlChannel();
    const runtime = createPopupRuntime(persistentPopupEnv(), channel);
    const resolveFocusTarget = runtime.storeOptions.resolveFocusTarget;

    const first = resolveFocusTarget?.();
    const firstRequest = requiredRequest(channel.requests.at(-1));
    channel.respond({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      requestId: firstRequest.requestId,
      type: "focus-target",
      origin: { provider: "fixture-terminal", clientId: "client-a" },
    });
    await expect(first).resolves.toMatchObject({
      origin: { provider: "fixture-terminal", clientId: "client-a" },
    });

    const second = resolveFocusTarget?.();
    const secondRequest = requiredRequest(channel.requests.at(-1));
    channel.respond({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      requestId: secondRequest.requestId,
      type: "focus-target",
      origin: { provider: "fixture-terminal", clientId: "client-b" },
    });
    await expect(second).resolves.toMatchObject({
      origin: { provider: "fixture-terminal", clientId: "client-b" },
    });
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
  });

  it("coalesces duplicate manual dismiss effects", async () => {
    const channel = new FakeRendererControlChannel();
    const runtime = createPopupRuntime(persistentPopupEnv(), channel);

    const first = runtime.storeOptions.onDismiss?.();
    const second = runtime.storeOptions.onDismiss?.();

    expect(channel.requests).toHaveLength(1);
    channel.respond(dismissedResponse(requiredRequest(channel.requests[0]).requestId));
    await Promise.all([first, second]);
  });

  it("surfaces correlated parent errors without closing the channel", async () => {
    const channel = new FakeRendererControlChannel();
    let controlLossCount = 0;
    const runtime = createPopupRuntime(persistentPopupEnv(), channel, () => {
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
        message: "The popup could not be dismissed.",
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
        command: "provider-command",
      }),
      (request: TuiRendererControlRequest) => ({
        protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
        requestId: request.requestId,
        type: "focus-target",
        origin: { provider: "fixture-terminal" },
      }),
    ]) {
      const channel = new FakeRendererControlChannel();
      let controlLossCount = 0;
      const runtime = createPopupRuntime(persistentPopupEnv(), channel, () => {
        controlLossCount += 1;
      });
      const dismiss = runtime.storeOptions.onDismiss?.();
      const request = requiredRequest(channel.requests.at(-1));

      channel.respond(responseFor(request));

      await expect(dismiss).rejects.toMatchObject({ tag: "TuiRendererControlError" });
      expect(channel.closeCount).toBe(1);
      expect(controlLossCount).toBe(1);
    }
  });

  it("reports idle control loss and removes listeners on disconnect or disposal", async () => {
    const disconnectedChannel = new FakeRendererControlChannel();
    let disconnectedControlLossCount = 0;
    const disconnected = createPopupRuntime(
      persistentPopupEnv(),
      disconnectedChannel,
      () => {
        disconnectedControlLossCount += 1;
      },
    );
    disconnectedChannel.disconnect();
    const afterDisconnect = disconnected.storeOptions.resolveFocusTarget?.();

    await expect(afterDisconnect).rejects.toMatchObject({
      code: "TUI_RENDERER_CONTROL_DISCONNECTED",
    });
    expect(disconnectedChannel.unsubscribeCount).toBe(1);
    expect(disconnectedControlLossCount).toBe(1);

    const disposedChannel = new FakeRendererControlChannel();
    let disposedControlLossCount = 0;
    const disposed = createPopupRuntime(persistentPopupEnv(), disposedChannel, () => {
      disposedControlLossCount += 1;
    });
    const pendingDispose = disposed.storeOptions.onDismiss?.();

    disposed.dispose();

    await expect(pendingDispose).rejects.toMatchObject({
      code: "TUI_RENDERER_CONTROL_DISPOSED",
    });
    expect(disposedChannel.unsubscribeCount).toBe(1);
    expect(disposedChannel.closeCount).toBe(0);
    expect(disposedControlLossCount).toBe(0);
  });
});

function dismissedResponse(requestId: string) {
  return {
    protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
    requestId,
    type: "dismissed" as const,
  };
}

function persistentPopupEnv(): Record<string, string> {
  return {
    STATION_TUI_POPUP: "1",
    STATION_TUI_PERSISTENT: "1",
  };
}

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
  connected = true;
  subscribeCount = 0;
  unsubscribeCount = 0;
  private handlers:
    | {
        onMessage(message: unknown): void;
        onDisconnect(): void;
      }
    | undefined;

  isConnected(): boolean {
    return this.connected;
  }

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
    this.connected = false;
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
    this.connected = false;
    handlers.onDisconnect();
  }
}
