import { type ChildProcess, execFile, spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { RealE2eEnvironment } from "./env";
import { requireToolPath } from "./env";

const execFileAsync = promisify(execFile);
const ptyBridgeScript = `
import os
import pty
import select
import sys

pid, fd = pty.fork()
if pid == 0:
    os.environ.setdefault("TERM", "xterm-256color")
    os.execvp(sys.argv[1], sys.argv[1:])

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
  const ptyClient = await startTmuxPtyClient(input.env, tmuxSessionFromTarget(input.target));
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
    try {
      ptyClient.sendKey(input.key);
      sendKeyDone = appendFile(input.markerPath, "key-sent\n", "utf8");
    } catch (error) {
      sendKeyDone = Promise.reject(error);
    }
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
}): Promise<string> {
  const output = await execFileAsync(
    requireToolPath(input.env, "tmux"),
    ["capture-pane", "-p", "-t", input.target, "-S", "-80"],
    { timeout: 10_000 },
  );
  return output.stdout;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function startTmuxPtyClient(
  env: RealE2eEnvironment,
  sessionName: string,
): Promise<{ clientName: string; sendKey(key: string): void; close(): Promise<void> }> {
  const tmux = requireToolPath(env, "tmux");
  const child = spawn(
    "python3",
    ["-c", ptyBridgeScript, tmux, "attach-session", "-t", sessionName],
    {
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const clientName = await waitForTmuxClient(env, sessionName, child, output, stderr);
  return {
    clientName,
    sendKey: (key: string) => {
      if (child.stdin?.writable !== true) {
        throw new Error("tmux PTY client is not writable.");
      }
      child.stdin.write(key);
    },
    close: async () => {
      await execFileAsync(tmux, ["detach-client", "-t", clientName], { timeout: 2_000 }).catch(
        () => undefined,
      );
      child.stdin?.end();
      await waitForChildExit(child, 2_000);
    },
  };
}

async function waitForTmuxClient(
  env: RealE2eEnvironment,
  sessionName: string,
  child: ChildProcess,
  output: Buffer[],
  stderr: Buffer[],
): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `tmux PTY client exited before attaching: ${Buffer.concat(output).toString("utf8")}${Buffer.concat(stderr).toString("utf8")}`,
      );
    }
    try {
      const output = await execFileAsync(
        requireToolPath(env, "tmux"),
        ["list-clients", "-t", sessionName, "-F", "#{client_name}"],
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
  throw new Error("tmux PTY client did not attach before popup launch.");
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function tmuxSessionFromTarget(target: string): string {
  return target.split(":")[0] ?? target;
}
