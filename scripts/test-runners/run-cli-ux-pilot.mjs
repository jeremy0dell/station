#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOwnedDisposableRuntime } from "../runtime-owner.mjs";

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const cliUxPilotSourceRef = "origin/main";
export const cliUxPilotDurationMs = 300_000;
export const cliUxPilotModel = "gpt-5.6-luna";
export const cliUxPilotReasoning = "xhigh";
export const cliUxPilotTestFile = "tests/e2e/real/real-cli-ux-pilot.test.ts";

const gitLocalEnvironmentVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

export function parseCliUxPilotArgs(args) {
  const values = args.filter((value) => value !== "--");
  const help = takeFlag(values, "--help") || takeFlag(values, "-h");
  const confirmed = takeFlag(values, "--yes");
  if (values.length > 0) {
    throw new Error(`Unknown CLI UX pilot option: ${values[0]}`);
  }
  return { confirmed, help };
}

export function cliUxPilotEnvironment(input, tools, sourceSha) {
  const env = environmentWithoutGitLocals(input);
  for (const key of [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "STATION_CLAUDE_BIN",
    "STATION_CONFIG_PATH",
    "STATION_CURSOR_BIN",
    "STATION_HARNESS_PROVIDER",
    "STATION_HOST_SOCKET_PATH",
    "STATION_HOOK_SPOOL_DIR",
    "STATION_INGRESS_BIN",
    "STATION_OBSERVER_SOCKET_PATH",
    "STATION_OBSERVER_STATE_DIR",
    "STATION_OPENCODE_BIN",
    "STATION_PI_BIN",
    "STATION_PROJECT_ID",
    "STATION_REAL_CLAUDE",
    "STATION_REAL_CURSOR",
    "STATION_REAL_E2E_KEEP_TEMP",
    "STATION_REAL_OPENCODE",
    "STATION_REAL_PI",
    "STATION_SESSION_ID",
    "STATION_TERMINAL_PROVIDER",
    "STATION_TERMINAL_TARGET_ID",
    "STATION_WORKTREE_ID",
    "STATION_WORKTREE_MANAGED_ROOT",
    "STATION_WORKTREE_PATH",
    "TMUX",
    "TMUX_PANE",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    STATION_CLI_UX_PILOT: "1",
    STATION_CLI_UX_PILOT_DURATION_MS: String(cliUxPilotDurationMs),
    STATION_CLI_UX_PILOT_MODEL: cliUxPilotModel,
    STATION_CLI_UX_PILOT_REASONING: cliUxPilotReasoning,
    STATION_CLI_UX_PILOT_SOURCE_SHA: sourceSha,
    STATION_REAL_CODEX: "1",
    STATION_REAL_E2E: "1",
    STATION_REAL_WORKTRUNK: "1",
    STATION_CODEX_BIN: tools.codex,
    STATION_TMUX_BIN: tools.tmux,
    STATION_WORKTRUNK_BIN: tools.worktrunk,
  };
}

export function environmentWithoutGitLocals(input) {
  const env = { ...input };
  for (const key of gitLocalEnvironmentVariables) delete env[key];
  return env;
}

async function main() {
  const parsed = parseCliUxPilotArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  if (!parsed.confirmed) {
    throw new Error(
      "CLI_UX_PILOT_CONFIRMATION_REQUIRED: this runs one paid real Codex agent; rerun with --yes.",
    );
  }

  for (const key of gitLocalEnvironmentVariables) delete process.env[key];
  const runnerEnv = { ...process.env };

  const tools = {
    bun: resolveCommand("bun"),
    codex: resolveCommand("codex"),
    tmux: resolveCommand("tmux"),
    worktrunk: resolveCommand("wt"),
  };
  await run(tools.codex, ["login", "status"], { cwd: checkoutRoot, env: runnerEnv });
  await run("git", ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
    cwd: checkoutRoot,
    env: runnerEnv,
  });
  const sourceSha = commandOutput(
    "git",
    ["rev-parse", "--verify", `${cliUxPilotSourceRef}^{commit}`],
    {
      cwd: checkoutRoot,
      env: runnerEnv,
    },
  );
  const isolatedRoot = resolve(await mkdtemp(join(tmpdir(), "station-cli-ux-pilot-")));
  const isolatedRootMetadata = await lstat(isolatedRoot);
  const isolatedRootIdentity = {
    path: await realpath(isolatedRoot),
    device: String(isolatedRootMetadata.dev),
    inode: String(isolatedRootMetadata.ino),
  };
  const isolatedCheckout = join(isolatedRoot, "checkout");
  const runtimeRoot = join(isolatedRoot, "runtime");
  const ownerStateDir = await cliUxPilotOwnerStateDirectory();
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  let ownerStarted = false;
  let ownerResult;
  let runFailure;

  process.stdout.write(
    `CLI UX pilot: source ${sourceSha}, Codex ${cliUxPilotModel} ${cliUxPilotReasoning}, hard stop ${cliUxPilotDurationMs / 1000}s.\n`,
  );
  process.stdout.write("Claude: skipped (TODO; no subscription).\n");

  try {
    await run(
      "git",
      ["clone", "--quiet", "--no-hardlinks", "--no-checkout", checkoutRoot, isolatedCheckout],
      { cwd: isolatedRoot, env: runnerEnv },
    );
    await run("git", ["checkout", "--quiet", "--detach", sourceSha], {
      cwd: isolatedCheckout,
      env: runnerEnv,
    });
    const isolatedSha = commandOutput("git", ["rev-parse", "HEAD"], {
      cwd: isolatedCheckout,
      env: runnerEnv,
    });
    if (isolatedSha !== sourceSha) {
      throw new Error(`Isolated checkout resolved ${isolatedSha}; expected ${sourceSha}.`);
    }
    if (!existsSync(join(isolatedCheckout, cliUxPilotTestFile))) {
      throw new Error(
        `CLI_UX_PILOT_NOT_ON_MAIN: ${cliUxPilotTestFile} is absent from origin/main ${sourceSha}.`,
      );
    }

    const vitest = join(isolatedCheckout, "node_modules", ".bin", "vitest");
    const pilotEnv = cliUxPilotEnvironment(process.env, tools, sourceSha);
    pilotEnv.STATION_RUNTIME_OWNER_FOREGROUND = "1";
    pilotEnv.TMPDIR = runtimeRoot;
    ownerStarted = true;
    ownerResult = await runOwnedDisposableRuntime({
      role: "cli-ux-pilot",
      checkoutRoot,
      stateDir: ownerStateDir,
      socketRoots: [runtimeRoot],
      persistenceRoots: [isolatedRoot],
      cleanupRoots: [isolatedRootIdentity],
      survivorPolicy: "preserve-persistent-station-runtime",
      terminalKey: "cli-ux-pilot",
      recoveryKey: cliUxPilotSourceRef,
      correlation: {
        traceId: `trc_${randomUUID()}`,
        spanId: `spn_${randomUUID()}`,
      },
      launch: {
        cwd: isolatedCheckout,
        steps: [
          { command: tools.bun, args: ["install", "--frozen-lockfile"] },
          { command: tools.bun, args: ["run", "build"] },
          {
            command: vitest,
            args: [
              "run",
              "--config",
              "config/vitest/vitest.real-e2e.config.ts",
              cliUxPilotTestFile,
            ],
          },
        ],
        env: pilotEnv,
      },
    });
    if (ownerResult.exitCode !== 0) {
      throw new Error(`CLI UX pilot failed with exit code ${ownerResult.exitCode}.`);
    }
  } catch (error) {
    runFailure = error;
  }

  let cleanupFailure;
  try {
    const cleanupRoots = ownerResult?.cleanupRoots ?? (ownerStarted ? [] : [isolatedRootIdentity]);
    await finalizeCliUxPilotRoots(cleanupRoots, runnerEnv, tools.tmux);
  } catch (error) {
    cleanupFailure = error;
  }
  if (existsSync(isolatedRoot)) {
    process.stderr.write(`Retained isolated checkout for failure triage: ${isolatedRoot}\n`);
  }
  if (runFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([runFailure, cleanupFailure], "CLI UX pilot and cleanup failed.");
  }
  if (runFailure !== undefined) throw runFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  process.stdout.write("STATION_CLI_UX_PILOT_CLEANUP=PASS\n");
}

