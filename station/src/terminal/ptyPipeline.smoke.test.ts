import { describe, expect, it } from "bun:test";
import { createLocalPtyTerminal } from "./pty/localPtyTerminal.js";
import { spanAtColumn, visibleRowText } from "./testing/vtAssert.js";
import { waitFor } from "./testing/waitFor.js";
import type { StationTerminalProcess } from "./types.js";
import { createStationVtScreen, type StationVtScreen } from "./vt/screen.js";

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
function startPipeline(command: string, size = { cols: 80, rows: 24 }): Pipeline {
  const screen = createStationVtScreen({
    size,
    onResponse: (data) => {
      terminal.write(data);
    },
  });
  const terminal = createLocalPtyTerminal({
    command: "/bin/sh",
    args: ["-c", command],
    size,
    env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
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
