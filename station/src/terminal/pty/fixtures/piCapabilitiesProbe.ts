import { detectCapabilities } from "@earendil-works/pi-tui";

const value = (key: string): string => process.env[key] ?? "unset";

process.stdout.write(
  `${[
    `CAPABILITIES=${JSON.stringify(detectCapabilities(() => false))}`,
    `TERM=${value("TERM")}`,
    `COLORTERM=${value("COLORTERM")}`,
    `TERM_PROGRAM=${value("TERM_PROGRAM")}`,
    `GHOSTTY=${value("GHOSTTY_RESOURCES_DIR")}`,
    `KITTY=${value("KITTY_WINDOW_ID")}`,
    `WEZTERM=${value("WEZTERM_PANE")}`,
    `BUNDLE=${value("__CFBundleIdentifier")}`,
    `TMUX=${value("TMUX")}`,
    `TMUX_PANE=${value("TMUX_PANE")}`,
    `STATION_OUTER_TMUX=${value("STATION_OUTER_TMUX")}`,
    `STATION_OUTER_TMUX_PANE=${value("STATION_OUTER_TMUX_PANE")}`,
    `NO_COLOR=${value("NO_COLOR")}`,
    `FORCE_COLOR=${value("FORCE_COLOR")}`,
    `VSCODE_GIT_ASKPASS_MAIN=${value("VSCODE_GIT_ASKPASS_MAIN")}`,
    `CURSOR_TRACE_ID=${value("CURSOR_TRACE_ID")}`,
    `USER_SETTING=${value("USER_SETTING")}`,
  ].join("\n")}\n`,
);

if (process.argv.includes("--hold")) {
  await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
}