export async function cliUxPilotOwnerStateDirectory(
  sourceCheckoutRoot = checkoutRoot,
  temporaryDirectory = tmpdir(),
) {
  const canonicalCheckout = await realpath(sourceCheckoutRoot);
  const checkoutMetadata = await lstat(canonicalCheckout);
  const key = createHash("sha256")
    .update(`${canonicalCheckout}\0${checkoutMetadata.dev}\0${checkoutMetadata.ino}`)
    .digest("hex")
    .slice(0, 24);
  const stateDir = join(resolve(temporaryDirectory), `station-cli-ux-pilot-owner-${key}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const metadata = await lstat(stateDir);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700 ||
    (typeof process.geteuid === "function" && metadata.uid !== process.geteuid())
  ) {
    throw new Error(`CLI UX pilot owner state is not private: ${stateDir}`);
  }
  return stateDir;
}

export async function finalizeCliUxPilotRoots(cleanupRoots, env, tmuxBin) {
  const uniqueRoots = new Map(
    cleanupRoots.map((root) => [`${root.path}\0${root.device}\0${root.inode}`, root]),
  );
  const failures = [];
  for (const expected of uniqueRoots.values()) {
    try {
      await finalizeCliUxPilotRoot(expected, env, tmuxBin);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "CLI UX pilot root cleanup failed.");
  }
}

function usage() {
  return [
    "Usage: bun run test:e2e:cli-ux:pilot -- --yes",
    "",
    "Clones exact origin/main, builds it, runs one private tmux/Codex Luna-xhigh CLI UX cell",
    "for at most five minutes, closes the exact session, and removes its isolated runtime.",
    "Claude is skipped and remains a TODO.",
    "",
  ].join("\n");
}

function takeFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index === -1) return false;
  values.splice(index, 1);
  return true;
}

function resolveCommand(command) {
  const resolved = spawnSync("which", [command], { encoding: "utf8" });
  const path = resolved.stdout.trim();
  if (resolved.status !== 0 || path.length === 0) {
    throw new Error(`Required command is unavailable: ${command}`);
  }
  return path;
}

function commandOutput(command, args, options) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function closePrivateTmuxEndpoints(runtimeRoot, env, tmuxBin) {
  let entries;
  try {
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const failures = [];
  const controllerEnv = { ...env };
  delete controllerEnv.TMUX;
  delete controllerEnv.TMUX_PANE;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("stn-real-tmux-")) continue;
    const root = join(runtimeRoot, entry.name);
    const socketPath = join(root, "server.sock");
    if (existsSync(socketPath)) {
      spawnSync(tmuxBin, ["-f", "/dev/null", "-S", socketPath, "kill-server"], {
        cwd: runtimeRoot,
        env: controllerEnv,
        stdio: "ignore",
        timeout: 10_000,
      });
      const probe = spawnSync(tmuxBin, ["-f", "/dev/null", "-S", socketPath, "list-sessions"], {
        cwd: runtimeRoot,
        env: controllerEnv,
        stdio: "ignore",
        timeout: 10_000,
      });
      if (probe.status === 0 || existsSync(socketPath)) {
        failures.push(new Error(`Private tmux endpoint remained reachable: ${socketPath}`));
        continue;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "CLI UX pilot tmux cleanup failed.");
  }
}

async function finalizeCliUxPilotRoot(expected, env, tmuxBin) {
  let metadata;
  try {
    metadata = await lstat(expected.path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const canonicalRoot = await realpath(expected.path);
  const canonicalTemporaryDirectory = await realpath(tmpdir());
  if (
    dirname(canonicalRoot) !== canonicalTemporaryDirectory ||
    !basename(canonicalRoot).startsWith("station-cli-ux-pilot-")
  ) {
    throw new Error(`Refusing unexpected CLI UX pilot cleanup root: ${expected.path}`);
  }
  assertExactPilotRoot(metadata, canonicalRoot, expected);
  await closePrivateTmuxEndpoints(join(canonicalRoot, "runtime"), env, tmuxBin);
  const finalMetadata = await lstat(canonicalRoot);
  assertExactPilotRoot(finalMetadata, canonicalRoot, expected);
  await rm(canonicalRoot, { recursive: true });
}

function assertExactPilotRoot(metadata, canonicalRoot, expected) {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    String(metadata.dev) !== expected.device ||
    String(metadata.ino) !== expected.inode ||
    canonicalRoot !== expected.path
  ) {
    throw new Error(`Refusing replaced CLI UX pilot cleanup root: ${expected.path}`);
  }
}

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const status = code ?? 1;
      if (status === 0) {
        resolvePromise(status);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} ${signal === null ? `exited ${status}` : `received ${signal}`}.`,
        ),
      );
    });
  });
}

function invokedDirectly() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "CLI UX pilot failed."}\n`);
    process.exitCode = 1;
  }
}
