import type { SafeError } from "@station/contracts";
import { runTmuxCommand, type TmuxCommandInput, tryRunTmuxCommand } from "../command.js";
import { tmuxProviderErrorFromUnknown } from "../errors.js";
import { isSafePopupClientName } from "./fastProtocol.js";
import type {
  TmuxClientIdentity,
  TmuxCurrentClientInput,
  TmuxPopupCommandInputOptions,
} from "./types.js";

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

function parseTmuxClientIdentity(value: string): TmuxClientIdentity | undefined {
  const [pidText, name, sessionName, ...rest] = value.trim().split("\t");
  if (
    rest.length > 0 ||
    pidText === undefined ||
    name === undefined ||
    sessionName === undefined ||
    !/^[1-9][0-9]{0,9}$/.test(pidText) ||
    !isSafePopupClientName(name)
  ) {
    return undefined;
  }
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid > 2_147_483_647 || sessionName.length === 0) {
    return undefined;
  }
  return { name, pid, sessionName };
}

function parseTmuxClientSession(value: string, clientId: string): string | undefined {
  for (const line of value.split("\n")) {
    const [name, sessionName, ...rest] = line.split("\t");
    if (rest.length === 0 && name === clientId && sessionName !== undefined) {
      return sessionName.length > 0 ? sessionName : undefined;
    }
  }
  return undefined;
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

/**
 * Resolves the session attached to an exact tmux client from one coherent client listing.
 *
 * `display-message -c` does not reliably scope client format fields while a nested popup client is
 * active, so callers must select the requested client row explicitly.
 */
export async function resolveTmuxClientSession(
  input: TmuxCommandInput,
  clientId: string,
): Promise<string | undefined> {
  const value = await resolveTmuxOption(input, {
    args: ["list-clients", "-F", "#{client_name}\t#{client_session}"],
    operation: "provider.tmux.popup.resolveClientSession",
    message: "tmux failed to resolve the station popup client session.",
    timeoutMessage: "tmux popup client session lookup timed out.",
  });
  return value === undefined ? undefined : parseTmuxClientSession(value, clientId);
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

export async function resolveCurrentTmuxClient(
  input: TmuxCurrentClientInput,
): Promise<TmuxClientIdentity | undefined> {
  if (input.env.TMUX === undefined || input.env.TMUX.length === 0) {
    return undefined;
  }
  const value = await resolveTmuxOption(input, {
    args: ["display-message", "-p", "#{client_pid}\t#{client_name}\t#{client_session}"],
    operation: "provider.tmux.popup.currentClientIdentity",
    message: "tmux failed to resolve the current client identity for the station popup.",
    timeoutMessage: "tmux current client identity lookup timed out.",
  });
  return value === undefined ? undefined : parseTmuxClientIdentity(value);
}
