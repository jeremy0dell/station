import { describe, expect, it } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "../../testing/waitFor.js";
import { PtyBridgeProtocolVersion } from "@station/contracts";
import { adoptLocalPtyBridge } from "../ptyBridgeAdoption.js";

const BRIDGE_PATH = fileURLToPath(new URL("../localPtyBridge.cjs", import.meta.url));
const PTY_INSTANCE_ID = "instance-1";

const gated = (): boolean => {
  if (Bun.env.STATION_PTY_SMOKE !== "1") {
    expect(true).toEqual(true);
    return true;
  }
  return false;
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error("waitForAsync timed out");
    }
    await delay(20);
  }
}

type OrphanSpawn = {
  bridge: ChildProcessWithoutNullStreams;
  controlSocketPath: string;
  parkStatePath: string;
  dir: string;
  stdout: () => string;
};

async function spawnOrphanBridge(
  command: string,
  args: string[],
  ttlMs = 60_000,
  orphanOverrides: Record<string, unknown> = {},
): Promise<OrphanSpawn> {
  const dir = await mkdtemp(join(tmpdir(), "station-orphan-"));
  const orphan = {
    controlSocketPath: join(dir, "pty-1.sock"),
    parkStatePath: join(dir, "pty-1.park.json"),
    ttlMs,
    ptyInstanceId: PTY_INSTANCE_ID,
    identity: {
      kind: "agent",
      terminalTargetId: "native:wt-orphan",
      worktreeId: "wt-orphan",
      projectId: "proj-orphan",
      sessionId: "ses-orphan",
      worktreePath: process.cwd(),
      harnessProvider: "scripted",
    },
    ...orphanOverrides,
  };
  const bridge = spawn(process.env.STATION_NODE ?? "node", [
    BRIDGE_PATH,
    Buffer.from(
      JSON.stringify({
        args,
        // Mirrors the production spawn, which always sends the owner's version.
        bridgeProtocol: PtyBridgeProtocolVersion,
        cols: 80,
        command,
        cwd: process.cwd(),
        env: { ...process.env, TERM: "xterm-256color" },
        name: "xterm-256color",
        rows: 24,
        orphan,
      }),
      "utf8",
    ).toString("base64url"),
  ]);
  let stdout = "";
  bridge.stdout.setEncoding("utf8");
  bridge.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  return {
    bridge,
    controlSocketPath: String(orphan.controlSocketPath),
    parkStatePath: String(orphan.parkStatePath),
    dir,
    stdout: () => stdout,
  };
}

async function cleanup(spawned: OrphanSpawn): Promise<void> {
  spawned.bridge.kill();
  await rm(spawned.dir, { recursive: true, force: true });
}

async function waitForReady(spawned: OrphanSpawn): Promise<void> {
  await waitFor(() => spawned.stdout().includes('"ready"'), 5_000);
}

async function park(spawned: OrphanSpawn): Promise<void> {
  spawned.bridge.stdin.end();
  await waitFor(() => existsSync(spawned.controlSocketPath), 5_000);
}

function connectControl(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

type LineCollector = {
  lines: string[];
  waitForLine(predicate: (line: string) => boolean, timeoutMs?: number): Promise<string>;
};

function readLines(socket: net.Socket): LineCollector {
  const lines: string[] = [];
  let buffer = "";
  const waiters: Array<{
    predicate: (line: string) => boolean;
    resolve: (line: string) => void;
  }> = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) {
        return;
      }
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      lines.push(line);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i];
        if (waiter !== undefined && waiter.predicate(line)) {
          waiters.splice(i, 1);
          waiter.resolve(line);
        }
      }
    }
  });
  return {
    lines,
    waitForLine(predicate, timeoutMs = 5_000) {
      const existing = lines.find(predicate);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Timed out waiting for a bridge control line."));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      });
    },
  };
}

function send(socket: net.Socket, command: object): void {
  socket.write(`${JSON.stringify(command)}\n`);
}

