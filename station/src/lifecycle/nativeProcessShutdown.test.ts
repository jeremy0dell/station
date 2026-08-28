import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "bun:test";
import { settleNativeCompositionShutdown } from "../main.js";
import {
  createNativeProcessShutdown,
  NATIVE_TERMINAL_LOSS_SHUTDOWN_DEADLINE_MS,
} from "./nativeProcessShutdown.js";

function processStartToken(pid: number): string | undefined {
  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  const output = result.stdout.trim();
  const certain = result.error === undefined && result.signal === null && result.stderr === "";
  if (certain && result.status === 0 && output.length > 0) return output;
  if (certain && result.status === 1 && output.length === 0) return undefined;
  throw new Error(`Uncertain process generation for PID ${pid}.`);
}

function signalExact(pid: number, startToken: string, signal: NodeJS.Signals): void {
  expect(processStartToken(pid)).toBe(startToken);
  expect(process.kill(pid, signal)).toBe(true);
}

type ChildClose = { code: number | null; signal: NodeJS.Signals | null };

async function beforeDeadline<T>(deadline: number, operation: Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Subprocess deadline expired.");
  const expiration = setTimeout(remaining, undefined, { ref: false }).then(() => {
    throw new Error("Subprocess deadline expired.");
  });
  return Promise.race([operation, expiration]);
}

function createHarness(input: { admissionError?: Error; kill?: boolean | "throw" } = {}) {
  const cleanup = Promise.withResolvers<"success" | "failure">();
  const state = {
    admittedBeforeCleanup: false,
    cleanupCalls: [] as Array<{ reason: string; failure?: { readonly error: unknown } }>,
    exits: [] as number[],
    finalized: [] as boolean[],
    kills: [] as string[],
    published: Promise.resolve(),
  };
  const timers = new Map<number, { ms: number; callback: () => void }>();
  let nextTimerId = 0;
  const processControl = Object.assign(new EventEmitter(), {
    pid: 4321,
    kill(_pid: number, signal: string) {
      state.kills.push(signal);
      if (input.kill === "throw") throw new Error("self signal failed");
      return input.kill ?? true;
    },
    exit(code?: number): never {
      state.exits.push(code ?? 0);
      return undefined as never;
    },
  });
  const coordinator = createNativeProcessShutdown({
    startCleanup: (reason, failure) => {
      state.cleanupCalls.push({ reason, ...(failure === undefined ? {} : { failure }) });
      return cleanup.promise;
    },
    finalizeLocal: (expired) => {
      state.finalized.push(expired);
      return true;
    },
    onAdmitted: (settled) => {
      state.admittedBeforeCleanup = state.cleanupCalls.length === 0;
      state.published = settled;
      if (input.admissionError !== undefined) throw input.admissionError;
    },
    process: processControl as never,
    timers: {
      setTimeout(callback, ms) {
        const id = ++nextTimerId;
        timers.set(id, { ms, callback });
        return id;
      },
      clearTimeout: (id) => void timers.delete(id as number),
    },
  });
  return { cleanup, coordinator, processControl, state, timers };
}

type SettlementInput = Parameters<typeof settleNativeCompositionShutdown>[0];

function settleComposition(events: string[], overrides: Partial<SettlementInput> = {}) {
  return settleNativeCompositionShutdown({
    cleanupSteps: [() => void events.push("cleanup")],
    failure: () => undefined,
    finalized: () => false,
    completed: async () => void events.push("completed"),
    recordFailure: async () => void events.push("fatal"),
    flush: async () => void events.push("flush"),
    release: () => void events.push("release"),
    ...overrides,
  });
}

function durableFailure(events: string[], assertFailure: (error: unknown) => void) {
  const started = Promise.withResolvers<void>();
  const written = Promise.withResolvers<void>();
  const recordFailure = async (error: unknown): Promise<void> => {
    assertFailure(error);
    events.push("fatal");
    started.resolve();
    await written.promise;
  };
  return { recordFailure, started: started.promise, written };
}

