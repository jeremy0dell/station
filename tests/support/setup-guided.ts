import { spawn } from "node:child_process";

export type GuidedPtyInput =
  | "y"
  | "n"
  | "enter"
  | "cancel"
  | `${number}`
  | `${number},${number}`
  | `select:${number}`
  | { readonly raw: string };

export type GuidedPtyResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly rawOutput: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly answersSent: number;
};

export type RunGuidedPtyOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly inputs: readonly GuidedPtyInput[];
  readonly rows?: number;
  readonly columns?: number;
  readonly timeoutMs?: number;
};

const rawModeMarker = "__STATION_GUIDED_PTY_RAW__\n";

export function runGuidedPty(options: RunGuidedPtyOptions): Promise<GuidedPtyResult> {
  const rows = options.rows ?? 24;
  const columns = options.columns ?? 100;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const bridge = spawn(
    "python3",
    ["-c", pythonPtyBridge, String(rows), String(columns), options.command, ...options.args],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const output: Buffer[] = [];
  let bridgeStderr = "";
  let markerBuffer = "";
  let answerIndex = 0;
  let timedOut = false;

  bridge.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  bridge.stderr.on("data", (chunk: Buffer) => {
    markerBuffer += chunk.toString("utf8");
    let markerIndex = markerBuffer.indexOf(rawModeMarker);
    while (markerIndex >= 0) {
      bridgeStderr += markerBuffer.slice(0, markerIndex);
      markerBuffer = markerBuffer.slice(markerIndex + rawModeMarker.length);
      const input = options.inputs[answerIndex];
      if (input !== undefined) {
        bridge.stdin.write(encodeGuidedInput(input));
        answerIndex += 1;
      }
      markerIndex = markerBuffer.indexOf(rawModeMarker);
    }
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      bridge.kill("SIGTERM");
      setTimeout(() => bridge.kill("SIGKILL"), 500).unref();
    }, timeoutMs);
    bridge.on("close", (exitCode) => {
      clearTimeout(timer);
      bridgeStderr += markerBuffer;
      const rawOutput = Buffer.concat(output).toString("utf8");
      resolve({
        exitCode,
        stdout: normalizeGuidedTranscript(rawOutput),
        rawOutput,
        stderr: bridgeStderr,
        timedOut,
        answersSent: answerIndex,
      });
    });
  });
}

export function normalizeGuidedTranscript(output: string): string {
  const withoutControls = stripTerminalControls(output)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const lines = withoutControls.split("\n").map((line) => normalizeRedrawnLine(line.trimEnd()));
  const normalized: string[] = [];
  for (const line of lines) {
    if (line === normalized.at(-1)) continue;
    normalized.push(line);
  }
  return `${normalized.join("\n").trim()}\n`;
}

function normalizeRedrawnLine(line: string): string {
  const submittedPrompt = line.lastIndexOf("◇  ");
  const guideSegments = line.split("│").length - 1;
  return submittedPrompt >= 0 && guideSegments > 1 ? line.slice(submittedPrompt) : line;
}

function stripTerminalControls(output: string): string {
  const escapeCharacter = String.fromCharCode(27);
  const bellCharacter = String.fromCharCode(7);
  let plain = "";
  let index = 0;
  while (index < output.length) {
    const character = output[index] ?? "";
    if (character === escapeCharacter && output[index + 1] === "[") {
      index += 2;
      while (index < output.length) {
        const code = output.charCodeAt(index);
        index += 1;
        if (code >= 64 && code <= 126) break;
      }
      continue;
    }
    if (character === escapeCharacter && output[index + 1] === "]") {
      index += 2;
      while (index < output.length) {
        if (output[index] === bellCharacter) {
          index += 1;
          break;
        }
        if (output[index] === escapeCharacter && output[index + 1] === "\\") {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }
    const code = output.charCodeAt(index);
    if (
      (code < 32 && character !== "\n" && character !== "\r" && character !== "\t") ||
      code === 127
    ) {
      index += 1;
      continue;
    }
    plain += character;
    index += 1;
  }
  return plain;
}

function encodeGuidedInput(input: GuidedPtyInput): string {
  if (typeof input === "object") return input.raw;
  if (input === "y" || input === "n") return input;
  if (input === "enter") return "\r";
  if (input === "cancel") return "\u0003";
  if (input.startsWith("select:")) {
    const selectedIndex = Number(input.slice("select:".length));
    return `${"\u001b[B".repeat(Math.max(0, selectedIndex - 1))}\r`;
  }
  const indexes = input.split(",").map(Number);
  if (indexes.some((index) => !Number.isInteger(index) || index < 1)) return "\r";
  let cursor = 1;
  let keys = "";
  for (const index of indexes) {
    const distance = index - cursor;
    keys += distance >= 0 ? "\u001b[B".repeat(distance) : "\u001b[A".repeat(-distance);
    keys += " ";
    cursor = index;
  }
  return `${keys}\r`;
}

const pythonPtyBridge = String.raw`
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

rows = int(sys.argv[1])
columns = int(sys.argv[2])
command = sys.argv[3]
arguments = sys.argv[3:]
child_pid, master_fd = pty.fork()
if child_pid == 0:
    os.execvpe(command, arguments, os.environ)

fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def terminate(_signal, _frame):
    try:
        os.killpg(child_pid, signal.SIGTERM)
    except ProcessLookupError:
        pass


signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
last_raw = False
stdin_open = True
while True:
    try:
        child_status = os.waitpid(child_pid, os.WNOHANG)
    except ChildProcessError:
        child_status = (child_pid, 0)
    if child_status[0] == child_pid:
        status = child_status[1]
        break
    try:
        raw = not bool(termios.tcgetattr(master_fd)[3] & termios.ICANON)
    except termios.error:
        raw = False
    if raw and not last_raw:
        os.write(2, b"__STATION_GUIDED_PTY_RAW__\n")
    last_raw = raw
    readers = [master_fd]
    if stdin_open:
        readers.append(0)
    ready, _, _ = select.select(readers, [], [], 0.01)
    if master_fd in ready:
        try:
            data = os.read(master_fd, 65536)
        except OSError:
            data = b""
        if data:
            os.write(1, data)
    if stdin_open and 0 in ready:
        data = os.read(0, 65536)
        if data:
            os.write(master_fd, data)
        else:
            stdin_open = False

try:
    while True:
        data = os.read(master_fd, 65536)
        if not data:
            break
        os.write(1, data)
except OSError:
    pass

if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
if os.WIFSIGNALED(status):
    sys.exit(128 + os.WTERMSIG(status))
sys.exit(1)
`;
