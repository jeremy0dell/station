import type { SafeError } from "@station/contracts";
import { runTmuxCommand, type TmuxCommandInput, tryRunTmuxCommand } from "../command.js";
import { tmuxProviderErrorFromUnknown } from "../errors.js";
import type { TmuxCurrentClientInput, TmuxPopupCommandInputOptions } from "./types.js";

type TmuxPopupCommandMessages = {
  operation?: string;
  message?: string;
  timeoutMessage?: string;
};

type RequiredTmuxPopupCommandMessages = {
  operation: string;
  message: string;
  timeoutMessage: string;
};

function popupFallback(message: string): SafeError {
  return {
    tag: "TerminalProviderError",
    code: "TERMINAL_POPUP_FAILED",
    message,
    provider: "tmux",
  };
}

function popupTimeoutError(message: string): SafeError {
  return {
    tag: "TerminalProviderError",
    code: "TERMINAL_TMUX_TIMEOUT",
    message,
    provider: "tmux",
  };
}

export function popupCommandInput(
  options: TmuxPopupCommandInputOptions,
  command: string,
): TmuxCommandInput {
  const input: TmuxCommandInput = {
    command,
  };
  if (options.runner !== undefined) {
    input.runner = options.runner;
  }
  if (options.timeoutMs !== undefined) {
    input.timeoutMs = options.timeoutMs;
  }
  return input;
}

export async function runTmuxPopupCommand(
  input: TmuxCommandInput,
  options: RequiredTmuxPopupCommandMessages & { args: string[] },
): Promise<void> {
  await runTmuxPopupQuery(input, options);
}

export async function runTmuxPopupQuery(
  input: TmuxCommandInput,
  options: RequiredTmuxPopupCommandMessages & { args: string[] },
) {
  try {
    return await runTmuxCommand(input, {
      args: options.args,
      operation: options.operation,
      fallback: popupFallback(options.message),
      timeoutError: popupTimeoutError(options.timeoutMessage),
    });
  } catch (error) {
    throw tmuxProviderErrorFromUnknown(error, {
      code: "TERMINAL_OPEN_FAILED",
      message: options.message,
    });
  }
}

export async function resolveTmuxOption(
  input: TmuxCommandInput,
  options: RequiredTmuxPopupCommandMessages & { args: string[] },
): Promise<string | undefined> {
  const result = await tryRunTmuxCommand(input, {
    args: options.args,
    operation: options.operation,
    fallback: popupFallback(options.message),
    timeoutError: popupTimeoutError(options.timeoutMessage),
  });
  const value = result?.stdout.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export async function resolveTmuxGlobalOption(
  input: TmuxCommandInput,
  optionName: string,
  messages: TmuxPopupCommandMessages = {},
): Promise<string | undefined> {
  return resolveTmuxOption(input, {
    args: ["show-options", "-gqv", optionName],
    operation: messages.operation ?? "provider.tmux.popup.globalOption",
    message: messages.message ?? "tmux failed to resolve a station popup option.",
    timeoutMessage: messages.timeoutMessage ?? "tmux popup option lookup timed out.",
  });
}

export async function setTmuxGlobalOption(
  input: TmuxCommandInput,
  optionName: string,
  value: string,
  messages: TmuxPopupCommandMessages = {},
): Promise<void> {
  await runTmuxPopupCommand(input, {
    args: ["set-option", "-gq", optionName, value],
    operation: messages.operation ?? "provider.tmux.popup.setGlobalOption",
    message: messages.message ?? "tmux failed to record a station popup option.",
    timeoutMessage: messages.timeoutMessage ?? "tmux popup option update timed out.",
  });
}

export async function clearTmuxGlobalOption(
  input: TmuxCommandInput,
  optionName: string,
  messages: RequiredTmuxPopupCommandMessages,
): Promise<void> {
  await runTmuxPopupCommand(input, {
    args: ["set-option", "-gq", "-u", optionName],
    ...messages,
  });
}

export async function closeTmuxPopup(
  input: TmuxCommandInput & { clientId: string },
): Promise<void> {
  await runTmuxPopupCommand(input, {
    args: ["display-popup", "-c", input.clientId, "-C"],
    operation: "provider.tmux.popup.close",
    message: "tmux failed to close the active station popup.",
    timeoutMessage: "tmux popup close timed out.",
  });
}

export async function hasTmuxSession(input: TmuxCommandInput, sessionId: string): Promise<boolean> {
  try {
    await runTmuxPopupCommand(input, {
      args: ["has-session", "-t", sessionId],
      operation: "provider.tmux.popup.hasWorkbench",
      message: "tmux failed to inspect the station workbench.",
      timeoutMessage: "tmux workbench inspection timed out.",
    });
    return true;
  } catch {
    return false;
  }
}

export async function resolveCurrentTmuxClientId(
  input: TmuxCurrentClientInput,
): Promise<string | undefined> {
  if (input.env.TMUX === undefined || input.env.TMUX.length === 0) {
    return undefined;
  }
  return resolveTmuxOption(input, {
    args: ["display-message", "-p", "#{client_name}"],
    operation: "provider.tmux.popup.currentClient",
    message: "tmux failed to resolve the current client for the station popup.",
    timeoutMessage: "tmux current client lookup timed out.",
  });
}
