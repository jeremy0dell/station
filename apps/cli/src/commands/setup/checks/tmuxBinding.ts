import { join } from "node:path";
import { type ExternalCommandRunner, runExternalCommand } from "@station/runtime";
import type { SetupTmuxBindingFact } from "../model.js";
import type { SetupFileSystemReader } from "./config.js";
import { setupProbeTimeoutMs } from "./constants.js";

export const tmuxPopupBindingMarker = "# >>> station popup binding >>>";
export const tmuxPopupBindingEndMarker = "# <<< station popup binding <<<";

export type CheckSetupTmuxBindingOptions = {
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  fs?: SetupFileSystemReader;
  launcherCommand?: string;
  runner?: ExternalCommandRunner;
  tmuxCommand?: string;
};

export function setupTmuxConfigPath(
  options: Pick<CheckSetupTmuxBindingOptions, "homeDir">,
): string {
  return join(options.homeDir, ".tmux.conf");
}

export async function checkSetupTmuxBinding(
  options: CheckSetupTmuxBindingOptions,
): Promise<SetupTmuxBindingFact> {
  const path = setupTmuxConfigPath(options);
  const fs = options.fs ?? nodeFsReader();
  const launcherCommand = options.launcherCommand ?? "stn-tmux-popup";
  const runShellCommand = tmuxPopupRunShellCommand(launcherCommand);
  const insideTmux = (options.env ?? process.env).TMUX !== undefined;
  const liveInput: Parameters<typeof checkLiveTmuxBinding>[0] = {
    insideTmux,
    launcherCommand,
  };
  if (options.env !== undefined) liveInput.env = options.env;
  if (options.runner !== undefined) liveInput.runner = options.runner;
  if (options.tmuxCommand !== undefined) liveInput.tmuxCommand = options.tmuxCommand;
  const liveStatus = await checkLiveTmuxBinding(liveInput);
  try {
    const source = await fs.readFile(path);
    if (source.includes(tmuxPopupBindingMarker) || source.includes("stn-tmux-popup")) {
      if (!source.includes(launcherCommand)) {
        return missingTmuxBinding({
          path,
          launcherCommand,
          runShellCommand,
          insideTmux,
          liveStatus,
          message: "tmux popup binding is installed but uses an outdated STATION launcher command.",
        });
      }
      if (insideTmux && liveStatus === "missing") {
        return missingTmuxBinding({
          path,
          launcherCommand,
          runShellCommand,
          insideTmux,
          liveStatus,
          message:
            "tmux popup binding is installed in ~/.tmux.conf but is not loaded in the current tmux server.",
        });
      }
      return {
        status: "ok",
        path,
        marker: tmuxPopupBindingMarker,
        launcherCommand,
        runShellCommand,
        insideTmux,
        liveStatus,
      };
    }
  } catch {
    return missingTmuxBinding({ path, launcherCommand, runShellCommand, insideTmux, liveStatus });
  }
  return missingTmuxBinding({ path, launcherCommand, runShellCommand, insideTmux, liveStatus });
}

export function tmuxPopupBindingBlock(launcherCommand = "stn-tmux-popup"): string {
  return [
    tmuxPopupBindingMarker,
    tmuxPopupBindingLine(launcherCommand),
    tmuxPopupBindingEndMarker,
    "",
  ].join("\n");
}

export function tmuxPopupBindingLine(launcherCommand = "stn-tmux-popup"): string {
  return `bind-key Space run-shell -b ${quoteShellValue(tmuxPopupRunShellCommand(launcherCommand))}`;
}

export function tmuxPopupRunShellCommand(launcherCommand = "stn-tmux-popup"): string {
  return `env STATION_FOCUS_PROVIDER=tmux STATION_FOCUS_CLIENT_ID=#{q:client_name} ${quoteShellValue(launcherCommand)}`;
}

function missingTmuxBinding(input: {
  path: string;
  launcherCommand: string;
  runShellCommand: string;
  insideTmux: boolean;
  liveStatus: "loaded" | "missing" | "unknown";
  message?: string;
}): SetupTmuxBindingFact {
  return {
    status: "missing",
    path: input.path,
    marker: tmuxPopupBindingMarker,
    launcherCommand: input.launcherCommand,
    runShellCommand: input.runShellCommand,
    insideTmux: input.insideTmux,
    liveStatus: input.liveStatus,
    message: input.message ?? "Optional tmux popup binding is not installed.",
  };
}

async function checkLiveTmuxBinding(input: {
  env?: NodeJS.ProcessEnv;
  insideTmux: boolean;
  launcherCommand: string;
  runner?: ExternalCommandRunner;
  tmuxCommand?: string;
}): Promise<"loaded" | "missing" | "unknown"> {
  if (!input.insideTmux) {
    return "unknown";
  }
  try {
    const result = await runExternalCommand(
      {
        command: input.tmuxCommand ?? "tmux",
        args: ["list-keys", "-T", "prefix", "Space"],
        timeoutMs: setupProbeTimeoutMs,
        maxOutputChars: 4096,
        ...(input.env === undefined ? {} : { env: envForExternalCommand(input.env) }),
      },
      input.runner,
    );
    return result.stdout.includes(input.launcherCommand) ? "loaded" : "missing";
  } catch {
    return "unknown";
  }
}

function quoteShellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function envForExternalCommand(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function nodeFsReader(): SetupFileSystemReader {
  return {
    async readFile(path) {
      const { readFile } = await import("node:fs/promises");
      return readFile(path, "utf8");
    },
  };
}
