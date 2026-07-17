import type { TmuxConfig } from "@station/config";
import type { TerminalFocusOrigin } from "@station/contracts";
import {
  type ExternalCommandRunner,
  runExternalCommand,
  runRuntimeBoundaryWithRetry,
} from "@station/runtime";
import type { TmuxCommandInput } from "../command.js";
import { tmuxProviderErrorFromUnknown } from "../errors.js";
import { shellQuote } from "../shell.js";
import { buildTmuxPopupArgs } from "./args.js";
import {
  popupCommandInput,
  resolveCurrentTmuxClient,
  resolveCurrentTmuxClientId,
} from "./command.js";
import {
  activePopupClaimOption,
  activePopupClientOption,
  focusPopupClientOption,
} from "./constants.js";
import {
  buildPopupActiveClaim,
  createPopupProtocolNonce,
  isSafePopupClientName,
} from "./fastProtocol.js";
import {
  ensurePersistentPopupSession,
  registerFastPopupUi,
  resolvePersistentPopupUi,
} from "./persistentUi.js";
import { openPopupShellForClient } from "./shell.js";
import {
  clearActivePopupClaimIfCurrent,
  clearLegacyFocusIfUnclaimed,
  clearLegacyPopupStateIfUnclaimed,
  compareAndSetActivePopupClaim,
  dismissLegacyPopupIfUnclaimed,
  resolveActivePopupClaimState,
  resolveActivePopupClient,
  resolveFocusPopupClient,
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
  TmuxPopupFocusTarget,
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
  TmuxPopupFocusTarget,
  TmuxPopupOptions,
  TmuxPopupResult,
  TmuxPopupShellResult,
  TmuxRegisteredDevPopupUi,
} from "./types.js";

type PopupDisplayResult = "opened" | "dismissed";
type ClaimedPopupActionResult = PopupDisplayResult | "contended";

type PopupDisplayInput = {
  args: string[];
  command: string;
  runner?: ExternalCommandRunner;
};

type ClaimedPopupActionInput = PopupDisplayInput & {
  claim: string;
  clientId: string;
  previousClientId?: string;
};

