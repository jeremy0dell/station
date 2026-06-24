import type { TmuxConfig } from "@station/config";
import type { TerminalFocusOrigin } from "@station/contracts";
import {
  type ExternalCommandRunner,
  runExternalCommand,
  runRuntimeBoundaryWithRetry,
} from "@station/runtime";
import type { TmuxCommandInput } from "../command.js";
import { tmuxProviderErrorFromUnknown } from "../errors.js";
import { buildTmuxPopupArgs } from "./args.js";
import { closeTmuxPopup, popupCommandInput, resolveCurrentTmuxClientId } from "./command.js";
import { activePopupClientOption, focusPopupClientOption } from "./constants.js";
import {
  ensurePersistentPopupSession,
  registerFastPopupUi,
  resolvePersistentPopupUi,
} from "./persistentUi.js";
import {
  clearActivePopupClient,
  clearFocusPopupClient,
  resolveActivePopupClient,
  resolveFocusPopupClient,
  setActivePopupClient,
  setFocusPopupClient,
} from "./state.js";
import type {
  BuildTmuxPopupArgsOptions,
  PopupWorkbenchFocusInput,
  TmuxCurrentClientInput,
  TmuxPersistentPopupSessionOptions,
  TmuxPersistentPopupUi,
  TmuxPopupDismissOptions,
  TmuxPopupDismissResult,
  TmuxPopupFocusOriginOptions,
  TmuxPopupOptions,
  TmuxPopupResult,
  TmuxPopupState,
} from "./types.js";
import { enterWorkbenchForPopup } from "./workbenchFocus.js";

export { buildTmuxPopupArgs } from "./args.js";
export { ensurePersistentPopupSession, resolveRegisteredDevPopupUi } from "./persistentUi.js";
export type {
  TmuxPersistentPopupSessionResult,
  TmuxPopupDismissResult,
  TmuxPopupOptions,
  TmuxPopupResult,
  TmuxRegisteredDevPopupUi,
} from "./types.js";

type PopupDisplayResult = "opened" | "dismissed";

type PopupDisplayInput = {
  args: string[];
  command: string;
  runner?: ExternalCommandRunner;
};

type PopupArgsInput = {
  command: string;
  config?: TmuxConfig;
  focusClientId?: string;
  persistent: boolean;
  persistentUi?: TmuxPersistentPopupUi;
  tuiCommand?: string;
};

function defaultTmuxCommand(command: string | undefined): string {
  return command ?? process.env.STATION_TMUX_BIN ?? "tmux";
}

function currentClientInput(options: TmuxPopupOptions, command: string): TmuxCurrentClientInput {
  const input: TmuxCurrentClientInput = {
    command,
    env: options.env ?? process.env,
  };
  if (options.runner !== undefined) {
    input.runner = options.runner;
  }
  if (options.timeoutMs !== undefined) {
    input.timeoutMs = options.timeoutMs;
  }
  return input;
}

function dismissOptions(
  options: TmuxPopupOptions,
  command: string,
  focusClientId: string,
): TmuxPopupDismissOptions {
  const input: TmuxPopupDismissOptions = {
    command,
    focusClientId,
  };
  if (options.runner !== undefined) {
    input.runner = options.runner;
  }
  if (options.timeoutMs !== undefined) {
    input.timeoutMs = options.timeoutMs;
  }
  return input;
}

function enterWorkbenchInput(
  input: TmuxCommandInput,
  clientId: string,
  config: TmuxConfig | undefined,
): PopupWorkbenchFocusInput {
  const enterInput: PopupWorkbenchFocusInput = {
    ...input,
    clientId,
  };
  if (config !== undefined) {
    enterInput.config = config;
  }
  return enterInput;
}

function persistentSessionOptions(
  options: TmuxPopupOptions,
  command: string,
  persistentUi: TmuxPersistentPopupUi,
): TmuxPersistentPopupSessionOptions {
  const input: TmuxPersistentPopupSessionOptions = {
    command,
    tuiCommand: persistentUi.command,
    uiSessionName: persistentUi.sessionName,
  };
  if (options.runner !== undefined) {
    input.runner = options.runner;
  }
  if (options.timeoutMs !== undefined) {
    input.timeoutMs = options.timeoutMs;
  }
  return input;
}

