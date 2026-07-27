import type { TmuxConfig } from "@station/config";
import type { TmuxCommandInput } from "../command.js";
import { tmuxProviderErrorFromUnknown } from "../errors.js";
import { buildTmuxPopupArgs } from "./args.js";
import {
  popupCommandInput,
  resolveCurrentTmuxClient,
  resolveCurrentTmuxClientId,
} from "./command.js";
import {
  type PopupDisplayInput,
  type PopupDisplayResult,
  runClaimedPopupAction,
  runPopupDisplay,
  runUnclaimedPopupAction,
} from "./display.js";
import {
  type AcquirePopupOwnershipInput,
  acquirePopupOwnership,
  type DismissPopupOwnershipInput,
  dismissPopupOwnership,
  type PopupOwnershipAcquisition,
} from "./ownership.js";
import {
  ensurePersistentPopupSession,
  registerFastPopupUi,
  resolvePersistentPopupUi,
} from "./persistentUi.js";
import {
  resolveTmuxPopupScopeDescriptor,
  type TmuxPopupScopeDescriptor,
  type TmuxPopupStateKeys,
} from "./scope.js";
import { openPopupShellForClient } from "./shell.js";
import {
  clearActivePopupClaimIfCurrent,
  clearLegacyPopupStateIfUnclaimed,
  dismissLegacyPopupIfUnclaimed,
  resolveActivePopupClaimState,
  resolveFocusPopupClient,
} from "./state.js";
import type {
  BuildTmuxPopupArgsOptions,
  ResolvePersistentPopupUiOptions,
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

export { buildTmuxPopupArgs } from "./args.js";
export { buildManagedFastPopupRunShellCommand } from "./fastBinding.js";
export { ensurePersistentPopupSession, resolveRegisteredDevPopupUi } from "./persistentUi.js";
export type {
  TmuxPopupDismissResult,
  TmuxPopupFocusTarget,
  TmuxPopupOptions,
  TmuxPopupResult,
} from "./types.js";

type PopupArgsInput = {
  claim?: string;
  command: string;
  config?: TmuxConfig;
  focusClientId?: string;
  persistent: boolean;
  persistentUi?: TmuxPersistentPopupUi;
  state: TmuxPopupStateKeys;
  tuiCommand?: string;
};

type OpenPopupContext = {
  command: string;
  currentClient?: TmuxClientIdentity;
  focusClientId?: string;
  scope: TmuxPopupScopeDescriptor;
  tmuxCommand: TmuxCommandInput;
};

type PreparedPersistentPopup = {
  persistent: boolean;
  registrationNonce?: string;
  ui?: TmuxPersistentPopupUi;
};

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

function persistentSessionOptions(
  options: TmuxPopupOptions,
  command: string,
  persistentUi: TmuxPersistentPopupUi,
  focusClientId: string | undefined,
): TmuxPersistentPopupSessionOptions {
  const input: TmuxPersistentPopupSessionOptions = {
    command,
    tuiCommand: persistentUi.command,
    uiSessionName: persistentUi.sessionName,
  };
  if (focusClientId !== undefined) {
    input.focusClientId = focusClientId;
  }
  if (options.runner !== undefined) {
    input.runner = options.runner;
  }
  if (options.timeoutMs !== undefined) {
    input.timeoutMs = options.timeoutMs;
  }
  return input;
}

function popupState(
  command: string,
  clientId: string,
  claim: string | undefined,
  keys: TmuxPopupStateKeys,
): TmuxPopupState {
  const state: TmuxPopupState = {
    clientId,
    optionName: keys.activeClientOption,
    focusOptionName: keys.focusClientOption,
    tmuxCommand: command,
  };
  if (claim !== undefined) {
    state.claim = claim;
    state.claimOptionName = keys.activeClaimOption;
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
    input.popupState = popupState(
      options.command,
      options.focusClientId,
      options.claim,
      options.state,
    );
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
  state: TmuxPopupStateKeys,
): PopupArgsInput {
  const input: PopupArgsInput = {
    command,
    persistent,
    state,
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
  state: TmuxPopupStateKeys,
): Promise<void> {
  if (clientId === undefined || clientId.length === 0) {
    return;
  }
  await clearLegacyPopupStateIfUnclaimed({ ...input, clientId }, state).catch(() => undefined);
}

async function dismissLegacyTmuxPopupForClient(
  options: TmuxPopupDismissOptions,
  clientId: string,
  scope: TmuxPopupScopeDescriptor,
): Promise<TmuxPopupDismissResult> {
  const command = defaultTmuxCommand(options.command, options.env ?? process.env);
  const input = popupCommandInput(options, command);
  return {
    dismissed: await dismissLegacyPopupIfUnclaimed({ ...input, clientId }, scope.state),
  };
}

function popupDismissOptions(
  options: TmuxPopupFocusOriginOptions,
  command: string,
  focusClientId?: string,
): TmuxPopupDismissOptions {
  const result: TmuxPopupDismissOptions = {
    command,
    env: options.env ?? process.env,
  };
  if (options.config !== undefined) result.config = options.config;
  if (focusClientId !== undefined) result.focusClientId = focusClientId;
  if (options.runner !== undefined) result.runner = options.runner;
  if (options.timeoutMs !== undefined) result.timeoutMs = options.timeoutMs;
  return result;
}

function configuredFocusClientId(
  options: { focusClientId?: string },
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (options.focusClientId !== undefined && options.focusClientId.length > 0) {
    return options.focusClientId;
  }
  return env.STATION_FOCUS_CLIENT_ID !== undefined && env.STATION_FOCUS_CLIENT_ID.length > 0
    ? env.STATION_FOCUS_CLIENT_ID
    : undefined;
}

async function dismissTmuxPopupWithExpectedClaim(
  options: TmuxPopupDismissOptions,
  expectedClaim?: string,
): Promise<TmuxPopupDismissResult> {
  const env = options.env ?? process.env;
  const command = defaultTmuxCommand(options.command ?? options.config?.command, env);
  const focusClientId = configuredFocusClientId(options, env);
  const scope = resolveTmuxPopupScopeDescriptor({
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(focusClientId === undefined ? {} : { focusClientId }),
  });
  if (scope === undefined) return { dismissed: false };

  const input: DismissPopupOwnershipInput = {
    command,
    scope,
    tmuxCommand: popupCommandInput(options, command),
  };
  if (expectedClaim !== undefined) input.expectedClaim = expectedClaim;
  if (focusClientId !== undefined) input.focusClientId = focusClientId;
  if (options.runner !== undefined) input.runner = options.runner;
  return { dismissed: await dismissPopupOwnership(input) };
}

function popupClaimContention(): never {
  throw tmuxProviderErrorFromUnknown(new Error("tmux popup claim contention"), {
    code: "TERMINAL_OPEN_FAILED",
    message: "tmux failed to claim the station popup.",
  });
}

async function clearAcquiredPopupState(input: {
  acquisition: PopupOwnershipAcquisition;
  focusClientId: string | undefined;
  scope: TmuxPopupScopeDescriptor;
  tmuxCommand: TmuxCommandInput;
}): Promise<void> {
  if (input.acquisition.kind === "claimed" && input.focusClientId !== undefined) {
    await clearActivePopupClaimIfCurrent(
      input.tmuxCommand,
      { claim: input.acquisition.claim, clientId: input.focusClientId },
      input.scope.state,
    ).catch(() => undefined);
    return;
  }
  if (input.acquisition.kind === "legacy") {
    await clearPopupState(input.tmuxCommand, input.focusClientId, input.scope.state);
  }
}

async function displayAcquiredPopup(input: {
  acquisition: PopupOwnershipAcquisition;
  display: PopupDisplayInput;
  focusClientId: string | undefined;
  scope: TmuxPopupScopeDescriptor;
}): Promise<PopupDisplayResult> {
  if (input.acquisition.kind === "claimed" && input.focusClientId !== undefined) {
    const result = await runClaimedPopupAction({
      ...input.display,
      claim: input.acquisition.claim,
      clientId: input.focusClientId,
      state: input.scope.state,
      ...(input.acquisition.previousClientId === undefined
        ? {}
        : { previousClientId: input.acquisition.previousClientId }),
    });
    return result === "contended" ? popupClaimContention() : result;
  }
  if (input.acquisition.kind === "legacy" && input.focusClientId !== undefined) {
    const result = await runUnclaimedPopupAction({
      ...input.display,
      clientId: input.focusClientId,
      state: input.scope.state,
      ...(input.acquisition.previousClientId === undefined
        ? {}
        : { previousClientId: input.acquisition.previousClientId }),
    });
    return result === "contended" ? popupClaimContention() : result;
  }
  return runPopupDisplay(input.display);
}

function popupScopeForOpen(
  options: TmuxPopupOptions,
  focusClientId: string | undefined,
): TmuxPopupScopeDescriptor | undefined {
  const input: {
    config?: TmuxConfig;
    focusClientId?: string;
    uiSessionName?: string;
  } = {};
  if (options.config !== undefined) input.config = options.config;
  if (focusClientId !== undefined) input.focusClientId = focusClientId;
  if (options.uiSessionName !== undefined) input.uiSessionName = options.uiSessionName;
  return resolveTmuxPopupScopeDescriptor(input);
}

async function resolveOpenPopupContext(options: TmuxPopupOptions): Promise<OpenPopupContext> {
  const env = options.env ?? process.env;
  const command = defaultTmuxCommand(options.command ?? options.config?.command, env);
  const clientInput = currentClientInput(options, command);
  const currentClient = await resolveCurrentTmuxClient(clientInput);
  const focusClientId =
    configuredFocusClientId(options, clientInput.env) ??
    currentClient?.name ??
    (await resolveCurrentTmuxClientId(clientInput));
  const scope = popupScopeForOpen(options, focusClientId);
  if (scope === undefined) {
    return popupClaimContention();
  }
  const context: OpenPopupContext = {
    command,
    scope,
    tmuxCommand: popupCommandInput(options, command),
  };
  if (currentClient !== undefined) context.currentClient = currentClient;
  if (focusClientId !== undefined) context.focusClientId = focusClientId;
  return context;
}

function persistentUiOptions(
  options: TmuxPopupOptions,
  scope: TmuxPopupScopeDescriptor,
): ResolvePersistentPopupUiOptions {
  const input: ResolvePersistentPopupUiOptions = { uiSessionName: scope.uiSessionName };
  if (options.checkoutRoot !== undefined) input.checkoutRoot = options.checkoutRoot;
  if (options.registeredDevPopupRoot !== undefined) {
    input.registeredDevPopupRoot = options.registeredDevPopupRoot;
  }
  if (options.tuiCommand !== undefined) input.tuiCommand = options.tuiCommand;
  if (scope.kind === "server" && options.preferRegisteredDevPopup === true) {
    input.preferRegisteredDevPopup = true;
  }
  return input;
}

async function preparePersistentPopup(
  options: TmuxPopupOptions,
  context: OpenPopupContext,
): Promise<PreparedPersistentPopup> {
  if (options.persistent === false) {
    return { persistent: false };
  }
  const ui = await resolvePersistentPopupUi(
    persistentUiOptions(options, context.scope),
    context.tmuxCommand,
  );
  const fixedFocusClientId = context.scope.kind === "client" ? context.focusClientId : undefined;
  await ensurePersistentPopupSession(
    persistentSessionOptions(options, context.command, ui, fixedFocusClientId),
  );
  const prepared: PreparedPersistentPopup = { persistent: true, ui };
  if (context.scope.registerFastPopup && ui.registerFastPopup) {
    const route = await registerFastPopupUi(context.tmuxCommand, ui).catch(() => undefined);
    if (route !== undefined) prepared.registrationNonce = route.registrationNonce;
  }
  return prepared;
}

function popupOwnershipInput(
  options: TmuxPopupOptions,
  context: OpenPopupContext,
  prepared: PreparedPersistentPopup,
): AcquirePopupOwnershipInput {
  const input: AcquirePopupOwnershipInput = {
    command: context.command,
    scope: context.scope,
    tmuxCommand: context.tmuxCommand,
  };
  if (context.currentClient !== undefined) input.currentClient = context.currentClient;
  if (context.focusClientId !== undefined) input.focusClientId = context.focusClientId;
  if (prepared.ui !== undefined) input.persistentUi = prepared.ui;
  if (prepared.registrationNonce !== undefined) {
    input.registrationNonce = prepared.registrationNonce;
  }
  if (options.runner !== undefined) input.runner = options.runner;
  return input;
}

function popupDisplayInput(
  options: TmuxPopupOptions,
  context: OpenPopupContext,
  prepared: PreparedPersistentPopup,
  acquisition: PopupOwnershipAcquisition,
): PopupDisplayInput {
  const activeClaim = acquisition.kind === "claimed" ? acquisition.claim : undefined;
  const args = buildTmuxPopupArgs(
    popupArgsOptions(
      popupArgsInput(
        options,
        context.command,
        context.focusClientId,
        prepared.persistent,
        prepared.ui,
        activeClaim,
        context.scope.state,
      ),
    ),
  );
  const input: PopupDisplayInput = { args, command: context.command };
  if (options.runner !== undefined) input.runner = options.runner;
  return input;
}

/**
 * ADAPTER
 *
 * Coordinates the configured ownership scope and persistent renderer through tmux.
 */
export async function openTmuxPopup(options: TmuxPopupOptions = {}): Promise<TmuxPopupResult> {
  const context = await resolveOpenPopupContext(options);
  const prepared = await preparePersistentPopup(options, context);
  const acquisition = await acquirePopupOwnership(popupOwnershipInput(options, context, prepared));
  if (acquisition.kind === "closed") {
    return { opened: false, closed: true };
  }

  const cleanupInput = {
    acquisition,
    focusClientId: context.focusClientId,
    scope: context.scope,
    tmuxCommand: context.tmuxCommand,
  };
  let displayResult: PopupDisplayResult;
  try {
    displayResult = await displayAcquiredPopup({
      acquisition,
      display: popupDisplayInput(options, context, prepared, acquisition),
      focusClientId: context.focusClientId,
      scope: context.scope,
    });
  } catch (error) {
    await clearAcquiredPopupState(cleanupInput);
    throw error;
  }
  if (displayResult === "dismissed") {
    await clearAcquiredPopupState(cleanupInput);
  }
  return { opened: true };
}

export async function resolveTmuxPopupFocusTarget(
  options: TmuxPopupFocusOriginOptions = {},
): Promise<TmuxPopupFocusTarget | undefined> {
  const env = options.env ?? process.env;
  const command = defaultTmuxCommand(options.command ?? options.config?.command, env);
  const focusClientId = configuredFocusClientId(options, env);
  const scope = resolveTmuxPopupScopeDescriptor({
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(focusClientId === undefined ? {} : { focusClientId }),
  });
  if (scope === undefined) {
    return undefined;
  }

  const input = popupCommandInput(options, command);
  const claimState = await resolveActivePopupClaimState(input, scope.state);
  if (claimState.kind === "malformed") {
    return undefined;
  }
  if (claimState.kind === "valid") {
    if (claimState.claim.state !== "open") {
      return undefined;
    }
    const exactDismissOptions = popupDismissOptions(options, command, claimState.claim.clientName);
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
  if (!scope.allowLegacyState) {
    return undefined;
  }

  const clientId = focusClientId ?? (await resolveFocusPopupClient(input, scope.state));
  if (clientId === undefined) {
    return undefined;
  }
  const legacyDismissOptions = popupDismissOptions(options, command, clientId);
  return {
    origin: { provider: "tmux", clientId },
    openShell: (cwd) => openPopupShellForClient(options, command, clientId, cwd),
    dismissExact: () => dismissLegacyTmuxPopupForClient(legacyDismissOptions, clientId, scope),
  };
}

export async function dismissTmuxPopup(
  options: TmuxPopupDismissOptions = {},
): Promise<TmuxPopupDismissResult> {
  return dismissTmuxPopupWithExpectedClaim(options);
}
