#!/usr/bin/env node

const nodePty = require("node-pty");
const readline = require("node:readline");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { PtyBridgeAdoptCommandSchema } = require("@station/contracts");

// xterm.js silently clamps resize to these minima; the bridge clamps to the
// same values so the PTY and the VT screen model can never disagree on size.
// node-pty itself throws on cols/rows <= 0, which previously killed the
// bridge (and the user's shell) when the pane collapsed to zero height.
const MIN_COLS = 2;
const MIN_ROWS = 1;

// Parked-output budget mirrors the host's scrollback ring so an adoption's
// backlog cannot grow the bridge without bound.
const PARK_MAX_BYTES = 256 * 1024;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
// An exited parked bridge only needs to outlive the window in which a new
// owner can read its exit status; the full TTL is for live PTYs.
const EXITED_RETENTION_MS = 5 * 60 * 1000;
const SOCKET_RETRY_MS = 30 * 1000;
const SOCKET_PROBE_TIMEOUT_MS = 1000;
// Fallback for owners too old to pass bridgeProtocol in the spawn options;
// current owners always send it, keeping this file free of a hardcoded twin.
const BRIDGE_CONTROL_PROTOCOL = 2;

const encodedOptions = process.argv[2] === "__pty-bridge" ? process.argv[3] : process.argv[2];

if (!encodedOptions) {
  process.stderr.write("Missing node-pty bridge options.\n");
  process.exit(2);
}

// If Station dies, our stdout pipe breaks; an unhandled EPIPE here would
// crash the bridge before the stdin-close path can shut the pty down cleanly.
process.stdout.on("error", () => {});

let ptyExited = false;
let exitEvent = null;
let sigtermed = false;

