import type { TmuxCommandInput } from "../command.js";
import { buildPersistentPopupTuiCommand } from "./args.js";
import {
  hasTmuxSession,
  popupCommandInput,
  resolveTmuxGlobalOption,
  resolveTmuxOption,
  runTmuxPopupCommand,
  setTmuxGlobalOption,
} from "./command.js";
import {
  defaultPersistentPopupSessionName,
  defaultPersistentPopupTuiCommand,
  persistentUiLeaseOption,
  persistentUiRouteOption,
  persistentUiSignatureOption,
  registeredDevPopupCommandOption,
  registeredDevPopupOwnerOption,
  registeredDevPopupRootOption,
  registeredDevPopupSessionNameOption,
  registeredPopupExpectedSignatureOption,
  registeredPopupRootOption,
  registeredPopupSessionNameOption,
} from "./constants.js";
import {
  buildNormalPopupRoute,
  type NormalPopupRoute,
  normalPopupRouteMatches,
  parseNormalPopupRoute,
} from "./fastProtocol.js";
import type {
  ResolvePersistentPopupUiOptions,
  TmuxPersistentPopupSessionOptions,
  TmuxPersistentPopupSessionResult,
  TmuxPersistentPopupUi,
  TmuxRegisteredDevPopupOptions,
  TmuxRegisteredDevPopupUi,
} from "./types.js";

type RegisteredDevPopupResultInput = {
  command: string;
  owner?: string;
  root?: string;
  sessionName: string;
};

function registeredDevPopupResult(
  options: RegisteredDevPopupResultInput,
): TmuxRegisteredDevPopupUi {
  const result: TmuxRegisteredDevPopupUi = {
    command: options.command,
    sessionName: options.sessionName,
  };
  if (options.owner !== undefined) {
    result.owner = options.owner;
  }
  if (options.root !== undefined) {
    result.root = options.root;
  }
  return result;
}

function isRegisteredDevPopupOwnerAlive(owner: string): boolean {
  const [pidText] = owner.split(":");
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isDeadProcessSignalError(error);
  }
}

function isDeadProcessSignalError(error: unknown): boolean {
  // Node exposes process.kill lookup failures as ErrnoException; this is a provider boundary.
  const candidate = error as NodeJS.ErrnoException;
  return candidate.code === "ESRCH" || candidate.code === "EINVAL";
}

function persistentSessionOptions(
  options: TmuxPersistentPopupSessionOptions,
  command: string,
): TmuxCommandInput {
  return popupCommandInput(options, command);
}

async function resolvePersistentPopupSessionSignature(
  input: TmuxCommandInput,
  sessionName: string,
): Promise<string | undefined> {
  return resolveTmuxOption(input, {
    args: ["show-options", "-t", sessionName, "-qv", persistentUiSignatureOption],
    operation: "provider.tmux.popup.persistentUiSignature",
    message: "tmux failed to resolve the persistent station popup UI signature.",
    timeoutMessage: "tmux persistent popup UI signature lookup timed out.",
  });
}

async function setPersistentPopupSessionSignature(
  input: TmuxCommandInput,
  options: { sessionName: string; signature: string },
): Promise<void> {
  await runTmuxPopupCommand(input, {
    args: [
      "set-option",
      "-t",
      options.sessionName,
      "-q",
      persistentUiSignatureOption,
      options.signature,
    ],
    operation: "provider.tmux.popup.setPersistentUiSignature",
    message: "tmux failed to record the persistent station popup UI signature.",
    timeoutMessage: "tmux persistent popup UI signature update timed out.",
  });
}

async function resolvePersistentPopupSessionLease(
  input: TmuxCommandInput,
  sessionName: string,
): Promise<string | undefined> {
  return resolveTmuxOption(input, {
    args: ["show-options", "-t", sessionName, "-qv", persistentUiLeaseOption],
    operation: "provider.tmux.popup.persistentUiLease",
    message: "tmux failed to resolve the persistent station popup UI lease.",
    timeoutMessage: "tmux persistent popup UI lease lookup timed out.",
  });
}

async function setPersistentPopupSessionLease(
  input: TmuxCommandInput,
  options: { lease: string; sessionName: string },
): Promise<void> {
  await runTmuxPopupCommand(input, {
    args: ["set-option", "-t", options.sessionName, "-q", persistentUiLeaseOption, options.lease],
    operation: "provider.tmux.popup.setPersistentUiLease",
    message: "tmux failed to record the persistent station popup UI lease.",
    timeoutMessage: "tmux persistent popup UI lease update timed out.",
  });
}

