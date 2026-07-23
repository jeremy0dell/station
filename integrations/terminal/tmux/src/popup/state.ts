import type { TmuxCommandInput } from "../command.js";
import {
  resolveTmuxGlobalOption,
  runTmuxPopupCommand,
  runTmuxPopupQuery,
  setTmuxGlobalOption,
} from "./command.js";
import {
  activePopupClaimOption,
  activePopupClientOption,
  focusPopupClientOption,
} from "./constants.js";
import {
  isSafePopupClientName,
  type PopupActiveClaim,
  parsePopupActiveClaim,
} from "./fastProtocol.js";

export type TmuxActivePopupClaimState =
  | { kind: "absent" }
  | { claim: PopupActiveClaim; kind: "valid"; raw: string }
  | { kind: "malformed"; raw: string };

function formatLiteral(value: string): string {
  return value.replaceAll("#", "##").replaceAll(",", "#,").replaceAll("}", "#}");
}

function optionEqualsFormat(optionName: string, value: string | undefined): string {
  return `#{==:#{${optionName}},${formatLiteral(value ?? "")}}`;
}

function claimEqualsFormat(value: string | undefined): string {
  return optionEqualsFormat(activePopupClaimOption, value);
}

function legacyPopupCondition(clientId: string): string {
  return `#{&&:${claimEqualsFormat(undefined)},#{||:${optionEqualsFormat(activePopupClientOption, clientId)},${optionEqualsFormat(focusPopupClientOption, clientId)}}}`;
}

function legacyPopupClearCommands(clientId: string): string {
  return [
    `if-shell -F "${optionEqualsFormat(activePopupClientOption, clientId)}" "set-option -gq -u ${activePopupClientOption}"`,
    `if-shell -F "${optionEqualsFormat(focusPopupClientOption, clientId)}" "set-option -gq -u ${focusPopupClientOption}"`,
  ].join(" ; ");
}

async function runLegacyPopupActionIfUnclaimed(
  input: TmuxCommandInput & { clientId: string },
  close: boolean,
): Promise<boolean> {
  if (!isSafePopupClientName(input.clientId)) {
    return false;
  }
  const miss = "STATION_POPUP_CAS_MISS";
  const commands = [
    ...(close ? [`display-popup -c ${input.clientId} -C`] : []),
    legacyPopupClearCommands(input.clientId),
  ].join(" ; ");
  const result = await runTmuxPopupQuery(input, {
    args: [
      "if-shell",
      "-F",
      legacyPopupCondition(input.clientId),
      commands,
      `display-message -p ${miss}`,
    ],
    operation: "provider.tmux.popup.clearLegacyState",
    message: "tmux failed to clear the legacy station popup state.",
    timeoutMessage: "tmux legacy popup state cleanup timed out.",
  });
  return result.stdout.trim() !== miss;
}

export async function resolveActivePopupClaimState(
  input: TmuxCommandInput,
): Promise<TmuxActivePopupClaimState> {
  const raw = await resolveTmuxGlobalOption(input, activePopupClaimOption, {
    operation: "provider.tmux.popup.activeClaim",
    message: "tmux failed to resolve the active station popup claim.",
    timeoutMessage: "tmux active popup claim lookup timed out.",
  });
  if (raw === undefined) {
    return { kind: "absent" };
  }
  const claim = parsePopupActiveClaim(raw);
  return claim === undefined ? { kind: "malformed", raw } : { claim, kind: "valid", raw };
}

export async function compareAndSetActivePopupClaim(
  input: TmuxCommandInput,
  options: { expected?: string; replacement: string },
): Promise<boolean> {
  await runTmuxPopupCommand(input, {
    args: [
      "if-shell",
      "-F",
      claimEqualsFormat(options.expected),
      `set-option -gq ${activePopupClaimOption} ${options.replacement}`,
    ],
    operation: "provider.tmux.popup.replaceActiveClaim",
    message: "tmux failed to claim the active station popup.",
    timeoutMessage: "tmux active popup claim update timed out.",
  });
  return (await resolveTmuxGlobalOption(input, activePopupClaimOption)) === options.replacement;
}

