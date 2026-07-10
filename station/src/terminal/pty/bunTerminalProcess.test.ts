import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { StationTerminalExit, StationTerminalProcess } from "../types.js";
import { waitFor } from "../testing/waitFor.js";
import {
  CTTY_HELPER_PATH,
  createBunTerminalProcess,
  type BunTerminalProcessOptions,
} from "./bunTerminalProcess.js";
import { createLocalPtyTerminal, createPtyEnv } from "./localPtyTerminal.js";

const RUN_REAL_BUN_PTY = process.env.STATION_PTY_IMPL === "bun";
const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function resolvedOptions(
  command: string,
  args: readonly string[] = [],
): BunTerminalProcessOptions {
  return {
    id: "bun-terminal-test",
    command,
    args,
    cwd: process.cwd(),
    env: createPtyEnv(undefined),
    name: "xterm-256color",
    size: { cols: 80, rows: 24 },
  };
}

function observe(terminal: StationTerminalProcess): {
  output(): string;
  exit(): StationTerminalExit | undefined;
} {
  let output = "";
  let exit: StationTerminalExit | undefined;
  terminal.onData((data) => {
    output += data;
  });
  terminal.onExit((event) => {
    exit = event;
  });
  return {
    output: () => output,
    exit: () => exit,
  };
}

function trackTerminal(terminal: StationTerminalProcess): StationTerminalProcess {
  cleanups.push(() => terminal.dispose());
  return terminal;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processState(pid: number): string | undefined {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim() || undefined;
}

function terminalForegroundGroup(pid: number): number | undefined {
  const result = spawnSync("ps", ["-o", "tpgid=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) {
    return undefined;
  }
  const value = Number(result.stdout.trim());
  return Number.isInteger(value) ? value : undefined;
}

function occurrences(input: string, needle: string): number {
  return input.split(needle).length - 1;
}

function childExit(child: ChildProcessWithoutNullStreams): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

type BunOwnerProcess = {
  readonly pid: number;
  readonly stdin: {
    write(data: string): number;
    flush(): number | Promise<number>;
  };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: string | number): void;
};

type BunOwnerRuntime = {
  spawn(
    command: string[],
    options: { stdin: "pipe"; stdout: "pipe"; stderr: "pipe" },
  ): BunOwnerProcess;
};

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error("PTY owner exited before reporting its payload PID.");
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        return buffer.slice(0, newline);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

describe("Bun PTY helper validation", () => {
  it("fails actionably when the helper is missing without launching the payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-ctty-missing-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const marker = join(dir, "payload-ran");

    expect(() =>
      createBunTerminalProcess({
        ...resolvedOptions("/bin/sh", ["-c", 'touch "$1"', "sh", marker]),
        cttyHelperPath: join(dir, "missing-helper"),
      }),
    ).toThrow(/bun run build:ctty-helper/);
    expect(existsSync(marker)).toBe(false);
  });

  it("fails actionably when the helper is not executable without launching the payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-ctty-mode-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const helper = join(dir, "ctty-helper");
    const marker = join(dir, "payload-ran");
    await writeFile(helper, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o644 });

    expect(() =>
      createBunTerminalProcess({
        ...resolvedOptions("/bin/sh", ["-c", 'touch "$1"', "sh", marker]),
        cttyHelperPath: helper,
      }),
    ).toThrow(/bun run build:ctty-helper/);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not blame the helper for an unrelated spawn failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-ctty-cwd-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const helper = join(dir, "ctty-helper");
    await writeFile(helper, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });

    let message = "";
    try {
      createBunTerminalProcess({
        ...resolvedOptions("/bin/true"),
        cwd: join(dir, "missing-cwd"),
        cttyHelperPath: helper,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Failed to spawn terminal");
    expect(message).not.toContain("build:ctty-helper");
  });
});

