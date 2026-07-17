import type { ChildProcess } from "node:child_process";
import {
  type SafeError,
  type TerminalFocusOrigin,
  TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
  TuiRendererControlRequestSchema,
  type TuiRendererControlResponse,
} from "@station/contracts";
import { safeErrorFromUnknown } from "@station/runtime";

export type TuiRendererControlAdapters = {
  dismissPopup: () => Promise<{ dismissed: boolean }>;
  /** Opens the shell and completes any exact popup dismissal owned by the adapter. */
  openShell?: (cwd: string) => Promise<{ opened: boolean }>;
  resolveFocusTarget: () => Promise<TuiRendererFocusTarget | undefined>;
};

export type TuiRendererFocusTarget = {
  origin: TerminalFocusOrigin;
  dismissExact: () => Promise<{ dismissed: boolean }>;
};

export type TuiRendererControlAttachment = {
  dispose: () => void;
};

/**
 * ADAPTER
 *
 * Translates strict renderer IPC requests into CLI-owned popup capabilities.
 *
 * Malformed or duplicate in-flight IDs close the channel; same-cwd shell effects coalesce.
 */
export function attachTuiRendererControl(
  child: ChildProcess,
  adapters: TuiRendererControlAdapters,
): TuiRendererControlAttachment {
  let closed = false;
  const pendingRequestIds = new Set<string>();
  let focusResolutionGeneration = 0;
  let activeFocusTarget:
    | {
        requestId: string;
        dismissExact: () => Promise<{ dismissed: boolean }>;
      }
    | undefined;
  let manualDismissEffect: Promise<{ dismissed: boolean }> | undefined;
  const shellOpenEffects = new Map<string, Promise<{ opened: boolean }>>();

  const removeListeners = () => {
    child.off("message", onMessage);
    child.off("disconnect", onChildClosed);
    child.off("error", onChildClosed);
    child.off("exit", onChildClosed);
  };
  const close = (disconnect: boolean) => {
    if (closed) return;
    closed = true;
    focusResolutionGeneration += 1;
    activeFocusTarget = undefined;
    pendingRequestIds.clear();
    shellOpenEffects.clear();
    removeListeners();
    if (disconnect && child.connected) {
      child.disconnect();
    }
  };
  const send = (response: TuiRendererControlResponse) => {
    if (closed || !child.connected || child.send === undefined) {
      close(false);
      return;
    }
    try {
      child.send(response, (error) => {
        if (error !== null && error !== undefined) close(true);
      });
    } catch {
      close(true);
    }
  };
  const sendError = (requestId: string, error: unknown, fallback: SafeError) => {
    send({
      protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
      requestId,
      type: "error",
      error: controlSafeError(error, fallback),
    });
  };
  const handleMessage = async (message: unknown) => {
    const parsed = TuiRendererControlRequestSchema.safeParse(message);
    if (!parsed.success || pendingRequestIds.has(parsed.data.requestId)) {
      close(true);
      return;
    }

    const request = parsed.data;
    pendingRequestIds.add(request.requestId);
    try {
      if (request.type === "dismiss") {
        focusResolutionGeneration += 1;
        activeFocusTarget = undefined;
        try {
          const result = await coalescedManualDismiss();
          if (!result.dismissed) {
            sendError(request.requestId, undefined, popupDismissError);
            return;
          }
          send({
            protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
            requestId: request.requestId,
            type: "dismissed",
          });
        } catch (error) {
          sendError(request.requestId, error, popupDismissError);
        }
        return;
      }

      if (request.type === "open-shell") {
        try {
          const result = await coalescedShellOpen(request.cwd);
          if (result?.opened !== true) {
            sendError(request.requestId, undefined, popupShellError);
            return;
          }
          send({
            protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
            requestId: request.requestId,
            type: "shell-opened",
          });
        } catch (error) {
          sendError(request.requestId, error, popupShellError);
        }
        return;
      }

      if (request.type === "dismiss-focus-target") {
        const focusTarget = activeFocusTarget;
        if (focusTarget?.requestId !== request.focusRequestId) {
          sendError(request.requestId, undefined, focusTargetStaleError);
          return;
        }
        activeFocusTarget = undefined;
        focusResolutionGeneration += 1;
        try {
          const result = await focusTarget.dismissExact();
          if (!result.dismissed) {
            sendError(request.requestId, undefined, focusTargetStaleError);
            return;
          }
          send({
            protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
            requestId: request.requestId,
            type: "dismissed",
          });
        } catch (error) {
          sendError(request.requestId, error, focusTargetStaleError);
        }
        return;
      }

      const generation = focusResolutionGeneration + 1;
      focusResolutionGeneration = generation;
      activeFocusTarget = undefined;
      try {
        const focusTarget = await adapters.resolveFocusTarget();
        if (focusTarget === undefined) {
          sendError(request.requestId, undefined, focusTargetUnavailableError);
          return;
        }
        if (generation !== focusResolutionGeneration) {
          sendError(request.requestId, undefined, focusTargetStaleError);
          return;
        }
        activeFocusTarget = {
          requestId: request.requestId,
          dismissExact: focusTarget.dismissExact,
        };
        send({
          protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
          requestId: request.requestId,
          type: "focus-target",
          origin: focusTarget.origin,
        });
      } catch (error) {
        sendError(request.requestId, error, focusTargetUnavailableError);
      }
    } finally {
      pendingRequestIds.delete(request.requestId);
    }
  };
  function onMessage(message: unknown): void {
    void handleMessage(message);
  }
  function onChildClosed(): void {
    close(false);
  }

  function coalescedShellOpen(cwd: string): Promise<{ opened: boolean }> {
    const current = shellOpenEffects.get(cwd);
    if (current !== undefined) return current;
    const effect = Promise.resolve().then(() => adapters.openShell?.(cwd) ?? { opened: false });
    shellOpenEffects.set(cwd, effect);
    const clear = () => {
      if (shellOpenEffects.get(cwd) === effect) shellOpenEffects.delete(cwd);
    };
    void effect.then(clear, clear);
    return effect;
  }

  function coalescedManualDismiss(): Promise<{ dismissed: boolean }> {
    const current = manualDismissEffect;
    if (current !== undefined) {
      return current;
    }
    const effect = adapters.dismissPopup();
    manualDismissEffect = effect;
    const clear = () => {
      if (manualDismissEffect === effect) {
        manualDismissEffect = undefined;
      }
    };
    void effect.then(clear, clear);
    return effect;
  }

  child.on("message", onMessage);
  child.on("disconnect", onChildClosed);
  child.on("error", onChildClosed);
  child.on("exit", onChildClosed);

  if (!child.connected || child.send === undefined) {
    close(false);
  }

  return { dispose: () => close(false) };
}

