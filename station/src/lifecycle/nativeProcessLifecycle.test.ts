import { once } from "node:events";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "bun:test";
import { createNativeProcessLifecycle } from "./nativeProcessLifecycle.js";

type Input = Parameters<typeof createNativeProcessLifecycle>[0];

function harness(options: {
  cleanupSteps?: Input["cleanupSteps"];
  killResult?: boolean;
  onRelease?: (listenerInstalled: boolean) => void;
  releaseError?: unknown;
  terminalLossTimeoutMs?: number;
} = {}) {
  const events: string[] = [];
  let signalHandler: (() => void) | undefined;
  const lifecycle = createNativeProcessLifecycle({
    stopSurfaceObservation: () => events.push("surface:stop"),
    cleanupSteps: options.cleanupSteps ?? [() => void events.push("cleanup")],
    lifecycle: {
      shutdownRequested: async (reason) => {
        events.push(`requested:${reason}`);
      },
      shutdownCompleted: async (reason) => {
        events.push(`completed:${reason}`);
      },
      fatal: async () => {
        events.push("fatal:TUI_FATAL");
      },
      flush: async () => {
        events.push("flush");
      },
    },
    releaseTty: () => {
      events.push("tty:release");
      options.onRelease?.(signalHandler !== undefined);
      if (options.releaseError !== undefined) throw options.releaseError;
    },
    processControl: {
      pid: 4242,
      on: (_signal, listener) => {
        signalHandler = listener;
      },
      off: (_signal, listener) => {
        if (signalHandler === listener) signalHandler = undefined;
      },
      kill: (pid, signal) => {
        events.push(`signal:${pid}:${signal}`);
        return options.killResult ?? true;
      },
      exit: (code) => events.push(`exit:${code}`),
    },
    ...(options.terminalLossTimeoutMs === undefined
      ? {}
      : { terminalLossTimeoutMs: options.terminalLossTimeoutMs }),
  });
  return { events, lifecycle, signal: () => signalHandler?.() };
}