// Options arrive base64url-encoded from the owner; a malformed blob must exit
// the bridge before any PTY exists rather than throw mid-startup.
let options;
try {
  options = JSON.parse(Buffer.from(encodedOptions, "base64url").toString("utf8"));
} catch (error) {
  process.stderr.write(
    `Unparseable node-pty bridge options: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}

// Parseable is not a shape guarantee: a JSON value without command/args must
// never reach node-pty, where an options-less spawn starts a default shell.
if (
  options === null ||
  typeof options !== "object" ||
  typeof options.command !== "string" ||
  !Array.isArray(options.args)
) {
  process.stderr.write("Invalid node-pty bridge options shape.\n");
  process.exit(2);
}

// Orphan mode is opt-in per spawn: with it, owner-pipe EOF parks the PTY
// behind a control socket instead of killing it. A malformed orphan block
// degrades to legacy behavior rather than risking the PTY at spawn time.
let orphan = options.orphan;
if (
  orphan !== undefined &&
  (typeof orphan.controlSocketPath !== "string" ||
    typeof orphan.parkStatePath !== "string" ||
    !Number.isInteger(orphan.ttlMs) ||
    orphan.ttlMs <= 0 ||
    typeof orphan.ptyInstanceId !== "string" ||
    orphan.ptyInstanceId.length === 0 ||
    (orphan.parkMaxBytes !== undefined &&
      (!Number.isInteger(orphan.parkMaxBytes) || orphan.parkMaxBytes <= 0)))
) {
  process.stderr.write("Ignoring malformed orphan options; falling back to owned mode.\n");
  orphan = undefined;
}

// Orphan-mode state. `mode` moves owned -> parked -> adopted and back to
// parked whenever an adopter dies without killing the PTY.
let mode = "owned";
let adopterSocket = null;
let server = null;
let serverBound = false;
let serverReclaimScheduled = false;
let tornDown = false;
let killRequested = false;
let orphanedAtMs = 0;
let ttlTimer = null;
let heartbeatTimer = null;
let exitedRetentionTimer = null;
const parkedChunks = [];
let parkedBytes = 0;
let parkedEvicted = false;

const pty = nodePty.spawn(options.command, options.args, {
  cttyHelperPath: options.cttyHelperPath,
  cols: clampDimension(options.cols, MIN_COLS),
  cwd: options.cwd,
  env: options.env,
  name: options.name,
  rows: clampDimension(options.rows, MIN_ROWS),
});
let currentCols = clampDimension(options.cols, MIN_COLS);
let currentRows = clampDimension(options.rows, MIN_ROWS);

send({
  type: "ready",
  pid: pty.pid,
  bridgePid: process.pid,
});

pty.onData((data) => {
  if (mode === "owned") {
    send({
      type: "data",
      data,
    });
    return;
  }
  if (mode === "parked") {
    parkData(data);
    return;
  }
  if (adopterSocket !== null) {
    controlSend(adopterSocket, {
      type: "data",
      data,
    });
  }
});

pty.onExit((event) => {
  ptyExited = true;
  // node-pty reports signal 0 on a clean code exit; normalize so an absent
  // signal means "exited by code" across exit frames, status, and park state.
  exitEvent = { exitCode: event.exitCode };
  if (event.signal) {
    exitEvent.signal = event.signal;
  }
  if (mode === "owned") {
    // Unchanged drain sequence; with orphan enabled the stdin-close handler
    // below transitions into park instead of exiting.
    send({
      type: "exit",
      exitCode: exitEvent.exitCode,
      signal: exitEvent.signal,
    });
    // process.exit() would discard stdout's buffered backlog, truncating the
    // final output burst of short-lived commands; close the inputs and let the
    // process drain stdout and exit naturally.
    process.exitCode = 0;
    commands.close();
    process.stdin.destroy();
    process.stdout.end();
    return;
  }
  if (mode === "parked") {
    writeParkState();
    restartTtlTimer(EXITED_RETENTION_MS);
    return;
  }
  if (adopterSocket !== null) {
    controlSend(adopterSocket, {
      type: "exit",
      exitCode: exitEvent.exitCode,
      signal: exitEvent.signal,
    });
    // The adopter is expected to dispose after seeing exit; do not linger
    // indefinitely with a dead PTY if it never does.
    exitedRetentionTimer = setTimeout(() => {
      teardownAndExit();
    }, EXITED_RETENTION_MS);
    return;
  }
  // Adopter already gone (dispose raced its kill): complete the teardown.
  teardownAndExit();
});

const commands = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

commands.on("line", (line) => {
  // A malformed or unsupported command must never take down the bridge: the
  // user's shell lives and dies with this process.
  try {
    const command = JSON.parse(line);

    switch (command.type) {
      case "write":
        pty.write(command.data);
        break;
      case "resize":
        currentCols = clampDimension(command.cols, MIN_COLS);
        currentRows = clampDimension(command.rows, MIN_ROWS);
        pty.resize(currentCols, currentRows);
        break;
      case "kill":
        pty.kill(command.signal);
        break;
    }
  } catch (error) {
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

// stdin closing means the Station process is gone (crash, SIGKILL, HMR churn).
// Without orphan mode the pty must die with its owner or shells orphan; the
// exit backstop is unref'd so a successful pty.kill -> onExit drain path still
// controls the final exit. With orphan mode a non-SIGTERM EOF parks the PTY
// for a new owner (a SIGTERM first means an intentional disposal, which keeps
// the legacy kill path).
commands.on("close", () => {
  if (orphan !== undefined && !sigtermed) {
    enterPark();
    return;
  }
  if (ptyExited) {
    return;
  }
  pty.kill();
  setTimeout(() => {
    process.exit(0);
  }, 500).unref();
});

process.on("SIGTERM", () => {
  sigtermed = true;
  if (orphan !== undefined && mode !== "owned") {
    // Intentional reap of a parked/adopted bridge: kill the PTY and remove
    // every durable trace instead of re-parking.
    if (!ptyExited) {
      pty.kill();
    }
    setTimeout(() => {
      teardownAndExit();
    }, 500);
    return;
  }
  pty.kill();
});

function send(message) {
  const flushed = process.stdout.write(`${JSON.stringify(message)}\n`);
  if (!flushed) {
    // Let the kernel pty buffer absorb bursts instead of growing our heap;
    // also keeps the downstream VT parser far from its discard watermark.
    pty.pause();
    process.stdout.once("drain", () => {
      pty.resume();
    });
  }
}

function enterPark() {
  if (mode !== "owned") {
    return;
  }
  mode = "parked";
  orphanedAtMs = Date.now();
  // A pre-park stdout backpressure pause would otherwise starve the PTY once
  // the dead owner pipe stops draining.
  pty.resume();
  writeParkState();
  listenControlSocket();
  heartbeatTimer = setInterval(() => {
    writeParkState();
  }, HEARTBEAT_INTERVAL_MS);
  restartTtlTimer();
}

function writeParkState() {
  if (orphan === undefined) {
    return;
  }
  const state = {
    v: 2,
    bridgePid: process.pid,
    pid: pty.pid,
    controlSocket: orphan.controlSocketPath,
    command: options.command,
    cols: currentCols,
    rows: currentRows,
    ptyInstanceId: orphan.ptyInstanceId,
    identity: orphan.identity,
    orphanedAtMs,
    ttlMs: orphan.ttlMs,
    heartbeatAtMs: Date.now(),
    exited: ptyExited,
  };
  if (exitEvent !== null) {
    state.exitCode = exitEvent.exitCode;
    if (exitEvent.signal !== undefined) {
      state.signal = exitEvent.signal;
    }
  }
  try {
    fs.mkdirSync(path.dirname(orphan.parkStatePath), { recursive: true });
    const tmpPath = `${orphan.parkStatePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(state)}\n`);
    fs.renameSync(tmpPath, orphan.parkStatePath);
  } catch {
    // Park state is adoption evidence, not serving state; keep the PTY alive
    // even if the filesystem disagrees.
  }
}

function listenControlSocket() {
  if (tornDown) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(orphan.controlSocketPath), { recursive: true });
  } catch {
    // Best-effort: the listen below reports the real failure.
  }
  server = net.createServer(handleControlConnection);
  server.on("listening", () => {
    serverBound = true;
  });
  server.on("error", (error) => {
    if (tornDown) {
      return;
    }
    if (error.code === "EADDRINUSE") {
      reclaimOrRetrySocket();
      return;
    }
    // Unusual listen failures leave the PTY alive but not adoptable; the TTL
    // still bounds the park. Persist a content-free diagnostic beside the park.
    try {
      fs.writeFileSync(
        `${orphan.parkStatePath}.listen-error`,
        `${error && error.code ? error.code : "error"}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } catch {
      // Ignore diagnostic write failures.
    }
  });
  server.listen(orphan.controlSocketPath);
}

