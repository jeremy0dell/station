import { type ChildProcess, type ExecFileException, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

export type RealTmuxEndpoint = { rootPath: string; socketPath: string; wrapperPath: string };

type TmuxClientRecord = { name: string; pid: number; session: string };

export async function createRealTmuxEndpoint(env: RealE2eEnvironment): Promise<RealTmuxEndpoint> {
  const rootPath = await mkdtemp(join(tmpdir(), "stn-real-tmux-"));
  const socketPath = join(rootPath, "server.sock");
  const wrapperPath = join(rootPath, "tmux");
  const endpoint = { rootPath, socketPath, wrapperPath };
  let wrapperReady = false;
  try {
    await chmod(rootPath, 0o700);
    const wrapper = `#!/bin/sh\nexec ${shellQuote(requireToolPath(env, "tmux"))} -f /dev/null "$@"\n`;
    await writeFile(endpoint.wrapperPath, wrapper, "utf8");
    await chmod(endpoint.wrapperPath, 0o700);
    wrapperReady = true;
    const args = ["new-session", "-d", "-s", "_station-real-endpoint", "sleep 86400"];
    await runTmuxCommand(endpoint, args);
    return endpoint;
  } catch (error) {
    try {
      await (wrapperReady
        ? closeRealTmuxEndpoint(endpoint)
        : rm(rootPath, { recursive: true, force: true }));
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "tmux endpoint creation and cleanup failed");
    }
    throw error;
  }
}

export async function closeRealTmuxEndpoint(endpoint: RealTmuxEndpoint): Promise<void> {
  try {
    await runTmuxCommand(endpoint, ["kill-server"]);
  } catch (error) {
    if (!isExactEndpointAbsence(error, endpoint)) throw error;
  }
  try {
    await runTmuxCommand(endpoint, ["list-sessions"]);
  } catch (error) {
    if (!isExactEndpointAbsence(error, endpoint)) throw error;
    await rm(endpoint.rootPath, { recursive: true });
    return;
  }
  throw new Error(`tmux endpoint remained reachable after kill-server: ${endpoint.socketPath}`);
}
/**
 * An attached tmux client whose keyboard and mouse bytes cross a real PTY rather
 * than `tmux send-keys` or OpenTUI's test-renderer dispatch. `processId` is the
 * Python bridge PID, not tmux client identity.
 */
export type AttachedTmuxPtyClient = {
  clientName: string;
  clientPid: number;
  processId: number;
  sessionName: string;
  write(bytes: Uint8Array): Promise<void>;
  outputTail(): string;
  close(): Promise<void>;
};

export type NativeStationTmuxLaunch = {
  panePid: number;
  target: string;
};

export async function killTmuxSession(
  endpoint: RealTmuxEndpoint,
  sessionName: string,
): Promise<void> {
  try {
    await runTmuxCommand(endpoint, ["kill-session", "-t", `=${sessionName}`]);
  } catch (error) {
    const absent =
      isExactEndpointAbsence(error, endpoint) ||
      isExactTmuxFailure(error, 1, `can't find session: ${sessionName}`);
    if (!absent) throw error;
  }
  if (await tmuxSessionExists(endpoint, sessionName)) {
    throw new Error(`tmux session remained present after kill-session: ${sessionName}`);
  }
}

export type ExactTmuxSessionLoss = {
  sessionName: string;
  lostAt: string;
};

export async function tmuxSessionExists(
  endpoint: RealTmuxEndpoint,
  sessionName: string,
): Promise<boolean> {
  try {
    await runTmuxCommand(endpoint, ["has-session", "-t", `=${sessionName}`]);
    return true;
  } catch (error) {
    if (
      isExactEndpointAbsence(error, endpoint) ||
      isExactTmuxFailure(error, 1, `can't find session: ${sessionName}`)
    ) {
      return false;
    }
    throw error;
  }
}