describe("native composition settlement", () => {
  it("awaits durable fatal evidence for a deferred renderer cleanup rejection", async () => {
    const renderer = Promise.withResolvers<void>();
    const events: string[] = [];
    const fatal = durableFailure(events, (error) => expect(error instanceof AggregateError).toBe(true));
    const settled = settleComposition(events, {
      cleanupSteps: [() => renderer.promise, () => void events.push("station")],
      recordFailure: fatal.recordFailure,
    });
    expect(events).toEqual(["station"]);
    renderer.reject(new Error("renderer startup failed"));
    await fatal.started;
    expect(events).toEqual(["station", "fatal"]);
    expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");
    fatal.written.resolve();
    expect(await settled).toBe("failure");
    expect(events).toEqual(["station", "fatal", "release"]);
  });

  it("preserves cleanup, evidence, release, and finalization ordering", async () => {
    const renderer = Promise.withResolvers<{ destroy(): void }>();
    const rendererEvents: string[] = [];
    const rendererSettled = settleComposition(rendererEvents, {
      cleanupSteps: [
        () => renderer.promise.then((value) => value.destroy()),
        () => void rendererEvents.push("station"),
      ],
    });
    expect(rendererEvents).toEqual(["station"]);
    renderer.resolve({ destroy: () => void rendererEvents.push("renderer") });
    expect(await rendererSettled).toBe("success");
    expect(rendererEvents).toEqual(["station", "renderer", "completed", "flush", "release"]);

    const failureEvents: string[] = [];
    const failureFatal = durableFailure(failureEvents, (error) => expect(error).toBeUndefined());
    const failureSettled = settleComposition(failureEvents, {
      failure: () => ({ error: undefined }),
      recordFailure: failureFatal.recordFailure,
    });
    await failureFatal.started;
    expect(failureEvents).toEqual(["cleanup", "fatal"]);
    failureFatal.written.resolve();
    expect(await failureSettled).toBe("failure");
    expect(failureEvents).toEqual(["cleanup", "fatal", "release"]);

    const releaseError = new Error("release failed");
    const releaseEvents: string[] = [];
    const releaseFatal = durableFailure(releaseEvents, (error) => expect(error).toBe(releaseError));
    const releaseSettled = settleComposition(releaseEvents, {
      release: () => {
        releaseEvents.push("release");
        throw releaseError;
      },
      recordFailure: releaseFatal.recordFailure,
    });
    await releaseFatal.started;
    expect(releaseEvents).toEqual(["cleanup", "completed", "flush", "release", "fatal"]);
    expect(await Promise.race([releaseSettled, Promise.resolve("pending")])).toBe("pending");
    releaseFatal.written.resolve();
    expect(await releaseSettled).toBe("failure");

    const cleanup = Promise.withResolvers<void>();
    const deadlineEvents: string[] = [];
    let finalized = false;
    const deadlineSettled = settleComposition(deadlineEvents, {
      cleanupSteps: [() => cleanup.promise, () => void deadlineEvents.push("attempted")],
      finalized: () => finalized,
    });
    expect(deadlineEvents).toEqual(["attempted"]);
    finalized = true;
    cleanup.reject(new Error("late cleanup failure"));
    expect(await deadlineSettled).toBe("failure");
    expect(deadlineEvents).toEqual(["attempted"]);
  });
});

