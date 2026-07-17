import { type ChildProcess, execFile, spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { RealE2eEnvironment } from "./env";
import { requireToolPath } from "./env";

const execFileAsync = promisify(execFile);
const OUTPUT_TAIL_BYTES = 64 * 1024;
const DEFAULT_PTY_DIMENSIONS: TmuxPtyDimensions = { columns: 140, rows: 44 };
const ptyBridgeScript = `
import fcntl
import os
import pty
import select
import struct
import sys
import termios

rows = int(sys.argv[1])
columns = int(sys.argv[2])
winsize = struct.pack("HHHH", rows, columns, 0, 0)
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(sys.stdin.fileno(), termios.TIOCSWINSZ, winsize)
    os.environ.setdefault("TERM", "xterm-256color")
    os.execvp(sys.argv[3], sys.argv[3:])

fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
while True:
    readable, _, _ = select.select([sys.stdin.buffer, fd], [], [])
    if sys.stdin.buffer in readable:
        data = os.read(sys.stdin.fileno(), 4096)
        if not data:
            break
        os.write(fd, data)
    if fd in readable:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(sys.stdout.fileno(), data)

try:
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
except ChildProcessError:
    sys.exit(0)
`;

export type TmuxPtyDimensions = {
  columns: number;
  rows: number;
};

/**
 * An attached tmux client whose keyboard and mouse bytes cross a real PTY rather
 * than `tmux send-keys` or OpenTUI's test-renderer dispatch.
 */
export type AttachedTmuxPtyClient = {
  clientName: string;
  processId: number;
  write(bytes: Uint8Array): Promise<void>;
  outputTail(): string;
  close(): Promise<void>;
};

export type NativeStationTmuxLaunch = {
  panePid: number;
  target: string;
};

export async function killTmuxSession(env: RealE2eEnvironment, sessionName: string): Promise<void> {
  await execFileAsync(requireToolPath(env, "tmux"), ["kill-session", "-t", sessionName], {
    timeout: 10_000,
  }).catch(() => undefined);
}

export async function tmuxSessionExists(
  env: RealE2eEnvironment,
  sessionName: string,
): Promise<boolean> {
  try {
    await execFileAsync(requireToolPath(env, "tmux"), ["has-session", "-t", sessionName], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function listTmuxWindows(
  env: RealE2eEnvironment,
  sessionName: string,
): Promise<string[]> {
  const output = await execFileAsync(
    requireToolPath(env, "tmux"),
    ["list-windows", "-t", sessionName, "-F", "#{window_name}"],
    { timeout: 10_000 },
  );
  return output.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function activeTmuxWindow(
  env: RealE2eEnvironment,
  sessionName: string,
): Promise<string> {
  const output = await execFileAsync(
    requireToolPath(env, "tmux"),
    ["display-message", "-p", "-t", sessionName, "#{window_name}"],
    { timeout: 10_000 },
  );
  return output.stdout.trim();
}

export async function activeTmuxPane(env: RealE2eEnvironment, target: string): Promise<string> {
  const output = await execFileAsync(
    requireToolPath(env, "tmux"),
    ["display-message", "-p", "-t", target, "#{pane_id}"],
    { timeout: 10_000 },
  );
  return output.stdout.trim();
}

/**
 * Launch bare `stn` as the native renderer while tmux supplies only a fixed-size
 * PTY and capture envelope; the Station process never receives tmux context.
 */
export async function launchNativeStationInTmux(input: {
  env: RealE2eEnvironment;
  configPath: string;
  observerSocketPath: string;
  stateDir: string;
  sessionName: string;
  cwd?: string;
  dimensions?: TmuxPtyDimensions;
}): Promise<NativeStationTmuxLaunch> {
  const tmux = requireToolPath(input.env, "tmux");
  const dimensions = input.dimensions ?? DEFAULT_PTY_DIMENSIONS;
  assertDimensions(dimensions);
  const command = [
    "exec",
    "env",
    "-u",
    "TMUX",
    "-u",
    "TMUX_PANE",
    "-u",
    "STATION_PANE",
    "-u",
    "STATION_TUI_POPUP",
    "-u",
    "STATION_TUI_PERSISTENT",
    `STATION_CONFIG_PATH=${shellQuote(input.configPath)}`,
    `STATION_OBSERVER_SOCKET_PATH=${shellQuote(input.observerSocketPath)}`,
    `STATION_HOST_SOCKET_PATH=${shellQuote(join(dirname(input.observerSocketPath), "station-host.sock"))}`,
    `STATION_LAYOUT_PATH=${shellQuote(join(input.stateDir, "station", "layout.json"))}`,
    shellQuote(input.env.stationBin),
    "--config",
    shellQuote(input.configPath),
  ].join(" ");
  const args = [
    "new-session",
    "-d",
    "-s",
    input.sessionName,
    "-x",
    String(dimensions.columns),
    "-y",
    String(dimensions.rows),
  ];
  if (input.cwd !== undefined) {
    args.push("-c", input.cwd);
  }
  args.push(command);

  try {
    await execFileAsync(tmux, args, { timeout: 10_000 });
    // Tmux must decode and forward the attached client's SGR stream before native OpenTUI can receive it.
    await execFileAsync(tmux, ["set-option", "-t", input.sessionName, "mouse", "on"], {
      timeout: 10_000,
    });
    const pane = await execFileAsync(
      tmux,
      ["display-message", "-p", "-t", input.sessionName, "#{pane_pid}\t#{pane_id}"],
      { timeout: 10_000 },
    );
    const [panePidText, paneId] = pane.stdout.trim().split("\t");
    const panePid = Number(panePidText);
    if (!Number.isInteger(panePid) || panePid <= 0 || paneId === undefined) {
      throw new Error(`Native Station tmux pane did not expose process identity: ${pane.stdout}`);
    }
    return { panePid, target: paneId };
  } catch (error) {
    await killTmuxSession(input.env, input.sessionName);
    throw error;
  }
}

export async function startStationTuiInTmux(input: {
  env: RealE2eEnvironment;
  configPath: string;
  sessionName: string;
}): Promise<void> {
  const command = [
    shellQuote(input.env.stationBin),
    "--config",
    shellQuote(input.configPath),
    "tui",
    "--popup",
  ].join(" ");
  await execFileAsync(
    requireToolPath(input.env, "tmux"),
    ["new-session", "-d", "-s", input.sessionName, command],
    { timeout: 10_000 },
  );
}

export async function displayStationPopupAndSendKey(input: {
  env: RealE2eEnvironment;
  configPath: string;
  target: string;
  key: string;
  markerPath: string;
  delaySeconds?: number;
}): Promise<void> {
  const delaySeconds = input.delaySeconds ?? 3;
  const ptyClient = await startAttachedTmuxPtyClient({
    env: input.env,
    sessionName: tmuxSessionFromTarget(input.target),
  });
  const popupCommand = [
    "exec",
    "env",
    `PATH=${shellQuote(dirname(process.execPath))}:$PATH`,
    "STATION_TUI_POPUP=1",
    "STATION_FOCUS_PROVIDER=tmux",
    `STATION_FOCUS_CLIENT_ID=${shellQuote(ptyClient.clientName)}`,
    shellQuote(input.env.stationBin),
    "--config",
    shellQuote(input.configPath),
    "tui",
    "--popup",
  ].join(" ");
  const popupScript = [
    `printf '%s\\n' popup-started > ${shellQuote(input.markerPath)}`,
    popupCommand,
  ].join("; ");
  let sendKeyDone: Promise<void> | undefined;
  const keyTimer = setTimeout(() => {
    sendKeyDone = ptyClient
      .write(Buffer.from(input.key, "utf8"))
      .then(() => appendFile(input.markerPath, "key-sent\n", "utf8"));
  }, delaySeconds * 1000);
  try {
    await execFileAsync(requireToolPath(input.env, "tmux"), ["select-pane", "-t", input.target], {
      timeout: 10_000,
    });
    await execFileAsync(
      requireToolPath(input.env, "tmux"),
      [
        "display-popup",
        "-t",
        ptyClient.clientName,
        "-w",
        "50%",
        "-h",
        "50%",
        "-E",
        `sh -lc ${shellQuote(popupScript)}`,
      ],
      { timeout: 120_000 },
    );
  } finally {
    clearTimeout(keyTimer);
    await sendKeyDone?.catch(() => undefined);
    await ptyClient.close();
  }
}

export async function sendTmuxKeys(input: {
  env: RealE2eEnvironment;
  target: string;
  keys: string[];
}): Promise<void> {
  await execFileAsync(
    requireToolPath(input.env, "tmux"),
    ["send-keys", "-t", input.target, ...input.keys],
    {
      timeout: 10_000,
    },
  );
}

export async function captureTmuxPane(input: {
  env: RealE2eEnvironment;
  target: string;
  styled?: boolean;
  preserveTrailingSpaces?: boolean;
  visibleOnly?: boolean;
}): Promise<string> {
  const args = ["capture-pane", "-p"];
  if (input.styled === true) args.push("-e");
  if (input.preserveTrailingSpaces === true) args.push("-N");
  args.push("-t", input.target);
  if (input.visibleOnly !== true) args.push("-S", "-80");
  const output = await execFileAsync(requireToolPath(input.env, "tmux"), args, {
    timeout: 10_000,
  });
  return output.stdout;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Attach a fixed-size terminal client and expose byte-accurate PTY input plus
 * bounded output tails for real keyboard/mouse acceptance diagnostics.
 */
export async function startAttachedTmuxPtyClient(input: {
  env: RealE2eEnvironment;
  sessionName: string;
  dimensions?: TmuxPtyDimensions;
  processEnv?: NodeJS.ProcessEnv;
}): Promise<AttachedTmuxPtyClient> {
  const tmux = requireToolPath(input.env, "tmux");
  const dimensions = input.dimensions ?? DEFAULT_PTY_DIMENSIONS;
  assertDimensions(dimensions);
  const child = spawn(
    "python3",
    [
      "-c",
      ptyBridgeScript,
      String(dimensions.rows),
      String(dimensions.columns),
      tmux,
      "attach-session",
      "-t",
      input.sessionName,
    ],
    {
      env: {
        ...(input.processEnv ?? process.env),
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const processId = child.pid;
  if (processId === undefined) {
    child.kill("SIGTERM");
    throw new Error("tmux PTY client did not expose a process id.");
  }
  let stdoutTail: Buffer = Buffer.alloc(0);
  let stderrTail: Buffer = Buffer.alloc(0);
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutTail = appendOutputTail(stdoutTail, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = appendOutputTail(stderrTail, chunk);
  });

  try {
    const clientName = await waitForTmuxClient({
      env: input.env,
      sessionName: input.sessionName,
      child,
      output: () => stdoutTail,
      stderr: () => stderrTail,
      spawnError: () => spawnError,
    });
    let closed = false;
    return {
      clientName,
      processId,
      write: (bytes) => writeChildInput(child, bytes),
      outputTail: () =>
        `\nPTY stdout tail:\n${stdoutTail.toString("utf8")}\nPTY stderr tail:\n${stderrTail.toString("utf8")}`,
      close: async () => {
        if (closed) return;
        closed = true;
        await execFileAsync(tmux, ["detach-client", "-t", clientName], {
          timeout: 2_000,
        }).catch(() => undefined);
        child.stdin?.end();
        await terminateChild(child, 2_000);
      },
    };
  } catch (error) {
    child.stdin?.end();
    await terminateChild(child, 1_000).catch(() => undefined);
    throw error;
  }
}

async function waitForTmuxClient(input: {
  env: RealE2eEnvironment;
  sessionName: string;
  child: ChildProcess;
  output: () => Buffer;
  stderr: () => Buffer;
  spawnError: () => Error | undefined;
}): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    if (
      input.spawnError() !== undefined ||
      input.child.exitCode !== null ||
      input.child.signalCode !== null
    ) {
      throw new Error(
        `tmux PTY client exited before attaching: ${input.spawnError()?.message ?? ""}${input.output().toString("utf8")}${input.stderr().toString("utf8")}`,
      );
    }
    try {
      const output = await execFileAsync(
        requireToolPath(input.env, "tmux"),
        ["list-clients", "-t", input.sessionName, "-F", "#{client_name}"],
        { timeout: 2_000 },
      );
      const clientName = output.stdout.trim().split(/\r?\n/).find(Boolean);
      if (clientName !== undefined) {
        return clientName;
      }
    } catch {
      // Keep polling until the PTY client appears or exits.
    }
    await delay(100);
  }
  throw new Error(
    `tmux PTY client did not attach before popup launch.\nstdout tail:\n${input.output().toString("utf8")}\nstderr tail:\n${input.stderr().toString("utf8")}`,
  );
}

async function writeChildInput(child: ChildProcess, bytes: Uint8Array): Promise<void> {
  const stdin = child.stdin;
  if (stdin === null || stdin.writable !== true) {
    throw new Error("tmux PTY client is not writable.");
  }
  await new Promise<void>((resolve, reject) => {
    stdin.write(bytes, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function terminateChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (await waitForChildExit(child, timeoutMs)) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, timeoutMs)) return;
  child.kill("SIGKILL");
  if (!(await waitForChildExit(child, timeoutMs))) {
    throw new Error(`tmux PTY client ${child.pid ?? "<unknown>"} survived SIGKILL.`);
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function appendOutputTail(current: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= OUTPUT_TAIL_BYTES
    ? combined
    : combined.subarray(combined.length - OUTPUT_TAIL_BYTES);
}

function assertDimensions(dimensions: TmuxPtyDimensions): void {
  if (
    !Number.isInteger(dimensions.columns) ||
    dimensions.columns <= 0 ||
    !Number.isInteger(dimensions.rows) ||
    dimensions.rows <= 0
  ) {
    throw new Error(
      `tmux PTY dimensions must be positive integers: ${dimensions.columns}x${dimensions.rows}`,
    );
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function tmuxSessionFromTarget(target: string): string {
  return target.split(":")[0] ?? target;
}
