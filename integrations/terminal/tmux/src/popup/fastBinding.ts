import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { safeShellTokenPattern, shellQuote } from "../shell.js";
import { defaultTmuxWorkbenchConfig } from "../workbenchConfig.js";

export const ManagedPopupLaunchOptionsSchema = z
  .object({
    configPath: z.string().optional(),
    tmuxCommand: z.string(),
    popupWidth: z.string().default(defaultTmuxWorkbenchConfig.popupWidth),
    popupHeight: z.string().default(defaultTmuxWorkbenchConfig.popupHeight),
    popupPosition: z.string().default(defaultTmuxWorkbenchConfig.popupPosition),
    popupStatusBar: z.boolean().default(defaultTmuxWorkbenchConfig.popupStatusBar),
  })
  .strict();

export type BuildManagedFastPopupRunShellCommandOptions = {
  configPath?: string;
  tmuxCommand: string;
  popupWidth?: string;
  popupHeight?: string;
  popupPosition?: string;
  popupStatusBar?: boolean;
  fallbackAlias: string;
  installedRoot: string;
};

function containsUnsafeShellValue(value: string): boolean {
  return (
    value.includes("\0") || value.includes("\r") || value.includes("\n") || value.includes("\u001f")
  );
}

export function validateManagedBindingOptions(
  options: BuildManagedFastPopupRunShellCommandOptions,
): void {
  if (
    !isAbsolute(options.installedRoot) ||
    options.installedRoot === "/" ||
    containsUnsafeShellValue(options.installedRoot)
  ) {
    throw new Error("Station popup ownership requires a safe canonical installed root.");
  }
  if (
    options.fallbackAlias !== join(options.installedRoot, "stn-tmux-popup") ||
    containsUnsafeShellValue(options.fallbackAlias)
  ) {
    throw new Error("Station popup fallback must be the installed stn-tmux-popup sibling alias.");
  }
  if (!isAbsolute(options.tmuxCommand) || containsUnsafeShellValue(options.tmuxCommand)) {
    throw new Error("Station popup binding requires a safe resolved tmux executable.");
  }
  if (
    options.configPath !== undefined &&
    (!isAbsolute(options.configPath) || containsUnsafeShellValue(options.configPath))
  ) {
    throw new Error("Station popup binding requires a safe absolute config path.");
  }
  for (const geometry of [options.popupWidth, options.popupHeight, options.popupPosition]) {
    if (geometry !== undefined && !safeShellTokenPattern.test(geometry)) {
      throw new Error("Station popup binding requires safe popup geometry tokens.");
    }
  }
}

/**
 * ADAPTER
 *
 * Pins popup configuration and caller context to the installed alias. The alias checks its
 * current build on each invocation; the persisted binding contains no build or route decision.
 */
export function buildManagedFastPopupRunShellCommand(
  options: BuildManagedFastPopupRunShellCommandOptions,
): string {
  validateManagedBindingOptions(options);
  const { installedRoot: _installedRoot, fallbackAlias, ...request } = options;
  const serialized = JSON.stringify(ManagedPopupLaunchOptionsSchema.parse(request));
  const script =
    'trap \'exit 0\' HUP INT TERM; tmux_bin=$1; shift; "$@"; status=$?; case "$status" in 0|129) ;; *) "$tmux_bin" display-message -d 3000 \'Station popup failed; run stn popup for details\' || : ;; esac; exit 0';
  const command = [
    "sh",
    "-c",
    script,
    "station-popup-binding",
    options.tmuxCommand,
    fallbackAlias,
    "__managed-popup",
    serialized,
  ]
    .map((value) => shellQuote(value.replaceAll("#", "##")))
    .join(" ");
  return `${command} #{q:client_name} #{client_pid} #{q:client_session} >/dev/null 2>&1`;

}
