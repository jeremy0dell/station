#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, fstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeOwnerError, runOwnedDisposableRuntime } from "../runtime-owner.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checkoutRoot = resolve(scriptDirectory, "../..");

export const guidedConfigPath = "config/vitest/vitest.setup-e2e.config.ts";
export const guidedTestFiles = [
  "tests/e2e/setup-guided-feedback.test.ts",
  "tests/e2e/setup-guided-tty.test.ts",
  "tests/e2e/setup-guided-sandbox.test.ts",
];

export function buildGuidedVitestArgs(extraArgs = []) {
  return ["run", "--config", guidedConfigPath, ...guidedTestFiles, ...extraArgs];
}

export function resolveVitestCommand(env, root = checkoutRoot) {
  const override = nonEmpty(env.STATION_SETUP_E2E_VITEST_BIN);
  if (override !== undefined) return override;
  const repoBin = join(root, "node_modules", ".bin", "vitest");
  return existsSync(repoBin) ? repoBin : "vitest";
}

/** Run the setup guided E2E suite inside one exact disposable group owned outside the fixture. */
async function main() {
  const passthroughArgs = process.argv.slice(2);
  const runtime = await resolveSetupGuidedRuntime();
  const result = await runOwnedDisposableRuntime({
    role: "setup-guided-e2e",
    checkoutRoot,
    stateDir: runtime.stateDir,
    socketRoots: [dirname(runtime.observerSocketPath), dirname(runtime.hostSocketPath)],
    persistenceRoots: [runtime.stateDir, dirname(runtime.layoutPath)],
    survivorPolicy: "preserve-persistent-station-runtime",
    terminalKey: terminalIdentityKey(),
    correlation: {
      traceId: `trc_${randomUUID()}`,
      spanId: `spn_${randomUUID()}`,
    },
    launch: {
      cwd: checkoutRoot,
      steps: [
        {
          command: resolveVitestCommand(process.env),
          args: buildGuidedVitestArgs(passthroughArgs),
        },
      ],
    },
  });
  process.exitCode = result.exitCode;
}

async function resolveSetupGuidedRuntime() {
  let configModule;
  try {
    configModule = await import("../../packages/config/dist/index.js");
  } catch (cause) {
    throw new RuntimeOwnerError(
      "SETUP_GUIDED_E2E_WORKSPACE_NOT_BUILT",
      "Station consumes built workspace packages. Run `pnpm build` at the repository root first.",
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
        "Station runtime config could not be loaded; setup guided E2E ownership is using default runtime paths.\n",
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

function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function nonEmpty(value) {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

if (invokedDirectly()) {
  try {
    await main();
  } catch (error) {
    if (error instanceof RuntimeOwnerError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
    } else {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Setup guided E2E ownership failed."}\n`,
      );
    }
    process.exitCode = 1;
  }
}
