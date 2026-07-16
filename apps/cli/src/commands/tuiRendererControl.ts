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
  resolveFocusOrigin: () => Promise<TerminalFocusOrigin | undefined>;
};

export type TuiRendererControlAttachment = {
  dispose: () => void;
};

/**
 * ADAPTER
 *
 * Translates strict renderer IPC requests into CLI-owned popup capabilities.
 *
 * Malformed or duplicate in-flight requests close the channel before any popup action runs.
 */
export function attachTuiRendererControl(
  child: ChildProcess,
  adapters: TuiRendererControlAdapters,
): TuiRendererControlAttachment {
  let closed = false;
  const pendingRequestIds = new Set<string>();

  const removeListeners = () => {
    child.off("message", onMessage);
    child.off("disconnect", onChildClosed);
    child.off("error", onChildClosed);
    child.off("exit", onChildClosed);
  };
  const close = (disconnect: boolean) => {
    if (closed) return;
    closed = true;
    pendingRequestIds.clear();
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
        try {
          const result = await adapters.dismissPopup();
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

      try {
        const origin = await adapters.resolveFocusOrigin();
        if (origin === undefined) {
          sendError(request.requestId, undefined, focusOriginError);
          return;
        }
        send({
          protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
          requestId: request.requestId,
          type: "focus-origin",
          origin,
        });
      } catch (error) {
        sendError(request.requestId, error, focusOriginError);
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
  message: "The tmux popup could not be dismissed.",
};

const focusOriginError: SafeError = {
  tag: "TuiRendererControlError",
  code: "TUI_POPUP_FOCUS_ORIGIN_UNAVAILABLE",
  message: "The current tmux popup focus origin could not be resolved.",
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
