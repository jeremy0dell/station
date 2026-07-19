export const STATION_CHILD_TERMINAL_ENV = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  TERM_PROGRAM: "Station",
} as const;

/**
 * Curated outer-renderer signals, not an exhaustive environment registry.
 * Functional provider, authentication, and user-preference values deliberately pass through.
 */
const KNOWN_OUTER_TERMINAL_ENVIRONMENT_KEYS = new Set([
  "__CFBundleIdentifier",
  "COLORTERM_BCE",
  "COLORFGBG",
  "COLUMNS",
  "FORCE_HYPERLINK",
  "FORCE_HYPERLINKS",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "LINES",
  "MSYSCON",
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

const KNOWN_OUTER_TERMINAL_ENVIRONMENT_PREFIXES = [
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
 * outer renderer environment; ordinary launch values, including authentication,
 * provider context, and color preferences, pass through. Station-owned terminal
 * identity is applied after known outer-only hints are removed.
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

  // TMUX claims the child is rendered by tmux, so keep outer-server access only
  // under Station-owned names that capability probes do not treat as terminal identity.
  delete childEnvironment.TMUX;
  delete childEnvironment.TMUX_PANE;
  if (tmux !== undefined && tmuxPane !== undefined) {
    childEnvironment.STATION_OUTER_TMUX = tmux;
    childEnvironment.STATION_OUTER_TMUX_PANE = tmuxPane;
  } else {
    delete childEnvironment.STATION_OUTER_TMUX;
    delete childEnvironment.STATION_OUTER_TMUX_PANE;
  }
  childEnvironment.STATION_PANE = "1";

  return childEnvironment;
}

function isOuterTerminalEnvironmentKey(key: string): boolean {
  return (
    KNOWN_OUTER_TERMINAL_ENVIRONMENT_KEYS.has(key) ||
    KNOWN_OUTER_TERMINAL_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}
