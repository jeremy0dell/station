import { dirname, join } from "node:path";
import type { CliEnv } from "../../env.js";
import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { type PopupCommandDeps, type PopupCommandOptions, runPopupCommand } from "../popup.js";

export const popupCliCommand: CliCommandNode = {
  name: "popup",
  description: "Open the terminal popup dashboard.",
  requiresConfig: true,
  run: runPopupCliCommand,
  usage: ["stn popup [--persistent]"],
  options: [
    {
      name: "--persistent",
      description: "Keep the popup lifecycle session available for reuse.",
    },
  ],
  examples: ["pnpm stn popup", "pnpm stn popup --persistent"],
};

async function runPopupCliCommand(context: CliCommandRunContext) {
  const popupEnv = context.options.popupDeps?.env ?? context.options.env;
  const defaultPopupEnv = popupEnv ?? process.env;
  const hasExplicitPopupUi =
    context.options.popupDeps?.tuiCommand !== undefined ||
    context.options.popupDeps?.uiSessionName !== undefined ||
    nonEmptyString(defaultPopupEnv.STATION_TUI_COMMAND) !== undefined ||
    nonEmptyString(defaultPopupEnv.STATION_TUI_SESSION_NAME) !== undefined;
  const insideTmux = nonEmptyString(defaultPopupEnv.TMUX) !== undefined;
  const tuiCommand =
    context.options.popupDeps?.tuiCommand ??
    defaultPopupTuiCommand(context.resolvedConfigPath, defaultPopupEnv, context.cliEntryPath);
  const uiSessionName =
    context.options.popupDeps?.uiSessionName ?? popupUiSessionNameFromEnv(defaultPopupEnv);
  const preferRegisteredDevPopup =
    context.options.popupDeps?.preferRegisteredDevPopup ?? (!hasExplicitPopupUi && insideTmux);
  const popupDeps: PopupCommandDeps = {};
  if (context.options.popupDeps !== undefined) {
    Object.assign(popupDeps, context.options.popupDeps);
  }
  if (context.options.observerDeps !== undefined) {
    popupDeps.observer = context.options.observerDeps;
  }
  const popupOptions: PopupCommandOptions = loadedCommandOptions(context);
  popupOptions.tuiCommand = tuiCommand;
  if (popupEnv !== undefined) {
    popupOptions.env = popupEnv;
  }
  popupOptions.preferRegisteredDevPopup = preferRegisteredDevPopup;
  if (uiSessionName !== undefined) {
    popupOptions.uiSessionName = uiSessionName;
  }
  popupOptions.checkoutRoot = repoRootFromCliModule(context.cliEntryPath);
  const result = await runPopupCommand(context.args, popupOptions, popupDeps);
  return { code: "code" in result ? result.code : 0, output: result };
}

function defaultPopupTuiCommand(
  configPath: string | undefined,
  env: CliEnv | undefined,
  cliEntryPath: string,
): string {
  const command = nonEmptyString(env?.STATION_TUI_COMMAND);
  const parts =
    command === undefined ? [shellQuote(process.execPath), shellQuote(cliEntryPath)] : [command];
  if (configPath !== undefined) {
    parts.push("--config", shellQuote(configPath));
  }
  parts.push("tui", "--popup", "--persistent");
  return parts.join(" ");
}

function popupUiSessionNameFromEnv(env: CliEnv | undefined): string | undefined {
  return nonEmptyString(env?.STATION_TUI_SESSION_NAME);
}

function nonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function repoRootFromCliModule(cliEntryPath: string): string {
  return join(dirname(cliEntryPath), "../../..");
}
