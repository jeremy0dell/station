#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  process.stderr.write("Usage: run-without-git-locals <command> [...args]\n");
  process.exitCode = 2;
} else {
  run(command, args);
}

function run(command, args) {
  let localVariables;
  try {
    localVariables = execFileSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split(/\r?\n/u)
      .filter((variable) => variable.length > 0);
  } catch (error) {
    fail(`Unable to discover Git-local environment variables: ${formatError(error)}`);
    return;
  }

  if (localVariables.length === 0) {
    fail("Git returned no repository-local environment variables; refusing to launch the child.");
    return;
  }

  const env = { ...process.env };
  for (const variable of localVariables) delete env[variable];

  const child = spawn(command, args, { env, stdio: "inherit" });
  const signalHandlers = new Map();
  let settled = false;

  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  };

  // Direct signals to the wrapper must reach the same child process that owns the hook gate.
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (!settled) child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    removeSignalHandlers();
    fail(`Unable to launch ${command}: ${formatError(error)}`);
  });
  child.once("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    removeSignalHandlers();
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