function popupState(command: string, clientId: string): TmuxPopupState {
  return {
    clientId,
    optionName: activePopupClientOption,
    focusOptionName: focusPopupClientOption,
    tmuxCommand: command,
  };
}

function popupArgsOptions(options: PopupArgsInput): BuildTmuxPopupArgsOptions {
  const input: BuildTmuxPopupArgsOptions = {
    command: options.command,
    persistent: options.persistent,
  };
  if (options.config !== undefined) {
    input.config = options.config;
  }
  if (options.focusClientId !== undefined) {
    input.focusClientId = options.focusClientId;
    input.popupState = popupState(options.command, options.focusClientId);
  }
  if (options.persistentUi !== undefined) {
    input.tuiCommand = options.persistentUi.command;
    input.uiSessionName = options.persistentUi.sessionName;
    return input;
  }
  if (options.tuiCommand !== undefined) {
    input.tuiCommand = options.tuiCommand;
  }
  return input;
}

function popupArgsInput(
  options: TmuxPopupOptions,
  command: string,
  focusClientId: string | undefined,
  persistent: boolean,
  persistentUi: TmuxPersistentPopupUi | undefined,
): PopupArgsInput {
  const input: PopupArgsInput = {
    command,
    persistent,
  };
  if (options.config !== undefined) {
    input.config = options.config;
  }
  if (focusClientId !== undefined) {
    input.focusClientId = focusClientId;
  }
  if (persistentUi !== undefined) {
    input.persistentUi = persistentUi;
  }
  if (options.tuiCommand !== undefined) {
    input.tuiCommand = options.tuiCommand;
  }
  return input;
}

async function clearPopupState(
  input: TmuxCommandInput,
  clientId: string | undefined,
): Promise<void> {
  if (clientId === undefined || clientId.length === 0) {
    return;
  }
  await clearActivePopupClient(input).catch(() => undefined);
  await clearFocusPopupClient(input).catch(() => undefined);
}

async function runPopupDisplay(input: PopupDisplayInput): Promise<PopupDisplayResult> {
  const result = await runRuntimeBoundaryWithRetry(
    {
      operation: "provider.tmux.popup",
      error: {
        tag: "TerminalProviderError",
        code: "TERMINAL_POPUP_FAILED",
        message: "tmux failed to open the station popup.",
        provider: "tmux",
      },
      retry: {
        retries: 0,
      },
    },
    ({ signal }) =>
      runExternalCommand(
        {
          command: input.command,
          args: input.args,
          signal,
          maxOutputChars: 64 * 1024,
          allowedExitCodes: [0, 129],
        },
        input.runner,
      ),
  );

  if (!result.ok) {
    throw tmuxProviderErrorFromUnknown(result.error, {
      code: "TERMINAL_OPEN_FAILED",
      message: "tmux failed to open the station popup.",
    });
  }

  return result.value.exitCode === 129 ? "dismissed" : "opened";
}

