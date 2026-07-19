import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStationChildPtyEnvironment } from "./childPtyEnvironment.js";

const PI_CAPABILITIES_PROBE = fileURLToPath(
  new URL("./fixtures/piCapabilitiesProbe.ts", import.meta.url),
);

const outerTerminalHints = {
  ALACRITTY_SOCKET: "/tmp/alacritty.sock",
  CMUX_SOCKET_PATH: "/tmp/cmux.sock",
  COLORTERM_BCE: "1",
  COLORFGBG: "15;0",
  ConEmuPID: "123",
  FORCE_HYPERLINK: "1",
  GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources/ghostty",
  GNOME_TERMINAL_SCREEN: "/org/gnome/Terminal/screen/1",
  ITERM_SESSION_ID: "w0t0p0:session",
  KITTY_WINDOW_ID: "7",
  KONSOLE_VERSION: "240800",
  LC_TERMINAL: "iTerm2",
  STY: "screen-session",
  TERMINAL_EMULATOR: "JetBrains-JediTerm",
  TERM_PROGRAM_VERSION: "9.9.9",
  TERM_SESSION_ID: "terminal-session",
  TILIX_ID: "tilix-session",
  VSCODE_INJECTION: "1",
  VTE_VERSION: "7600",
  WARP_SESSION_ID: "warp-session",
  WARP_TERMINAL_SESSION_UUID: "warp-terminal-session",
  WEZTERM_PANE: "4",
  WT_PROFILE_ID: "{profile}",
  WT_SESSION: "{session}",
  XTERM_VERSION: "XTerm(999)",
  ZELLIJ: "0",
  __CFBundleIdentifier: "com.mitchellh.ghostty",
} as const;

function definedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) {
      defined[key] = value;
    }
  }
  return defined;
}

function runPiCapabilitiesProbe(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const result = spawnSync(process.execPath, [PI_CAPABILITIES_PROBE], {
    encoding: "utf8",
    env: definedEnvironment(environment),
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}

describe("createStationChildPtyEnvironment", () => {
  it("replaces inherited and launch terminal identity with Station's", () => {
    const inherited = {
      ...outerTerminalHints,
      TERM: "xterm-ghostty",
      COLORTERM: "24bit",
      TERM_PROGRAM: "ghostty",
      STATION_PANE: "inherited",
    };
    const launch = {
      ...outerTerminalHints,
      TERM: "xterm-kitty",
      COLORTERM: "station-test-color",
      TERM_PROGRAM: "WezTerm",
      STATION_PANE: "launch",
    };
    const inheritedBefore = { ...inherited };
    const launchBefore = { ...launch };

    const child = createStationChildPtyEnvironment(inherited, launch);

    expect(child.TERM).toBe("xterm-256color");
    expect(child.COLORTERM).toBe("truecolor");
    expect(child.TERM_PROGRAM).toBe("Station");
    expect(child.STATION_PANE).toBe("1");
    for (const key of Object.keys(outerTerminalHints)) {
      expect(child[key]).toBeUndefined();
    }
    expect(inherited).toEqual(inheritedBefore);
    expect(launch).toEqual(launchBefore);
  });

  it("passes ordinary process and launch environment through with launch precedence", () => {
    const child = createStationChildPtyEnvironment(
      {
        PATH: "/usr/bin:/bin",
        HOME: "/home/station",
        LANG: "en_US.UTF-8",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        TERMINFO: "/home/station/.terminfo",
        CODEX_HOME: "/home/station/.codex",
        CURSOR_TRACE_ID: "provider-trace",
        FORCE_COLOR: "0",
        GIT_ASKPASS: "/opt/visual-studio-code/resources/app/extensions/git/dist/askpass.sh",
        NO_COLOR: "1",
        STATION_SESSION_ID: "session-1",
        USER_SETTING: "inherited",
        VSCODE_GIT_ASKPASS_MAIN:
          "/opt/visual-studio-code/resources/app/extensions/git/dist/askpass-main.js",
      },
      {
        USER_SETTING: "launch",
        PROJECT_SETTING: "enabled",
      },
    );

    expect(child).toMatchObject({
      PATH: "/usr/bin:/bin",
      HOME: "/home/station",
      LANG: "en_US.UTF-8",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      TERMINFO: "/home/station/.terminfo",
      CODEX_HOME: "/home/station/.codex",
      CURSOR_TRACE_ID: "provider-trace",
      FORCE_COLOR: "0",
      GIT_ASKPASS: "/opt/visual-studio-code/resources/app/extensions/git/dist/askpass.sh",
      NO_COLOR: "1",
      STATION_SESSION_ID: "session-1",
      USER_SETTING: "launch",
      VSCODE_GIT_ASKPASS_MAIN:
        "/opt/visual-studio-code/resources/app/extensions/git/dist/askpass-main.js",
      PROJECT_SETTING: "enabled",
    });
  });

  it("makes the real Pi detector fail closed for the reported outer-terminal environment", () => {
    const reportedEnvironment = {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "Apple_Terminal",
      GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources/ghostty",
    };
    expect(runPiCapabilitiesProbe(reportedEnvironment)).toContain(
      'CAPABILITIES={"images":"kitty","trueColor":true,"hyperlinks":true}',
    );

    const childEnvironment = createStationChildPtyEnvironment(reportedEnvironment, {
      TERM: "xterm-kitty",
      TERM_PROGRAM: "WezTerm",
      KITTY_WINDOW_ID: "7",
      WEZTERM_PANE: "4",
    });
    expect(runPiCapabilitiesProbe(childEnvironment)).toContain(
      'CAPABILITIES={"images":null,"trueColor":true,"hyperlinks":false}',
    );
  });

  it("removes direct tmux identity while preserving explicit outer-server access", () => {
    const child = createStationChildPtyEnvironment(
      {
        TMUX: "/tmp/tmux-501/origin,123,0",
        TMUX_PANE: "%3",
        STATION_OUTER_TMUX: "stale-origin",
        STATION_OUTER_TMUX_PANE: "stale-origin-pane",
        STATION_PANE: "inherited",
      },
      {
        TMUX: "/tmp/tmux-501/launch,456,0",
        TMUX_PANE: "%7",
        STATION_OUTER_TMUX: "stale-launch",
        STATION_OUTER_TMUX_PANE: "stale-launch-pane",
        STATION_PANE: "launch",
      },
    );

    expect(child.TMUX).toBeUndefined();
    expect(child.TMUX_PANE).toBeUndefined();
    expect(child.STATION_OUTER_TMUX).toBe("/tmp/tmux-501/launch,456,0");
    expect(child.STATION_OUTER_TMUX_PANE).toBe("%7");
    expect(child.STATION_PANE).toBe("1");
  });

  it("clears stale outer-tmux access when no complete direct tmux context exists", () => {
    const child = createStationChildPtyEnvironment({
      TMUX: "/tmp/tmux-501/incomplete,123,0",
      STATION_OUTER_TMUX: "stale",
      STATION_OUTER_TMUX_PANE: "stale-pane",
    });

    expect(child.TMUX).toBeUndefined();
    expect(child.STATION_OUTER_TMUX).toBeUndefined();
    expect(child.STATION_OUTER_TMUX_PANE).toBeUndefined();
  });
});
