import { type ExternalCommandRunner, runExternalCommand } from "@station/runtime";

// tmux before 3.8 can open its button-3 menu while a popup reports mouse movement;
// tmux/tmux@ad6832e, first released in 3.8, attaches menus to the window instead.
const firstMovementSafeTmux = { major: 3, minor: 8 };

/** Accepts release versions such as `3.8`, `3.8a`, and `next-3.9`; other builds stay click-only. */
export function tmuxVersionSupportsPopupMouseMovement(version: string): boolean {
  const match = /^(?:next-)?(\d+)\.(\d+)[a-z]?$/.exec(version.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (
    major > firstMovementSafeTmux.major ||
    (major === firstMovementSafeTmux.major && minor >= firstMovementSafeTmux.minor)
  );
}

/** Asks the tmux server hosting the popup for its version; any failure keeps click-only input. */
export async function popupTmuxSupportsMouseMovement(options: {
  command: string;
  runner?: ExternalCommandRunner;
}): Promise<boolean> {
  try {
    const output = await runExternalCommand(
      {
        command: options.command,
        args: ["display-message", "-p", "#{version}"],
        timeoutMs: 1000,
        maxOutputChars: 256,
      },
      options.runner,
    );
    return tmuxVersionSupportsPopupMouseMovement(output.stdout);
  } catch {
    return false;
  }
}
