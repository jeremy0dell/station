import { emptyConfig } from "@station/config";
import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type {
  CliCommandConfigErrorContext,
  CliCommandNode,
  CliCommandRunContext,
} from "../cliCommand/types.js";
import { isConfigError } from "../configDiagnostics.js";
import { runTuiCommand, type TuiCommandDeps } from "../tui.js";

export const tuiCliCommand: CliCommandNode = {
  name: "tui",
  description: "Open the fullscreen or popup TUI.",
  requiresConfig: true,
  run: runTuiCliCommand,
  handleConfigError: handleTuiConfigError,
  usage: ["stn tui [--popup] [--persistent]"],
  options: [
    { name: "--popup", description: "Run in popup mode." },
    {
      name: "--persistent",
      description: "Accepted for tmux-popup compatibility (no separate behavior).",
    },
  ],
  examples: ["pnpm stn tui", "pnpm stn tui --popup --persistent"],
};

async function handleTuiConfigError(error: unknown, context: CliCommandConfigErrorContext) {
  if (
    !isConfigError(error) ||
    error.code !== "CONFIG_FILE_NOT_FOUND" ||
    context.configPath !== undefined
  ) {
    return undefined;
  }
  return runTuiCliCommand({ ...context, config: emptyConfig() });
}

async function runTuiCliCommand(context: CliCommandRunContext) {
  const tuiDeps: TuiCommandDeps = {};
  if (context.options.observerDeps !== undefined) tuiDeps.observer = context.options.observerDeps;
  if (context.options.tuiDeps?.spawnRenderer !== undefined)
    tuiDeps.spawnRenderer = context.options.tuiDeps.spawnRenderer;
  const tuiEnv = context.options.tuiDeps?.env ?? context.options.env;
  if (tuiEnv !== undefined) tuiDeps.env = tuiEnv;
  const result = await runTuiCommand(context.args, loadedCommandOptions(context), tuiDeps);
  return { code: result.code, output: result };
}