export async function destroyExactTmuxSession(
  endpoint: RealTmuxEndpoint,
  sessionName: string,
): Promise<ExactTmuxSessionLoss> {
  if (!(await tmuxSessionExists(endpoint, sessionName))) {
    throw new Error(`tmux session did not exist before terminal loss: ${sessionName}`);
  }
  const lostAt = new Date().toISOString();
  await runTmuxCommand(endpoint, ["kill-session", "-t", `=${sessionName}`]);
  if (await tmuxSessionExists(endpoint, sessionName)) {
    throw new Error(`tmux session remained present after terminal loss: ${sessionName}`);
  }
  return { sessionName, lostAt };
}

export async function killTmuxWindow(endpoint: RealTmuxEndpoint, target: string): Promise<void> {
  await runTmuxCommand(endpoint, ["kill-window", "-t", target]);
}

export async function listTmuxWindows(
  endpoint: RealTmuxEndpoint,
  sessionName: string,
): Promise<string[]> {
  const args = ["list-windows", "-t", sessionName, "-F", "#{window_name}"];
  const output = await runTmuxCommand(endpoint, args);
  return output.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function activeTmuxPane(endpoint: RealTmuxEndpoint, target: string): Promise<string> {
  const args = ["display-message", "-p", "-t", target, "#{pane_id}"];
  return (await runTmuxCommand(endpoint, args)).stdout.trim();
}

export async function inspectTmuxClient(
  endpoint: RealTmuxEndpoint,
  clientName: string,
): Promise<string> {
  const format = "#{client_name}\t#{client_pid}\t#{session_name}\t#{window_name}\t#{pane_id}";
  const args = ["display-message", "-p", "-c", clientName, format];
  return (await runTmuxCommand(endpoint, args)).stdout.replace(/\r?\n$/u, "");
}

/**
 * Launch bare `stn` as the native renderer while tmux supplies only a fixed-size
 * PTY and capture envelope; the Station process never receives tmux context.
 */
export async function launchNativeStationInTmux(input: {
  env: RealE2eEnvironment;
  endpoint: RealTmuxEndpoint;
  configPath: string;
  observerSocketPath: string;
  stateDir: string;
  sessionName: string;
  cwd?: string;
  dimensions?: TmuxPtyDimensions;
}): Promise<NativeStationTmuxLaunch> {
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

  let sessionCreated = false;
  try {
    await runTmuxCommand(input.endpoint, args);
    sessionCreated = true;
    // Tmux must decode and forward the attached client's SGR stream before native OpenTUI can receive it.
    await runTmuxCommand(input.endpoint, ["set-option", "-t", input.sessionName, "mouse", "on"]);
    const paneArgs = ["display-message", "-p", "-t", input.sessionName, "#{pane_pid}\t#{pane_id}"];
    const pane = await runTmuxCommand(input.endpoint, paneArgs);
    const [panePidText, paneId] = pane.stdout.trim().split("\t");
    const panePid = Number(panePidText);
    if (!Number.isInteger(panePid) || panePid <= 0 || paneId === undefined) {
      throw new Error(`Native Station tmux pane did not expose process identity: ${pane.stdout}`);
    }
    return { panePid, target: paneId };
  } catch (error) {
    if (!sessionCreated) throw error;
    try {
      await killTmuxSession(input.endpoint, input.sessionName);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "native tmux launch and cleanup failed");
    }
    throw error;
  }
}

