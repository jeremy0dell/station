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
import {
  closeTmuxPopup,
  popupCommandInput,
  resolveCurrentTmuxClient,
  resolveCurrentTmuxClientId,
} from "./command.js";
import {
  activePopupClaimOption,
  activePopupClientOption,
  focusPopupClientOption,
} from "./constants.js";
import { buildPopupActiveClaim, createPopupProtocolNonce } from "./fastProtocol.js";
import {
  ensurePersistentPopupSession,
  registerFastPopupUi,
  resolvePersistentPopupUi,
} from "./persistentUi.js";
import {
  clearActivePopupClaimIfCurrent,
  clearLegacyFocusIfUnclaimed,
  clearLegacyPopupStateIfUnclaimed,
  compareAndSetActivePopupClaim,
  dismissLegacyPopupIfUnclaimed,
  replaceLegacyPopupIfUnclaimed,
  resolveActivePopupClaimState,
  resolveActivePopupClient,
  resolveFocusPopupClient,
  setPopupClaimMirrors,
} from "./state.js";
import type {
  BuildTmuxPopupArgsOptions,
  PopupWorkbenchFocusInput,
  TmuxClientIdentity,
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
export type { BuildManagedFastPopupRunShellCommandOptions } from "./fastBinding.js";
export { buildManagedFastPopupRunShellCommand } from "./fastBinding.js";
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
  claim?: string;
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

function popupState(command: string, clientId: string, claim: string | undefined): TmuxPopupState {
  const state: TmuxPopupState = {
    clientId,
    optionName: activePopupClientOption,
    focusOptionName: focusPopupClientOption,
    tmuxCommand: command,
  };
  if (claim !== undefined) {
    state.claim = claim;
    state.claimOptionName = activePopupClaimOption;
  }
  return state;
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
    input.popupState = popupState(options.command, options.focusClientId, options.claim);
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
  claim: string | undefined,
): PopupArgsInput {
  const input: PopupArgsInput = {
    command,
    persistent,
  };
  if (claim !== undefined) {
    input.claim = claim;
  }
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
  await clearLegacyPopupStateIfUnclaimed({ ...input, clientId }).catch(() => undefined);
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
  const currentClient = await resolveCurrentTmuxClient(clientInput);
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
    requestedFocusClientId ??
    envFocusClientId ??
    currentClient?.name ??
    (await resolveCurrentTmuxClientId(clientInput));
  const tmuxCommand = popupCommandInput(options, command);

  const persistentUi = persistent
    ? await resolvePersistentPopupUi(options, tmuxCommand)
    : undefined;
  let registeredRoute: Awaited<ReturnType<typeof registerFastPopupUi>> | undefined;

  if (persistentUi !== undefined) {
    await ensurePersistentPopupSession(persistentSessionOptions(options, command, persistentUi));
    if (persistentUi.registerFastPopup) {
      registeredRoute = await registerFastPopupUi(tmuxCommand, persistentUi).catch(() => undefined);
    }
  }

  let activeClaim: string | undefined;
  if (focusClientId !== undefined && focusClientId.length > 0 && currentClient !== undefined) {
    const claimClient: TmuxClientIdentity = {
      ...currentClient,
      name: focusClientId,
    };
    const fallbackRegistrationNonce = createPopupProtocolNonce();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const claimState = await resolveActivePopupClaimState(tmuxCommand);
      if (claimState.kind === "malformed" && claimState.raw.length > 4096) {
        break;
      }

      if (claimState.kind === "valid") {
        const sameClient =
          claimState.claim.clientName === focusClientId &&
          claimState.claim.clientPid === claimClient.pid;
        const nestedClient =
          persistentUi !== undefined && claimClient.sessionName === persistentUi.sessionName;
        if (sameClient || nestedClient) {
          const closingClaim = buildPopupActiveClaim({
            clientName: claimState.claim.clientName,
            clientPid: claimState.claim.clientPid,
            registrationNonce: claimState.claim.registrationNonce,
            state: "closing",
          });
          if (
            !(await compareAndSetActivePopupClaim(tmuxCommand, {
              expected: claimState.raw,
              replacement: closingClaim,
            }))
          ) {
            continue;
          }
          await setPopupClaimMirrors({
            ...tmuxCommand,
            clientId: claimState.claim.clientName,
          });
          try {
            await closeTmuxPopup({
              ...tmuxCommand,
              clientId: claimState.claim.clientName,
            });
          } finally {
            await clearActivePopupClaimIfCurrent(tmuxCommand, {
              claim: closingClaim,
              clientId: claimState.claim.clientName,
            }).catch(() => undefined);
          }
          return { opened: false, closed: true };
        }
      }

      const activeClientId = await resolveActivePopupClient(tmuxCommand);
      if (claimState.kind === "absent" && activeClientId === focusClientId) {
        const closingClaim = buildPopupActiveClaim({
          clientName: claimClient.name,
          clientPid: claimClient.pid,
          registrationNonce: registeredRoute?.registrationNonce ?? fallbackRegistrationNonce,
          state: "closing",
        });
        if (
          !(await compareAndSetActivePopupClaim(tmuxCommand, {
            replacement: closingClaim,
          }))
        ) {
          continue;
        }
        await setPopupClaimMirrors({ ...tmuxCommand, clientId: focusClientId });
        try {
          await closeTmuxPopup({ ...tmuxCommand, clientId: focusClientId });
        } finally {
          await clearActivePopupClaimIfCurrent(tmuxCommand, {
            claim: closingClaim,
            clientId: focusClientId,
          }).catch(() => undefined);
        }
        return { opened: false, closed: true };
      }

      const registrationNonce =
        registeredRoute?.registrationNonce ??
        (claimState.kind === "valid"
          ? claimState.claim.registrationNonce
          : fallbackRegistrationNonce);
      const nextClaim = buildPopupActiveClaim({
        clientName: claimClient.name,
        clientPid: claimClient.pid,
        registrationNonce,
        state: "open",
      });
      const replaced = await compareAndSetActivePopupClaim(tmuxCommand, {
        ...(claimState.kind === "absent" ? {} : { expected: claimState.raw }),
        replacement: nextClaim,
      });
      if (!replaced) {
        continue;
      }
      activeClaim = nextClaim;
      try {
        await setPopupClaimMirrors({ ...tmuxCommand, clientId: focusClientId });
        const previousClient =
          claimState.kind === "valid" ? claimState.claim.clientName : activeClientId;
        if (previousClient !== undefined && previousClient !== focusClientId) {
          await closeTmuxPopup({ ...tmuxCommand, clientId: previousClient });
        }
        if (options.enterWorkbench === true) {
          await enterWorkbenchForPopup(
            enterWorkbenchInput(tmuxCommand, focusClientId, options.config),
          );
        }
      } catch (error) {
        await clearActivePopupClaimIfCurrent(tmuxCommand, {
          claim: nextClaim,
          clientId: focusClientId,
        }).catch(() => undefined);
        throw error;
      }
      break;
    }
    if (activeClaim === undefined) {
      throw tmuxProviderErrorFromUnknown(new Error("tmux popup claim contention"), {
        code: "TERMINAL_OPEN_FAILED",
        message: "tmux failed to claim the station popup.",
      });
    }
  } else if (focusClientId !== undefined && focusClientId.length > 0) {
    const claimState = await resolveActivePopupClaimState(tmuxCommand);
    if (claimState.kind !== "absent") {
      throw tmuxProviderErrorFromUnknown(new Error("tmux popup claim contention"), {
        code: "TERMINAL_OPEN_FAILED",
        message: "tmux failed to claim the station popup.",
      });
    }
    const activeClientId = await resolveActivePopupClient(tmuxCommand);
    if (activeClientId === focusClientId) {
      await dismissTmuxPopup(dismissOptions(options, command, focusClientId));
      return { opened: false, closed: true };
    }
    const replaced = await replaceLegacyPopupIfUnclaimed({
      ...tmuxCommand,
      clientId: focusClientId,
      ...(activeClientId === undefined ? {} : { previousClientId: activeClientId }),
    });
    if (!replaced) {
      throw tmuxProviderErrorFromUnknown(new Error("tmux popup claim contention"), {
        code: "TERMINAL_OPEN_FAILED",
        message: "tmux failed to claim the station popup.",
      });
    }
  } else {
    const legacyFocusClientId = await resolveFocusPopupClient(tmuxCommand);
    if (legacyFocusClientId !== undefined) {
      await clearLegacyFocusIfUnclaimed({
        ...tmuxCommand,
        clientId: legacyFocusClientId,
      }).catch(() => undefined);
    }
  }

  const args = buildTmuxPopupArgs(
    popupArgsOptions(
      popupArgsInput(options, command, focusClientId, persistent, persistentUi, activeClaim),
    ),
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
    if (activeClaim !== undefined && focusClientId !== undefined) {
      await clearActivePopupClaimIfCurrent(tmuxCommand, {
        claim: activeClaim,
        clientId: focusClientId,
      }).catch(() => undefined);
    } else {
      await clearPopupState(tmuxCommand, focusClientId);
    }
    throw error;
  }
  if (displayResult === "dismissed") {
    if (activeClaim !== undefined && focusClientId !== undefined) {
      await clearActivePopupClaimIfCurrent(tmuxCommand, {
        claim: activeClaim,
        clientId: focusClientId,
      }).catch(() => undefined);
    } else {
      await clearPopupState(tmuxCommand, focusClientId);
    }
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
  const input = popupCommandInput(options, command);
  const claimState = await resolveActivePopupClaimState(input);
  const clientId =
    requestedFocusClientId ??
    envFocusClientId ??
    (claimState.kind === "valid" ? claimState.claim.clientName : undefined) ??
    (await resolveFocusPopupClient(input));
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
  let claimContended = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claimState = await resolveActivePopupClaimState(input);
    if (claimState.kind === "malformed") {
      return { dismissed: false };
    }
    if (claimState.kind === "absent") {
      break;
    }
    const closingClaim = buildPopupActiveClaim({
      clientName: claimState.claim.clientName,
      clientPid: claimState.claim.clientPid,
      registrationNonce: claimState.claim.registrationNonce,
      state: "closing",
    });
    if (
      !(await compareAndSetActivePopupClaim(input, {
        expected: claimState.raw,
        replacement: closingClaim,
      }))
    ) {
      claimContended = true;
      continue;
    }
    await setPopupClaimMirrors({ ...input, clientId: claimState.claim.clientName });
    try {
      await closeTmuxPopup({ ...input, clientId: claimState.claim.clientName });
    } finally {
      await clearActivePopupClaimIfCurrent(input, {
        claim: closingClaim,
        clientId: claimState.claim.clientName,
      }).catch(() => undefined);
    }
    return { dismissed: true };
  }
  if (claimContended) {
    return { dismissed: false };
  }
  const clientId =
    requestedFocusClientId ??
    envFocusClientId ??
    (await resolveFocusPopupClient(input)) ??
    (await resolveActivePopupClient(input));
  if (clientId === undefined) {
    return { dismissed: false };
  }
  return { dismissed: await dismissLegacyPopupIfUnclaimed({ ...input, clientId }) };
}
