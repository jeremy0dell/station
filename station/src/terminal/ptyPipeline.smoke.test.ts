import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createLocalPtyTerminal } from "./pty/localPtyTerminal.js";
import { spanAtColumn, visibleRowText } from "./testing/vtAssert.js";
import { waitFor } from "./testing/waitFor.js";
import type { StationTerminalProcess } from "./types.js";
import { createStationVtScreen, type StationVtScreen } from "./vt/screen.js";

const PI_CAPABILITIES_PROBE = fileURLToPath(
  new URL("./pty/fixtures/piCapabilitiesProbe.ts", import.meta.url),
);

const gated = (): boolean => {
  if (Bun.env.STATION_PTY_SMOKE !== "1") {
    expect(true).toEqual(true);
    return true;
  }
  return false;
};

type Pipeline = {
  terminal: StationTerminalProcess;
  screen: StationVtScreen;
  dispose(): void;
};

/** The production wiring: real bridge pty feeding a real vt screen. */
function startArgvPipeline(
  command: string,
  args: readonly string[],
  size = { cols: 80, rows: 24 },
  env: Readonly<Record<string, string | undefined>> = {},
): Pipeline {
  const screen = createStationVtScreen({
    size,
    onResponse: (data) => {
      terminal.write(data);
    },
  });
  const terminal = createLocalPtyTerminal({
    command,
    args,
    size,
    env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", ...env },
  });
  terminal.onData((data) => {
    screen.feed(data);
  });
  return {
    terminal,
    screen,
    dispose: () => {
      terminal.dispose();
      screen.dispose();
    },
  };
}

function startPipeline(
  command: string,
  size = { cols: 80, rows: 24 },
  env: Readonly<Record<string, string | undefined>> = {},
): Pipeline {
  return startArgvPipeline("/bin/sh", ["-c", command], size, env);
}

function someRowIncludes(screen: StationVtScreen, needle: string): number {
  for (let row = 0; row < screen.bufferStats().rows; row++) {
    if (visibleRowText(screen, row).includes(needle)) {
      return row;
    }
  }
  return -1;
}

describe("pty pipeline smoke", () => {
  it("real shell sgr output lands styled in the vt screen", async () => {
    if (gated()) return;
    const pipeline = startPipeline("printf '\\033[31mSMOKE-RED\\033[0m\\n'");
    try {
      await waitFor(() => someRowIncludes(pipeline.screen, "SMOKE-RED") >= 0, 5_000);
      const row = someRowIncludes(pipeline.screen, "SMOKE-RED");
      const col = visibleRowText(pipeline.screen, row).indexOf("SMOKE-RED");
      const span = spanAtColumn(pipeline.screen, row, col);
      expect(span?.fg).toBe("#cd3131");
    } finally {
      pipeline.dispose();
    }
  });

  it("the real Pi detector sees only Station-owned terminal capabilities", async () => {
    if (gated()) return;
    const pipeline = startArgvPipeline(
      process.execPath,
      [PI_CAPABILITIES_PROBE],
      { cols: 80, rows: 24 },
      {
        TERM: "xterm-kitty",
        COLORTERM: "station-test-color",
        TERM_PROGRAM: "ghostty",
        GHOSTTY_RESOURCES_DIR: "/ghostty",
        KITTY_WINDOW_ID: "7",
        WEZTERM_PANE: "4",
        __CFBundleIdentifier: "com.mitchellh.ghostty",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        CURSOR_TRACE_ID: "provider-trace",
        VSCODE_GIT_ASKPASS_MAIN: "/opt/vscode/askpass-main.js",
        TMUX: "/tmp/tmux-501/renderer,123,0",
        TMUX_PANE: "%7",
        USER_SETTING: "ordinary",
      },
    );
    try {
      await waitFor(() => someRowIncludes(pipeline.screen, "USER_SETTING=ordinary") >= 0, 5_000);
      for (const expected of [
        'CAPABILITIES={"images":null,"trueColor":true,"hyperlinks":false}',
        "TERM=xterm-256color",
        "COLORTERM=truecolor",
        "TERM_PROGRAM=Station",
        "GHOSTTY=unset",
        "KITTY=unset",
        "WEZTERM=unset",
        "BUNDLE=unset",
        "NO_COLOR=1",
        "FORCE_COLOR=0",
        "VSCODE_GIT_ASKPASS_MAIN=/opt/vscode/askpass-main.js",
        "CURSOR_TRACE_ID=provider-trace",
        "STATION_OUTER_TMUX=/tmp/tmux-501/renderer,123,0",
        "STATION_OUTER_TMUX_PANE=%7",
        "USER_SETTING=ordinary",
      ]) {
        expect(someRowIncludes(pipeline.screen, expected)).toBeGreaterThanOrEqual(0);
      }
    } finally {
      pipeline.dispose();
    }
  });

  it("the child process sees the spawn size", async () => {
    if (gated()) return;
    const pipeline = startPipeline("stty size", { cols: 100, rows: 40 });
    try {
      await waitFor(() => someRowIncludes(pipeline.screen, "40 100") >= 0, 5_000);
    } finally {
      pipeline.dispose();
    }
  });

  it("a live resize reaches the child", async () => {
    if (gated()) return;
    const pipeline = startPipeline("sleep 0.4; stty size", { cols: 100, rows: 40 });
    try {
      pipeline.terminal.resize({ cols: 90, rows: 30 });
      pipeline.screen.resize({ cols: 90, rows: 30 });
      await waitFor(() => someRowIncludes(pipeline.screen, "30 90") >= 0, 5_000);
    } finally {
      pipeline.dispose();
    }
  });

  it("alt-screen bytes from a real process round-trip", async () => {
    if (gated()) return;
    const pipeline = startPipeline(
      "printf '\\033[?1049hALT-CONTENT'; sleep 0.2; printf '\\033[?1049lBACK'",
    );
    try {
      await waitFor(() => someRowIncludes(pipeline.screen, "BACK") >= 0, 5_000);
      expect(pipeline.screen.isAltScreen()).toBe(false);
    } finally {
      pipeline.dispose();
    }
  });

  // Real third-party TUI run; extra-gated because vi availability and
  // variant behavior differ per machine.
  it("vi enters and exits the alt screen", async () => {
    if (gated()) return;
    if (Bun.env.STATION_PTY_SMOKE_TUI !== "1") {
      expect(true).toEqual(true);
      return;
    }
    let sawAlt = false;
    const pipeline = startPipeline("vi -c q || true");
    try {
      // Flush-tick sampling can miss a fast enter/exit; the buffer-change
      // event fires on every switch.
      pipeline.screen.unsafeEngine.buffer.onBufferChange((buffer) => {
        if (buffer.type === "alternate") {
          sawAlt = true;
        }
      });
      await waitFor(
        () => sawAlt && !pipeline.screen.isAltScreen(),
        10_000,
      );
    } finally {
      pipeline.dispose();
    }
  });
});