const popupDismissError: SafeError = {
  tag: "TuiRendererControlError",
  code: "TUI_POPUP_DISMISS_FAILED",
  message: "The popup could not be dismissed.",
};

const popupShellError: SafeError = {
  tag: "TuiRendererControlError",
  code: "TUI_POPUP_SHELL_FAILED",
  message: "The popup could not open the requested shell.",
};

const focusTargetUnavailableError: SafeError = {
  tag: "TuiRendererControlError",
  code: "TUI_POPUP_FOCUS_TARGET_UNAVAILABLE",
  message: "The current popup focus target could not be resolved.",
};

const focusTargetStaleError: SafeError = {
  tag: "TuiRendererControlError",
  code: "TUI_POPUP_FOCUS_TARGET_STALE",
  message: "The popup focus target changed before dismissal.",
};

function controlSafeError(error: unknown, fallback: SafeError): SafeError {
  const normalized = safeErrorFromUnknown(error, fallback);
  const result: SafeError = {
    tag: normalized.tag,
    code: normalized.code,
    message: normalized.message,
  };
  if (normalized.hint !== undefined) result.hint = normalized.hint;
  if (normalized.commandId !== undefined) result.commandId = normalized.commandId;
  if (normalized.projectId !== undefined) result.projectId = normalized.projectId;
  if (normalized.worktreeId !== undefined) result.worktreeId = normalized.worktreeId;
  if (normalized.sessionId !== undefined) result.sessionId = normalized.sessionId;
  if (normalized.provider !== undefined) result.provider = normalized.provider;
  if (normalized.traceId !== undefined) result.traceId = normalized.traceId;
  if (normalized.diagnosticId !== undefined) result.diagnosticId = normalized.diagnosticId;
  return result;
}