describe("native process lifecycle", () => {
  it("is pure on construction and installs, disposes, and reinstalls one SIGHUP listener", () => {
    const before = process.listenerCount("SIGHUP");
    const lifecycle = createNativeProcessLifecycle({
      stopSurfaceObservation: () => undefined,
      cleanupSteps: [],
      lifecycle: {
        shutdownRequested: async () => undefined,
        shutdownCompleted: async () => undefined,
        fatal: async () => undefined,
        flush: async () => undefined,
      },
      releaseTty: () => undefined,
    });
    expect(process.listenerCount("SIGHUP")).toBe(before);
    try {
      lifecycle.install();
      lifecycle.install();
      expect(process.listenerCount("SIGHUP")).toBe(before + 1);
      lifecycle.dispose();
      expect(process.listenerCount("SIGHUP")).toBe(before);
      lifecycle.install();
      expect(process.listenerCount("SIGHUP")).toBe(before + 1);
    } finally {
      lifecycle.dispose();
    }
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });

  it("admits the first racing request and attempts every cleanup step once", async () => {
    const calls: string[] = [];
    let settlePty!: () => void;
    const ptySettlement = new Promise<void>((resolve) => {
      settlePty = resolve;
    });
    const station = harness({
      cleanupSteps: [
        () => void calls.push("station"),
        () => void calls.push("root"),
        () => void calls.push("renderer"),
        () => {
          calls.push("pty");
          return ptySettlement;
        },
      ],
    });
    station.lifecycle.install();

    const first = station.lifecycle.request("ctrl_q");
    const repeated = station.lifecycle.request("ctrl_q");
    const takeover = station.lifecycle.request("tty_takeover");
    station.signal();
    expect(repeated).toBe(first);
    expect(takeover).toBe(first);
    await Promise.resolve();
    expect(calls).toEqual(["station", "root", "renderer", "pty"]);
    expect(station.events).toEqual(["surface:stop", "requested:ctrl_q"]);
    settlePty();
    await first;

    expect(station.events).toEqual([
      "surface:stop",
      "requested:ctrl_q",
      "completed:ctrl_q",
      "flush",
      "tty:release",
      "exit:0",
    ]);
  });

  it("records fatal evidence after rejected cleanup and cannot exit successfully", async () => {
    const calls: string[] = [];
    const station = harness({
      cleanupSteps: [
        () => void calls.push("station"),
        () => {
          calls.push("root");
          throw new Error("private terminal content");
        },
        () => void calls.push("renderer"),
        () => void calls.push("pty"),
      ],
    });

    await station.lifecycle.request("tty_takeover");

    expect(calls).toEqual(["station", "root", "renderer", "pty"]);
    expect(station.events).toEqual([
      "surface:stop",
      "requested:tty_takeover",
      "fatal:TUI_FATAL",
      "flush",
      "tty:release",
      "exit:1",
    ]);
  });

  it("bounds terminal-loss cleanup and releases TTY ownership before signaling", async () => {
    const station = harness({
      cleanupSteps: [() => new Promise<void>(() => undefined)],
      terminalLossTimeoutMs: 5,
    });
    station.lifecycle.install();

    station.signal();
    await station.lifecycle.request("ctrl_q");

    expect(station.events).toEqual([
      "surface:stop",
      "requested:terminal_loss",
      "fatal:TUI_FATAL",
      "flush",
      "tty:release",
      "signal:4242:SIGHUP",
    ]);
  });

  it("falls back to derived status 129 when SIGHUP self-signaling fails", async () => {
    const station = harness({ killResult: false });
    station.lifecycle.install();
    station.signal();
    await station.lifecycle.request("tty_takeover");
    expect(station.events.slice(-3)).toEqual([
      "tty:release",
      "signal:4242:SIGHUP",
      "exit:129",
    ]);
  });

  it("keeps coalescing SIGHUP through TTY release and self-signals when release throws", async () => {
    let listenerInstalledDuringRelease = false;
    const station = harness({
      onRelease: (installed) => {
        listenerInstalledDuringRelease = installed;
        station.signal();
      },
      releaseError: new Error("release failed"),
    });
    station.lifecycle.install();
    station.signal();

    await station.lifecycle.request("ctrl_q");

    expect(listenerInstalledDuringRelease).toBe(true);
    expect(station.events.slice(-2)).toEqual(["tty:release", "signal:4242:SIGHUP"]);
    station.signal();
    expect(station.events.slice(-2)).toEqual(["tty:release", "signal:4242:SIGHUP"]);
  });

  it("exits unsuccessfully when TTY release fails during a non-signal shutdown", async () => {
    const station = harness({ releaseError: new Error("release failed") });

    await station.lifecycle.request("tty_takeover");

    expect(station.events.slice(-2)).toEqual(["tty:release", "exit:1"]);
  });

  it("re-raises a real SIGHUP only after spawned-process cleanup settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-native-sighup-"));
    const marker = join(root, "cleanup.txt");
    const moduleUrl = new URL("./nativeProcessLifecycle.ts", import.meta.url).href;
    const fixture = `
      import { writeFile } from "node:fs/promises";
      const { createNativeProcessLifecycle } = await import(${JSON.stringify(moduleUrl)});
      const lifecycle = createNativeProcessLifecycle({
        stopSurfaceObservation() {},
        cleanupSteps: [() => writeFile(${JSON.stringify(marker)}, "settled")],
        lifecycle: {
          shutdownRequested: async () => {},
          shutdownCompleted: async () => {},
          fatal: async () => {},
          flush: async () => {},
        },
        releaseTty() {},
      });
      lifecycle.install();
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--eval", fixture], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    try {
      await Promise.race([
        once(child.stdout!, "data"),
        once(child, "exit").then(() => Promise.reject(new Error(stderr || "fixture exited"))),
      ]);
      const exited = once(child, "exit");
      process.kill(child.pid!, "SIGHUP");
      const [code, signal] = (await exited) as [number | null, NodeJS.Signals | null];

      expect({ code, signal }).toEqual({ code: null, signal: "SIGHUP" });
      expect(await readFile(marker, "utf8")).toBe("settled");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
