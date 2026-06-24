import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createNodePtyTerminal } from "./nodePtyTerminal.js";
import { waitFor } from "../testing/waitFor.js";
import type { StationTerminalExit, StationTerminalProcess } from "../types.js";

const BRIDGE_PATH = fileURLToPath(new URL("./nodePtyBridge.cjs", import.meta.url));

const gated = (): boolean => {
  if (Bun.env.STATION_PTY_SMOKE !== "1") {
    expect(true).toEqual(true);
    return true;
  }
  return false;
};

function encodeBridgeOptions(command: string, args: string[]): string {
  return Buffer.from(
    JSON.stringify({
      args,
      cols: 80,
      command,
      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color" },
      name: "xterm-256color",
      rows: 24,
    }),
    "utf8",
  ).toString("base64url");
}

describe("nodePtyBridge hardening", () => {
  it("survives a degenerate resize and keeps serving the shell", async () => {
    if (gated()) return;
    let terminal: StationTerminalProcess | undefined;
    try {
      let received = "";
      terminal = createNodePtyTerminal({
        command: "/bin/sh",
        args: ["-c", "read line; echo got-$line"],
        size: { cols: 80, rows: 24 },
      });
      terminal.onData((data) => {
        received += data;
      });
      terminal.resize({ cols: 0, rows: 0 });
      terminal.write("alive\n");
      await waitFor(() => received.includes("got-alive"), 5_000);
    } finally {
      terminal?.dispose();
    }
  });

  it("write after exit is a silent no-op", async () => {
    if (gated()) return;
    let terminal: StationTerminalProcess | undefined;
    try {
      let exited = false;
      terminal = createNodePtyTerminal({
        command: "/bin/sh",
        args: ["-c", "exit 0"],
        size: { cols: 80, rows: 24 },
      });
      terminal.onExit(() => {
        exited = true;
      });
      await waitFor(() => exited, 5_000);
      terminal.write("after exit");
      terminal.resize({ cols: 90, rows: 30 });
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      terminal?.dispose();
    }
  });

  it("delivers the full final burst and the real exit code", async () => {
    if (gated()) return;
    let terminal: StationTerminalProcess | undefined;
    try {
      let received = "";
      let exit: StationTerminalExit | undefined;
      terminal = createNodePtyTerminal({
        command: "/bin/sh",
        args: ["-c", "head -c 100000 /dev/zero | base64; exit 7"],
        size: { cols: 80, rows: 24 },
      });
      terminal.onData((data) => {
        received += data;
      });
      terminal.onExit((event) => {
        exit = event;
      });
      await waitFor(() => exit !== undefined, 10_000);
      // base64 of 100k zero bytes is ~135k chars; truncation loses tens of KB.
      expect(received.length).toBeGreaterThan(130_000);
      expect(exit?.exitCode).toBe(7);
    } finally {
      terminal?.dispose();
    }
  });

  it("replies with an error message to garbage commands and stays alive", async () => {
    if (gated()) return;
    const bridge = spawn(process.env.STATION_NODE ?? "node", [
      BRIDGE_PATH,
      encodeBridgeOptions("/bin/sh", ["-c", "read line; echo got-$line"]),
    ]);
    try {
      let stdout = "";
      bridge.stdout.setEncoding("utf8");
      bridge.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      await waitFor(() => stdout.includes('"ready"'), 5_000);
      bridge.stdin.write("this is not json\n");
      await waitFor(() => stdout.includes('"error"'), 5_000);
      bridge.stdin.write(`${JSON.stringify({ type: "write", data: "alive\n" })}\n`);
      await waitFor(() => stdout.includes("got-alive"), 5_000);
    } finally {
      bridge.kill();
    }
  });

  it("kills the pty and exits when stdin closes", async () => {
    if (gated()) return;
    const bridge = spawn(process.env.STATION_NODE ?? "node", [
      BRIDGE_PATH,
      encodeBridgeOptions("/bin/sh", ["-c", "sleep 30"]),
    ]);
    try {
      let stdout = "";
      let exited = false;
      bridge.stdout.setEncoding("utf8");
      bridge.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      bridge.on("exit", () => {
        exited = true;
      });
      await waitFor(() => stdout.includes('"ready"'), 5_000);
      bridge.stdin.end();
      await waitFor(() => exited, 2_000);
    } finally {
      bridge.kill();
    }
  });
});