function reclaimOrRetrySocket() {
  if (serverReclaimScheduled || mode === "owned" || tornDown) {
    return;
  }
  serverReclaimScheduled = true;
  probeControlSocket(orphan.controlSocketPath, (alive) => {
    const retry = () => {
      setTimeout(() => {
        serverReclaimScheduled = false;
        listenControlSocket();
      }, alive ? SOCKET_RETRY_MS : 50);
    };
    if (alive) {
      // A live bridge already owns this identity; wait for it to move on.
      retry();
      return;
    }
    fs.unlink(orphan.controlSocketPath, () => {
      retry();
    });
  });
}

function probeControlSocket(socketPath, done) {
  let settled = false;
  const finish = (alive) => {
    if (settled) {
      return;
    }
    settled = true;
    done(alive);
  };
  const probe = net.connect(socketPath);
  const timer = setTimeout(() => {
    probe.destroy();
    finish(false);
  }, SOCKET_PROBE_TIMEOUT_MS);
  probe.on("connect", () => {
    probe.write(`${JSON.stringify({ type: "exit-status" })}\n`);
  });
  probe.on("data", () => {
    clearTimeout(timer);
    probe.destroy();
    finish(true);
  });
  probe.on("error", () => {
    clearTimeout(timer);
    probe.destroy();
    finish(false);
  });
}

function handleControlConnection(socket) {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      // A malformed control command must never take down a parked bridge.
      try {
        handleControlCommand(socket, JSON.parse(line));
      } catch (error) {
        controlSend(socket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    if (socket === adopterSocket) {
      onAdopterClose();
    }
  });
}

function handleControlCommand(socket, command) {
  switch (command.type) {
    case "exit-status":
      controlSend(socket, statusMessage());
      return;
    case "adopt": {
      const parsed = PtyBridgeAdoptCommandSchema.safeParse(command);
      if (!parsed.success) {
        controlSend(socket, {
          type: "error",
          code: "INVALID_ADOPT_COMMAND",
          message: "The PTY bridge adoption request is invalid.",
        });
        socket.end();
        return;
      }
      if (parsed.data.ptyInstanceId !== orphan.ptyInstanceId) {
        controlSend(socket, {
          type: "error",
          code: "PTY_INSTANCE_MISMATCH",
          message: "The requested PTY instance does not own this parked bridge.",
        });
        socket.end();
        return;
      }
      if (mode === "adopted") {
        if (socket === adopterSocket) {
          // A duplicate adopt on the owning socket is idempotent: resend the
          // status rather than severing the adopter's own connection.
          controlSend(socket, statusMessage());
          return;
        }
        controlSend(socket, {
          type: "error",
          code: "ALREADY_ADOPTED",
          message: "The parked bridge already has an owner.",
        });
        socket.end();
        return;
      }
      adopterSocket = socket;
      mode = "adopted";
      killRequested = false;
      clearParkTimers();
      controlSend(socket, statusMessage());
      for (const data of parkedChunks) {
        controlSend(socket, { type: "data", data });
      }
      parkedChunks.length = 0;
      parkedBytes = 0;
      if (ptyExited && exitEvent !== null) {
        controlSend(socket, {
          type: "exit",
          exitCode: exitEvent.exitCode,
          signal: exitEvent.signal,
        });
      }
      return;
    }
    case "write":
      if (socket !== adopterSocket) {
        controlSend(socket, notAdopterError());
        return;
      }
      if (!ptyExited) {
        pty.write(command.data);
      }
      return;
    case "resize":
      if (socket !== adopterSocket) {
        controlSend(socket, notAdopterError());
        return;
      }
      currentCols = clampDimension(command.cols, MIN_COLS);
      currentRows = clampDimension(command.rows, MIN_ROWS);
      if (!ptyExited) {
        pty.resize(currentCols, currentRows);
      }
      writeParkState();
      return;
    case "kill":
      if (socket !== adopterSocket) {
        controlSend(socket, notAdopterError());
        return;
      }
      if (!ptyExited) {
        killRequested = true;
        pty.kill(command.signal);
      }
      return;
    default:
      controlSend(socket, {
        type: "error",
        message: `Unsupported control command type ${JSON.stringify(command.type)}.`,
      });
  }
}

