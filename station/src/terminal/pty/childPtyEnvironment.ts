export const STATION_CHILD_TERMINAL_ENV = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  TERM_PROGRAM: "Station",
} as const;

const OUTER_TERMINAL_ENVIRONMENT_KEYS = new Set([
  "COLORTERM_BCE",
  "COLORFGBG",
  "COLUMNS",
  "FORCE_COLOR",
  "FORCE_HYPERLINK",
  "FORCE_HYPERLINKS",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "LINES",
  "MSYSCON",
  "NO_COLOR",
  "SHELL_SESSION_ID",
  "STY",
  "TERMCAP",
  "TERMINAL_EMULATOR",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "VSCODE_INJECTION",
  "VSCODE_NONCE",
  "VSCODE_PID",
  "VSCODE_SHELL_INTEGRATION",
  "VTE_VERSION",
  "WINDOW",
  "WINDOWID",
  "WT_PROFILE_ID",
  "WT_SESSION",
  "XTERM_VERSION",
  "ZELLIJ",
  "ZELLIJ_PANE_ID",
]);

const OUTER_TERMINAL_ENVIRONMENT_PREFIXES = [
  "ALACRITTY_",
  "CMUX_",
  "ConEmu",
  "GHOSTTY_",
  "GNOME_TERMINAL_",
  "ITERM_",
  "KITTY_",
  "KONSOLE_",
  "TILIX_",
  "WARP_",
  "WEZTERM_",
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Builds the environment for a Station-rendered child PTY without mutating the
 * outer renderer environment; ordinary launch values pass through, while
 * Station-owned terminal identity is applied after outer-only hints are removed.
 */
export function createStationChildPtyEnvironment(
  inheritedEnvironment: Environment,
  launchEnvironment?: Environment,
): Record<string, string | undefined> {
  const childEnvironment: Record<string, string | undefined> = {
    ...inheritedEnvironment,
    ...launchEnvironment,
  };
  const tmux = childEnvironment.TMUX;
  const tmuxPane = childEnvironment.TMUX_PANE;

  for (const key of Object.keys(childEnvironment)) {
    if (isOuterTerminalEnvironmentKey(key)) {
      delete childEnvironment[key];
    }
  }

  Object.assign(childEnvironment, STATION_CHILD_TERMINAL_ENV);

  // TMUX remains a connectivity channel and STATION_PANE binding, not evidence of Station's renderer.
  childEnvironment.STATION_PANE =
    tmux !== undefined && tmuxPane !== undefined ? JSON.stringify([tmux, tmuxPane]) : "1";

  return childEnvironment;
}

function isOuterTerminalEnvironmentKey(key: string): boolean {
  return (
    OUTER_TERMINAL_ENVIRONMENT_KEYS.has(key) ||
    OUTER_TERMINAL_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}
