import {
  TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
  TerminalFocusOriginSchema,
  TuiRendererControlResponseSchema,
  type SafeError,
  type TerminalFocusOrigin,
  type TuiRendererControlRequest,
  type TuiRendererControlResponse,
} from "@station/contracts";
import type { TuiStoreOptions } from "@station/dashboard-core";

export type RendererControlChannel = {
  send(request: TuiRendererControlRequest): void;
  subscribe(handlers: {
    onMessage(message: unknown): void;
    onDisconnect(): void;
  }): () => void;
  close(): void;
};

type PopupStoreOptions = Pick<
  TuiStoreOptions,
  | "exitOnFocusSuccess"
  | "focusOrigin"
  | "onDismiss"
  | "onFocusSuccess"
  | "persistentPopup"
  | "resolveFocusOrigin"
>;

export type PopupRuntime = {
  storeOptions: PopupStoreOptions;
  dispose(): void;
};

export function createPopupRuntime(
  env: Record<string, string | undefined>,
  channel: RendererControlChannel | undefined,
  onControlLoss: () => void = () => {},
): PopupRuntime {
  if (env.STATION_TUI_POPUP !== "1") {
    return { storeOptions: {}, dispose: () => {} };
  }

  if (channel === undefined) {
    const focusOrigin = focusOriginFromEnv(env);
    return {
      storeOptions: {
        exitOnFocusSuccess: true,
        ...(focusOrigin === undefined ? {} : { focusOrigin }),
      },
      dispose: () => {},
    };
  }

  const control = createRendererControlClient(channel, onControlLoss);
  const dismiss = async (): Promise<void> => control.dismiss();
  return {
    storeOptions: {
      exitOnFocusSuccess: false,
      persistentPopup: true,
      onDismiss: dismiss,
      onFocusSuccess: dismiss,
      resolveFocusOrigin: async () => control.resolveFocusOrigin(),
    },
    dispose: control.dispose,
  };
}

export function createProcessRendererControlChannel(): RendererControlChannel | undefined {
  if (process.connected !== true || typeof process.send !== "function") {
    return undefined;
  }

  return {
    send: (request): void => {
      if (process.connected !== true || process.send === undefined) {
        throw rendererControlError(
          "TUI_RENDERER_CONTROL_DISCONNECTED",
          "The popup renderer control channel disconnected.",
        );
      }
      process.send(request);
    },
    subscribe: ({ onMessage, onDisconnect }): (() => void) => {
      process.on("message", onMessage);
      process.on("disconnect", onDisconnect);
      return () => {
        process.off("message", onMessage);
        process.off("disconnect", onDisconnect);
      };
    },
    close: (): void => {
      if (process.connected === true) {
        process.disconnect?.();
      }
    },
  };
}

type PendingRequest =
  | {
      type: "dismiss";
      resolve(): void;
      reject(error: SafeError): void;
    }
  | {
      type: "resolve-focus-origin";
      resolve(origin: TerminalFocusOrigin): void;
      reject(error: SafeError): void;
    };

type RendererControlClient = {
  dismiss(): Promise<void>;
  resolveFocusOrigin(): Promise<TerminalFocusOrigin>;
  dispose(): void;
};

function createRendererControlClient(
  channel: RendererControlChannel,
  onControlLoss: () => void,
): RendererControlClient {
  const pending = new Map<string, PendingRequest>();
  let nextRequestId = 1;
  let closedError: SafeError | undefined;

  const unsubscribe = channel.subscribe({
    onMessage: (message) => {
      const parsed = TuiRendererControlResponseSchema.safeParse(message);
      if (!parsed.success) {
        loseControl(
          rendererControlError(
            "TUI_RENDERER_CONTROL_INVALID_RESPONSE",
            "The popup renderer received an invalid control response.",
          ),
          true,
        );
        return;
      }
      settle(parsed.data);
    },
    onDisconnect: () => {
      loseControl(
        rendererControlError(
          "TUI_RENDERER_CONTROL_DISCONNECTED",
          "The popup renderer control channel disconnected.",
        ),
        false,
      );
    },
  });

  function newRequestId(): string {
    const requestId = `renderer-${nextRequestId}`;
    nextRequestId += 1;
    return requestId;
  }

  function send(request: TuiRendererControlRequest, requestState: PendingRequest): void {
    if (closedError !== undefined) {
      requestState.reject(closedError);
      return;
    }
    pending.set(request.requestId, requestState);
    try {
      channel.send(request);
    } catch {
      loseControl(
        rendererControlError(
          "TUI_RENDERER_CONTROL_SEND_FAILED",
          "The popup renderer could not send a control request.",
        ),
        true,
      );
    }
  }

  function settle(response: TuiRendererControlResponse): void {
    const request = pending.get(response.requestId);
    if (request === undefined) {
      loseControl(
        rendererControlError(
          "TUI_RENDERER_CONTROL_CORRELATION_FAILED",
          "The popup renderer received an uncorrelated control response.",
        ),
        true,
      );
      return;
    }

    if (response.type === "error") {
      pending.delete(response.requestId);
      request.reject(response.error);
      return;
    }
    if (response.type === "dismissed" && request.type === "dismiss") {
      pending.delete(response.requestId);
      request.resolve();
      return;
    }
    if (response.type === "focus-origin" && request.type === "resolve-focus-origin") {
      pending.delete(response.requestId);
      request.resolve(response.origin);
      return;
    }

    loseControl(
      rendererControlError(
        "TUI_RENDERER_CONTROL_CORRELATION_FAILED",
        "The popup renderer received a mismatched control response.",
      ),
      true,
    );
  }

  function loseControl(error: SafeError, close: boolean): void {
    if (fail(error, close)) {
      onControlLoss();
    }
  }

  function fail(error: SafeError, close: boolean): boolean {
    if (closedError !== undefined) {
      return false;
    }
    closedError = error;
    unsubscribe();
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
    if (close) {
      channel.close();
    }
    return true;
  }

  return {
    dismiss: async (): Promise<void> => {
      const requestId = newRequestId();
      return new Promise<void>((resolve, reject) => {
        send(
          {
            protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
            requestId,
            type: "dismiss",
          },
          { type: "dismiss", resolve, reject },
        );
      });
    },
    resolveFocusOrigin: async (): Promise<TerminalFocusOrigin> => {
      const requestId = newRequestId();
      return new Promise<TerminalFocusOrigin>((resolve, reject) => {
        send(
          {
            protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
            requestId,
            type: "resolve-focus-origin",
          },
          { type: "resolve-focus-origin", resolve, reject },
        );
      });
    },
    dispose: (): void => {
      fail(
        rendererControlError(
          "TUI_RENDERER_CONTROL_DISPOSED",
          "The popup renderer control channel was disposed.",
        ),
        false,
      );
    },
  };
}

function focusOriginFromEnv(
  env: Record<string, string | undefined>,
): TerminalFocusOrigin | undefined {
  const provider = env.STATION_FOCUS_PROVIDER;
  if (provider === undefined || provider.length === 0) {
    return undefined;
  }
  const candidate: { provider: string; clientId?: string } = { provider };
  const clientId = env.STATION_FOCUS_CLIENT_ID;
  if (clientId !== undefined && clientId.length > 0) {
    candidate.clientId = clientId;
  }
  const parsed = TerminalFocusOriginSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function rendererControlError(code: string, message: string): SafeError {
  return {
    tag: "TuiRendererControlError",
    code,
    message,
  };
}
