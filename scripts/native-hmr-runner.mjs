#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { fstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeOwnerError, runOwnedDisposableRuntime } from "./runtime-owner.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checkoutRoot = resolve(scriptDirectory, "..");
const stationRoot = join(checkoutRoot, "station");

/** Run native Bun HMR inside one exact disposable group while persistent Station services survive. */
async function main() {
  if (process.argv.length !== 2) {
    throw new RuntimeOwnerError(
      "NATIVE_HMR_ARGUMENT_UNSUPPORTED",
      "The native HMR development command does not accept positional arguments.",
    );
  }
  const runtime = await resolveNativeHmrRuntime();
  const uiRunId = `ui_${randomUUID()}`;
  const result = await runOwnedDisposableRuntime({
    role: "native-hmr",
    checkoutRoot,
    stateDir: runtime.stateDir,
    socketRoots: [dirname(runtime.observerSocketPath), dirname(runtime.hostSocketPath)],
    persistenceRoots: [runtime.stateDir, dirname(runtime.layoutPath)],
    survivorPolicy: "preserve-persistent-station-runtime",
    terminalKey: terminalIdentityKey(),
    correlation: {
      traceId: `trc_${randomUUID()}`,
      spanId: `spn_${randomUUID()}`,
      uiRunId,
    },
    launch: {
      cwd: stationRoot,
      steps: [
        { command: "bun", args: ["run", "repair:node-pty"] },
        { command: "bun", args: ["--hot", "src/main.tsx"] },
      ],
      env: { STATION_UI_RUN_ID: uiRunId },
    },
  });
  process.exitCode = result.exitCode;
}

async function resolveNativeHmrRuntime() {
  let configModule;
  try {
    configModule = await import("../packages/config/dist/index.js");
  } catch (cause) {
    throw new RuntimeOwnerError(
      "NATIVE_HMR_WORKSPACE_NOT_BUILT",
      "Station consumes built workspace packages. Run `bun run build` at the repository root first.",
      { cause },
    );
  }
  const configPath = nonEmpty(process.env.STATION_CONFIG_PATH);
  let config;
  try {
    const loaded =
      configPath === undefined
        ? await configModule.loadConfig()
        : await configModule.loadConfig({ configPath });
    config = loaded.config;
  } catch (error) {
    if (!(error instanceof configModule.ConfigError) || error.code !== "CONFIG_FILE_NOT_FOUND") {
      process.stderr.write(
        "Station runtime config could not be loaded; native HMR ownership is using default runtime paths.\n",
      );
    }
  }

  const observerPaths = configModule.resolveObserverPaths(config);
  const observerSocketPath =
    nonEmpty(process.env.STATION_OBSERVER_SOCKET_PATH) ?? observerPaths.socketPath;
  const hostSocketPath =
    nonEmpty(process.env.STATION_HOST_SOCKET_PATH) ??
    join(dirname(observerSocketPath), "station-host.sock");
  return {
    stateDir: observerPaths.stateDir,
    observerSocketPath,
    hostSocketPath,
    layoutPath: resolveLayoutPath(process.env),
  };
}

function resolveLayoutPath(env) {
  const override = nonEmpty(env.STATION_LAYOUT_PATH);
  if (override !== undefined) return resolve(override);
  const stateHome = nonEmpty(env.XDG_STATE_HOME);
  if (stateHome !== undefined) return join(stateHome, "station", "station", "layout.json");
  return join(homedir(), ".local", "state", "station", "station", "layout.json");
}

function terminalIdentityKey() {
  if (!process.stdin.isTTY) return "no-tty";
  const metadata = fstatSync(process.stdin.fd);
  return createHash("sha256")
    .update(`${metadata.dev}\0${metadata.ino}\0${metadata.rdev}`)
    .digest("hex");
}

function nonEmpty(value) {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

try {
  await main();
} catch (error) {
  if (error instanceof RuntimeOwnerError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Native HMR ownership failed."}\n`,
    );
  }
  process.exitCode = 1;
}
