import { runExternalCommand, runRuntimeBoundaryWithRetry } from "@station/runtime";
import { tmuxProviderErrorFromUnknown } from "../errors.js";
import { popupCommandInput, resolveTmuxClientSessionId } from "./command.js";
import type { TmuxPopupFocusOriginOptions, TmuxPopupShellResult } from "./types.js";

const popupShellCwdOption = "@station_shell_cwd";
const tmuxWindowIdPattern = /^@[0-9]+$/;
const shellOpenQueues = new Map<string, Promise<void>>();

function removeTerminalRecordDelimiter(output: string): string {
  if (output.endsWith("\r\n")) return output.slice(0, -2);
  if (output.endsWith("\n")) return output.slice(0, -1);
  return output;
}

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
  return removeTerminalRecordDelimiter(result.value.stdout);
}

async function serializeShellOpen<T>(key: string, effect: () => Promise<T>): Promise<T> {
  const predecessor = shellOpenQueues.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.then(() => current);
  shellOpenQueues.set(key, tail);
  await predecessor;
  try {
    return await effect();
  } finally {
    release?.();
    if (shellOpenQueues.get(key) === tail) shellOpenQueues.delete(key);
  }
}

async function openOrReuseShellWindow(
  options: TmuxPopupFocusOriginOptions,
  command: string,
  sessionId: string,
  cwd: string,
): Promise<TmuxPopupShellResult> {
  const windows = await runPopupShellCommand(
    options,
    command,
    ["list-windows", "-t", sessionId, "-F", `#{window_id}\t#{${popupShellCwdOption}}`],
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
    .find((windowId) => windowId !== undefined && tmuxWindowIdPattern.test(windowId));
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
    ["new-window", "-P", "-F", "#{window_id}", "-c", cwd, "-t", `${sessionId}:`],
    "provider.tmux.popup.openShellWindow",
  );
  if (!tmuxWindowIdPattern.test(windowId)) {
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

/**
 * Opens or reuses a cwd-bound shell window in the exact popup client's tmux session.
 * Concurrent requests for the same session and cwd serialize the list-create critical section.
 */
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
  const sessionId = await resolveTmuxClientSessionId(popupCommandInput(options, command), clientId);
  if (sessionId === undefined) {
    return { opened: false };
  }

  return serializeShellOpen(`${command}\0${sessionId}\0${cwd}`, () =>
    openOrReuseShellWindow(options, command, sessionId, cwd),
  );
}