export async function startStationTuiInTmux(input: {
  env: RealE2eEnvironment;
  endpoint: RealTmuxEndpoint;
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
  await runTmuxCommand(input.endpoint, ["new-session", "-d", "-s", input.sessionName, command]);
}

/**
 * Own one real popup invocation through start, input, renderer exit, and explicit
 * release. Failed proofs close only that exact client popup; successful
 * focus proofs may provide the exact post-focus tmux view expected before cleanup.
 */
export async function displayStationPopupAndSendKey(input: {
  env: RealE2eEnvironment;
  endpoint: RealTmuxEndpoint;
  client: AttachedTmuxPtyClient;
  configPath: string;
  target: string;
  expectedWindowName: string;
  expectedPaneId: string;
  key: string;
  markerPath: string;
  delaySeconds?: number;
}): Promise<{
  release(
    causalSuccess: boolean,
    finalView?: { windowName: string; paneId: string },
  ): Promise<void>;
}> {
  const { client, endpoint } = input;
  const invocationNonce = randomUUID();
  const releasePath = `${input.markerPath}.${invocationNonce}.release`;
  if (client.sessionName !== (input.target.split(":")[0] ?? input.target)) {
    throw new Error(
      `popup client ${client.clientName}/${client.clientPid}/${client.sessionName} is not in target ${input.target} on ${endpoint.socketPath}${client.outputTail()}`,
    );
  }
  const checkView = async (
    phase: string,
    view = { windowName: input.expectedWindowName, paneId: input.expectedPaneId },
  ): Promise<void> => {
    const actual = await inspectTmuxClient(endpoint, client.clientName);
    const expected = `${client.clientName}\t${client.clientPid}\t${client.sessionName}\t${view.windowName}\t${view.paneId}`;
    if (actual !== expected) {
      throw new Error(
        `popup client changed ${phase} endpoint=${endpoint.socketPath} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}${client.outputTail()}`,
      );
    }
  };
  await checkView("before display");
  const startMarker = `popup-started:${client.clientName}:${client.clientPid}:${input.target}:${invocationNonce}`;
  const popupCommand = [
    "env",
    `PATH=${shellQuote(dirname(process.execPath))}:$PATH`,
    "STATION_TUI_POPUP=1",
    "STATION_FOCUS_PROVIDER=tmux",
    `STATION_FOCUS_CLIENT_ID=${shellQuote(client.clientName)}`,
    shellQuote(input.env.stationBin),
    "--config",
    shellQuote(input.configPath),
    "tui",
    "--popup",
  ].join(" ");
  const popupScript = [
    `printf '%s\\n' ${shellQuote(startMarker)} > ${shellQuote(input.markerPath)}`,
    popupCommand,
    "child_status=$?",
    `printf 'child-exit:%s\\n' "$child_status" >> ${shellQuote(input.markerPath)}`,
    `while [ ! -e ${shellQuote(releasePath)} ]; do sleep 0.05; done`,
    'exit "$child_status"',
  ].join("; ");
  const popupArgs = [
    "display-popup",
    "-c",
    client.clientName,
    "-t",
    input.target,
    "-w",
    "50%",
    "-h",
    "50%",
    "-E",
    `sh -lc ${shellQuote(popupScript)}`,
  ];
  let settlementError: unknown;
  let settled = false;
  const settlement = runTmuxCommand(endpoint, popupArgs, 120_000)
    .catch((error: unknown) => {
      settlementError = error;
    })
    .finally(() => {
      settled = true;
    });
  let keyAttempted = false;
  let markerEvidence = "<unread>";
  let releaseEvidence = "release=not-attempted";
  let releasePromise: Promise<void> | undefined;
  const release = (
    causalSuccess: boolean,
    finalView?: { windowName: string; paneId: string },
  ): Promise<void> => {
    releasePromise ??= (async () => {
      const failures: unknown[] = [];
      let closeState = "not-attempted";
      const closePopup = async (): Promise<void> => {
        closeState = "failed";
        try {
          await runTmuxCommand(endpoint, ["display-popup", "-c", client.clientName, "-C"]);
          closeState = "ok";
        } catch (error) {
          failures.push(error);
        }
      };
      if (!causalSuccess) await closePopup();
      let gateWritten = false;
      try {
        await writeFile(releasePath, "release\n", { encoding: "utf8", flag: "wx" });
        gateWritten = true;
      } catch (error) {
        failures.push(error);
      }
      if (!gateWritten && closeState === "not-attempted") await closePopup();
      await settlement;
      try {
        markerEvidence = await readMarker(input.markerPath);
      } catch (error) {
        failures.push(error);
        markerEvidence = "<unreadable>";
      }
      const markerExact =
        markerEvidence === `${startMarker}\nkey-sent\nchild-exit:0\n` ||
        markerEvidence === `${startMarker}\nchild-exit:0\nkey-sent\n`;
      if (causalSuccess && !markerExact) {
        failures.push(new Error(`popup marker or child exit was not exact: ${markerEvidence}`));
      }
      let viewExact = false;
      try {
        await checkView("after release", finalView);
        viewExact = true;
      } catch (error) {
        failures.push(error);
      }
      const causalEvidence =
        causalSuccess && gateWritten && closeState === "not-attempted" && markerExact && viewExact;
      if (
        settlementError !== undefined &&
        !(causalEvidence && isExactTmuxFailure(settlementError, 129, ""))
      ) {
        failures.push(settlementError);
      }
      if (failures.length > 0 && closeState === "not-attempted") await closePopup();
      releaseEvidence = `gate=${gateWritten ? "ok" : "failed"} close=${closeState} settlement=${settlementError === undefined ? "ok" : "failed"}`;
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `real tmux popup release failed ${releaseEvidence} marker=${JSON.stringify(markerEvidence)}${client.outputTail()}`,
        );
      }
    })();
    return releasePromise;
  };
  try {
    await waitForPopupStart(input.markerPath, startMarker, () => settled);
    await waitForPopupDelay(
      input.markerPath,
      startMarker,
      (input.delaySeconds ?? 3) * 1000,
      () => settled,
    );
    if ((await readMarker(input.markerPath)) !== `${startMarker}\n`) {
      throw new Error("popup Station child exited before delayed input");
    }
    await checkView("before input");
    if (settled) throw new Error("popup settled immediately before input");
    keyAttempted = true;
    await client.write(Buffer.from(input.key, "utf8"));
    await appendFile(input.markerPath, "key-sent\n", "utf8");
  } catch (error) {
    const failures: unknown[] = [error];
    await release(false).catch((releaseError: unknown) => {
      failures.push(releaseError);
    });
    throw new AggregateError(
      failures,
      `real tmux popup failed endpoint=${endpoint.socketPath} client=${client.clientName}/${client.clientPid}/${client.sessionName} target=${input.target} key=${keyAttempted ? "attempting" : "not-attempted"} ${releaseEvidence} marker=${JSON.stringify(markerEvidence)}${client.outputTail()}`,
    );
  }

  return { release };
}

