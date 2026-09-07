import type { SafeError } from "@station/contracts";
import { stationObserverBuildVersion } from "@station/runtime";
import { z } from "zod";
import type { TmuxCommandInput } from "../command.js";
import { shellQuote } from "../shell.js";
import { defaultTmuxWorkbenchConfig } from "../topology.js";
import { buildPersistentPopupTuiCommand } from "./args.js";
import { persistentPopupSignature } from "./signature.js";

export { persistentPopupSignature } from "./signature.js";

import {
  hasTmuxSession,
  popupCommandInput,
  resolveTmuxGlobalOption,
  resolveTmuxOption,
  runTmuxPopupCommand,
  runTmuxPopupQuery,
  setTmuxGlobalOption,
} from "./command.js";
import {
  defaultPersistentPopupSessionName,
  defaultPersistentPopupTuiCommand,
  persistentUiLeaseOption,
  persistentUiOwnerClientOption,
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

async function setPersistentPopupSessionOwnerClient(
  input: TmuxCommandInput,
  options: { clientId: string; sessionName: string },
): Promise<void> {
  await runTmuxPopupCommand(input, {
    args: [
      "set-option",
      "-t",
      options.sessionName,
      "-q",
      persistentUiOwnerClientOption,
      options.clientId,
    ],
    operation: "provider.tmux.popup.setPersistentUiOwnerClient",
    message: "tmux failed to record the persistent station popup owner client.",
    timeoutMessage: "tmux persistent station popup owner client update timed out.",
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

const persistentPopupPaneSchema = z.tuple([
  z.string().regex(/^\$[0-9]+$/),
  z.string().regex(/^%[0-9]+$/),
  z.literal("1"),
  z.literal("1"),
  z.string().min(1).max(4096),
  z.string().min(1).max(8192),
]);
const persistentPopupSignatureSchema = z
  .string()
  .regex(/^v(?:1:[^\0\r\n]+|2:[^:\0\r\n]+:[^\0\r\n]+)$/);
// tmux prints this single shell-command argument in double quotes; never evaluate it as shell code.
const persistentPopupStartCommandSchema = z
  .string()
  .regex(/^"(?:[^"\\\0\r\n]|\\[\\"$])*"$/)
  .transform((command) => command.slice(1, -1).replace(/\\([\\"$])/g, "$1"));

function signedPopupCommand(
  signature: string,
  focusClientId: string | undefined,
): string | undefined {
  if (!persistentPopupSignatureSchema.safeParse(signature).success) return undefined;
  if (signature.startsWith("v1:")) return signature.slice(3);
  const command = signature.slice(signature.indexOf(":", 3) + 1);
  if (focusClientId === undefined) return command;
  const suffix = `:client=${focusClientId}`;
  return command.endsWith(suffix) ? command.slice(0, -suffix.length) : undefined;
}

async function killPersistentPopupSessionIfUnchanged(
  input: TmuxCommandInput,
  sessionName: string,
  expectedSignature: string,
  tuiCommand: string,
  focusClientId: string | undefined,
): Promise<void> {
  const fields = [
    "session_id",
    "pane_id",
    "session_windows",
    "window_panes",
    persistentUiSignatureOption,
    "pane_start_command",
  ];
  const result = await runTmuxPopupQuery(input, {
    args: [
      "display-message",
      "-p",
      "-t",
      `=${sessionName}:`,
      fields.map((field) => `#{${field}}`).join("\t"),
    ],
    operation: "provider.tmux.popup.inspectPersistentUi",
    message: "tmux failed to verify the persistent popup session before replacement.",
    timeoutMessage: "tmux persistent popup ownership inspection timed out.",
  });
  const parsed = persistentPopupPaneSchema.safeParse(result.stdout.trimEnd().split("\t"));
  if (parsed.success && parsed.data[4] !== expectedSignature) return;
  const signedCommand = signedPopupCommand(expectedSignature, focusClientId);
  const startCommand = persistentPopupStartCommandSchema.safeParse(parsed.data?.[5]);
  if (
    !parsed.success ||
    signedCommand === undefined ||
    (signedCommand !== tuiCommand && !signedCommand.endsWith("tui --popup --persistent")) ||
    !startCommand.success ||
    startCommand.data !== buildPersistentPopupTuiCommand(signedCommand, focusClientId)
  ) {
    throw persistentPopupOwnershipError(
      `The tmux session ${sessionName} is not proven to contain only its signed Station dashboard.`,
      "Inspect and preserve its panes before retrying stn popup; Station left the session unchanged.",
    );
  }
  const [sessionId] = parsed.data;
  const unchanged = fields
    .map((field, index) => globalOptionEqualsFormat(field, parsed.data[index]))
    .reduce((left, right) => `#{&&:${left},${right}}`);
  // Revalidate the exact session, pane, command, and topology in the same tmux queue as removal.
  // A same-name replacement or added pane must never inherit this removal decision.
  await runTmuxPopupCommand(input, {
    args: [
      "if-shell",
      "-F",
      "-t",
      `=${sessionName}:`,
      unchanged,
      `kill-session -t ${shellQuote(sessionId)}`,
    ],
    operation: "provider.tmux.popup.killPersistentUi",
    message: "tmux failed to replace the persistent station popup UI.",
    timeoutMessage: "tmux persistent popup UI replacement timed out.",
  });
}

function persistentPopupOwnershipError(message: string, hint: string): SafeError {
  return {
    tag: "TerminalProviderError",
    code: "TERMINAL_POPUP_FAILED",
    message,
    provider: "tmux",
    hint,
  };
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

async function configurePersistentPopupSessionStatusBar(
  input: TmuxCommandInput,
  sessionName: string,
  visible: boolean,
): Promise<void> {
  // This option is session-scoped so Station never changes the invoking tmux session's status bar.
  await runTmuxPopupCommand(input, {
    args: ["set-option", "-t", sessionName, "status", visible ? "on" : "off"],
    operation: "provider.tmux.popup.configureStatusBar",
    message: "tmux failed to configure the persistent station popup UI status bar.",
    timeoutMessage: "tmux persistent popup UI status bar setup timed out.",
  });
}

async function configurePersistentPopupSession(
  input: TmuxCommandInput,
  sessionName: string,
  focusClientId: string | undefined,
  popupStatusBar: boolean,
): Promise<void> {
  await enablePersistentPopupSessionMouse(input, sessionName);
  await configurePersistentPopupSessionStatusBar(input, sessionName, popupStatusBar);
  if (focusClientId !== undefined) {
    await setPersistentPopupSessionOwnerClient(input, {
      clientId: focusClientId,
      sessionName,
    });
  }
}

/**
 * ADAPTER
 *
 * Reuses the exact renderer build or replaces only a revalidated dashboard-only tmux session.
 * Unsigned, repurposed, and concurrently changed sessions retain their processes and panes.
 */
export async function ensurePersistentPopupSession(
  options: TmuxPersistentPopupSessionOptions = {},
): Promise<TmuxPersistentPopupSessionResult> {
  const command = options.command ?? process.env.STATION_TMUX_BIN ?? "tmux";
  const input = persistentSessionOptions(options, command);
  const sessionName = options.uiSessionName ?? defaultPersistentPopupSessionName;
  const tuiCommand = options.tuiCommand ?? defaultPersistentPopupTuiCommand;
  const popupStatusBar = options.popupStatusBar ?? defaultTmuxWorkbenchConfig.popupStatusBar;
  const signature = persistentPopupSignature(
    tuiCommand,
    stationObserverBuildVersion(),
    options.focusClientId,
  );
  if (await hasTmuxSession(input, sessionName)) {
    const currentSignature = await resolvePersistentPopupSessionSignature(input, sessionName);
    if (currentSignature === signature) {
      await configurePersistentPopupSession(
        input,
        sessionName,
        options.focusClientId,
        popupStatusBar,
      );
      return { sessionName, created: false };
    }
    if (currentSignature !== undefined) {
      await killPersistentPopupSessionIfUnchanged(
        input,
        sessionName,
        currentSignature,
        tuiCommand,
        options.focusClientId,
      );
      if (await hasTmuxSession(input, sessionName)) {
        // The CAS kill no-opped, so a concurrent contender owns the session now;
        // only its exact signature is reusable.
        const contenderSignature = await resolvePersistentPopupSessionSignature(input, sessionName);
        if (contenderSignature === signature) {
          await configurePersistentPopupSession(
            input,
            sessionName,
            options.focusClientId,
            popupStatusBar,
          );
          return { sessionName, created: false };
        }
        throw persistentPopupOwnershipError(
          `The tmux session ${sessionName} changed during persistent popup replacement.`,
          "Retry opening the popup; the concurrent replacement usually settles on the next attempt.",
        );
      }
    } else if (await hasTmuxSession(input, sessionName)) {
      // Every Station-created session is signed at creation since the first release,
      // so an unsigned session is not proven Station-owned and is never killed.
      throw persistentPopupOwnershipError(
        `The tmux session ${sessionName} exists without Station ownership evidence.`,
        `Inspect it with "tmux attach-session -t ${shellQuote(sessionName)}" and, when it holds nothing you need, kill it with "tmux kill-session -t ${shellQuote(sessionName)}"; Station will not replace an unsigned session.`,
      );
    }
  }

  await runTmuxPopupCommand(input, {
    args: [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-n",
      "station-ui",
      buildPersistentPopupTuiCommand(tuiCommand, options.focusClientId),
    ],
    operation: "provider.tmux.popup.createPersistentUi",
    message: "tmux failed to create the persistent station popup UI.",
    timeoutMessage: "tmux persistent popup UI creation timed out.",
  });
  await setPersistentPopupSessionSignature(input, {
    sessionName,
    signature,
  });
  await configurePersistentPopupSession(input, sessionName, options.focusClientId, popupStatusBar);
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
