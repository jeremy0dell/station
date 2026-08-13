#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createObserverClient,
  readUnixSocketHolderPids,
} from "../../packages/protocol/dist/index.js";
import { parseStationObserverBuildVersion } from "../../packages/runtime/dist/index.js";
import { createStationHostClient } from "../../packages/station-host/dist/index.js";
import {
  assertOwnedDisposableRuntimeChild,
  RuntimeLifecycleEventSchema,
  runOwnedDisposableRuntime,
} from "../runtime-owner.mjs";
import {
  captureBinarySmokeEvidence,
  finalizeBinarySmokeEvidence,
  releaseBinarySmokeEvidenceReservation,
  reserveBinarySmokeEvidenceDestination,
} from "./binary-smoke-evidence.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const runnerPath = fileURLToPath(import.meta.url);
const receiptContent = "station-installer-binary-v1\n";
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const targetNames = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const childTimeoutMs = 120_000;
const buildTimeoutMs = 12 * 60_000;
const outputLimit = 4 * 1024 * 1024;
const externalOwner = process.env.STATION_UPDATE_SMOKE_OWNED_CHILD === "1";
const tmuxPtyClientScript = `
import fcntl
import os
import pty
import select
import struct
import sys
import termios

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(sys.stdin.fileno(), termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
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

class SmokeCommandError extends Error {
  constructor(command, args, result) {
    super(
      `${command} ${args.join(" ")} exited with ${exitDescription(result)}\n${result.stdout}\n${result.stderr}`,
    );
    this.command = command;
    this.args = args;
    this.result = result;
  }
}

if (externalOwner) {
  await assertOwnedDisposableRuntimeChild({
    role: "binary-smoke",
    stateDir: requiredEnvironment("STATION_UPDATE_SMOKE_OWNER_STATE_DIR"),
    runtimeId: requiredEnvironment("STATION_RUNTIME_OWNER_ID"),
  });
  await runUpdateSmoke(parseArgs(process.argv.slice(2)));
} else {
  await runOwnedUpdateSmoke(process.argv.slice(2));
}

async function runOwnedUpdateSmoke(argv) {
  const options = parseArgs(argv);
  const root = resolve(await mkdtemp(join(tmpdir(), "stn-update-smoke-")));
  const rootIdentity = fileIdentity(await lstat(root));
  const runId = `run_${randomUUID()}`;
  const ownerStateDir = await ownerStateDirectory();
  const ownerLogPath = join(ownerStateDir, "logs", "cli.jsonl");
  const ownerLogOffset = await fileSizeOrZero(ownerLogPath);
  const evidenceDir = optionalAbsoluteEnvironment("STATION_BINARY_SMOKE_EVIDENCE_DIR");
  if (evidenceDir !== undefined) {
    await reserveBinarySmokeEvidenceDestination({ evidenceDir, smokeRoot: root, runId });
  }

  let result;
  let ownerError;
  try {
    result = await runOwnedDisposableRuntime({
      role: "binary-smoke",
      checkoutRoot: repoRoot,
      stateDir: ownerStateDir,
      socketRoots: [root],
      persistenceRoots: [root],
      cleanupRoots: [{ path: await realpath(root), ...rootIdentity }],
      survivorPolicy: "preserve-persistent-station-runtime",
      terminalKey: "update-smoke-runner",
      recoveryKey: options.scenarios,
      correlation: { traceId: `trc_${randomUUID()}`, spanId: `spn_${randomUUID()}` },
      launch: {
        cwd: repoRoot,
        steps: [{ command: process.execPath, args: [runnerPath, ...argv] }],
        env: {
          STATION_UPDATE_SMOKE_OWNED_CHILD: "1",
          STATION_UPDATE_SMOKE_OWNER_STATE_DIR: ownerStateDir,
          STATION_UPDATE_SMOKE_ROOT: root,
          STATION_UPDATE_SMOKE_RUN_ID: runId,
          STATION_RUNTIME_OWNER_FOREGROUND: "1",
          ...(evidenceDir === undefined ? {} : { STATION_UPDATE_SMOKE_EVIDENCE_DIR: evidenceDir }),
        },
      },
    });
  } catch (error) {
    ownerError = error;
  }

  const lifecycle = await readLifecycle(ownerLogPath, ownerLogOffset);
  let rootRemoved = false;
  if (!options.keepTemp) {
    await removeExactTemporaryRoot(root, rootIdentity);
    rootRemoved = true;
  } else {
    process.stderr.write(`update smoke retained ${root}\n`);
  }

  const failed = ownerError !== undefined || result?.exitCode !== 0;
  if (evidenceDir !== undefined) {
    const manifestPath = join(evidenceDir, "manifest.json");
    if (await pathExists(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const runtimeId = result?.runtimeId;
      const groupExited =
        ownerError === undefined &&
        runtimeId !== undefined &&
        lifecycle.some(
          (event) =>
            event.attributes.runtimeId === runtimeId &&
            event.message === "runtime.cleanup.completed" &&
            event.attributes.memberCount === 0,
        ) &&
        lifecycle.some(
          (event) =>
            event.attributes.runtimeId === runtimeId && event.message === "runtime.owner.retired",
        );
      await finalizeBinarySmokeEvidence({
        evidenceDir,
        expectedRunId: runId,
        cleanup: {
          status: groupExited && rootRemoved ? "complete" : "incomplete",
          observerExited: groupExited,
          hostExited: groupExited,
          socketRemoved: rootRemoved,
          pidfileRemoved: rootRemoved,
          hostSocketRemoved: rootRemoved,
          rootRemoved,
        },
        ...(groupExited
          ? {
              processes: manifest.rounds[0].runtime.processes.map((process) => ({
                ...process,
                exists: false,
              })),
            }
          : {}),
        lifecycleEvents: lifecycle,
        warnings: ownerError === undefined ? [] : [`runtime owner: ${errorMessage(ownerError)}`],
      });
    } else if (!failed) {
      await releaseBinarySmokeEvidenceReservation({ evidenceDir, smokeRoot: root, runId });
    }
  }

  if (ownerError !== undefined) throw ownerError;
  process.exitCode = result?.exitCode ?? 1;
}

async function runUpdateSmoke(options) {
  const root = resolve(requiredEnvironment("STATION_UPDATE_SMOKE_ROOT"));
  const evidenceDir = process.env.STATION_UPDATE_SMOKE_EVIDENCE_DIR;
  const suppliedBinary = await snapshotSuppliedBinary(
    options.incumbentBinary,
    options.incumbentVersion,
  );
  const target = await prepareTarget(options, root);
  const scenarios =
    options.scenarios === "no-host"
      ? [{ name: "tmux-no-host", invocation: "tmux", busyHost: false }]
      : [
          { name: "external-busy-host", invocation: "external", busyHost: true },
          { name: "tmux-busy-host", invocation: "tmux", busyHost: true },
          { name: "tmux-no-host", invocation: "tmux", busyHost: false },
        ];

  try {
    for (const scenario of scenarios) {
      await runScenario({
        ...scenario,
        options,
        root,
        suppliedBinary,
        target,
        evidenceDir,
      });
    }
    await assertSuppliedBinaryUnchanged(suppliedBinary);
    process.stdout.write(
      `update smoke passed (${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"})\n`,
    );
  } catch (error) {
    if (evidenceDir !== undefined && !(await pathExists(join(evidenceDir, "manifest.json")))) {
      await captureFailureEvidence({
        root,
        stateDir: join(root, "state"),
        socketPath: join(root, "runtime", "observer.sock"),
        error,
        suppliedBinary,
        target,
        scenarioName: "target-preparation",
      }).catch((captureError) => {
        process.stderr.write(
          `Update smoke evidence capture failed: ${errorMessage(captureError)}\n`,
        );
      });
    }
    throw error;
  }
}

