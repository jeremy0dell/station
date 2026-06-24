import { shellQuote } from "../shell.js";
import { resolveTmuxWorkbenchConfig } from "../topology.js";
import { defaultPersistentPopupSessionName } from "./constants.js";
import type { BuildTmuxPopupArgsOptions, TmuxPopupState } from "./types.js";

const safeShellTokenPattern = /^[A-Za-z0-9_@%+=,./:-]+$/;
const persistentPopupAttachFeatures = "hyperlinks";

function buildPopupTuiCommand(options: { focusClientId?: string; tuiCommand: string }): string {
  const envAssignments = ["STATION_TUI_POPUP=1", "STATION_FOCUS_PROVIDER=tmux"];
  if (options.focusClientId !== undefined && options.focusClientId.length > 0) {
    envAssignments.push(`STATION_FOCUS_CLIENT_ID=${quoteShellValue(options.focusClientId)}`);
  }
  return ["env", ...envAssignments, options.tuiCommand].join(" ");
}

function buildPersistentPopupAttachCommand(options: {
  tmuxCommand: string;
  uiSessionName: string;
}): string {
  return `env -u TMUX ${quoteShellValue(options.tmuxCommand)} -T ${persistentPopupAttachFeatures} attach-session -t ${quoteShellValue(options.uiSessionName)}`;
}

function withPopupStateCleanup(command: string, popupState: TmuxPopupState): string {
  const cleanupScript = buildPopupCleanupScript(popupState);
  return `sh -lc ${shellQuote(`trap ${shellQuote(cleanupScript)} EXIT; ${command}`)}`;
}

function buildPopupCleanupScript(options: TmuxPopupState): string {
  const tmuxCommand = shellQuote(options.tmuxCommand);
  const optionName = shellQuote(options.optionName);
  const focusOptionName =
    options.focusOptionName === undefined ? undefined : shellQuote(options.focusOptionName);
  const clientId = shellQuote(options.clientId);
  const commands = [
    `if [ "$(${tmuxCommand} show-options -gqv ${optionName} 2>/dev/null)" = ${clientId} ]; then`,
    `${tmuxCommand} set-option -gq -u ${optionName};`,
    "fi;",
  ];
  if (focusOptionName !== undefined) {
    commands.push(
      `if [ "$(${tmuxCommand} show-options -gqv ${focusOptionName} 2>/dev/null)" = ${clientId} ]; then`,
      `${tmuxCommand} set-option -gq -u ${focusOptionName};`,
      "fi;",
    );
  }
  return commands.join(" ");
}

function quoteShellValue(value: string): string {
  return safeShellTokenPattern.test(value) ? value : shellQuote(value);
}

function transientPopupCommandOptions(options: BuildTmuxPopupArgsOptions): {
  focusClientId?: string;
  tuiCommand: string;
} {
  const input: { focusClientId?: string; tuiCommand: string } = {
    tuiCommand: options.tuiCommand ?? "stn tui --popup",
  };
  if (options.focusClientId !== undefined) {
    input.focusClientId = options.focusClientId;
  }
  return input;
}

export function buildPersistentPopupTuiCommand(tuiCommand: string): string {
  return ["env", "STATION_TUI_POPUP=1", "STATION_FOCUS_PROVIDER=tmux", tuiCommand].join(" ");
}

export function buildTmuxPopupArgs(options: BuildTmuxPopupArgsOptions = {}): string[] {
  const config = resolveTmuxWorkbenchConfig(options.config);
  const persistent = options.persistent !== false;
  const args = ["display-popup"];
  if (options.focusClientId !== undefined && options.focusClientId.length > 0) {
    args.push("-c", options.focusClientId);
  }
  args.push("-w", config.popupWidth, "-h", config.popupHeight);
  if (config.popupPosition.length > 0 && config.popupPosition !== "C") {
    args.push("-x", config.popupPosition);
  }

  const command = persistent
    ? buildPersistentPopupAttachCommand({
        tmuxCommand: options.command ?? "tmux",
        uiSessionName: options.uiSessionName ?? defaultPersistentPopupSessionName,
      })
    : buildPopupTuiCommand(transientPopupCommandOptions(options));

  const popupCommand =
    options.popupState === undefined ? command : withPopupStateCleanup(command, options.popupState);
  args.push("-E", popupCommand);
  return args;
}