async function waitForPopupStart(
  markerPath: string,
  startMarker: string,
  settled: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let marker = "";
  while (Date.now() < deadline) {
    marker = await readMarker(markerPath);
    if (marker === `${startMarker}\n`) return;
    if (settled()) throw new Error(`popup settled before its start marker: ${marker}`);
    await delay(Math.min(50, deadline - Date.now()));
  }
  throw new Error(`popup start marker timed out: ${markerPath} marker=${JSON.stringify(marker)}`);
}

async function waitForPopupDelay(
  markerPath: string,
  startMarker: string,
  delayMs: number,
  settled: () => boolean,
): Promise<void> {
  const deadline = Date.now() + delayMs;
  while (Date.now() < deadline) {
    if (settled()) throw new Error("popup settled during the post-start delay");
    const marker = await readMarker(markerPath);
    if (marker !== `${startMarker}\n`)
      throw new Error(`popup marker changed before input: ${marker}`);
    await delay(Math.min(50, deadline - Date.now()));
  }
}

export async function sendTmuxKeys(input: {
  endpoint: RealTmuxEndpoint;
  target: string;
  keys: string[];
}): Promise<void> {
  await runTmuxCommand(input.endpoint, ["send-keys", "-t", input.target, ...input.keys]);
}

export async function captureTmuxPane(input: {
  endpoint: RealTmuxEndpoint;
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
  const output = await runTmuxCommand(input.endpoint, args);
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
  endpoint: RealTmuxEndpoint;
  sessionName: string;
  dimensions?: TmuxPtyDimensions;
  processEnv?: NodeJS.ProcessEnv;
}): Promise<AttachedTmuxPtyClient> {
  const { endpoint, sessionName } = input;
  const dimensions = input.dimensions ?? DEFAULT_PTY_DIMENSIONS;
  assertDimensions(dimensions);
  const baseline = await listTmuxClients(endpoint, sessionName);
  const child = spawn(
    "python3",
    [
      "-c",
      ptyBridgeScript,
      String(dimensions.rows),
      String(dimensions.columns),
      endpoint.wrapperPath,
      "-S",
      endpoint.socketPath,
      "attach-session",
      "-t",
      sessionName,
    ],
    {
      env: controllerEnvironment({
        ...(input.processEnv ?? process.env),
        TERM: "xterm-256color",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdoutTail: Buffer = Buffer.alloc(0);
  let stderrTail: Buffer = Buffer.alloc(0);
  let spawnError: Error | undefined;
  const childClose = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutTail = appendOutputTail(stdoutTail, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = appendOutputTail(stderrTail, chunk);
  });
  const outputTail = () =>
    `\nPTY stdout tail:\n${stdoutTail.toString("utf8")}\nPTY stderr tail:\n${stderrTail.toString("utf8")}`;
  const processId = child.pid;

  try {
    if (processId === undefined) {
      throw new Error("tmux PTY client did not expose a process id.");
    }
    const client = await waitForTmuxClient(
      endpoint,
      sessionName,
      baseline,
      child,
      () => spawnError,
      outputTail,
    );
    let closed = false;
    return {
      clientName: client.name,
      clientPid: client.pid,
      processId,
      sessionName: client.session,
      write: (bytes) => writeChildInput(child, bytes),
      outputTail,
      close: async () => {
        if (closed) return;
        closed = true;
        const failures: unknown[] = [];
        try {
          const view = await inspectTmuxClient(endpoint, client.name);
          if (!view.startsWith(`${client.name}\t${client.pid}\t${client.session}\t`)) {
            throw new Error(
              `tmux PTY client identity changed before detach expected=${JSON.stringify(client)} actual=${JSON.stringify(view)}`,
            );
          }
          await runTmuxCommand(endpoint, ["detach-client", "-t", client.name], 2_000);
        } catch (error) {
          failures.push(error);
        }
        child.stdin?.end();
        try {
          await terminateChild(child, childClose, 2_000);
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            `tmux PTY client cleanup failed endpoint=${endpoint.socketPath} client=${client.name}/${client.pid}/${client.session}${outputTail()}`,
          );
        }
      },
    };
  } catch (error) {
    const failures: unknown[] = [error];
    child.stdin?.end();
    await terminateChild(child, childClose, 1_000).catch((cleanupError: unknown) => {
      failures.push(cleanupError);
    });
    if (spawnError !== undefined) failures.push(spawnError);
    throw new AggregateError(
      failures,
      `tmux PTY client attachment failed endpoint=${endpoint.socketPath} session=${sessionName}${outputTail()}`,
    );
  }
}

async function waitForTmuxClient(
  endpoint: RealTmuxEndpoint,
  sessionName: string,
  baseline: TmuxClientRecord[],
  child: ChildProcess,
  spawnError: () => Error | undefined,
  evidence: () => string,
): Promise<TmuxClientRecord> {
  const baselineByName = new Map(baseline.map((record) => [record.name, record.pid]));
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    if (spawnError() !== undefined || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `tmux PTY client exited before attaching: ${spawnError()?.message ?? ""}${evidence()}`,
      );
    }
    const current = await listTmuxClients(endpoint, sessionName);
    if (
      current.filter((record) => baselineByName.get(record.name) === record.pid).length !==
      baseline.length
    ) {
      throw new Error(
        `tmux client baseline changed during PTY attach baseline=${JSON.stringify(baseline).slice(0, 4096)} current=${JSON.stringify(current).slice(0, 4096)}`,
      );
    }
    const candidates = current.filter((record) => !baselineByName.has(record.name));
    if (candidates.length > 1) {
      throw new Error(
        `tmux PTY attach admitted multiple clients: ${JSON.stringify(candidates).slice(0, 4096)}`,
      );
    }
    const candidate = candidates[0];
    if (candidate !== undefined) return candidate;
    await delay(100);
  }
  throw new Error(`tmux PTY client did not attach before popup launch.${evidence()}`);
}