if (RUN_REAL_BUN_PTY) {
  describe("BunTerminalProcess real PTY", () => {
    it("passes interactive input to the child and output to the subscriber", async () => {
      const terminal = trackTerminal(
        createLocalPtyTerminal({
          command: "/bin/sh",
          args: ["-c", 'read line; printf "got:%s" "$line"'],
        }),
      );
      const observed = observe(terminal);

      terminal.write("hello\n");
      await waitFor(() => observed.exit() !== undefined, 5_000);

      expect(observed.output()).toContain("got:hello");
      expect(observed.exit()).toEqual({ exitCode: 0 });
    });

    it("delivers a fast large final burst and exact nonzero exit code", async () => {
      const terminal = trackTerminal(
        createLocalPtyTerminal({
          command: process.execPath,
          args: ["-e", "process.stdout.write('x'.repeat(100000)); process.exit(7)"],
        }),
      );
      const observed = observe(terminal);

      await waitFor(() => observed.exit() !== undefined, 10_000);

      expect(observed.output()).toBe("x".repeat(100_000));
      expect(observed.exit()).toEqual({ exitCode: 7 });
    });

    it("clamps spawn and resize dimensions to 2x1 without killing the shell", async () => {
      const terminal = trackTerminal(
        createLocalPtyTerminal({
          command: "/bin/sh",
          args: ["-c", 'stty size; read line; stty size; printf "got:%s" "$line"'],
          size: { cols: 0, rows: 0 },
        }),
      );
      const observed = observe(terminal);

      expect(terminal.size).toEqual({ cols: 2, rows: 1 });
      await waitFor(() => observed.output().includes("1 2"), 5_000);
      terminal.resize({ cols: -10, rows: 0 });
      expect(terminal.size).toEqual({ cols: 2, rows: 1 });
      terminal.write("alive\n");
      await waitFor(() => observed.exit() !== undefined, 5_000);

      expect(occurrences(observed.output(), "1 2")).toBe(2);
      expect(observed.output()).toContain("got:alive");
      expect(observed.exit()).toEqual({ exitCode: 0 });
    });

    it("passes the sanitized color-capable environment", async () => {
      const terminal = trackTerminal(
        createLocalPtyTerminal({
          command: "/bin/sh",
          args: [
            "-c",
            'printf "%s|%s|%s|%s" "$TERM" "$COLORTERM" "${NO_COLOR-unset}" "${FORCE_COLOR-unset}"',
          ],
          env: {
            TERM: "station-test-term",
            COLORTERM: "station-test-color",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
        }),
      );
      const observed = observe(terminal);

      await waitFor(() => observed.exit() !== undefined, 5_000);

      expect(observed.output()).toBe("station-test-term|station-test-color|unset|unset");
    });

    it("dispose terminates a long-running payload before closing the terminal", async () => {
      const terminal = trackTerminal(
        createLocalPtyTerminal({
          command: "/bin/sh",
          args: ["-c", "printf READY; exec sleep 30"],
        }),
      );
      const observed = observe(terminal);
      const payloadPid = terminal.pid;
      cleanups.push(() => {
        if (isProcessAlive(payloadPid)) process.kill(payloadPid, "SIGKILL");
      });

      await waitFor(() => observed.output().includes("READY"), 5_000);
      terminal.dispose();
      await waitFor(() => !isProcessAlive(payloadPid), 5_000);

      expect(isProcessAlive(payloadPid)).toBe(false);
    });

    it("supports Ctrl-Z, fg, and Ctrl-C through the controlling terminal", async () => {
      const prompt = `__STATION_PTY_PROMPT_${process.pid}__ `;
      const terminal = trackTerminal(
        createLocalPtyTerminal({
          command: "/bin/bash",
          args: ["--noprofile", "--norc", "-i"],
          env: { PS1: prompt, PS2: "", LC_ALL: "C" },
        }),
      );
      const observed = observe(terminal);
      cleanups.push(() => {
        if (isProcessAlive(terminal.pid)) process.kill(terminal.pid, "SIGKILL");
      });

      await waitFor(() => occurrences(observed.output(), prompt) >= 1, 5_000);
      terminal.write("/bin/sh -c 'echo __CHILD__=$$; exec sleep 30'\n");
      await waitFor(() => /__CHILD__=\d+/.test(observed.output()), 5_000);
      const childPid = Number(observed.output().match(/__CHILD__=(\d+)/)?.[1]);
      expect(childPid).toBeGreaterThan(0);
      cleanups.push(() => {
        if (isProcessAlive(childPid)) process.kill(childPid, "SIGKILL");
      });
      await waitFor(() => terminalForegroundGroup(childPid) === childPid, 5_000);

      terminal.write("\x1a");
      await waitFor(
        () => processState(childPid)?.includes("T") === true && occurrences(observed.output(), prompt) >= 2,
        5_000,
      );

      terminal.write("fg\n");
      await waitFor(
        () => processState(childPid)?.includes("T") === false && terminalForegroundGroup(childPid) === childPid,
        5_000,
      );

      terminal.write("\x03");
      await waitFor(
        () => !isProcessAlive(childPid) && occurrences(observed.output(), prompt) >= 3,
        5_000,
      );
      terminal.write("exit 0\n");
      await waitFor(() => observed.exit() !== undefined, 5_000);

      expect(observed.exit()).toEqual({ exitCode: 0 });
    });

    it("leaves no payload after a separate Bun owner is SIGKILLed", async () => {
      const ownerScript = `
        const terminal = new Bun.Terminal({ cols: 80, rows: 24, data() {} });
        const child = Bun.spawn([${JSON.stringify(CTTY_HELPER_PATH)}, "/bin/sleep", "30"], { terminal });
        console.log(child.pid);
        process.stdin.once("data", () => process.kill(process.pid, 9));
        process.stdin.resume();
      `;
      const owner = (Bun as unknown as BunOwnerRuntime).spawn(
        [process.execPath, "-e", ownerScript],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      let payloadPid = 0;
      cleanups.push(async () => {
        if (isProcessAlive(owner.pid)) owner.kill("SIGKILL");
        if (isProcessAlive(payloadPid)) process.kill(payloadPid, "SIGKILL");
        await owner.exited.catch(() => undefined);
      });

      payloadPid = Number(await readFirstLine(owner.stdout));
      expect(owner.pid).toBeGreaterThan(0);
      expect(payloadPid).toBeGreaterThan(0);
      expect(isProcessAlive(owner.pid)).toBe(true);
      expect(isProcessAlive(payloadPid)).toBe(true);

      owner.stdin.write("kill\n");
      await owner.stdin.flush();
      expect(await owner.exited).toBe(137);
      expect(owner.signalCode).toBe("SIGKILL");
      const deadline = Date.now() + 5_000;
      let state = processState(payloadPid);
      while (state !== undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        state = processState(payloadPid);
      }

      expect(state).toBeUndefined();
    });

    it("launches bun-nocctty without claiming job-control guarantees", async () => {
      const terminal = trackTerminal(
        createBunTerminalProcess({
          ...resolvedOptions("/bin/sh", ["-c", "printf NOCTTY"]),
        }),
      );
      const observed = observe(terminal);

      await waitFor(() => observed.exit() !== undefined, 5_000);

      expect(observed.output()).toBe("NOCTTY");
      expect(observed.exit()).toEqual({ exitCode: 0 });
    });
  });

  describe("station-ctty-helper exit codes", () => {
    it("returns 64 when no payload is supplied", async () => {
      const child = spawn(CTTY_HELPER_PATH, []);
      expect((await childExit(child)).code).toBe(64);
    });

    it("returns 126 when controlling-terminal setup fails", async () => {
      const child = spawn(CTTY_HELPER_PATH, ["/bin/true"]);
      expect((await childExit(child)).code).toBe(126);
    });

    it("returns 127 when the payload cannot be found", async () => {
      const terminal = trackTerminal(
        createBunTerminalProcess({
          ...resolvedOptions(`station-missing-command-${process.pid}`),
          cttyHelperPath: CTTY_HELPER_PATH,
        }),
      );
      const observed = observe(terminal);

      await waitFor(() => observed.exit() !== undefined, 5_000);

      expect(observed.exit()).toEqual({ exitCode: 127 });
    });
  });
}