async function adoptRaw(socketPath: string): Promise<{ socket: net.Socket; reader: LineCollector }> {
  const socket = await connectControl(socketPath);
  const reader = readLines(socket);
  send(socket, { type: "adopt", ptyInstanceId: PTY_INSTANCE_ID });
  await reader.waitForLine((line) => line.includes('"status"'));
  return { socket, reader };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("localPtyBridge orphan mode", () => {
  it("parks on owner EOF and answers exit-status until adopted", async () => {
    if (gated()) return;
    const spawned = await spawnOrphanBridge("/bin/sh", ["-c", "sleep 30"]);
    try {
      await waitForReady(spawned);
      await park(spawned);
      const probe = await connectControl(spawned.controlSocketPath);
      const probeReader = readLines(probe);
      send(probe, { type: "exit-status" });
      const statusLine = await probeReader.waitForLine((line) => line.includes('"status"'));
      const status = JSON.parse(statusLine);
      expect(status.exited).toEqual(false);
      expect(status.adopted).toEqual(false);
      expect(status.bridgeProtocol).toEqual(PtyBridgeProtocolVersion);
      expect(typeof status.pid).toEqual("number");
      probe.destroy();
    } finally {
      await cleanup(spawned);
    }
  });

  it("restores write, resize, and kill through adoption", async () => {
    if (gated()) return;
    const spawned = await spawnOrphanBridge("/bin/sh", [
      "-c",
      "read line; echo got-$line; sleep 30",
    ]);
    try {
      await waitForReady(spawned);
      await park(spawned);
      const { socket, reader } = await adoptRaw(spawned.controlSocketPath);
      send(socket, { type: "write", data: "alive\n" });
      await reader.waitForLine((line) => line.includes("got-alive"));
      send(socket, { type: "resize", cols: 101, rows: 31 });
      // Geometry persists into the durable park state even mid-adoption.
      await waitForAsync(async () => {
        const state = JSON.parse(await readFile(spawned.parkStatePath, "utf8"));
        return state.cols === 101 && state.rows === 31;
      }, 5_000);
      send(socket, { type: "kill" });
      await reader.waitForLine((line) => line.includes('"exit"'));
      socket.destroy();
      await waitFor(() => !existsSync(spawned.controlSocketPath), 5_000);
    } finally {
      await cleanup(spawned);
    }
  });

  it("flushes the parked output backlog on adoption", async () => {
    if (gated()) return;
    const spawned = await spawnOrphanBridge("/bin/sh", [
      "-c",
      "sleep 0.3; echo parked-output; sleep 30",
    ]);
    try {
      await waitForReady(spawned);
      await park(spawned);
      await delay(600);
      const { socket, reader } = await adoptRaw(spawned.controlSocketPath);
      await reader.waitForLine((line) => line.includes("parked-output"));
      send(socket, { type: "kill" });
      socket.destroy();
    } finally {
      await cleanup(spawned);
    }
  });

  it("keeps the PTY alive across an owner SIGKILL and serves a typed adoption", async () => {
    if (gated()) return;
    const dir = await mkdtemp(join(tmpdir(), "station-orphan-owner-"));
    const controlSocketPath = join(dir, "pty-1.sock");
    const parkStatePath = join(dir, "pty-1.park.json");
    const bridgeOptions = Buffer.from(
      JSON.stringify({
        args: ["-c", "read line; echo got-$line; sleep 30"],
        cols: 80,
        command: "/bin/sh",
        cwd: process.cwd(),
        env: { ...process.env, TERM: "xterm-256color" },
        name: "xterm-256color",
        rows: 24,
        orphan: {
          controlSocketPath,
          parkStatePath,
          ttlMs: 60_000,
          ptyInstanceId: PTY_INSTANCE_ID,
          identity: {
            kind: "agent",
            terminalTargetId: "native:wt-owner",
            worktreeId: "wt-owner",
            projectId: "proj-owner",
            sessionId: "ses-owner",
            worktreePath: process.cwd(),
            harnessProvider: "scripted",
          },
        },
      }),
      "utf8",
    ).toString("base64url");
    // The owner only holds the bridge's stdin pipe; SIGKILL closes it, which is
    // exactly the EOF the bridge parks on.
    const owner = spawn(process.env.STATION_NODE ?? "node", [
      "-e",
      `const { spawn } = require("node:child_process");
       const child = spawn(process.execPath, process.argv.slice(1), { stdio: ["pipe", "inherit", "inherit"] });
       child.on("exit", () => process.exit(0));
       setInterval(() => {}, 1000);`,
      BRIDGE_PATH,
      bridgeOptions,
    ]);
    let ownerStdout = "";
    owner.stdout.setEncoding("utf8");
    owner.stdout.on("data", (chunk: string) => {
      ownerStdout += chunk;
    });
    try {
      await waitFor(() => ownerStdout.includes('"ready"'), 5_000);
      owner.kill("SIGKILL");
      await waitFor(() => existsSync(controlSocketPath), 5_000);

      const terminal = await adoptLocalPtyBridge({
        id: "pty-1",
        ptyInstanceId: PTY_INSTANCE_ID,
        command: "/bin/sh",
        controlSocketPath,
        size: { cols: 80, rows: 24 },
      });
      try {
        let received = "";
        terminal.onData((data) => {
          received += data;
        });
        let exited = false;
        terminal.onExit(() => {
          exited = true;
        });
        terminal.write("back-from-the-dead\n");
        await waitFor(() => received.includes("got-back-from-the-dead"), 5_000);
        terminal.resize({ cols: 90, rows: 25 });
        expect(terminal.size).toEqual({ cols: 90, rows: 25 });
        expect(processAlive(terminal.pid)).toEqual(true);
        terminal.kill();
        await waitFor(() => exited, 5_000);
      } finally {
        terminal.dispose();
      }
      await waitFor(() => !existsSync(controlSocketPath), 5_000);
    } finally {
      owner.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("re-parks with a fresh epoch when the adopter dies without disposing", async () => {
    if (gated()) return;
    const spawned = await spawnOrphanBridge("/bin/sh", ["-c", "sleep 30"]);
    try {
      await waitForReady(spawned);
      await park(spawned);
      const first = await adoptRaw(spawned.controlSocketPath);
      // Abrupt EOF without a kill: the PTY must park again, not die.
      first.socket.destroy();
      await waitForAsync(async () => {
        const probe = await connectControl(spawned.controlSocketPath);
        const reader = readLines(probe);
        send(probe, { type: "exit-status" });
        const line = await reader.waitForLine((l) => l.includes('"status"'));
        probe.destroy();
        return JSON.parse(line).adopted === false;
      }, 5_000);

      const second = await adoptRaw(spawned.controlSocketPath);
      send(second.socket, { type: "kill" });
      await second.reader.waitForLine((line) => line.includes('"exit"'));
      second.socket.destroy();
      await waitFor(() => !existsSync(spawned.controlSocketPath), 5_000);
    } finally {
      await cleanup(spawned);
    }
  });

  it("refuses a second adopter while the bridge is owned", async () => {
    if (gated()) return;
    const spawned = await spawnOrphanBridge("/bin/sh", ["-c", "sleep 30"]);
    try {
      await waitForReady(spawned);
      await park(spawned);
      const first = await adoptRaw(spawned.controlSocketPath);
      const second = await connectControl(spawned.controlSocketPath);
      const secondReader = readLines(second);
      send(second, { type: "adopt", ptyInstanceId: PTY_INSTANCE_ID });
      const errorLine = await secondReader.waitForLine((line) => line.includes("ALREADY_ADOPTED"));
      expect(JSON.parse(errorLine).type).toEqual("error");
      second.destroy();
      send(first.socket, { type: "kill" });
      first.socket.destroy();
      await waitFor(() => !existsSync(spawned.controlSocketPath), 5_000);
    } finally {
      await cleanup(spawned);
    }
  });

  it("leaves the bridge parked when an adopter names the wrong PTY instance", async () => {
    if (gated()) return;
    const spawned = await spawnOrphanBridge("/bin/sh", ["-c", "sleep 30"]);
    try {
      await waitForReady(spawned);
      await park(spawned);

      const wrong = await connectControl(spawned.controlSocketPath);
      const wrongReader = readLines(wrong);
      send(wrong, { type: "adopt", ptyInstanceId: "instance-wrong" });
      const errorLine = await wrongReader.waitForLine((line) =>
        line.includes("PTY_INSTANCE_MISMATCH"),
      );
      expect(JSON.parse(errorLine)).toMatchObject({
        type: "error",
        code: "PTY_INSTANCE_MISMATCH",
      });
      wrong.destroy();

      const correct = await adoptRaw(spawned.controlSocketPath);
      send(correct.socket, { type: "kill" });
      correct.socket.destroy();
      await waitFor(() => !existsSync(spawned.controlSocketPath), 5_000);
    } finally {
      await cleanup(spawned);
    }
  });

  it("reaps an unadopted orphan at TTL and tears down the PTY", async () => {
    if (gated()) return;
    const spawned = await spawnOrphanBridge("/bin/sh", ["-c", "sleep 30"], 400);
    let bridgeExited = false;
    try {
      await waitForReady(spawned);
      spawned.bridge.on("exit", () => {
        bridgeExited = true;
      });
      spawned.bridge.stdin.end();
      await waitFor(() => existsSync(spawned.controlSocketPath), 5_000);
      const parkState = JSON.parse(await readFile(spawned.parkStatePath, "utf8"));
      const ptyPid: number = parkState.pid;
      expect(processAlive(ptyPid)).toEqual(true);
      // TTL fires, the PTY dies, and every durable trace is unlinked.
      await waitFor(() => bridgeExited, 5_000);
      expect(existsSync(spawned.controlSocketPath)).toEqual(false);
      expect(existsSync(spawned.parkStatePath)).toEqual(false);
      expect(processAlive(ptyPid)).toEqual(false);
    } finally {
      await cleanup(spawned);
    }
  });

  it("keeps an exited PTY queryable from the park until adoption", async () => {
    if (gated()) return;
    const spawned = await spawnOrphanBridge("/bin/sh", ["-c", "exit 3"]);
    try {
      await waitForReady(spawned);
      // Natural exit while owned drains exactly as today; owner EOF then parks.
      await waitFor(() => spawned.stdout().includes('"exit"'), 5_000);
      spawned.bridge.stdin.end();
      await waitFor(() => existsSync(spawned.controlSocketPath), 5_000);
      const probe = await connectControl(spawned.controlSocketPath);
      const probeReader = readLines(probe);
      send(probe, { type: "exit-status" });
      const status = JSON.parse(
        await probeReader.waitForLine((line) => line.includes('"status"')),
      );
      expect(status.exited).toEqual(true);
      expect(status.exitCode).toEqual(3);
      // node-pty's signal 0 on a clean exit is normalized away at the bridge.
      expect("signal" in status).toEqual(false);
      probe.destroy();

      const terminal = await adoptLocalPtyBridge({
        id: "pty-1",
        ptyInstanceId: PTY_INSTANCE_ID,
        command: "/bin/sh",
        controlSocketPath: spawned.controlSocketPath,
        size: { cols: 80, rows: 24 },
      });
      try {
        expect(terminal.recordedExit).toMatchObject({ exitCode: 3 });
        let exit: { exitCode: number } | undefined;
        terminal.onExit((event) => {
          exit = event;
        });
        await waitFor(() => exit !== undefined, 5_000);
        expect(exit?.exitCode).toEqual(3);
      } finally {
        terminal.dispose();
      }
      await waitFor(() => !existsSync(spawned.controlSocketPath), 5_000);
    } finally {
      await cleanup(spawned);
    }
  });

  it("survives garbage control commands while parked", async () => {
    if (gated()) return;
    const spawned = await spawnOrphanBridge("/bin/sh", ["-c", "sleep 30"]);
    try {
      await waitForReady(spawned);
      await park(spawned);
      const socket = await connectControl(spawned.controlSocketPath);
      const reader = readLines(socket);
      socket.write("this is not json\n");
      await reader.waitForLine((line) => line.includes('"error"'));
      send(socket, { type: "exit-status" });
      const status = JSON.parse(
        await reader.waitForLine((line) => line.includes('"status"')),
      );
      expect(status.exited).toEqual(false);
      socket.destroy();
    } finally {
      await cleanup(spawned);
    }
  });

  it("answers a duplicate adopt on the owning socket without severing it", async () => {
    if (gated()) return;
    const spawned = await spawnOrphanBridge("/bin/sh", [
      "-c",
      "read line; echo got-$line; sleep 30",
    ]);
    try {
      await waitForReady(spawned);
      await park(spawned);
      const { socket, reader } = await adoptRaw(spawned.controlSocketPath);
      send(socket, { type: "adopt", ptyInstanceId: PTY_INSTANCE_ID });
      await waitForAsync(
        async () => reader.lines.filter((line) => line.includes('"status"')).length >= 2,
        5_000,
      );
      const statusLines = reader.lines.filter((line) => line.includes('"status"'));
      const status = JSON.parse(statusLines[statusLines.length - 1] ?? "");
      expect(status.adopted).toEqual(true);
      // The connection still belongs to the adopter: no re-park, writes flow.
      send(socket, { type: "write", data: "still-mine\n" });
      await reader.waitForLine((line) => line.includes("got-still-mine"));
      send(socket, { type: "kill" });
      await reader.waitForLine((line) => line.includes('"exit"'));
      socket.destroy();
      await waitFor(() => !existsSync(spawned.controlSocketPath), 5_000);
    } finally {
      await cleanup(spawned);
    }
  });

  it("bounds a single oversized parked chunk to parkMaxBytes", async () => {
    if (gated()) return;
    const spawned = await spawnOrphanBridge(
      "/bin/sh",
      ["-c", `sleep 0.3; echo ${"x".repeat(500)}; sleep 30`],
      60_000,
      { parkMaxBytes: 64 },
    );
    try {
      await waitForReady(spawned);
      await park(spawned);
      await delay(600);
      const probe = await connectControl(spawned.controlSocketPath);
      const probeReader = readLines(probe);
      send(probe, { type: "exit-status" });
      const status = JSON.parse(
        await probeReader.waitForLine((line) => line.includes('"status"')),
      );
      expect(status.parkedEvicted).toEqual(true);
      probe.destroy();

      const { socket, reader } = await adoptRaw(spawned.controlSocketPath);
      const dataLine = await reader.waitForLine((line) => line.includes('"data"'));
      const payload = JSON.parse(dataLine).data as string;
      expect(Buffer.byteLength(payload, "utf8") <= 64).toEqual(true);
      expect(payload.endsWith("\n")).toEqual(true);
      send(socket, { type: "kill" });
      socket.destroy();
    } finally {
      await cleanup(spawned);
    }
  });

  it("does not unlink a live foreign socket file when reaped", async () => {
    if (gated()) return;
    const dir = await mkdtemp(join(tmpdir(), "station-orphan-impostor-"));
    const controlSocketPath = join(dir, "pty-1.sock");
    // A live impostor owns the path and answers probes, so the parked bridge
    // classifies it as occupied and retries instead of stealing it.
    const impostor = net.createServer((socket) => {
      socket.on("data", () => {
        socket.write("{}\n");
      });
    });
    await new Promise<void>((resolve) => {
      impostor.listen(controlSocketPath, resolve);
    });
    const spawned = await spawnOrphanBridge("/bin/sh", ["-c", "sleep 30"], 60_000, {
      controlSocketPath,
      parkStatePath: join(dir, "pty-1.park.json"),
    });
    let bridgeExited = false;
    try {
      await waitForReady(spawned);
      spawned.bridge.on("exit", () => {
        bridgeExited = true;
      });
      spawned.bridge.stdin.end();
      await waitFor(() => existsSync(spawned.parkStatePath), 5_000);
      await delay(300);
      spawned.bridge.kill("SIGTERM");
      await waitFor(() => bridgeExited, 5_000);
      // The reaped bridge never bound the path, so the impostor's file survives.
      expect(existsSync(controlSocketPath)).toEqual(true);
      const probe = await connectControl(controlSocketPath);
      probe.destroy();
    } finally {
      await cleanup(spawned);
      await new Promise<void>((resolve) => {
        impostor.close(() => resolve());
      });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects parseable but shape-invalid options before any PTY exists", async () => {
    if (gated()) return;
    for (const payload of ["{}", "5", "null"]) {
      const bridge = spawn(process.env.STATION_NODE ?? "node", [
        BRIDGE_PATH,
        Buffer.from(payload, "utf8").toString("base64url"),
      ]);
      const exitCode = await new Promise<number | null>((resolve) => {
        bridge.on("exit", (code) => resolve(code));
      });
      expect(exitCode).toEqual(2);
    }
  });
});