export async function openTmuxPopup(options: TmuxPopupOptions = {}): Promise<TmuxPopupResult> {
  const command = defaultTmuxCommand(options.command ?? options.config?.command);
  const persistent = options.persistent !== false;
  const clientInput = currentClientInput(options, command);
  const requestedFocusClientId =
    options.focusClientId !== undefined && options.focusClientId.length > 0
      ? options.focusClientId
      : undefined;
  const envFocusClientId =
    clientInput.env.STATION_FOCUS_CLIENT_ID !== undefined &&
    clientInput.env.STATION_FOCUS_CLIENT_ID.length > 0
      ? clientInput.env.STATION_FOCUS_CLIENT_ID
      : undefined;
  const focusClientId =
    requestedFocusClientId ?? envFocusClientId ?? (await resolveCurrentTmuxClientId(clientInput));
  const tmuxCommand = popupCommandInput(options, command);
  if (focusClientId !== undefined && focusClientId.length > 0) {
    const activeClientId = await resolveActivePopupClient(tmuxCommand);
    if (activeClientId === focusClientId) {
      await dismissTmuxPopup(dismissOptions(options, command, focusClientId));
      return { opened: false, closed: true };
    }
    if (activeClientId !== undefined) {
      await closeTmuxPopup({
        ...tmuxCommand,
        clientId: activeClientId,
      });
    }
    await setActivePopupClient({
      ...tmuxCommand,
      clientId: focusClientId,
    });
    await setFocusPopupClient({
      ...tmuxCommand,
      clientId: focusClientId,
    });
    if (options.enterWorkbench === true) {
      await enterWorkbenchForPopup(enterWorkbenchInput(tmuxCommand, focusClientId, options.config));
    }
  } else {
    await clearFocusPopupClient(tmuxCommand);
  }

  const persistentUi = persistent
    ? await resolvePersistentPopupUi(options, tmuxCommand)
    : undefined;

  if (persistentUi !== undefined) {
    await ensurePersistentPopupSession(persistentSessionOptions(options, command, persistentUi));
    if (persistentUi.registerFastPopup) {
      await registerFastPopupUi(tmuxCommand, persistentUi).catch(() => undefined);
    }
  }

  const args = buildTmuxPopupArgs(
    popupArgsOptions(popupArgsInput(options, command, focusClientId, persistent, persistentUi)),
  );

  const displayInput: PopupDisplayInput = {
    args,
    command,
  };
  if (options.runner !== undefined) {
    displayInput.runner = options.runner;
  }

  let displayResult: PopupDisplayResult;
  try {
    displayResult = await runPopupDisplay(displayInput);
  } catch (error) {
    await clearPopupState(tmuxCommand, focusClientId);
    throw error;
  }
  if (displayResult === "dismissed") {
    await clearPopupState(tmuxCommand, focusClientId);
  }

  return { opened: true };
}

export async function resolveTmuxPopupFocusOrigin(
  options: TmuxPopupFocusOriginOptions = {},
): Promise<TerminalFocusOrigin | undefined> {
  const env = options.env ?? process.env;
  const command = defaultTmuxCommand(options.command);
  const requestedFocusClientId =
    options.focusClientId !== undefined && options.focusClientId.length > 0
      ? options.focusClientId
      : undefined;
  const envFocusClientId =
    env.STATION_FOCUS_CLIENT_ID !== undefined && env.STATION_FOCUS_CLIENT_ID.length > 0
      ? env.STATION_FOCUS_CLIENT_ID
      : undefined;
  const clientId =
    requestedFocusClientId ??
    envFocusClientId ??
    (await resolveFocusPopupClient(popupCommandInput(options, command)));
  if (clientId === undefined) {
    return undefined;
  }
  return {
    provider: "tmux",
    clientId,
  };
}

export async function dismissTmuxPopup(
  options: TmuxPopupDismissOptions = {},
): Promise<TmuxPopupDismissResult> {
  const env = options.env ?? process.env;
  const command = defaultTmuxCommand(options.command);
  const input = popupCommandInput(options, command);
  const requestedFocusClientId =
    options.focusClientId !== undefined && options.focusClientId.length > 0
      ? options.focusClientId
      : undefined;
  const envFocusClientId =
    env.STATION_FOCUS_CLIENT_ID !== undefined && env.STATION_FOCUS_CLIENT_ID.length > 0
      ? env.STATION_FOCUS_CLIENT_ID
      : undefined;
  const clientId =
    requestedFocusClientId ??
    envFocusClientId ??
    (await resolveFocusPopupClient(input)) ??
    (await resolveActivePopupClient(input));
  if (clientId === undefined) {
    await clearActivePopupClient(input).catch(() => undefined);
    await clearFocusPopupClient(input).catch(() => undefined);
    return { dismissed: false };
  }
  await closeTmuxPopup({
    ...input,
    clientId,
  });
  await clearActivePopupClient(input);
  await clearFocusPopupClient(input);
  return { dismissed: true };
}
