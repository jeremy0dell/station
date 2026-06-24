#!/usr/bin/env node

const nodePty = require("node-pty");
const readline = require("node:readline");

// xterm.js silently clamps resize to these minima; the bridge clamps to the
// same values so the PTY and the VT screen model can never disagree on size.
// node-pty itself throws on cols/rows <= 0, which previously killed the
// bridge (and the user's shell) when the pane collapsed to zero height.
const MIN_COLS = 2;
const MIN_ROWS = 1;

const [, , encodedOptions] = process.argv;

if (!encodedOptions) {
  process.stderr.write("Missing node-pty bridge options.\n");
  process.exit(2);
}

// If Station dies, our stdout pipe breaks; an unhandled EPIPE here would
// crash the bridge before the stdin-close path can shut the pty down cleanly.
process.stdout.on("error", () => {});

let ptyExited = false;

const options = JSON.parse(Buffer.from(encodedOptions, "base64url").toString("utf8"));
const pty = nodePty.spawn(options.command, options.args, {
  cols: clampDimension(options.cols, MIN_COLS),
  cwd: options.cwd,
  env: options.env,
  name: options.name,
  rows: clampDimension(options.rows, MIN_ROWS),
});

send({
  type: "ready",
  pid: pty.pid,
});

pty.onData((data) => {
  send({
    type: "data",
    data,
  });
});

pty.onExit((event) => {
  ptyExited = true;
  send({
    type: "exit",
    exitCode: event.exitCode,
    signal: event.signal,
  });
  // process.exit() would discard stdout's buffered backlog, truncating the
  // final output burst of short-lived commands; close the inputs and let the
  // process drain stdout and exit naturally.
  process.exitCode = 0;
  commands.close();
  process.stdin.destroy();
  process.stdout.end();
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
        pty.resize(
          clampDimension(command.cols, MIN_COLS),
          clampDimension(command.rows, MIN_ROWS),
        );
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

// stdin closing means the Station process is gone (crash, SIGKILL, HMR churn);
// without this the pty keeps the bridge alive forever and shells orphan.
// The exit backstop is unref'd so a successful pty.kill -> onExit drain path
// still controls the final exit.
commands.on("close", () => {
  if (ptyExited) {
    return;
  }
  pty.kill();
  setTimeout(() => {
    process.exit(0);
  }, 500).unref();
});

process.on("SIGTERM", () => {
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

function clampDimension(value, minimum) {
  return Number.isInteger(value) && value >= minimum ? value : minimum;
}
