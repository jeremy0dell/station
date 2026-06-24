import { describe, expect, it } from "bun:test";
import {
  createNodePtyTerminal,
  type StationTerminalProcess,
} from "../index.js";
import { createPtyEnv } from "./nodePtyTerminal.js";

declare const Bun: {
  env: Record<string, string | undefined>;
};

describe("createPtyEnv", () => {
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
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("createNodePtyTerminal", () => {
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

        terminal = createNodePtyTerminal({
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