type GuardedPopupActionInput = PopupDisplayInput & {
  clientId: string;
  condition: string;
  previousClientId?: string;
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

const popupCasMiss = "STATION_POPUP_CAS_MISS";
const safeTmuxCommandTokenPattern = /^[A-Za-z0-9_@%+=,./:-]+$/;

function defaultTmuxCommand(command: string | undefined, env: NodeJS.ProcessEnv): string {
  return command ?? env.STATION_TMUX_BIN ?? "tmux";
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

function tmuxFormatLiteral(value: string): string {
  return value.replaceAll("#", "##").replaceAll(",", "#,").replaceAll("}", "#}");
}

function nestedTmuxCommand(args: readonly string[]): string {
  return args
    .map((arg) => {
      const escaped = arg.replaceAll("#", "##");
      return safeTmuxCommandTokenPattern.test(escaped) ? escaped : shellQuote(escaped);
    })
    .join(" ");
}

async function runGuardedPopupAction(
  input: GuardedPopupActionInput,
): Promise<ClaimedPopupActionResult> {
  if (
    !isSafePopupClientName(input.clientId) ||
    (input.previousClientId !== undefined && !isSafePopupClientName(input.previousClientId))
  ) {
    throw tmuxProviderErrorFromUnknown(new Error("unsafe tmux popup client"), {
      code: "TERMINAL_OPEN_FAILED",
      message: "tmux failed to open the station popup.",
    });
  }
  const action = [
    nestedTmuxCommand(["set-option", "-gq", activePopupClientOption, input.clientId]),
    nestedTmuxCommand(["set-option", "-gq", focusPopupClientOption, input.clientId]),
    ...(input.previousClientId === undefined || input.previousClientId === input.clientId
      ? []
      : [nestedTmuxCommand(["display-popup", "-c", input.previousClientId, "-C"])]),
    nestedTmuxCommand(input.args),
  ].join(" ; ");
  const result = await runRuntimeBoundaryWithRetry(
    {
      operation: "provider.tmux.popup.guardedAction",
      error: {
        tag: "TerminalProviderError",
        code: "TERMINAL_POPUP_FAILED",
        message: "tmux failed to open the station popup.",
        provider: "tmux",
      },
      retry: { retries: 0 },
    },
    ({ signal }) =>
      runExternalCommand(
        {
          command: input.command,
          args: ["if-shell", "-F", input.condition, action, `display-message -p ${popupCasMiss}`],
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
  if (result.value.stdout.trim() === popupCasMiss) {
    return "contended";
  }
  return result.value.exitCode === 129 ? "dismissed" : "opened";
}

function runClaimedPopupAction(input: ClaimedPopupActionInput): Promise<ClaimedPopupActionResult> {
  return runGuardedPopupAction({
    ...input,
    condition: `#{==:#{${activePopupClaimOption}},${tmuxFormatLiteral(input.claim)}}`,
  });
}

function runUnclaimedPopupAction(
  input: Omit<GuardedPopupActionInput, "condition">,
): Promise<ClaimedPopupActionResult> {
  return runGuardedPopupAction({
    ...input,
    condition: `#{&&:#{==:#{${activePopupClaimOption}},},#{==:#{${activePopupClientOption}},${tmuxFormatLiteral(input.previousClientId ?? "")}}}`,
  });
}

async function dismissLegacyTmuxPopupForClient(
  options: TmuxPopupDismissOptions,
  clientId: string,
): Promise<TmuxPopupDismissResult> {
  const command = defaultTmuxCommand(options.command, options.env ?? process.env);
  const input = popupCommandInput(options, command);
  return { dismissed: await dismissLegacyPopupIfUnclaimed({ ...input, clientId }) };
}

function popupDismissOptions(
  options: TmuxPopupFocusOriginOptions,
  command: string,
): TmuxPopupDismissOptions {
  const result: TmuxPopupDismissOptions = {
    command,
    env: options.env ?? process.env,
  };
  if (options.runner !== undefined) result.runner = options.runner;
  if (options.timeoutMs !== undefined) result.timeoutMs = options.timeoutMs;
  return result;
}

async function dismissTmuxPopupWithExpectedClaim(
  options: TmuxPopupDismissOptions,
  expectedClaim?: string,
): Promise<TmuxPopupDismissResult> {
  const env = options.env ?? process.env;
  const command = defaultTmuxCommand(options.command, env);
  const input = popupCommandInput(options, command);
  const requestedFocusClientId =
    options.focusClientId !== undefined && options.focusClientId.length > 0
      ? options.focusClientId
      : undefined;
  const envFocusClientId =
    env.STATION_FOCUS_CLIENT_ID !== undefined && env.STATION_FOCUS_CLIENT_ID.length > 0
      ? env.STATION_FOCUS_CLIENT_ID
      : undefined;
  let boundClaim = expectedClaim;
  let claimContended = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claimState = await resolveActivePopupClaimState(input);
    if (
      claimState.kind === "malformed" ||
      (claimState.kind === "valid" && claimState.claim.state !== "open")
    ) {
      return { dismissed: false };
    }
    if (boundClaim !== undefined) {
      if (claimState.kind !== "valid" || claimState.raw !== boundClaim) {
        return { dismissed: false };
      }
    } else if (claimState.kind === "valid") {
      boundClaim = claimState.raw;
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
    let actionResult: ClaimedPopupActionResult | undefined;
    try {
      actionResult = await runClaimedPopupAction({
        args: ["display-popup", "-c", claimState.claim.clientName, "-C"],
        claim: closingClaim,
        clientId: claimState.claim.clientName,
        command,
        ...(options.runner === undefined ? {} : { runner: options.runner }),
      });
    } finally {
      if (actionResult !== "contended") {
        await clearActivePopupClaimIfCurrent(input, {
          claim: closingClaim,
          clientId: claimState.claim.clientName,
        }).catch(() => undefined);
      }
    }
    if (actionResult === "contended") {
      claimContended = true;
      continue;
    }
    return { dismissed: true };
  }
  if (claimContended) {
    return { dismissed: false };
  }
  if (boundClaim !== undefined) {
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

export async function openTmuxPopup(options: TmuxPopupOptions = {}): Promise<TmuxPopupResult> {
  const command = defaultTmuxCommand(
    options.command ?? options.config?.command,
    options.env ?? process.env,
  );
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
  let legacyPopupAction = false;
  let previousPopupClientId: string | undefined;
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
          let actionResult: ClaimedPopupActionResult | undefined;
          try {
            actionResult = await runClaimedPopupAction({
              args: ["display-popup", "-c", claimState.claim.clientName, "-C"],
              claim: closingClaim,
              clientId: claimState.claim.clientName,
              command,
              ...(options.runner === undefined ? {} : { runner: options.runner }),
            });
          } finally {
            if (actionResult !== "contended") {
              await clearActivePopupClaimIfCurrent(tmuxCommand, {
                claim: closingClaim,
                clientId: claimState.claim.clientName,
              }).catch(() => undefined);
            }
          }
          if (actionResult === "contended") {
            continue;
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
        let actionResult: ClaimedPopupActionResult | undefined;
        try {
          actionResult = await runClaimedPopupAction({
            args: ["display-popup", "-c", focusClientId, "-C"],
            claim: closingClaim,
            clientId: focusClientId,
            command,
            ...(options.runner === undefined ? {} : { runner: options.runner }),
          });
        } finally {
          if (actionResult !== "contended") {
            await clearActivePopupClaimIfCurrent(tmuxCommand, {
              claim: closingClaim,
              clientId: focusClientId,
            }).catch(() => undefined);
          }
        }
        if (actionResult === "contended") {
          continue;
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
      if (options.enterWorkbench === true) {
        await enterWorkbenchForPopup(
          enterWorkbenchInput(tmuxCommand, focusClientId, options.config),
        );
      }
      const replaced = await compareAndSetActivePopupClaim(tmuxCommand, {
        ...(claimState.kind === "absent" ? {} : { expected: claimState.raw }),
        replacement: nextClaim,
      });
      if (!replaced) {
        continue;
      }
      activeClaim = nextClaim;
      previousPopupClientId =
        claimState.kind === "valid" ? claimState.claim.clientName : activeClientId;
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
    legacyPopupAction = true;
    previousPopupClientId = activeClientId;
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
    if (activeClaim !== undefined && focusClientId !== undefined) {
      const claimedResult = await runClaimedPopupAction({
        ...displayInput,
        claim: activeClaim,
        clientId: focusClientId,
        ...(previousPopupClientId === undefined ? {} : { previousClientId: previousPopupClientId }),
      });
      if (claimedResult === "contended") {
        throw tmuxProviderErrorFromUnknown(new Error("tmux popup claim contention"), {
          code: "TERMINAL_OPEN_FAILED",
          message: "tmux failed to claim the station popup.",
        });
      }
      displayResult = claimedResult;
    } else if (legacyPopupAction && focusClientId !== undefined) {
      const guardedResult = await runUnclaimedPopupAction({
        ...displayInput,
        clientId: focusClientId,
        ...(previousPopupClientId === undefined ? {} : { previousClientId: previousPopupClientId }),
      });
      if (guardedResult === "contended") {
        throw tmuxProviderErrorFromUnknown(new Error("tmux popup claim contention"), {
          code: "TERMINAL_OPEN_FAILED",
          message: "tmux failed to claim the station popup.",
        });
      }
      displayResult = guardedResult;
    } else {
      displayResult = await runPopupDisplay(displayInput);
    }
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
  return (await resolveTmuxPopupFocusTarget(options))?.origin;
}

export async function resolveTmuxPopupFocusTarget(
  options: TmuxPopupFocusOriginOptions = {},
): Promise<TmuxPopupFocusTarget | undefined> {
  const env = options.env ?? process.env;
  const command = defaultTmuxCommand(options.command, env);
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
  if (claimState.kind === "malformed") {
    return undefined;
  }
  if (claimState.kind === "valid") {
    if (claimState.claim.state !== "open") {
      return undefined;
    }
    const exactDismissOptions = popupDismissOptions(options, command);
    return {
      origin: {
        provider: "tmux",
        clientId: claimState.claim.clientName,
      },
      openShell: (cwd) =>
        openPopupShellForClient(options, command, claimState.claim.clientName, cwd),
      dismissExact: () => dismissTmuxPopupWithExpectedClaim(exactDismissOptions, claimState.raw),
    };
  }
  const clientId =
    requestedFocusClientId ?? envFocusClientId ?? (await resolveFocusPopupClient(input));
  if (clientId === undefined) {
    return undefined;
  }
  const legacyDismissOptions = popupDismissOptions(options, command);
  return {
    origin: { provider: "tmux", clientId },
    openShell: (cwd) => openPopupShellForClient(options, command, clientId, cwd),
    dismissExact: () => dismissLegacyTmuxPopupForClient(legacyDismissOptions, clientId),
  };
}

export async function dismissTmuxPopup(
  options: TmuxPopupDismissOptions = {},
): Promise<TmuxPopupDismissResult> {
  return dismissTmuxPopupWithExpectedClaim(options);
}
