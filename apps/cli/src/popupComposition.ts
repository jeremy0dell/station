import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StationConfig } from "@station/config";
import {
  ProviderIdSchema,
  type SafeError,
  type TerminalPopupControl,
  type TerminalPopupLauncher,
} from "@station/contracts";
import { createTmuxPopupControl, createTmuxPopupLauncher } from "@station/tmux";
import type { CliEnv } from "./env.js";
import { buildPopupRendererCommand } from "./popupRendererCommand.js";
import { selfExecArgv } from "./selfExec.js";

type PopupCompositionOptions = {
  config?: StationConfig;
  env?: CliEnv;
  firstRun?: boolean;
};

/**
 * COMPOSITION ROOT
 *
 * Selects a terminal popup capability and binds the current CLI renderer command to it.
 * Config-less first-run popup launches retain the tmux route without implying provider readiness.
 */
export function createPopupLauncher(
  options: PopupCompositionOptions & {
    cliEntryPath: string;
    configPath?: string;
    installedRoot?: string;
    timeoutMs?: number;
  },
): TerminalPopupLauncher {
  const provider = configuredPopupProvider(options);
  if (provider !== "tmux") throw unsupportedPopupError(provider);
  const input: Parameters<typeof createTmuxPopupLauncher>[0] = {
    checkoutRoot:
      options.installedRoot ?? realpathSync(join(dirname(options.cliEntryPath), "../../..")),
    buildRendererCommand: (override, persistent) =>
      buildPopupRendererCommand(
        selfExecArgv("cli", [process.execPath, options.cliEntryPath]),
        options.configPath,
        override,
        persistent,
      ),
  };
  if (options.installedRoot !== undefined) input.installedRoot = options.installedRoot;
  if (options.config?.terminal?.tmux !== undefined) input.config = options.config.terminal.tmux;
  if (options.env !== undefined) input.env = options.env;
  if (options.timeoutMs !== undefined) input.timeoutMs = options.timeoutMs;
  return createTmuxPopupLauncher(input);
}

/**
 * COMPOSITION ROOT
 *
 * Selects popup controls using the launcher provider when present, otherwise the configured provider.
 * Provider provenance selects an adapter; the adapter must still prove ownership before effects.
 */
export function createPopupControl(options: PopupCompositionOptions = {}): TerminalPopupControl {
  const env = options.env ?? process.env;
  const provenance = env.STATION_TUI_POPUP === "1" ? env.STATION_FOCUS_PROVIDER : undefined;
  const provider =
    provenance === undefined
      ? configuredPopupProvider(options)
      : ProviderIdSchema.parse(provenance);
  if (provider !== "tmux") throw unsupportedPopupError(provider);
  const input: Parameters<typeof createTmuxPopupControl>[0] = { env };
  if (options.config?.terminal?.tmux !== undefined) input.config = options.config.terminal.tmux;
  return createTmuxPopupControl(input);
}

function configuredPopupProvider(options: PopupCompositionOptions): string {
  if (
    options.config === undefined ||
    (options.firstRun === true && options.config.projects.length === 0)
  )
    return "tmux";
  return options.config.defaults.terminal;
}

function unsupportedPopupError(provider: string): SafeError {
  return {
    tag: "TerminalProviderError",
    code: "TERMINAL_POPUP_UNSUPPORTED",
    message: `Terminal provider ${provider} does not supply popup capabilities.`,
    provider,
  };
}