function globalOptionEqualsFormat(optionName: string, value: string | undefined): string {
  const literal = (value ?? "").replaceAll("#", "##").replaceAll(",", "#,").replaceAll("}", "#}");
  return `#{==:#{${optionName}},${literal}}`;
}

async function compareAndSetPersistentPopupRoute(
  input: TmuxCommandInput,
  options: { expected?: string; lease: string; route: string; sessionName: string },
): Promise<boolean> {
  const routeMatches = globalOptionEqualsFormat(persistentUiRouteOption, options.expected);
  const leaseMatches = globalOptionEqualsFormat(persistentUiLeaseOption, options.lease);
  await runTmuxPopupCommand(input, {
    args: [
      "if-shell",
      "-F",
      "-t",
      `${options.sessionName}:`,
      `#{&&:${routeMatches},${leaseMatches}}`,
      `set-option -gq ${persistentUiRouteOption} ${options.route}`,
    ],
    operation: "provider.tmux.popup.commitPersistentUiRoute",
    message: "tmux failed to commit the persistent station popup UI route.",
    timeoutMessage: "tmux persistent popup UI route commit timed out.",
  });
  return (await resolveTmuxGlobalOption(input, persistentUiRouteOption)) === options.route;
}

function registeredRouteMatches(
  route: NormalPopupRoute,
  ui: TmuxPersistentPopupUi & { root: string },
  signature: string,
): boolean {
  return normalPopupRouteMatches(route, {
    root: ui.root,
    sessionName: ui.sessionName,
    signature,
  });
}

async function killPersistentPopupSession(
  input: TmuxCommandInput,
  sessionName: string,
): Promise<void> {
  await runTmuxPopupCommand(input, {
    args: ["kill-session", "-t", sessionName],
    operation: "provider.tmux.popup.killPersistentUi",
    message: "tmux failed to replace the persistent station popup UI.",
    timeoutMessage: "tmux persistent popup UI replacement timed out.",
  });
}

async function enablePersistentPopupSessionMouse(
  input: TmuxCommandInput,
  sessionName: string,
): Promise<void> {
  await runTmuxPopupCommand(input, {
    args: ["set-option", "-t", sessionName, "mouse", "on"],
    operation: "provider.tmux.popup.enableMouse",
    message: "tmux failed to enable mouse support for the persistent station popup UI.",
    timeoutMessage: "tmux persistent popup UI mouse setup timed out.",
  });
}

export function persistentPopupSignature(tuiCommand: string): string {
  return `v1:${tuiCommand}`;
}

export async function ensurePersistentPopupSession(
  options: TmuxPersistentPopupSessionOptions = {},
): Promise<TmuxPersistentPopupSessionResult> {
  const command = options.command ?? process.env.STATION_TMUX_BIN ?? "tmux";
  const input = persistentSessionOptions(options, command);
  const sessionName = options.uiSessionName ?? defaultPersistentPopupSessionName;
  const tuiCommand = options.tuiCommand ?? defaultPersistentPopupTuiCommand;
  const signature = persistentPopupSignature(tuiCommand);
  if (await hasTmuxSession(input, sessionName)) {
    const currentSignature = await resolvePersistentPopupSessionSignature(input, sessionName);
    if (currentSignature === signature) {
      await enablePersistentPopupSessionMouse(input, sessionName);
      return { sessionName, created: false };
    }
    await killPersistentPopupSession(input, sessionName);
  }

  await runTmuxPopupCommand(input, {
    args: [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-n",
      "station-ui",
      buildPersistentPopupTuiCommand(tuiCommand),
    ],
    operation: "provider.tmux.popup.createPersistentUi",
    message: "tmux failed to create the persistent station popup UI.",
    timeoutMessage: "tmux persistent popup UI creation timed out.",
  });
  await setPersistentPopupSessionSignature(input, {
    sessionName,
    signature,
  });
  await enablePersistentPopupSessionMouse(input, sessionName);
  return { sessionName, created: true };
}

