import { runExternalCommand, runRuntimeBoundaryWithRetry } from "@station/runtime";
import { tmuxProviderErrorFromUnknown } from "../errors.js";
import { popupCommandInput, resolveTmuxClientSession } from "./command.js";
import type { TmuxPopupFocusOriginOptions, TmuxPopupShellResult } from "./types.js";

const popupShellCwdOption = "@station_shell_cwd";
const safeTmuxCommandTokenPattern = /^[A-Za-z0-9_@%+=,./:-]+$/;

async function runPopupShellCommand(
  options: TmuxPopupFocusOriginOptions,
  command: string,
  args: string[],
  operation: string,
): Promise<string> {
  const result = await runRuntimeBoundaryWithRetry(
    {
      operation,
      error: {
        tag: "TerminalProviderError",
        code: "TERMINAL_OPEN_FAILED",
        message: "tmux failed to open the requested shell.",
        provider: "tmux",
      },
      retry: { retries: 0 },
    },
    ({ signal }) =>
      runExternalCommand(
        {
          command,
          args,
          signal,
          maxOutputChars: 64 * 1024,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
        options.runner,
      ),
  );
  if (!result.ok) {
    throw tmuxProviderErrorFromUnknown(result.error, {
      code: "TERMINAL_OPEN_FAILED",
      message: "tmux failed to open the requested shell.",
    });
  }
  return result.value.stdout.trim();
}

/** Opens or reuses a cwd-bound shell window in the exact popup client's tmux session. */
export async function openPopupShellForClient(
  options: TmuxPopupFocusOriginOptions,
  command: string,
  clientId: string,
  cwd: string,
): Promise<TmuxPopupShellResult> {
  const invalidCwdCharacters = [0, 9, 10, 13].map((code) => String.fromCharCode(code));
  if (cwd.length === 0 || invalidCwdCharacters.some((character) => cwd.includes(character))) {
    throw tmuxProviderErrorFromUnknown(new Error("invalid shell working directory"), {
      code: "TERMINAL_OPEN_FAILED",
      message: "tmux could not open the requested shell working directory.",
    });
  }
  const sessionName = await resolveTmuxClientSession(popupCommandInput(options, command), clientId);
  if (sessionName === undefined || !safeTmuxCommandTokenPattern.test(sessionName)) {
    return { opened: false };
  }

  const windows = await runPopupShellCommand(
    options,
    command,
    ["list-windows", "-t", sessionName, "-F", `#{window_id}\t#{${popupShellCwdOption}}`],
    "provider.tmux.popup.listShellWindows",
  );
  const existingWindowId = windows
    .split("\n")
    .map((line) => {
      const separator = line.indexOf("\t");
      return separator >= 0 && line.slice(separator + 1) === cwd
        ? line.slice(0, separator)
        : undefined;
    })
    .find((windowId) => windowId !== undefined && safeTmuxCommandTokenPattern.test(windowId));
  if (existingWindowId !== undefined) {
    await runPopupShellCommand(
      options,
      command,
      ["select-window", "-t", existingWindowId],
      "provider.tmux.popup.focusShellWindow",
    );
    return { opened: true };
  }

  const windowId = await runPopupShellCommand(
    options,
    command,
    ["new-window", "-P", "-F", "#{window_id}", "-c", cwd, "-t", `${sessionName}:`],
    "provider.tmux.popup.openShellWindow",
  );
  if (!safeTmuxCommandTokenPattern.test(windowId)) {
    return { opened: false };
  }
  try {
    await runPopupShellCommand(
      options,
      command,
      ["set-option", "-w", "-t", windowId, popupShellCwdOption, cwd],
      "provider.tmux.popup.bindShellWindow",
    );
  } catch (error) {
    await runPopupShellCommand(
      options,
      command,
      ["kill-window", "-t", windowId],
      "provider.tmux.popup.rollbackShellWindow",
    ).catch(() => undefined);
    throw error;
  }
  return { opened: true };
}