async function writeChildInput(child: ChildProcess, bytes: Uint8Array): Promise<void> {
  const stdin = child.stdin;
  if (stdin === null || stdin.writable !== true) {
    throw new Error("tmux PTY client is not writable.");
  }
  await new Promise<void>((resolve, reject) => {
    stdin.write(bytes, (error) => (error == null ? resolve() : reject(error)));
  });
}

async function terminateChild(
  child: ChildProcess,
  childClose: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (await waitForChildClose(childClose, timeoutMs)) return;
  child.kill("SIGTERM");
  if (await waitForChildClose(childClose, timeoutMs)) return;
  child.kill("SIGKILL");
  if (!(await waitForChildClose(childClose, timeoutMs))) {
    throw new Error(`tmux PTY client ${child.pid ?? "<unknown>"} survived SIGKILL.`);
  }
}

async function waitForChildClose(childClose: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    childClose.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
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

async function runTmuxCommand(
  endpoint: RealTmuxEndpoint,
  args: string[],
  timeoutMs = 10_000,
): Promise<{ stderr: string; stdout: string }> {
  return execFileAsync(endpoint.wrapperPath, ["-S", endpoint.socketPath, ...args], {
    encoding: "utf8",
    env: controllerEnvironment(process.env),
    timeout: timeoutMs,
  });
}

function controllerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

async function listTmuxClients(
  endpoint: RealTmuxEndpoint,
  sessionName: string,
): Promise<TmuxClientRecord[]> {
  const format = "#{client_name}\t#{client_pid}\t#{session_name}";
  const args = ["list-clients", "-t", sessionName, "-F", format];
  const serialized = (await runTmuxCommand(endpoint, args, 2_000)).stdout.replace(/\r?\n$/u, "");
  if (serialized.length === 0) return [];
  return serialized.split("\n").map((line) => {
    const match = /^([^\t\n]+)\t([1-9]\d*)\t([^\t\n]+)$/u.exec(line);
    if (match === null || match[3] !== sessionName) {
      throw new Error(`Malformed tmux client record for ${sessionName}: ${line}`);
    }
    return { name: match[1] as string, pid: Number(match[2]), session: match[3] };
  });
}

async function readMarker(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).slice(-OUTPUT_TAIL_BYTES);
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function isExactEndpointAbsence(error: unknown, endpoint: RealTmuxEndpoint): boolean {
  return [
    `no server running on ${endpoint.socketPath}`,
    `error connecting to ${endpoint.socketPath} (No such file or directory)`,
  ].some((diagnostic) => isExactTmuxFailure(error, 1, diagnostic));
}

function isExactTmuxFailure(error: unknown, code: number, diagnostic: string): boolean {
  if (!(error instanceof Error)) return false;
  const failure = error as ExecFileException;
  const stderr = String(failure.stderr ?? "");
  return (
    failure.code === code &&
    failure.signal == null &&
    failure.killed !== true &&
    String(failure.stdout ?? "") === "" &&
    (diagnostic === "" ? stderr === "" : stderr.replace(/\r?\n$/u, "") === diagnostic)
  );
}