export async function resolveRegisteredDevPopupUi(
  options: TmuxRegisteredDevPopupOptions = {},
): Promise<TmuxRegisteredDevPopupUi | undefined> {
  const command = options.command ?? process.env.STATION_TMUX_BIN ?? "tmux";
  const input = popupCommandInput(options, command);
  const sessionName = await resolveTmuxGlobalOption(input, registeredDevPopupSessionNameOption);
  const devCommand = await resolveTmuxGlobalOption(input, registeredDevPopupCommandOption);
  if (sessionName === undefined || devCommand === undefined) {
    return undefined;
  }

  const owner = await resolveTmuxGlobalOption(input, registeredDevPopupOwnerOption);
  if (owner !== undefined && !isRegisteredDevPopupOwnerAlive(owner)) {
    return undefined;
  }

  const root = await resolveTmuxGlobalOption(input, registeredDevPopupRootOption);
  const resultInput: RegisteredDevPopupResultInput = {
    command: devCommand,
    sessionName,
  };
  if (owner !== undefined) {
    resultInput.owner = owner;
  }
  if (root !== undefined) {
    resultInput.root = root;
  }
  return registeredDevPopupResult(resultInput);
}

export async function resolvePersistentPopupUi(
  options: ResolvePersistentPopupUiOptions,
  input: TmuxCommandInput,
): Promise<TmuxPersistentPopupUi> {
  const checkoutRoot = options.checkoutRoot ?? options.registeredDevPopupRoot;
  if (options.preferRegisteredDevPopup === true) {
    const registered = await resolveRegisteredDevPopupUi(input);
    if (
      registered !== undefined &&
      registered.root !== undefined &&
      registered.root === checkoutRoot
    ) {
      return {
        command: registered.command,
        registerFastPopup: false,
        sessionName: registered.sessionName,
      };
    }
  }
  const result: TmuxPersistentPopupUi = {
    command: options.tuiCommand ?? defaultPersistentPopupTuiCommand,
    registerFastPopup: true,
    sessionName: options.uiSessionName ?? defaultPersistentPopupSessionName,
  };
  if (checkoutRoot !== undefined) {
    result.root = checkoutRoot;
  }
  return result;
}

export async function registerFastPopupUi(
  input: TmuxCommandInput,
  ui: TmuxPersistentPopupUi,
): Promise<NormalPopupRoute | undefined> {
  if (ui.root === undefined || !(await hasTmuxSession(input, ui.sessionName))) {
    return undefined;
  }
  const signature = persistentPopupSignature(ui.command);
  if ((await resolvePersistentPopupSessionSignature(input, ui.sessionName)) !== signature) {
    return undefined;
  }

  const previousRouteValue = await resolveTmuxGlobalOption(input, persistentUiRouteOption);
  const previousRoute =
    previousRouteValue === undefined ? undefined : parseNormalPopupRoute(previousRouteValue);
  if (
    previousRouteValue !== undefined &&
    previousRoute === undefined &&
    previousRouteValue.length > 4096
  ) {
    return undefined;
  }

  const currentLease = await resolvePersistentPopupSessionLease(input, ui.sessionName);
  const currentSessionName = await resolveTmuxGlobalOption(input, registeredPopupSessionNameOption);
  const currentSignature = await resolveTmuxGlobalOption(
    input,
    registeredPopupExpectedSignatureOption,
  );
  const currentRoot = await resolveTmuxGlobalOption(input, registeredPopupRootOption);
  if (
    previousRoute !== undefined &&
    registeredRouteMatches(
      previousRoute,
      ui as TmuxPersistentPopupUi & { root: string },
      signature,
    ) &&
    currentLease === previousRouteValue &&
    currentSessionName === ui.sessionName &&
    currentSignature === signature &&
    currentRoot === ui.root
  ) {
    return previousRoute;
  }

  const routeValue = buildNormalPopupRoute({
    root: ui.root,
    sessionName: ui.sessionName,
    signature,
  });
  const route = parseNormalPopupRoute(routeValue);
  if (route === undefined) {
    return undefined;
  }

  await setPersistentPopupSessionLease(input, { lease: routeValue, sessionName: ui.sessionName });
  await setTmuxGlobalOption(input, registeredPopupSessionNameOption, ui.sessionName);
  await setTmuxGlobalOption(input, registeredPopupExpectedSignatureOption, signature);
  await setTmuxGlobalOption(input, registeredPopupRootOption, ui.root);
  const committed = await compareAndSetPersistentPopupRoute(input, {
    lease: routeValue,
    route: routeValue,
    sessionName: ui.sessionName,
    ...(previousRouteValue === undefined ? {} : { expected: previousRouteValue }),
  });
  if (!committed) {
    return undefined;
  }
  return route;
}