function statusMessage() {
  const message = {
    type: "status",
    bridgeProtocol: options.bridgeProtocol ?? BRIDGE_CONTROL_PROTOCOL,
    ptyInstanceId: orphan.ptyInstanceId,
    pid: pty.pid,
    bridgePid: process.pid,
    cols: currentCols,
    rows: currentRows,
    adopted: mode === "adopted",
    exited: ptyExited,
    parkedEvicted,
  };
  if (exitEvent !== null) {
    message.exitCode = exitEvent.exitCode;
    if (exitEvent.signal !== undefined) {
      message.signal = exitEvent.signal;
    }
  }
  return message;
}

function notAdopterError() {
  return {
    type: "error",
    code: "NOT_ADOPTER",
    message: "Only the adopting owner may send this command.",
  };
}

function controlSend(socket, message) {
  const flushed = socket.write(`${JSON.stringify(message)}\n`);
  if (!flushed && socket === adopterSocket && mode === "adopted") {
    pty.pause();
    socket.once("drain", () => {
      if (socket === adopterSocket) {
        pty.resume();
      }
    });
  }
}

function parkData(data) {
  // The owner passes its scrollback capacity as parkMaxBytes; the constant only
  // covers owners older than that option.
  const budget = orphan.parkMaxBytes ?? PARK_MAX_BYTES;
  parkedChunks.push(data);
  parkedBytes += Buffer.byteLength(data, "utf8");
  while (parkedBytes > budget && parkedChunks.length > 1) {
    const dropped = parkedChunks.shift();
    parkedBytes -= Buffer.byteLength(dropped, "utf8");
    parkedEvicted = true;
  }
  if (parkedBytes > budget) {
    // A single read larger than the budget still honors the bound. The slice
    // can split a VT sequence, which is safe: eviction sends adopters down
    // semantic recovery instead of raw replay.
    const only = Buffer.from(parkedChunks[0], "utf8");
    const kept = only.subarray(only.length - budget);
    parkedChunks[0] = kept.toString("utf8");
    parkedBytes = kept.length;
    parkedEvicted = true;
  }
}

function onAdopterClose() {
  if (mode !== "adopted") {
    return;
  }
  adopterSocket = null;
  if (ptyExited) {
    teardownAndExit();
    return;
  }
  if (killRequested) {
    // The adopter's kill is in flight; onExit completes the teardown once the
    // PTY is actually dead instead of re-parking a doomed process.
    return;
  }
  // Adopter died without disposing: park again with a fresh TTL epoch so the
  // next owner gets the full adoption window.
  mode = "parked";
  orphanedAtMs = Date.now();
  writeParkState();
  heartbeatTimer = setInterval(() => {
    writeParkState();
  }, HEARTBEAT_INTERVAL_MS);
  restartTtlTimer();
}

function clearParkTimers() {
  if (ttlTimer !== null) {
    clearTimeout(ttlTimer);
    ttlTimer = null;
  }
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function restartTtlTimer(durationMs) {
  if (ttlTimer !== null) {
    clearTimeout(ttlTimer);
  }
  const duration = durationMs ?? (ptyExited ? EXITED_RETENTION_MS : orphan.ttlMs);
  ttlTimer = setTimeout(() => {
    ttlTimer = null;
    // TTL self-reap: an unadopted park must end with a clean PTY teardown.
    if (!ptyExited) {
      pty.kill();
    }
    setTimeout(() => {
      teardownAndExit();
    }, 500);
  }, duration);
}

function teardownAndExit() {
  if (tornDown) {
    return;
  }
  tornDown = true;
  clearParkTimers();
  if (exitedRetentionTimer !== null) {
    clearTimeout(exitedRetentionTimer);
    exitedRetentionTimer = null;
  }
  try {
    if (server !== null) {
      server.close();
    }
  } catch {
    // Closing a never-bound server can throw; teardown proceeds regardless.
  }
  if (orphan !== undefined) {
    // Only this bridge's own bind may be unlinked: after a lost EADDRINUSE
    // race the file belongs to the live owner.
    if (serverBound) {
      try {
        fs.unlinkSync(orphan.controlSocketPath);
      } catch {
        // Already gone.
      }
    }
    try {
      fs.unlinkSync(orphan.parkStatePath);
    } catch {
      // Already gone.
    }
  }
  process.exit(0);
}

function clampDimension(value, minimum) {
  return Number.isInteger(value) && value >= minimum ? value : minimum;
}
