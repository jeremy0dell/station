import { describe, expect, it } from "bun:test";
import type { StationTerminalProcess } from "../types.js";
import {
  createLocalPtyTerminal,
  createPtyEnv,
  resolvePtyImplementation,
} from "./localPtyTerminal.js";

declare const Bun: {
  env: Record<string, string | undefined>;
};

describe("createPtyEnv", () => {
  it("marks inherited and launch environments as Station-owned panes", () => {
    const previousStationPane = process.env.STATION_PANE;
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    try {
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      for (const inherited of ["0", "", undefined]) {
        restoreEnv("STATION_PANE", inherited);
        expect(createPtyEnv(undefined).STATION_PANE).toBe("1");
      }

      process.env.STATION_PANE = "inherited";
      for (const launchStationPane of ["0", "", undefined]) {
        expect(createPtyEnv({ STATION_PANE: launchStationPane }).STATION_PANE).toBe("1");
      }

      process.env.TMUX = "/tmp/tmux-501/origin,123,0";
      process.env.TMUX_PANE = "%3";
      expect(createPtyEnv(undefined).STATION_PANE).toBe(
        JSON.stringify(["/tmp/tmux-501/origin,123,0", "%3"]),
      );
      expect(
        createPtyEnv({
          STATION_PANE: "0",
          TMUX: "/tmp/tmux-501/launch,456,0",
          TMUX_PANE: "%7",
        }).STATION_PANE,
      ).toBe(JSON.stringify(["/tmp/tmux-501/launch,456,0", "%7"]));
    } finally {
      restoreEnv("STATION_PANE", previousStationPane);
      restoreEnv("TMUX", previousTmux);
      restoreEnv("TMUX_PANE", previousTmuxPane);
    }
  });

  it("commits to color-capable defaults and strips color-suppressing vars", () => {
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "0";
    try {
      // A NO_COLOR/FORCE_COLOR leaked into the host's own env must not reach panes.
      const inherited = createPtyEnv(undefined);
      expect(inherited.NO_COLOR).toBeUndefined();
      expect(inherited.FORCE_COLOR).toBeUndefined();
      expect(inherited.COLORTERM).toEqual("truecolor");
      expect(inherited.TERM).toBeDefined();

      // ...and an explicit per-spawn env carrying them is sanitized too.
      const explicit = createPtyEnv({ NO_COLOR: "1", FORCE_COLOR: "0", TERM: "screen-256color" });
      expect(explicit.NO_COLOR).toBeUndefined();
      expect(explicit.FORCE_COLOR).toBeUndefined();
      expect(explicit.TERM).toEqual("screen-256color");
    } finally {
      restoreEnv("NO_COLOR", previousNoColor);
      restoreEnv("FORCE_COLOR", previousForceColor);
    }
  });

  it("treats empty terminal capability values as absent", () => {
    const previousTerm = process.env.TERM;
    const previousColorTerm = process.env.COLORTERM;
    process.env.TERM = "";
    process.env.COLORTERM = "";
    try {
      const env = createPtyEnv({ TERM: "", COLORTERM: "" });
      expect(env.TERM).toBe("xterm-256color");
      expect(env.COLORTERM).toBe("truecolor");
    } finally {
      restoreEnv("TERM", previousTerm);
      restoreEnv("COLORTERM", previousColorTerm);
    }
  });
});

describe("resolvePtyImplementation", () => {
  it("keeps the bridge as the default", () => {
    expect(resolvePtyImplementation(undefined)).toBe("bridge");
    expect(resolvePtyImplementation("")).toBe("bridge");
    expect(resolvePtyImplementation("bridge")).toBe("bridge");
  });

  it("allows compiled startup to supply Bun as the default", () => {
    expect(resolvePtyImplementation(undefined, "bun")).toBe("bun");
    expect(resolvePtyImplementation("", "bun")).toBe("bun");
    expect(resolvePtyImplementation("bridge", "bun")).toBe("bridge");
  });

  it("accepts the two explicit Bun modes", () => {
    expect(resolvePtyImplementation("bun")).toBe("bun");
    expect(resolvePtyImplementation("bun-nocctty")).toBe("bun-nocctty");
  });

  it("rejects unsupported values", () => {
    expect(() => resolvePtyImplementation("auto")).toThrow(
      /Unsupported STATION_PTY_IMPL value "auto"/,
    );
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("createLocalPtyTerminal", () => {
  it("surfaces an unsupported selector value in the spawn error", () => {
    const previous = process.env.STATION_PTY_IMPL;
    process.env.STATION_PTY_IMPL = "auto";
    try {
      expect(() => createLocalPtyTerminal({ command: "/bin/true" })).toThrow(
        /Unsupported STATION_PTY_IMPL value "auto"/,
      );
    } finally {
      restoreEnv("STATION_PTY_IMPL", previous);
    }
  });

  it("spawns a command in a pty when the smoke probe is enabled", async () => {
    if (Bun.env.STATION_PTY_SMOKE !== "1") {
      expect(true).toEqual(true);
      return;
    }

    const expected = "station-node-pty-ready";
    let terminal: StationTerminalProcess | undefined;

    try {
      const output = await new Promise<string>((resolve, reject) => {
        let settled = false;
        let received = "";
        let timeout: ReturnType<typeof setTimeout> | undefined;

        const fail = (error: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
          reject(error);
        };

        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
          resolve(received);
        };

        timeout = setTimeout(() => {
          fail(new Error("Timed out waiting for node-pty output."));
        }, 2_000);

        terminal = createLocalPtyTerminal({
          args: ["-lc", `printf ${expected}`],
          command: "/bin/sh",
          size: {
            cols: 80,
            rows: 24,
          },
        });

        terminal.onData((data) => {
          received += data;
          if (received.includes(expected)) {
            finish();
          }
        });

        terminal.onExit((event) => {
          if (received.includes(expected)) {
            finish();
            return;
          }

          fail(
            new Error(
              `PTY exited before expected output: ${JSON.stringify(event)}`,
            ),
          );
        });
      });

      expect(output.includes(expected)).toEqual(true);
    } finally {
      terminal?.dispose();
    }
  });
});
