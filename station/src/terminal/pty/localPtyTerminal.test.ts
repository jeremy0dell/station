import { describe, expect, it } from "bun:test";
import type { StationTerminalProcess } from "../types.js";
import { createLocalPtyTerminal, resolvePtyImplementation } from "./localPtyTerminal.js";

declare const Bun: {
  env: Record<string, string | undefined>;
};

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

  it("passes Station-owned capabilities to a real child when the smoke probe is enabled", async () => {
    if (Bun.env.STATION_PTY_SMOKE !== "1") {
      expect(true).toEqual(true);
      return;
    }

    const expected = "xterm-256color|truecolor|Station|unset|unset|ordinary";
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
          args: [
            "-c",
            'printf "%s|%s|%s|%s|%s|%s" "$TERM" "$COLORTERM" "$TERM_PROGRAM" "${GHOSTTY_RESOURCES_DIR-unset}" "${KITTY_WINDOW_ID-unset}" "$USER_SETTING"',
          ],
          command: "/bin/sh",
          env: {
            TERM: "xterm-kitty",
            COLORTERM: "station-test-color",
            TERM_PROGRAM: "ghostty",
            GHOSTTY_RESOURCES_DIR: "/ghostty",
            KITTY_WINDOW_ID: "7",
            USER_SETTING: "ordinary",
          },
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