describe("native process shutdown", () => {
  it("publishes admission, keeps fatal sticky, and arbitrates HMR", async () => {
    const harness = createHarness();
    const first = harness.coordinator.request("ctrl_q");
    expect(harness.state.published).toBe(first);
    expect(harness.state.admittedBeforeCleanup).toBe(true);
    expect(harness.coordinator.request("fatal")).toBe(first);
    expect(harness.state.cleanupCalls).toEqual([{ reason: "ctrl_q" }]);
    harness.cleanup.resolve("success");
    await first;
    expect(harness.state.finalized).toEqual([false]);
    expect(harness.state.exits).toEqual([1]);

    const hmrFirst = createHarness();
    expect(hmrFirst.coordinator.beginHotReload()).toBe("hot_reload");
    expect(hmrFirst.processControl.listenerCount("SIGHUP")).toBe(0);
    await hmrFirst.coordinator.request("ctrl_q");
    expect(hmrFirst.state.cleanupCalls).toEqual([]);

    const processFirst = createHarness();
    const settled = processFirst.coordinator.request("ctrl_q");
    expect(processFirst.coordinator.beginHotReload()).toBe("process_shutdown");
    expect(processFirst.coordinator.request("tty_takeover")).toBe(settled);
    processFirst.processControl.emit("SIGHUP");
    processFirst.cleanup.resolve("success");
    await Promise.resolve();
    expect(processFirst.state.finalized).toEqual([false]);
    expect(processFirst.state.kills).toEqual(["SIGHUP"]);

    const deadline = createHarness();
    deadline.processControl.emit("SIGHUP");
    deadline.processControl.emit("SIGHUP");
    expect(deadline.state.cleanupCalls).toEqual([{ reason: "terminal_loss" }]);
    const deadlineDelays = [...deadline.timers.values()].map((timer) => timer.ms);
    expect(deadlineDelays).toEqual([NATIVE_TERMINAL_LOSS_SHUTDOWN_DEADLINE_MS]);
    [...deadline.timers.values()][0]!.callback();
    expect(deadline.state.finalized).toEqual([true]);
    expect(deadline.state.kills).toEqual(["SIGHUP"]);
    expect(deadline.processControl.listenerCount("SIGHUP")).toBe(0);
    deadline.cleanup.reject(undefined);
    await Promise.resolve();
    expect(deadline.state.finalized).toEqual([true]);
  });

  for (const [name, admissionError, reason, rejectCleanup, expectedExit] of [
    ["ordinary Ctrl-Q", undefined, "ctrl_q", false, 0],
    ["admission publication", new Error("barrier publication failed"), "tty_takeover", false, 1],
    ["direct fatal", undefined, "fatal", false, 1],
    ["cleanup rejection", undefined, "ctrl_q", true, 1],
  ] as const)
    it(`settles ${name}`, async () => {
      const harness = createHarness(admissionError === undefined ? {} : { admissionError });
      const settled = harness.coordinator.request(reason);
      if (reason === "fatal" || admissionError !== undefined) {
        expect(harness.state.cleanupCalls[0]?.failure).toEqual({ error: admissionError });
      }
      if (rejectCleanup) {
        harness.cleanup.reject(undefined);
      } else {
        harness.cleanup.resolve("success");
      }
      await settled;
      expect(harness.state.exits).toEqual([expectedExit]);
    });

  for (const [name, kill, consumed] of [
    ["returns false", false, false],
    ["throws", "throw", false],
    ["is consumed", true, true],
  ] as const)
    it(`settles when self-SIGHUP ${name}`, async () => {
      const harness = createHarness({ kill });
      harness.processControl.emit("SIGHUP");
      harness.cleanup.resolve("success");
      await Promise.resolve();
      expect([...harness.timers.values()].map((timer) => timer.ms)).toEqual(consumed ? [100] : []);
      if (consumed) {
        expect(harness.state.exits).toEqual([]);
        [...harness.timers.values()][0]!.callback();
      }
      expect(harness.state.exits).toEqual([129]);
    });

  it("delivers real SIGHUP after gated cleanup", async () => {
    const moduleUrl = new URL("./nativeProcessShutdown.ts", import.meta.url).href;
    const source = `
      setTimeout(() => process.exit(124), 8_000);
      const { createNativeProcessShutdown } = await import(${JSON.stringify(moduleUrl)});
      const cleanup = Promise.withResolvers();
      process.once("SIGUSR1", () => cleanup.resolve("success"));
      createNativeProcessShutdown({
        startCleanup: () => {
          console.log("CLEANUP");
          return cleanup.promise;
        },
        finalizeLocal: () => {
          console.log("FINALIZE");
          return true;
        },
        onAdmitted: () => {},
      });
      console.log("READY");
    `;
    const protocolDeadline = Date.now() + 6_000;
    const drainDeadline = protocolDeadline + 2_500;
    const child = spawn(process.execPath, ["-e", source], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const lineReader = createInterface({ input: child.stdout! });
    const lines = lineReader[Symbol.asyncIterator]();
    const closed = Promise.withResolvers<ChildClose>();
    child.once("error", closed.reject);
    child.once("close", (code, signal) => closed.resolve({ code, signal }));
    const childPid = child.pid;
    let startToken: string | undefined;
    try {
      if (childPid === undefined) throw new Error("Spawned child has no PID.");
      startToken = processStartToken(childPid);
      if (startToken === undefined) throw new Error("Spawned child exited before signaling.");
      expect((await beforeDeadline(protocolDeadline, lines.next())).value).toBe("READY");
      signalExact(childPid, startToken, "SIGHUP");
      expect((await beforeDeadline(protocolDeadline, lines.next())).value).toBe("CLEANUP");
      signalExact(childPid, startToken, "SIGHUP");
      signalExact(childPid, startToken, "SIGUSR1");
      expect((await beforeDeadline(protocolDeadline, lines.next())).value).toBe("FINALIZE");
      const closeResult: ChildClose = await beforeDeadline(protocolDeadline, closed.promise);
      expect(closeResult).toEqual({ code: null, signal: "SIGHUP" });
    } finally {
      lineReader.close();
      if (childPid !== undefined) {
        const current = processStartToken(childPid);
        if (startToken !== undefined && current === startToken) {
          signalExact(childPid, startToken, "SIGKILL");
        } else if (current !== undefined) {
          throw new Error("Spawned child generation changed before cleanup.");
        }
      }
      await beforeDeadline(drainDeadline, closed.promise);
      if (childPid !== undefined) expect(processStartToken(childPid)).toBeUndefined();
    }
  }, 10_000);
});
