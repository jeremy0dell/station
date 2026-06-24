import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTmuxPopup } from "../../src/popup";
import { shellQuote } from "../../src/shell";

const execFileAsync = promisify(execFile);
const runRealTmux = process.env.STATION_REAL_TMUX === "1";
const describeRealTmux = runRealTmux ? describe : describe.skip;
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

describeRealTmux("real tmux dev popup routing", () => {
  let tmux: string;
  let tempRoot: string;
  let wrapper: string;
  let ptyClient: Awaited<ReturnType<typeof startTmuxPtyClient>> | undefined;

  beforeAll(async () => {
    tmux = process.env.STATION_TMUX_BIN ?? "tmux";
    await execFileAsync(tmux, ["-V"], { timeout: 10_000 });
  });

  afterEach(async () => {
    await ptyClient?.close().catch(() => undefined);
    ptyClient = undefined;
    if (wrapper !== undefined) {
      await execFileAsync(wrapper, ["kill-server"], { timeout: 5_000 }).catch(() => undefined);
    }
  });

  it("plain popup routing attaches the registered dev UI and reuses its process", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "station-real-tmux-popup-"));
    wrapper = await writeTmuxWrapper({
      root: tempRoot,
      tmux,
      label: `stn-popup-${process.pid}-${Date.now()}`,
    });

    const baseSession = "base";
    const devSession = "_station-ui-dev-real";
    const normalSession = "_station-ui-normal";
    const devMarker = join(tempRoot, "dev-started.txt");
    const normalMarker = join(tempRoot, "normal-started.txt");
    const devCommand = persistentMarkerCommand(devMarker);
    const normalCommand = persistentMarkerCommand(normalMarker);

    await tmuxExec(wrapper, ["new-session", "-d", "-s", baseSession, "sleep 300"]);
    ptyClient = await startTmuxPtyClient({ tmux: wrapper, sessionName: baseSession });

    await setGlobalOption(wrapper, "@station_tui_dev_session_name", devSession);
    await setGlobalOption(wrapper, "@station_tui_dev_command", devCommand);
    await setGlobalOption(wrapper, "@station_tui_dev_owner", `${process.pid}:real-tmux`);
    await setGlobalOption(wrapper, "@station_tui_dev_root", tempRoot);

    await openAndCloseRegisteredPopup({
      tmux: wrapper,
      clientName: ptyClient.clientName,
      devCommand,
      expectedSession: devSession,
      registeredDevPopupRoot: tempRoot,
    });
    await waitForFileText(devMarker, "start\n");
    const firstDevPid = await panePid(wrapper, devSession);

    await openAndCloseRegisteredPopup({
      tmux: wrapper,
      clientName: ptyClient.clientName,
      devCommand,
      expectedSession: devSession,
      registeredDevPopupRoot: tempRoot,
    });
    const secondDevPid = await panePid(wrapper, devSession);
    const devStarts = await readFile(devMarker, "utf8");

    expect(secondDevPid).toBe(firstDevPid);
    expect(devStarts).toBe("start\n");

    await setGlobalOption(wrapper, "@station_tui_dev_owner", "999999999:stale");
    await openAndCloseRegisteredPopup({
      tmux: wrapper,
      clientName: ptyClient.clientName,
      devCommand: normalCommand,
      expectedSession: normalSession,
      registeredDevPopupRoot: tempRoot,
      uiSessionName: normalSession,
    });

    await expect(readFile(normalMarker, "utf8")).resolves.toBe("start\n");
  }, 60_000);
});

async function writeTmuxWrapper(input: {
  root: string;
  tmux: string;
  label: string;
}): Promise<string> {
  const wrapper = join(input.root, "tmux-wrapper.sh");
  await writeFile(
    wrapper,
    [
      "#!/bin/sh",
      `exec ${shellQuote(input.tmux)} -L ${shellQuote(input.label)} -f /dev/null "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(wrapper, 0o755);
  return wrapper;
}

async function openAndCloseRegisteredPopup(input: {
  tmux: string;
  clientName: string;
  devCommand: string;
  expectedSession: string;
  registeredDevPopupRoot?: string;
  uiSessionName?: string;
}): Promise<void> {
  let settled = false;
  const popup = openTmuxPopup({
    command: input.tmux,
    env: {
      STATION_FOCUS_CLIENT_ID: input.clientName,
    },
    preferRegisteredDevPopup: true,
    ...(input.registeredDevPopupRoot === undefined
      ? {}
      : { registeredDevPopupRoot: input.registeredDevPopupRoot }),
    timeoutMs: 10_000,
    tuiCommand: input.devCommand,
    ...(input.uiSessionName === undefined ? {} : { uiSessionName: input.uiSessionName }),
  }).finally(() => {
    settled = true;
  });

  await waitForTmuxSession(input.tmux, input.expectedSession);
  const deadline = Date.now() + 5_000;
  while (!settled && Date.now() < deadline) {
    await tmuxExec(input.tmux, ["display-popup", "-c", input.clientName, "-C"]).catch(
      () => undefined,
    );
    await delay(100);
  }
  await withTimeout(popup, 10_000, "tmux popup did not close after display-popup -C");
}

async function startTmuxPtyClient(input: {
  tmux: string;
  sessionName: string;
}): Promise<{ clientName: string; close(): Promise<void> }> {
  const child = spawn(
    "python3",
    ["-c", ptyBridgeScript, input.tmux, "attach-session", "-t", input.sessionName],
    {
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const clientName = await waitForTmuxClient({
    tmux: input.tmux,
    sessionName: input.sessionName,
    child,
    stdout,
    stderr,
  });
  return {
    clientName,
    close: async () => {
      await tmuxExec(input.tmux, ["detach-client", "-t", clientName]).catch(() => undefined);
      child.stdin?.end();
      await waitForChildExit(child, 2_000);
    },
  };
}

async function waitForTmuxClient(input: {
  tmux: string;
  sessionName: string;
  child: ChildProcess;
  stdout: Buffer[];
  stderr: Buffer[];
}): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (input.child.exitCode !== null) {
      throw new Error(
        `tmux client exited before attach: ${Buffer.concat(input.stdout).toString("utf8")}${Buffer.concat(input.stderr).toString("utf8")}`,
      );
    }
    const clients = await tmuxExec(input.tmux, [
      "list-clients",
      "-t",
      input.sessionName,
      "-F",
      "#{client_name}",
    ]).catch(() => "");
    const client = clients
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (client !== undefined) {
      return client;
    }
    await delay(100);
  }
  throw new Error("tmux client did not attach.");
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

async function waitForTmuxSession(tmux: string, sessionName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await tmuxExec(tmux, ["has-session", "-t", sessionName]);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`tmux session ${sessionName} did not appear.`);
}

async function waitForFileText(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text === expected) {
      return;
    }
    await delay(100);
  }
  throw new Error(`File ${path} did not contain expected text.`);
}

async function panePid(tmux: string, sessionName: string): Promise<string> {
  return tmuxExec(tmux, ["display-message", "-p", "-t", sessionName, "#{pane_pid}"]).then((text) =>
    text.trim(),
  );
}

async function setGlobalOption(tmux: string, name: string, value: string): Promise<void> {
  await tmuxExec(tmux, ["set-option", "-gq", name, value]);
}

async function tmuxExec(tmux: string, args: string[]): Promise<string> {
  const output = await execFileAsync(tmux, args, { timeout: 10_000 });
  return output.stdout;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function persistentMarkerCommand(markerPath: string): string {
  return `sh -c ${shellQuote(`printf 'start\\n' >> ${shellQuote(markerPath)}; while :; do sleep 1; done`)}`;
}