async function runScenario(input) {
  const scenarioRoot = join(input.root, "scenarios", input.name);
  const scenarioKey =
    input.name === "external-busy-host" ? "e" : input.name === "tmux-busy-host" ? "b" : "n";
  const homeDir = join(scenarioRoot, "home");
  const configHome = join(homeDir, ".config");
  const stateHome = join(scenarioRoot, "state-home");
  const dataHome = join(scenarioRoot, "data-home");
  const cacheHome = join(scenarioRoot, "cache-home");
  const stateDir = join(scenarioRoot, "state");
  const runtimeDir = join(input.root, "r", scenarioKey);
  const tempDir = join(scenarioRoot, "tmp");
  const tmuxTempDir = join(input.root, "m", scenarioKey);
  const installDir = join(scenarioRoot, "bin");
  const configPath = join(configHome, "station", "config.toml");
  const socketPath = join(runtimeDir, "observer.sock");
  const hostSocketPath = join(runtimeDir, "station-host.sock");
  assertUnixSocketPath(socketPath);
  assertUnixSocketPath(hostSocketPath);
  const postSignal = join(scenarioRoot, "post");
  const releaseSignal = join(scenarioRoot, "release");
  const diagnostics = { observerPid: undefined, hostPid: undefined };
  const cleanupWarnings = [];
  let observerClient;
  let incumbentObserver;
  let incumbentHostProcess;
  let incumbentHostOutput;
  let tmuxServer;
  let spawnedPty;
  let ptyIdentity;
  let ptyChildPid;
  let failure;

  await Promise.all(
    [
      homeDir,
      dirname(configPath),
      stateHome,
      dataHome,
      cacheHome,
      stateDir,
      runtimeDir,
      tempDir,
      tmuxTempDir,
      installDir,
    ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  await installIncumbent(input.suppliedBinary.path, installDir, dataHome);
  await writeConfig(configPath, stateDir, socketPath);
  const transportDir =
    input.target.mode === "public"
      ? undefined
      : await writeReleaseTransport({
          scenarioRoot,
          currentTag: `v${input.options.incumbentVersion}`,
          target: input.target,
        });
  const tmuxPath = findExecutable("tmux", process.env.PATH);
  const env = isolatedEnvironment({
    homeDir,
    configHome,
    stateHome,
    dataHome,
    cacheHome,
    runtimeDir,
    tempDir,
    tmuxTempDir,
    installDir,
    configPath,
    socketPath,
    hostSocketPath,
    transportDir,
    tmuxPath,
  });
  const installedBinary = join(installDir, "stn");

  try {
    const incumbentVersion = await run(installedBinary, ["--version"], { env });
    assertEqual(
      incumbentVersion.stdout.trim(),
      input.options.incumbentVersion,
      `${input.name} incumbent version`,
    );
    const observerStart = await run(
      installedBinary,
      ["observer", "start", "--timeout-ms", "30000"],
      { env, timeoutMs: 40_000 },
    );
    incumbentObserver = parseJson(observerStart.stdout, `${input.name} Observer start`).health;
    assertDisplayVersion(
      incumbentObserver.version,
      input.options.incumbentVersion,
      `${input.name} incumbent Observer`,
    );
    diagnostics.observerPid = incumbentObserver.pid;
    observerClient = createObserverClient({ socketPath, timeoutMs: 5000 });

    if (input.busyHost) {
      incumbentHostProcess = spawn(
        installedBinary,
        ["__station-host", "--socket", hostSocketPath, "--state-dir", stateDir],
        { cwd: scenarioRoot, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      incumbentHostOutput = collectOutput(incumbentHostProcess);
      diagnostics.hostPid = incumbentHostProcess.pid;
      const incumbentHostClient = createStationHostClient({
        socketPath: hostSocketPath,
        timeoutMs: 2000,
        expectedBuildVersion: input.options.incumbentVersion,
      });
      await waitForHost(incumbentHostClient, incumbentHostOutput);
      assertDeepEqual(
        readUnixSocketHolderPids(hostSocketPath),
        [incumbentHostProcess.pid],
        `${input.name} incumbent Host holder`,
      );
      ptyIdentity = {
        kind: "agent",
        terminalTargetId: `native:${input.name}`,
        worktreeId: input.name,
        projectId: "update-smoke",
        sessionId: `ses_${input.name.replaceAll("-", "_")}`,
        worktreePath: scenarioRoot,
        harnessProvider: "scripted",
      };
      spawnedPty = await incumbentHostClient.spawn({
        ...ptyIdentity,
        command: "/bin/sh",
        args: [
          "-c",
          'printf "UPDATE_SMOKE_PRE\\n"; while [ ! -f "$1" ]; do sleep 0.1; done; printf "UPDATE_SMOKE_POST\\n"; while [ ! -f "$2" ]; do sleep 0.1; done',
          "update-smoke-child",
          postSignal,
          releaseSignal,
        ],
        cwd: scenarioRoot,
        cols: 80,
        rows: 24,
      });
      ptyChildPid = await waitForPtyChild(incumbentHostClient, spawnedPty);
      await waitForPtyOutput(
        incumbentHostClient,
        { ...ptyIdentity, ...spawnedPty },
        "UPDATE_SMOKE_PRE",
      );
      incumbentHostClient.dispose();
    } else {
      assertEqual(await pathExists(hostSocketPath), false, `${input.name} starts without Host`);
    }

    if (input.invocation === "tmux") {
      tmuxServer = await startTmuxServer(tmuxPath, env, tmuxTempDir, input.name);
    }
    const updateResult =
      input.invocation === "external"
        ? await run(installedBinary, ["update", "--json"], { env, timeoutMs: childTimeoutMs })
        : await runInTmuxPane(tmuxServer, "update", "stn update --json", scenarioRoot);
    const report = parseJson(updateResult.stdout, `${input.name} update report`);
    assertUpdateReport(report, input);
    assertNoMismatch(updateResult.stderr, `${input.name} update stderr`);

    const targetObserver = await waitForObserver(observerClient, input.target.version);
    diagnostics.observerPid = targetObserver.pid;
    assertNotEqual(
      targetObserver.pid,
      incumbentObserver.pid,
      `${input.name} Observer replacement PID`,
    );
    assertEqual(
      await waitForProcessExit(incumbentObserver.pid, 10_000),
      true,
      `${input.name} incumbent Observer exit`,
    );
    assertDeepEqual(
      readUnixSocketHolderPids(socketPath),
      [targetObserver.pid],
      `${input.name} target Observer holder`,
    );

    if (input.busyHost) {
      assertEqual(
        await waitForProcessExit(incumbentHostProcess.pid, 10_000),
        true,
        `${input.name} incumbent Host exit`,
      );
      const holders = await waitForSocketHolders(hostSocketPath, 10_000);
      assertEqual(holders.length, 1, `${input.name} target Host holder count`);
      assertNotEqual(holders[0], incumbentHostProcess.pid, `${input.name} target Host replacement`);
      diagnostics.hostPid = holders[0];
      const targetHostClient = createStationHostClient({
        socketPath: hostSocketPath,
        timeoutMs: 3000,
        expectedBuildVersion: input.target.version,
      });
      const hostHealth = await targetHostClient.health();
      assertEqual(hostHealth.buildVersion, input.target.version, `${input.name} target Host build`);
      const live = (await targetHostClient.list()).find(
        (entry) => entry.ptyId === spawnedPty.ptyId,
      );
      if (live === undefined) throw new Error(`${input.name} target Host lost the live PTY.`);
      assertEqual(live.ptyId, spawnedPty.ptyId, `${input.name} PTY ID`);
      assertEqual(live.ptyInstanceId, spawnedPty.ptyInstanceId, `${input.name} PTY instance`);
      assertEqual(live.pid, ptyChildPid, `${input.name} PTY child PID`);
      const attachment = await targetHostClient.attach({ ...ptyIdentity, ...spawnedPty }, "viewer");
      const replay = replayText(attachment.ack);
      assertIncludes(replay, "UPDATE_SMOKE_PRE", `${input.name} preserved replay`);
      const iterator = attachment.frames[Symbol.asyncIterator]();
      await writeFile(postSignal, "\n", { mode: 0o600 });
      const post = await waitForFrame(iterator, "UPDATE_SMOKE_POST", 10_000);
      assertIncludes(post, "UPDATE_SMOKE_POST", `${input.name} continued PTY output`);
      await writeFile(releaseSignal, "\n", { mode: 0o600 });
      await waitForExitFrame(iterator, 10_000);
      await iterator.return?.();
      await attachment.detach();
      await targetHostClient.close(spawnedPty.ptyId).catch(() => undefined);
      targetHostClient.dispose();
    } else {
      assertEqual(await pathExists(hostSocketPath), false, `${input.name} skips Host creation`);
    }

    await verifyBareLaunches({
      installedBinary,
      env,
      scenarioRoot,
      tmuxPath,
      tmuxTempDir,
      tmuxServer,
      name: input.name,
    });
    if (input.busyHost) {
      const cleanupClient = createStationHostClient({
        socketPath: hostSocketPath,
        timeoutMs: 3000,
        expectedBuildVersion: input.target.version,
      });
      await cleanupClient.stopIfIdle(input.target.version);
      cleanupClient.dispose();
      await waitForMissing(hostSocketPath, 10_000);
      assertEqual(
        await waitForProcessExit(diagnostics.hostPid, 10_000),
        true,
        `${input.name} target Host cleanup`,
      );
    }
    await observerClient.stop();
    await waitForMissing(socketPath, 10_000);
    assertEqual(
      await waitForProcessExit(targetObserver.pid, 10_000),
      true,
      `${input.name} target Observer cleanup`,
    );
  } catch (error) {
    failure = error;
    if (input.evidenceDir !== undefined) {
      await captureFailureEvidence({
        root: input.root,
        stateDir,
        socketPath,
        error,
        suppliedBinary: input.suppliedBinary,
        target: input.target,
        scenarioName: input.name,
        observerPid: diagnostics.observerPid,
        hostPid: diagnostics.hostPid,
      }).catch((captureError) => {
        cleanupWarnings.push(`evidence capture: ${errorMessage(captureError)}`);
      });
    }
  } finally {
    await cleanupAction(cleanupWarnings, "PTY release", async () => {
      await writeFile(postSignal, "\n", { mode: 0o600 });
      await writeFile(releaseSignal, "\n", { mode: 0o600 });
    });
    await cleanupAction(cleanupWarnings, "tmux cleanup", async () => {
      if (tmuxServer !== undefined) {
        await stopTmuxServer(tmuxServer);
        return;
      }
      const wrapperPath = join(tmuxTempDir, "tmux-private");
      if (!(await pathExists(wrapperPath))) return;
      await run(wrapperPath, ["kill-server"], { env, allowedExitCodes: [0, 1] });
      const probe = await run(wrapperPath, ["has-session"], {
        env,
        allowedExitCodes: [0, 1],
      });
      assertEqual(probe.code, 1, "unadmitted private tmux server unreachable");
    });
    await cleanupAction(cleanupWarnings, "Host cleanup", async () => {
      if (!(await pathExists(hostSocketPath))) return;
      const raw = createStationHostClient({ socketPath: hostSocketPath, timeoutMs: 2000 });
      const health = await raw.health();
      raw.dispose();
      if (health.buildVersion === undefined) throw new Error("Host cleanup found legacy health.");
      const client = createStationHostClient({
        socketPath: hostSocketPath,
        timeoutMs: 2000,
        expectedBuildVersion: health.buildVersion,
      });
      await waitForHostIdle(client, 10_000);
      await client.stopIfIdle(health.buildVersion);
      client.dispose();
      await waitForMissing(hostSocketPath, 10_000);
    });
    await cleanupAction(cleanupWarnings, "Observer cleanup", async () => {
      if (observerClient === undefined || !(await pathExists(socketPath))) return;
      await observerClient.stop();
      await waitForMissing(socketPath, 10_000);
    });
    await cleanupAction(cleanupWarnings, "incumbent Host child", async () => {
      if (incumbentHostProcess?.pid === undefined || !processIsAlive(incumbentHostProcess.pid)) {
        return;
      }
      incumbentHostProcess.kill("SIGTERM");
      await waitForProcessExit(incumbentHostProcess.pid, 5000);
    });
  }

  for (const warning of cleanupWarnings) process.stderr.write(`Update smoke warning: ${warning}\n`);
  if (failure !== undefined) throw failure;
  if (cleanupWarnings.length > 0) {
    throw new AggregateError(
      cleanupWarnings.map((warning) => new Error(warning)),
      `${input.name} cleanup failed.`,
    );
  }
  assertEqual(await pathExists(socketPath), false, `${input.name} Observer socket cleanup`);
  assertEqual(await pathExists(hostSocketPath), false, `${input.name} Host socket cleanup`);
}

async function prepareTarget(options, root) {
  if (options.target.mode === "public") {
    return { mode: "public", tag: options.target.tag, version: options.target.tag.slice(1) };
  }
  if (options.target.mode === "staged") {
    const target = {
      mode: "staged",
      tag: options.target.tag,
      version: options.target.tag.slice(1),
      releaseDir: options.target.releaseDir,
      archivePath: join(
        options.target.releaseDir,
        `stn-${options.target.tag}-${nativeTarget()}.tar.gz`,
      ),
      installerPath: join(options.target.releaseDir, "install.sh"),
      checksumsPath: join(options.target.releaseDir, "SHA256SUMS"),
    };
    await validateTargetFiles(target);
    return target;
  }

  const buildRoot = join(root, "target-source");
  const releaseDir = join(root, "target-release");
  await mkdir(releaseDir, { recursive: true, mode: 0o700 });
  await cloneCurrentSource(buildRoot);
  const buildEnv = buildEnvironment();
  await run(findExecutable("pnpm", process.env.PATH), ["install", "--frozen-lockfile"], {
    cwd: buildRoot,
    env: buildEnv,
    timeoutMs: buildTimeoutMs,
  });
  await run(findExecutable("bun", process.env.PATH), ["install", "--frozen-lockfile"], {
    cwd: join(buildRoot, "station"),
    env: buildEnv,
    timeoutMs: buildTimeoutMs,
  });
  await run(
    findExecutable("pnpm", process.env.PATH),
    ["build:binary", "--", "--version", options.target.version],
    { cwd: buildRoot, env: buildEnv, timeoutMs: buildTimeoutMs },
  );
  const packageResult = await run(
    "/bin/sh",
    ["scripts/release/package-archive.sh", options.target.version, nativeTarget()],
    { cwd: buildRoot, env: buildEnv, timeoutMs: childTimeoutMs },
  );
  const archiveSource = packageResult.stdout.trim();
  const archivePath = join(releaseDir, basename(archiveSource));
  await rename(archiveSource, archivePath);
  const installerSource = await readFile(join(buildRoot, "scripts", "install.sh"), "utf8");
  if (installerSource.split('embedded_version=""').length !== 2) {
    throw new Error("Source installer does not contain one unstamped version marker.");
  }
  const installerPath = join(releaseDir, "install.sh");
  await writeFile(
    installerPath,
    installerSource.replace('embedded_version=""', `embedded_version="v${options.target.version}"`),
    { mode: 0o700 },
  );
  const checksumsPath = join(releaseDir, "SHA256SUMS");
  await writeFile(
    checksumsPath,
    `${await sha256File(archivePath)}  ${basename(archivePath)}\n${await sha256File(installerPath)}  install.sh\n`,
    { mode: 0o600 },
  );
  await rm(buildRoot, { recursive: true, force: true });
  const target = {
    mode: "source",
    tag: `v${options.target.version}`,
    version: options.target.version,
    releaseDir,
    archivePath,
    installerPath,
    checksumsPath,
  };
  await validateTargetFiles(target);
  return target;
}

async function cloneCurrentSource(destination) {
  const git = findExecutable("git", process.env.PATH);
  const env = buildEnvironment();
  await run(git, ["clone", "--shared", "--no-checkout", repoRoot, destination], {
    env,
    timeoutMs: childTimeoutMs,
  });
  await run(git, ["checkout", "--detach", "HEAD"], { cwd: destination, env });
  const diff = await run(git, ["diff", "--binary", "--full-index", "HEAD"], {
    cwd: repoRoot,
    env,
    maxOutputChars: 64 * 1024 * 1024,
  });
  if (diff.stdout.length > 0) {
    await run(git, ["apply", "--whitespace=nowarn", "-"], {
      cwd: destination,
      env,
      input: diff.stdout,
      maxOutputChars: 64 * 1024 * 1024,
    });
  }
  const untracked = await run(git, ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    env,
    maxOutputChars: 64 * 1024 * 1024,
  });
  for (const relativePath of untracked.stdout.split("\0").filter(Boolean)) {
    const source = join(repoRoot, relativePath);
    const target = join(destination, relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(source, target, { dereference: false, preserveTimestamps: true, recursive: true });
  }
}

async function validateTargetFiles(target) {
  for (const path of [target.installerPath, target.checksumsPath, target.archivePath]) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
      throw new Error(`Update target asset is not a nonempty regular file: ${path}`);
    }
  }
  const installer = await readFile(target.installerPath, "utf8");
  if (!installer.split(/\r?\n/u).includes(`embedded_version="${target.tag}"`)) {
    throw new Error(`Target installer is not stamped for ${target.tag}.`);
  }
}

async function writeReleaseTransport(input) {
  const transportDir = join(input.scenarioRoot, "transport");
  await mkdir(transportDir, { recursive: true, mode: 0o700 });
  const curlPath = join(transportDir, "curl");
  const current = releaseMetadata(input.currentTag, 1001, "2026-01-01T00:00:00Z");
  const target = releaseMetadata(input.target.tag, 1002, "2026-01-02T00:00:00Z");
  const routes = [
    [releaseApiTagUrl(input.currentTag), { kind: "json", value: current }],
    [releaseApiTagUrl(input.target.tag), { kind: "json", value: target }],
    [
      "https://api.github.com/repos/jeremy0dell/station/releases?per_page=100&page=1",
      { kind: "json", value: [current, target] },
    ],
    [
      releaseDownloadUrl(input.target.tag, "install.sh"),
      { kind: "file", path: input.target.installerPath },
    ],
    [
      releaseDownloadUrl(input.target.tag, "SHA256SUMS"),
      { kind: "file", path: input.target.checksumsPath },
    ],
    [
      releaseDownloadUrl(input.target.tag, basename(input.target.archivePath)),
      { kind: "file", path: input.target.archivePath },
    ],
  ];
  const script =
    `#!${process.execPath}\n` +
    `const { appendFileSync, copyFileSync, readFileSync } = require("node:fs");\n` +
    `const routes = new Map(${JSON.stringify(routes)});\n` +
    `const args = process.argv.slice(2);\n` +
    `const url = [...args].reverse().find((arg) => /^https:\\/\\//.test(arg));\n` +
    `appendFileSync(${JSON.stringify(join(transportDir, "curl.log"))}, String(url) + "\\n");\n` +
    `const route = routes.get(url);\n` +
    `if (!route) { process.stderr.write("unexpected update smoke URL: " + url + "\\n"); process.exit(22); }\n` +
    `const outputIndex = args.indexOf("--output");\n` +
    `const bytes = route.kind === "json" ? Buffer.from(JSON.stringify(route.value)) : readFileSync(route.path);\n` +
    `if (outputIndex >= 0) copyFileSync(route.kind === "file" ? route.path : (() => { throw new Error("JSON output route unsupported"); })(), args[outputIndex + 1]);\n` +
    `else process.stdout.write(bytes);\n`;
  await writeFile(curlPath, script, { mode: 0o700 });
  return transportDir;
}

function releaseMetadata(tag, id, publishedAt) {
  const version = tag.slice(1);
  const names = [
    "install.sh",
    "SHA256SUMS",
    ...targetNames.map((target) => `stn-v${version}-${target}.tar.gz`),
  ];
  return {
    id,
    tag_name: tag,
    draft: false,
    immutable: true,
    published_at: publishedAt,
    assets: names.map((name, index) => ({ id: id * 10 + index, name })),
  };
}

function releaseApiTagUrl(tag) {
  return `https://api.github.com/repos/jeremy0dell/station/releases/tags/${encodeURIComponent(tag)}`;
}

function releaseDownloadUrl(tag, name) {
  return `https://github.com/jeremy0dell/station/releases/download/${encodeURIComponent(tag)}/${name}`;
}

async function installIncumbent(source, installDir, dataHome) {
  const binary = join(installDir, "stn");
  await copyFile(source, binary);
  await chmod(binary, 0o755);
  await symlink("stn", join(installDir, "stn-ingress"));
  await symlink("stn", join(installDir, "stn-tmux-popup"));
  await writeFile(join(installDir, ".station-install-receipt"), receiptContent, {
    mode: 0o600,
  });
  const licenseDir = join(dataHome, "station");
  await mkdir(licenseDir, { recursive: true, mode: 0o700 });
  await copyFile(join(repoRoot, "LICENSE"), join(licenseDir, "LICENSE"));
  await chmod(join(licenseDir, "LICENSE"), 0o644);
  assertEqual(await readlink(join(installDir, "stn-ingress")), "stn", "incumbent ingress alias");
  assertEqual(
    (await lstat(join(installDir, ".station-install-receipt"))).mode & 0o777,
    0o600,
    "incumbent receipt mode",
  );
}

async function writeConfig(path, stateDir, socketPath) {
  await writeFile(
    path,
    [
      "schema_version = 1",
      "projects = []",
      "",
      "[observer]",
      `state_dir = ${JSON.stringify(stateDir)}`,
      `socket_path = ${JSON.stringify(socketPath)}`,
      "",
      "[defaults]",
      'worktree_provider = "noop-worktree"',
      'terminal = "tmux"',
      'harness = "noop-harness"',
      'layout = "agent-shell"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function isolatedEnvironment(input) {
  const toolDirectories = unique([
    input.transportDir,
    input.installDir,
    dirname(input.tmuxPath),
    dirname(process.execPath),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]);
  return {
    HOME: input.homeDir,
    XDG_CONFIG_HOME: input.configHome,
    XDG_STATE_HOME: input.stateHome,
    XDG_DATA_HOME: input.dataHome,
    XDG_CACHE_HOME: input.cacheHome,
    XDG_RUNTIME_DIR: input.runtimeDir,
    TMPDIR: input.tempDir,
    TMUX_TMPDIR: input.tmuxTempDir,
    PATH: toolDirectories.join(":"),
    SHELL: "/bin/sh",
    LANG: "C",
    LC_ALL: "C",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    STATION_CONFIG_PATH: input.configPath,
    STATION_OBSERVER_SOCKET_PATH: input.socketPath,
    STATION_HOST_SOCKET_PATH: input.hostSocketPath,
    STATION_RUNTIME_OWNER_FOREGROUND: "1",
    STATION_TMUX_BIN: input.tmuxPath,
  };
}

async function startTmuxServer(tmuxPath, env, tmuxTempDir, label) {
  const key = `u${createHash("sha256").update(`${label}-${randomUUID()}`).digest("hex").slice(0, 8)}`;
  const session = "station-update";
  const wrapperPath = join(tmuxTempDir, "tmux-private");
  await writeFile(
    wrapperPath,
    `#!/bin/sh\nexec ${shellQuote(tmuxPath)} -L ${shellQuote(key)} -f /dev/null "$@"\n`,
    { mode: 0o700 },
  );
  const serverEnv = { ...env, STATION_TMUX_BIN: wrapperPath };
  const args = [];
  await run(wrapperPath, ["new-session", "-d", "-s", session, "-x", "100", "-y", "30", "/bin/sh"], {
    env: serverEnv,
  });
  const pidResult = await run(
    wrapperPath,
    ["display-message", "-p", "-t", `${session}:0.0`, "#{pid}"],
    { env: serverEnv },
  );
  const pid = Number(pidResult.stdout.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Private tmux server did not report a PID.");
  const socketPath = join(tmuxTempDir, `tmux-${process.getuid?.() ?? 0}`, key);
  assertUnixSocketPath(socketPath);
  const python = findExecutable("python3", serverEnv.PATH);
  const client = spawn(
    python,
    ["-c", tmuxPtyClientScript, wrapperPath, "attach-session", "-t", session],
    { env: serverEnv, stdio: ["pipe", "pipe", "pipe"] },
  );
  const clientOutput = collectOutput(client);
  const deadline = Date.now() + 10_000;
  let clientName;
  while (Date.now() < deadline) {
    if (client.exitCode !== null || client.signalCode !== null) {
      const output = clientOutput();
      throw new Error(
        `Private tmux client exited before attach.\n${output.stdout}\n${output.stderr}`,
      );
    }
    const clients = await run(
      wrapperPath,
      ["list-clients", "-t", session, "-F", "#{client_name}"],
      {
        env: serverEnv,
        allowedExitCodes: [0, 1],
      },
    );
    clientName = clients.stdout.trim().split("\n").find(Boolean);
    if (clientName !== undefined) break;
    await delay(50);
  }
  if (clientName === undefined) {
    client.kill("SIGTERM");
    throw new Error("Private tmux client did not attach.");
  }
  return {
    tmuxPath: wrapperPath,
    env: serverEnv,
    args,
    key,
    session,
    pid,
    socketPath,
    client: { child: client, name: clientName, output: clientOutput },
  };
}

async function runInTmuxPane(server, name, command, outputRoot) {
  const stdoutPath = join(outputRoot, `${name}.stdout`);
  const stderrPath = join(outputRoot, `${name}.stderr`);
  const statusPath = join(outputRoot, `${name}.status`);
  const shellCommand = `${command} > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}; update_smoke_status=$?; printf '%s\\n' "$update_smoke_status" > ${shellQuote(statusPath)}`;
  await run(
    server.tmuxPath,
    [...server.args, "send-keys", "-l", "-t", `${server.session}:0.0`, shellCommand],
    { env: server.env },
  );
  await run(
    server.tmuxPath,
    [...server.args, "send-keys", "-t", `${server.session}:0.0`, "Enter"],
    {
      env: server.env,
    },
  );
  await waitForPath(statusPath, 120_000);
  const code = Number((await readFile(statusPath, "utf8")).trim());
  const result = {
    code,
    signal: null,
    stdout: await readFile(stdoutPath, "utf8").catch(() => ""),
    stderr: await readFile(stderrPath, "utf8").catch(() => ""),
  };
  if (code !== 0) throw new SmokeCommandError("tmux-pane", [command], result);
  return result;
}

async function stopTmuxServer(server) {
  await run(server.tmuxPath, [...server.args, "detach-client", "-t", server.client.name], {
    env: server.env,
    allowedExitCodes: [0, 1],
  });
  server.client.child.stdin.end();
  if (!(await waitForProcessExit(server.client.child.pid, 5_000))) {
    server.client.child.kill("SIGTERM");
    assertEqual(
      await waitForProcessExit(server.client.child.pid, 5_000),
      true,
      "private tmux client exit",
    );
  }
  await run(server.tmuxPath, [...server.args, "kill-server"], {
    env: server.env,
    allowedExitCodes: [0, 1],
  });
  assertEqual(await waitForProcessExit(server.pid, 10_000), true, "private tmux server exit");
  const probe = await run(server.tmuxPath, [...server.args, "has-session"], {
    env: server.env,
    allowedExitCodes: [0, 1],
  });
  assertEqual(probe.code, 1, "private tmux server unreachable");
  if (await pathExists(server.socketPath)) {
    const socket = await lstat(server.socketPath);
    if (!socket.isSocket())
      throw new Error(`Refusing non-socket tmux cleanup at ${server.socketPath}.`);
    await rm(server.socketPath);
  }
  await waitForMissing(server.socketPath, 10_000);
}

async function verifyBareLaunches(input) {
  const touch = findExecutable("touch", input.env.PATH);
  const nativeCanary = join(input.scenarioRoot, "native-renderer-canary");
  const nativeResult = await run(input.installedBinary, [], {
    env: { ...input.env, STATION_DASHBOARD_COMMAND: `${touch} ${shellQuote(nativeCanary)}` },
    timeoutMs: 30_000,
  });
  await waitForPath(nativeCanary, 10_000);
  assertNoMismatch(nativeResult.stderr, `${input.name} native bare stn`);

  let server = input.tmuxServer;
  if (server === undefined) {
    server = await startTmuxServer(
      input.tmuxPath,
      input.env,
      input.tmuxTempDir,
      `${input.name}-canary`,
    );
  }
  try {
    const tmuxCanary = join(input.scenarioRoot, "tmux-renderer-canary");
    const tmuxCanaryCommand = join(input.scenarioRoot, "tmux-renderer-canary-command");
    const sleep = findExecutable("sleep", input.env.PATH);
    await writeFile(
      tmuxCanaryCommand,
      `#!/bin/sh\n${shellQuote(touch)} ${shellQuote(tmuxCanary)}\n${shellQuote(sleep)} 2\n`,
      { mode: 0o700 },
    );
    await run(
      server.tmuxPath,
      [...server.args, "set-environment", "-g", "STATION_DASHBOARD_COMMAND", tmuxCanaryCommand],
      { env: server.env },
    );
    const tmuxResult = await runInTmuxPane(server, "bare-stn", "stn", input.scenarioRoot);
    await waitForPath(tmuxCanary, 10_000);
    assertNoMismatch(tmuxResult.stderr, `${input.name} tmux bare stn`);
  } finally {
    if (input.tmuxServer === undefined) await stopTmuxServer(server);
  }
}

function assertUpdateReport(report, input) {
  assertEqual(report.schemaVersion, 1, `${input.name} update schema`);
  assertEqual(report.channel, "installer-binary", `${input.name} update channel`);
  assertEqual(report.status, "updated", `${input.name} update status`);
  assertEqual(report.current?.version, input.options.incumbentVersion, `${input.name} current`);
  assertEqual(report.target?.version, input.target.version, `${input.name} target`);
  assertDeepEqual(report.warnings, [], `${input.name} update warnings`);
  assertDeepEqual(report.recoveryCommands, [], `${input.name} recovery commands`);
  assertEqual(report.error, undefined, `${input.name} update error`);
  const steps = new Map(report.steps.map((step) => [step.id, step]));
  for (const id of ["detect", "plan", "apply", "observer-restart"]) {
    assertEqual(steps.get(id)?.status, "completed", `${input.name} ${id} step`);
  }
  assertEqual(
    steps.get("host-handoff")?.status,
    input.busyHost ? "completed" : "skipped",
    `${input.name} Host handoff step`,
  );
}

async function waitForObserver(client, version) {
  const deadline = Date.now() + 15_000;
  let lastError;
  do {
    try {
      const health = await client.health();
      assertDisplayVersion(health.version, version, "target Observer");
      return health;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  } while (Date.now() < deadline);
  throw lastError ?? new Error("Target Observer did not become healthy.");
}

async function waitForHost(client, output) {
  const deadline = Date.now() + 10_000;
  let lastError;
  do {
    try {
      return await client.health();
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  } while (Date.now() < deadline);
  const diagnostics = output();
  throw new Error(
    `Station Host did not become healthy: ${errorMessage(lastError)}\n${diagnostics.stdout}\n${diagnostics.stderr}`,
  );
}

async function waitForHostIdle(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  do {
    last = await client.list();
    if (last.length === 0) return;
    for (const pty of last) {
      if (!pty.alive) await client.close(pty.ptyId).catch(() => undefined);
    }
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Host retained ${last.length} PTY entries during cleanup.`);
}

async function waitForPtyChild(client, spawned) {
  const deadline = Date.now() + 10_000;
  let last;
  do {
    last = (await client.list()).find((entry) => entry.ptyId === spawned.ptyId);
    if (last?.alive === true && last.pid > 0 && last.pid !== spawned.pid) return last.pid;
    await delay(50);
  } while (Date.now() < deadline);
  if (last?.alive === true && last.pid > 0) return last.pid;
  throw new Error(`PTY payload PID did not converge after spawn: ${JSON.stringify(last)}`);
}

async function waitForPtyOutput(client, expectation, marker) {
  const deadline = Date.now() + 10_000;
  do {
    const attachment = await client.attach(expectation, "viewer");
    let output;
    try {
      output = replayText(attachment.ack);
      if (!output.includes(marker)) {
        const iterator = attachment.frames[Symbol.asyncIterator]();
        output += await waitForFrame(iterator, marker, 500).catch(() => "");
        await iterator.return?.();
      }
    } finally {
      await attachment.detach().catch(() => undefined);
    }
    if (output.includes(marker)) return;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`PTY did not emit ${marker}.`);
}

function replayText(ack) {
  return ack.replay.events
    .filter((event) => event.type === "data")
    .map((event) => event.data)
    .join("");
}

async function waitForFrame(iterator, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let output = "";
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      iterator.next(),
      delay(remaining).then(() => ({ timeout: true })),
    ]);
    if (next.timeout || next.done) break;
    if (next.value.type === "data") output += next.value.data;
    if (output.includes(marker)) return output;
  }
  throw new Error(`Timed out waiting for PTY marker ${marker}; output=${JSON.stringify(output)}`);
}

async function waitForExitFrame(iterator, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      iterator.next(),
      delay(remaining).then(() => ({ timeout: true })),
    ]);
    if (next.timeout || next.done) break;
    if (next.value.type === "exit") return next.value;
  }
  throw new Error("Timed out waiting for PTY exit after update.");
}

async function waitForSocketHolders(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  do {
    try {
      last = readUnixSocketHolderPids(path);
      if (last.length > 0) return last;
    } catch {
      last = [];
    }
    await delay(50);
  } while (Date.now() < deadline);
  return last;
}

async function captureFailureEvidence(input) {
  const evidenceDir = requiredEnvironment("STATION_UPDATE_SMOKE_EVIDENCE_DIR");
  await mkdir(input.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(input.socketPath), { recursive: true, mode: 0o700 });
  const incumbentIdentity = parseStationObserverBuildVersion(
    input.suppliedBinary.version,
  ).buildIdentity;
  await captureBinarySmokeEvidence({
    runId: requiredEnvironment("STATION_UPDATE_SMOKE_RUN_ID"),
    evidenceDir,
    smokeRoot: input.root,
    stateDir: input.stateDir,
    socketPath: input.socketPath,
    status: "failed",
    round: 1,
    elapsedMs: 0,
    direction: {
      logical: `update-smoke:${input.scenarioName}`,
      physical: `${input.suppliedBinary.version ?? "incumbent"}-to-${input.target.version}`,
    },
    error: input.error,
    failure: {
      message: errorMessage(input.error),
      exitDisposition:
        input.error instanceof SmokeCommandError
          ? input.error.result.signal === null
            ? { type: "code", code: input.error.result.code }
            : { type: "signal", signal: input.error.result.signal }
          : { type: "unavailable" },
    },
    artifacts: {
      current: {
        path: input.suppliedBinary.path,
        displayVersion: input.suppliedBinary.version ?? "unknown",
        buildIdentity: incumbentIdentity ?? "unavailable",
      },
      alternate: {
        path: input.target.archivePath ?? input.target.tag,
        displayVersion: input.target.version,
        buildIdentity: "unavailable",
      },
      incumbent: "current",
      requested: "alternate",
    },
    knownProcesses: [
      ...(input.observerPid === undefined ? [] : [{ role: "observer", pid: input.observerPid }]),
      ...(input.hostPid === undefined ? [] : [{ role: "station-host", pid: input.hostPid }]),
    ],
    lifecycleEvents: [],
  });
}

async function snapshotSuppliedBinary(path, version) {
  const resolvedPath = resolve(path);
  const metadata = await lstat(resolvedPath, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111n) === 0n) {
    throw new Error(`Incumbent binary is not an executable regular file: ${resolvedPath}`);
  }
  return {
    path: resolvedPath,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    sha256: await sha256File(resolvedPath),
    version,
  };
}

async function assertSuppliedBinaryUnchanged(snapshot) {
  const current = await snapshotSuppliedBinary(snapshot.path);
  assertDeepEqual(
    { device: current.device, inode: current.inode, sha256: current.sha256 },
    { device: snapshot.device, inode: snapshot.inode, sha256: snapshot.sha256 },
    "supplied incumbent binary identity",
  );
}

function parseArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const values = new Map();
  let keepTemp = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--keep-temp") {
      if (keepTemp) throw new Error("--keep-temp may be provided only once.");
      keepTemp = true;
      continue;
    }
    if (key === undefined || !key.startsWith("--")) throw new Error(updateSmokeUsage());
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(updateSmokeUsage());
    if (values.has(key)) throw new Error(`Duplicate update smoke flag: ${key}`);
    values.set(key, value);
    index += 1;
  }
  for (const key of values.keys()) {
    if (
      ![
        "--incumbent-binary",
        "--incumbent-version",
        "--target-source-version",
        "--target-release-dir",
        "--target-tag",
        "--public-target-tag",
        "--scenarios",
      ].includes(key)
    ) {
      throw new Error(`Unknown update smoke flag: ${key}`);
    }
  }
  const incumbentBinary = requiredFlag(values, "--incumbent-binary");
  const incumbentVersion = semverFlag(values, "--incumbent-version");
  const sourceVersion = values.get("--target-source-version");
  const releaseDir = values.get("--target-release-dir");
  const targetTag = values.get("--target-tag");
  const publicTag = values.get("--public-target-tag");
  const modes = [
    sourceVersion !== undefined,
    releaseDir !== undefined || targetTag !== undefined,
    publicTag !== undefined,
  ].filter(Boolean).length;
  if (modes !== 1 || (releaseDir === undefined) !== (targetTag === undefined)) {
    throw new Error(updateSmokeUsage());
  }
  let target;
  if (sourceVersion !== undefined) {
    if (!semverPattern.test(sourceVersion))
      throw new Error("--target-source-version must be SemVer.");
    target = { mode: "source", version: sourceVersion };
  } else if (releaseDir !== undefined && targetTag !== undefined) {
    validateTag(targetTag, "--target-tag");
    target = { mode: "staged", releaseDir: resolve(releaseDir), tag: targetTag };
  } else {
    validateTag(publicTag, "--public-target-tag");
    target = { mode: "public", tag: publicTag };
  }
  const targetVersion = target.mode === "source" ? target.version : target.tag.slice(1);
  if (targetVersion === incumbentVersion) {
    throw new Error("Update smoke target must differ from the incumbent version.");
  }
  const scenarios = values.get("--scenarios") ?? "full";
  if (scenarios !== "full" && scenarios !== "no-host") {
    throw new Error("--scenarios must be full or no-host.");
  }
  return {
    incumbentBinary: resolve(incumbentBinary),
    incumbentVersion,
    target,
    scenarios,
    keepTemp,
  };
}

function updateSmokeUsage() {
  return "Usage: run-update-smoke.mjs --incumbent-binary <path> --incumbent-version <version> (--target-source-version <version> | --target-release-dir <path> --target-tag <tag> | --public-target-tag <tag>) [--scenarios full|no-host] [--keep-temp]";
}

function requiredFlag(values, key) {
  const value = values.get(key);
  if (value === undefined || value.length === 0) throw new Error(`Missing ${key}.`);
  return value;
}

function semverFlag(values, key) {
  const value = requiredFlag(values, key);
  if (!semverPattern.test(value)) throw new Error(`${key} must be SemVer without build metadata.`);
  return value;
}

function validateTag(tag, flag) {
  if (tag === undefined || !tag.startsWith("v") || !semverPattern.test(tag.slice(1))) {
    throw new Error(`${flag} must be a v-prefixed SemVer tag.`);
  }
}

function nativeTarget() {
  const target = {
    "darwin:arm64": "darwin-arm64",
    "darwin:x64": "darwin-x64",
    "linux:arm64": "linux-arm64",
    "linux:x64": "linux-x64",
  }[`${process.platform}:${process.arch}`];
  if (target === undefined)
    throw new Error(`Unsupported update smoke host: ${process.platform}/${process.arch}`);
  return target;
}

function buildEnvironment() {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_PREFIX",
    "STATION_CONFIG_PATH",
    "STATION_OBSERVER_SOCKET_PATH",
    "STATION_HOST_SOCKET_PATH",
    "STATION_OPENCODE_PLUGIN_BODY_PATH",
    "STATION_RUNTIME_OWNER_FOREGROUND",
    "TMUX",
    "TMUX_PANE",
  ]) {
    delete env[key];
  }
  return env;
}

function findExecutable(command, pathValue) {
  if (isAbsolute(command)) return command;
  for (const directory of (pathValue ?? "").split(":")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, command);
    try {
      const metadata = statSyncSafe(candidate);
      if (metadata?.isFile() && (metadata.mode & 0o111) !== 0) return candidate;
    } catch {
      // Continue through the explicit PATH.
    }
  }
  throw new Error(`Required command is unavailable on PATH: ${command}`);
}

function statSyncSafe(path) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

async function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? childTimeoutMs;
  const maxOutputChars = options.maxOutputChars ?? outputLimit;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      return next.length > maxOutputChars ? next.slice(next.length - maxOutputChars) : next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const finish = (error, code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        rejectRun(error);
        return;
      }
      const result = { code: code ?? signalExitCode(signal), signal, stdout, stderr };
      if (!(options.allowedExitCodes ?? [0]).includes(result.code)) {
        rejectRun(new SmokeCommandError(command, args, result));
        return;
      }
      resolveRun(result);
    };
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => finish(undefined, code, signal));
  });
}

function collectOutput(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout = (stdout + chunk.toString("utf8")).slice(-65_536);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-65_536);
  });
  return () => ({ stdout, stderr });
}

async function waitForPath(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await pathExists(path)) return;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${path}.`);
}

async function waitForMissing(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await pathExists(path))) return;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for removal of ${path}.`);
}

async function waitForProcessExit(pid, timeoutMs) {
  if (pid === undefined) return true;
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processIsAlive(pid)) return true;
    await delay(50);
  } while (Date.now() < deadline);
  return !processIsAlive(pid);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function cleanupAction(warnings, label, action) {
  try {
    await action();
  } catch (error) {
    warnings.push(`${label}: ${errorMessage(error)}`);
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function removeExactTemporaryRoot(root, identity) {
  const canonical = await realpath(root);
  const temporary = await realpath(tmpdir());
  if (dirname(canonical) !== temporary || !basename(canonical).startsWith("stn-update-smoke-")) {
    throw new Error(`Refusing unexpected update smoke deletion target: ${canonical}`);
  }
  const current = await lstat(canonical);
  const actual = fileIdentity(current);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    actual.device !== identity.device ||
    actual.inode !== identity.inode
  ) {
    throw new Error(`Refusing replaced update smoke root: ${canonical}`);
  }
  await rm(canonical, { recursive: true, force: true });
}

function fileIdentity(metadata) {
  return { device: String(metadata.dev), inode: String(metadata.ino) };
}

async function ownerStateDirectory() {
  const checkout = await realpath(repoRoot);
  const metadata = await lstat(checkout);
  const key = createHash("sha256")
    .update(`${checkout}\0${metadata.dev}\0${metadata.ino}`)
    .digest("hex")
    .slice(0, 24);
  const path = join(resolve(tmpdir()), `station-update-smoke-owner-${key}`);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const current = await lstat(path);
  if (!current.isDirectory() || current.isSymbolicLink() || (current.mode & 0o777) !== 0o700) {
    throw new Error(`Update smoke owner state is not private: ${path}`);
  }
  return path;
}

async function readLifecycle(path, offset) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return bytes
    .subarray(Math.min(offset, bytes.length))
    .toString("utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = RuntimeLifecycleEventSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
}

async function fileSizeOrZero(path) {
  try {
    return (await lstat(path)).size;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`${label} was not valid JSON: ${text}`, { cause });
  }
}

function assertDisplayVersion(selector, expected, label) {
  if (selector === undefined) throw new Error(`${label} omitted its build selector.`);
  assertEqual(parseStationObserverBuildVersion(selector).version, expected, `${label} version`);
}

function assertNoMismatch(output, label) {
  if (
    /mismatch|OBSERVER_HANDOFF_REFUSED|HOST_(?:UPGRADE_BLOCKED|VERSION_INCOMPATIBLE)/iu.test(output)
  ) {
    throw new Error(`${label} emitted a build mismatch: ${output}`);
  }
}

function assertUnixSocketPath(path) {
  if (process.platform === "darwin" && Buffer.byteLength(path) >= 104) {
    throw new Error(`Update smoke Unix socket path exceeds macOS's 103-byte limit: ${path}`);
  }
}

function assertEqual(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function assertNotEqual(actual, expected, label) {
  if (Object.is(actual, expected))
    throw new Error(`${label}: values unexpectedly matched ${actual}`);
}

function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function assertIncludes(actual, expected, label) {
  if (!actual.includes(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)} in ${JSON.stringify(actual)}`);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value.length > 0))];
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing required ${name}.`);
  return value;
}

function optionalAbsoluteEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) return undefined;
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute.`);
  return resolve(value);
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function exitDescription(result) {
  return result.signal === null ? `code ${result.code}` : `signal ${result.signal}`;
}

function signalExitCode(signal) {
  return { SIGHUP: 129, SIGINT: 130, SIGTERM: 143, SIGKILL: 137 }[signal] ?? 1;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
