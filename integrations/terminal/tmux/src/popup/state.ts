import type { TmuxCommandInput } from "../command.js";
import { resolveTmuxGlobalOption, runTmuxPopupCommand, runTmuxPopupQuery } from "./command.js";
import {
  isSafePopupClientName,
  type PopupActiveClaim,
  parsePopupActiveClaim,
} from "./fastProtocol.js";
import { serverPopupStateKeys, type TmuxPopupStateKeys } from "./scope.js";

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

function claimEqualsFormat(value: string | undefined, state: TmuxPopupStateKeys): string {
  return optionEqualsFormat(state.activeClaimOption, value);
}

function legacyPopupCondition(clientId: string, state: TmuxPopupStateKeys): string {
  return `#{&&:${claimEqualsFormat(undefined, state)},#{||:${optionEqualsFormat(state.activeClientOption, clientId)},${optionEqualsFormat(state.focusClientOption, clientId)}}}`;
}

function legacyPopupClearCommands(clientId: string, state: TmuxPopupStateKeys): string {
  return [
    `if-shell -F "${optionEqualsFormat(state.activeClientOption, clientId)}" "set-option -gq -u ${state.activeClientOption}"`,
    `if-shell -F "${optionEqualsFormat(state.focusClientOption, clientId)}" "set-option -gq -u ${state.focusClientOption}"`,
  ].join(" ; ");
}

async function runLegacyPopupActionIfUnclaimed(
  input: TmuxCommandInput & { clientId: string },
  close: boolean,
  state: TmuxPopupStateKeys,
): Promise<boolean> {
  if (!isSafePopupClientName(input.clientId)) {
    return false;
  }
  const miss = "STATION_POPUP_CAS_MISS";
  const commands = [
    ...(close ? [`display-popup -c ${input.clientId} -C`] : []),
    legacyPopupClearCommands(input.clientId, state),
  ].join(" ; ");
  const result = await runTmuxPopupQuery(input, {
    args: [
      "if-shell",
      "-F",
      legacyPopupCondition(input.clientId, state),
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
  state: TmuxPopupStateKeys = serverPopupStateKeys,
): Promise<TmuxActivePopupClaimState> {
  const raw = await resolveTmuxGlobalOption(input, state.activeClaimOption, {
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
  state: TmuxPopupStateKeys = serverPopupStateKeys,
): Promise<boolean> {
  await runTmuxPopupCommand(input, {
    args: [
      "if-shell",
      "-F",
      claimEqualsFormat(options.expected, state),
      `set-option -gq ${state.activeClaimOption} ${options.replacement}`,
    ],
    operation: "provider.tmux.popup.replaceActiveClaim",
    message: "tmux failed to claim the active station popup.",
    timeoutMessage: "tmux active popup claim update timed out.",
  });
  return (await resolveTmuxGlobalOption(input, state.activeClaimOption)) === options.replacement;
}

export async function clearActivePopupClaimIfCurrent(
  input: TmuxCommandInput,
  options: { claim: string; clientId: string },
  state: TmuxPopupStateKeys = serverPopupStateKeys,
): Promise<void> {
  const clearCommands = [
    `set-option -gq -u ${state.activeClaimOption}`,
    `if-shell -F "#{==:#{${state.activeClientOption}},${options.clientId}}" "set-option -gq -u ${state.activeClientOption}"`,
    `if-shell -F "#{==:#{${state.focusClientOption}},${options.clientId}}" "set-option -gq -u ${state.focusClientOption}"`,
  ].join(" ; ");
  await runTmuxPopupCommand(input, {
    args: ["if-shell", "-F", claimEqualsFormat(options.claim, state), clearCommands],
    operation: "provider.tmux.popup.clearActiveClaim",
    message: "tmux failed to clear the active station popup claim.",
    timeoutMessage: "tmux active popup claim cleanup timed out.",
  });
}

export async function clearLegacyPopupStateIfUnclaimed(
  input: TmuxCommandInput & { clientId: string },
  state: TmuxPopupStateKeys = serverPopupStateKeys,
): Promise<boolean> {
  return runLegacyPopupActionIfUnclaimed(input, false, state);
}

export async function clearLegacyFocusIfUnclaimed(
  input: TmuxCommandInput & { clientId: string },
  state: TmuxPopupStateKeys = serverPopupStateKeys,
): Promise<boolean> {
  if (!isSafePopupClientName(input.clientId)) {
    return false;
  }
  const miss = "STATION_POPUP_CAS_MISS";
  const condition = `#{&&:${claimEqualsFormat(undefined, state)},${optionEqualsFormat(state.focusClientOption, input.clientId)}}`;
  const result = await runTmuxPopupQuery(input, {
    args: [
      "if-shell",
      "-F",
      condition,
      `set-option -gq -u ${state.focusClientOption}`,
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
  state: TmuxPopupStateKeys = serverPopupStateKeys,
): Promise<boolean> {
  return runLegacyPopupActionIfUnclaimed(input, true, state);
}

export async function resolveActivePopupClient(
  input: TmuxCommandInput,
  state: TmuxPopupStateKeys = serverPopupStateKeys,
): Promise<string | undefined> {
  return resolveTmuxGlobalOption(input, state.activeClientOption, {
    operation: "provider.tmux.popup.activeClient",
    message: "tmux failed to resolve the active station popup.",
    timeoutMessage: "tmux active popup lookup timed out.",
  });
}

export async function resolveFocusPopupClient(
  input: TmuxCommandInput,
  state: TmuxPopupStateKeys = serverPopupStateKeys,
): Promise<string | undefined> {
  return resolveTmuxGlobalOption(input, state.focusClientOption, {
    operation: "provider.tmux.popup.focusClient",
    message: "tmux failed to resolve the station popup focus client.",
    timeoutMessage: "tmux popup focus client lookup timed out.",
  });
}
