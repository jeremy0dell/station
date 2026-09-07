import { shellQuote } from "../shell.js";
import {
  type ManagedPopupLaunchOptions,
  ManagedPopupLaunchOptionsSchema,
  validateManagedPopupLaunchOptions,
} from "./launchRequest.js";

/**
 * ADAPTER
 *
 * Pins popup configuration and caller context to the installed alias. The alias checks its
 * current build on each invocation; the persisted binding contains no build or route decision.
 */
export function buildManagedFastPopupRunShellCommand(options: ManagedPopupLaunchOptions): string {
  validateManagedPopupLaunchOptions(options);
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