export async function clearActivePopupClaimIfCurrent(
  input: TmuxCommandInput,
  options: { claim: string; clientId: string },
): Promise<void> {
  const clearCommands = [
    `set-option -gq -u ${activePopupClaimOption}`,
    `if-shell -F "#{==:#{${activePopupClientOption}},${options.clientId}}" "set-option -gq -u ${activePopupClientOption}"`,
    `if-shell -F "#{==:#{${focusPopupClientOption}},${options.clientId}}" "set-option -gq -u ${focusPopupClientOption}"`,
  ].join(" ; ");
  await runTmuxPopupCommand(input, {
    args: ["if-shell", "-F", claimEqualsFormat(options.claim), clearCommands],
    operation: "provider.tmux.popup.clearActiveClaim",
    message: "tmux failed to clear the active station popup claim.",
    timeoutMessage: "tmux active popup claim cleanup timed out.",
  });
}

export async function clearLegacyPopupStateIfUnclaimed(
  input: TmuxCommandInput & { clientId: string },
): Promise<boolean> {
  return runLegacyPopupActionIfUnclaimed(input, false);
}

export async function clearLegacyFocusIfUnclaimed(
  input: TmuxCommandInput & { clientId: string },
): Promise<boolean> {
  if (!isSafePopupClientName(input.clientId)) {
    return false;
  }
  const miss = "STATION_POPUP_CAS_MISS";
  const condition = `#{&&:${claimEqualsFormat(undefined)},${optionEqualsFormat(focusPopupClientOption, input.clientId)}}`;
  const result = await runTmuxPopupQuery(input, {
    args: [
      "if-shell",
      "-F",
      condition,
      `set-option -gq -u ${focusPopupClientOption}`,
      `display-message -p ${miss}`,
    ],
    operation: "provider.tmux.popup.clearLegacyFocus",
    message: "tmux failed to clear the legacy station popup focus.",
    timeoutMessage: "tmux legacy popup focus cleanup timed out.",
  });
  return result.stdout.trim() !== miss;
}

export async function dismissLegacyPopupIfUnclaimed(
  input: TmuxCommandInput & { clientId: string },
): Promise<boolean> {
  return runLegacyPopupActionIfUnclaimed(input, true);
}

export async function resolveActivePopupClient(
  input: TmuxCommandInput,
): Promise<string | undefined> {
  return resolveTmuxGlobalOption(input, activePopupClientOption, {
    operation: "provider.tmux.popup.activeClient",
    message: "tmux failed to resolve the active station popup.",
    timeoutMessage: "tmux active popup lookup timed out.",
  });
}

export async function resolveFocusPopupClient(
  input: TmuxCommandInput,
): Promise<string | undefined> {
  return resolveTmuxGlobalOption(input, focusPopupClientOption, {
    operation: "provider.tmux.popup.focusClient",
    message: "tmux failed to resolve the station popup focus client.",
    timeoutMessage: "tmux popup focus client lookup timed out.",
  });
}

export async function setActivePopupClient(
  input: TmuxCommandInput & { clientId: string },
): Promise<void> {
  await setTmuxGlobalOption(input, activePopupClientOption, input.clientId, {
    operation: "provider.tmux.popup.setActiveClient",
    message: "tmux failed to record the active station popup.",
    timeoutMessage: "tmux active popup update timed out.",
  });
}

export async function setFocusPopupClient(
  input: TmuxCommandInput & { clientId: string },
): Promise<void> {
  await setTmuxGlobalOption(input, focusPopupClientOption, input.clientId, {
    operation: "provider.tmux.popup.setFocusClient",
    message: "tmux failed to record the station popup focus client.",
    timeoutMessage: "tmux popup focus client update timed out.",
  });
}
