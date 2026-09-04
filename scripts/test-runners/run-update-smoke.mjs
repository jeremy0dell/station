#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
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
import { readBuildIdentity } from "../build-identity.mjs";
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
import {
  parseComposedUpdateReport,
  updateReportSchemaVersionForEmitter,
} from "./composed-update-report.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const runnerPath = fileURLToPath(import.meta.url);
const receiptContent = "station-installer-binary-v1\n";
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const targetNames = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const childTimeoutMs = 120_000;
const buildTimeoutMs = 12 * 60_000;
const outputLimit = 4 * 1024 * 1024;
const paneOutputLimit = 64 * 1024;
const timeoutTerminationGraceMs = 2_000;
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

class SmokeTimeoutError extends SmokeCommandError {
  constructor(command, args, result, timeoutMs) {
    super(command, args, result);
    this.timedOut = true;
    this.message = `${command} ${args.join(" ")} timed out after ${timeoutMs}ms and was reaped\n${result.stdout}\n${result.stderr}`;
  }
}

if (process.argv[2] === "__pane-child") {
  await runPaneChild(process.argv[3]);
} else if (externalOwner) {
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
    await reserveBinarySmokeEvidenceDestination({
      evidenceDir,
      smokeRoot: root,
      runId,
    });
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
      correlation: {
        traceId: `trc_${randomUUID()}`,
        spanId: `spn_${randomUUID()}`,
      },
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
      await releaseBinarySmokeEvidenceReservation({
        evidenceDir,
        smokeRoot: root,
        runId,
      });
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
  let predecessorSource;
  if (options.predecessorSourceDir !== undefined) {
    predecessorSource = await snapshotTaggedPredecessorSource(
      options.predecessorSourceDir,
      options.incumbentVersion,
    );
  }
  const target = await prepareTarget(options, root);
  await assertTargetAssetsUnchanged(target);
  const predecessorScenarios = [
    {
      name: "external-busy-host",
      socketKey: "e",
      invocation: "external",
      artifactState: "predecessor",
      hostState: "busy-compiled-non-bridge",
    },
    {
      name: "tmux-busy-host",
      socketKey: "b",
      invocation: "tmux",
      artifactState: "predecessor",
      hostState:
        options.busyHostOutcome === "full-handoff"
          ? "busy-source-bridge"
          : "busy-compiled-non-bridge",
    },
    {
      name: "tmux-no-host",
      socketKey: "n",
      invocation: "tmux",
      artifactState: "predecessor",
      hostState: "absent",
    },
  ];
  const currentArtifactScenarios = [
    {
      name: "current-no-host",
      socketKey: "cn",
      invocation: "external",
      artifactState: "current",
      hostState: "absent",
    },
    {
      name: "current-idle-host",
      socketKey: "ci",
      invocation: "external",
      artifactState: "current",
      hostState: "idle-compiled",
    },
    {
      name: "current-busy-source-bridge-host",
      socketKey: "cb",
      invocation: "external",
      artifactState: "current",
      hostState: "busy-source-bridge",
    },
    {
      name: "current-busy-non-bridge-host",
      socketKey: "cx",
      invocation: "external",
      artifactState: "current",
      hostState: "busy-compiled-non-bridge",
    },
  ];
  const scenarios =
    options.scenarios === "no-host"
      ? [predecessorScenarios[2]]
      : options.scenarios === "release"
        ? [...predecessorScenarios, ...currentArtifactScenarios]
        : predecessorScenarios;

  try {
    for (const scenario of scenarios) {
      await assertTargetAssetsUnchanged(target);
      await runScenario({
        ...scenario,
        options,
        root,
        suppliedBinary,
        predecessorSource,
        target,
        evidenceDir,
      });
    }
    await assertTargetAssetsUnchanged(target);
    await assertSuppliedBinaryUnchanged(suppliedBinary);
    if (predecessorSource !== undefined) {
      await assertTaggedPredecessorSourceUnchanged(predecessorSource);
    }
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
  const homeDir = join(scenarioRoot, "home");
  const configHome = join(homeDir, ".config");
  const stateHome = join(scenarioRoot, "state-home");
  const dataHome = join(scenarioRoot, "data-home");
  const cacheHome = join(scenarioRoot, "cache-home");
  // Bridge control sockets inherit this path; keep it short enough for macOS sun_path.
  const stateDir = join(input.root, "s", input.socketKey);
  const runtimeDir = join(input.root, "r", input.socketKey);
  const tempDir = join(scenarioRoot, "tmp");
  const tmuxTempDir = await mkdtemp(join("/tmp", `stn-tmux-${input.socketKey}-`));
  const installDir = join(scenarioRoot, "bin");
  const configPath = join(configHome, "station", "config.toml");
  const socketPath = join(runtimeDir, "observer.sock");
  const hostSocketPath = join(runtimeDir, "station-host.sock");
  assertUnixSocketPath(socketPath);
  assertUnixSocketPath(hostSocketPath);
  const postSignal = join(scenarioRoot, "post");
  const releaseSignal = join(scenarioRoot, "release");
  const diagnostics = { observerPid: undefined, hostPid: undefined };
  const processIdentities = new Map();
  const cleanupWarnings = [];
  let observerClient;
  let incumbentObserver;
  let incumbentHostBuildIdentity;
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
      runtimeDir,
      tempDir,
      tmuxTempDir,
      installDir,
    ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  await installIncumbent(input.suppliedBinary.path, installDir, dataHome);
  await writeConfig(configPath, stateDir, socketPath);
  const updateTransportDir =
    input.target.mode === "public"
      ? undefined
      : await writeReleaseTransport({
          scenarioRoot,
          ledger: "update-transport",
          currentTag:
            input.artifactState === "current"
              ? input.target.tag
              : `v${input.options.incumbentVersion}`,
          target: input.target,
          includeAssets: input.artifactState === "predecessor",
        });
  const targetInstallTransportDir =
    input.artifactState === "current"
      ? await writeReleaseTransport({
          scenarioRoot,
          ledger: "target-install-transport",
          currentTag: input.target.tag,
          target: input.target,
          includeMetadata: false,
          includeInstaller: false,
        })
      : undefined;
  const tmuxPath = findExecutable("tmux", process.env.PATH);
  const tmuxAudit = await prepareTmuxAudit(scenarioRoot, tmuxPath);
  const environmentInput = {
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
    tmuxPath,
    tmuxShadowDir: tmuxAudit.shadowDir,
  };
  const env = isolatedEnvironment({
    ...environmentInput,
    transportDir: updateTransportDir,
  });
  const targetInstallEnv =
    targetInstallTransportDir === undefined
      ? undefined
      : isolatedEnvironment({
          ...environmentInput,
          transportDir: targetInstallTransportDir,
        });
  const installedBinary = await realpath(join(installDir, "stn"));

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
    const incumbentBuildIdentity = parseStationObserverBuildVersion(
      incumbentObserver.version,
    ).buildIdentity;
    diagnostics.observerPid = incumbentObserver.pid;
    await recordProcessIdentity(processIdentities, "incumbent-observer", incumbentObserver.pid);
    observerClient = createObserverClient({
      socketPath,
      timeoutMs: 5000,
      acceptPreviousLifecycleSchema: true,
    });

    if (scenarioHasHost(input)) {
      const sourceBridgeHost = input.hostState === "busy-source-bridge";
      if (sourceBridgeHost && incumbentBuildIdentity === undefined) {
        throw new Error(`${input.name} incumbent Observer did not expose a build identity.`);
      }
      const taggedPredecessorHost = sourceBridgeHost && input.predecessorSource !== undefined;
      if (taggedPredecessorHost) {
        incumbentHostBuildIdentity = input.predecessorSource.buildIdentity;
      } else {
        incumbentHostBuildIdentity = incumbentBuildIdentity;
      }
      let hostCommand = installedBinary;
      let hostArgs = ["__station-host", "--socket", hostSocketPath, "--state-dir", stateDir];
      let hostEnvironment = env;
      let hostCwd = scenarioRoot;
      if (sourceBridgeHost) {
        hostCommand = process.env.STATION_BUN ?? findExecutable("bun", process.env.PATH);
        hostCwd = input.predecessorSource?.path ?? repoRoot;
        hostArgs = [
          join(hostCwd, "station", "src", "host", "hostMain.ts"),
          "--socket",
          hostSocketPath,
          "--state-dir",
          stateDir,
        ];
        hostEnvironment = { ...env, STATION_PTY_IMPL: "bridge" };
        if (!taggedPredecessorHost) {
          hostArgs.push(
            "--build-version",
            input.options.incumbentVersion,
            "--build-identity",
            incumbentBuildIdentity,
          );
          hostEnvironment.STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE = "1";
        }
      }
      incumbentHostProcess = spawn(hostCommand, hostArgs, {
        cwd: hostCwd,
        env: hostEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      incumbentHostOutput = collectOutput(incumbentHostProcess);
      diagnostics.hostPid = incumbentHostProcess.pid;
      await recordProcessIdentity(processIdentities, "incumbent-host", incumbentHostProcess.pid);
      const incumbentHostClient = createStationHostClient({
        socketPath: hostSocketPath,
        timeoutMs: 2000,
        expectedBuildVersion: input.options.incumbentVersion,
      });
      const incumbentHostHealth = await waitForHost(incumbentHostClient, incumbentHostOutput);
      assertEqual(
        incumbentHostHealth.buildVersion,
        input.options.incumbentVersion,
        `${input.name} incumbent Host version`,
      );
      assertDeepEqual(
        readUnixSocketHolderPids(hostSocketPath),
        [incumbentHostProcess.pid],
        `${input.name} incumbent Host holder`,
      );
      if (scenarioHasBusyHost(input)) {
        const rawIdentityCanary = randomUUID().replaceAll("-", "");
        ptyIdentity = {
          kind: "agent",
          terminalTargetId: `native:raw-terminal-${rawIdentityCanary}`,
          worktreeId: `raw-worktree-${rawIdentityCanary}`,
          projectId: `raw-project-${rawIdentityCanary}`,
          sessionId: `ses_raw_session_${rawIdentityCanary}`,
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
        await recordProcessIdentity(processIdentities, "pty-payload", ptyChildPid);
        await waitForPtyOutput(
          incumbentHostClient,
          { ...ptyIdentity, ...spawnedPty },
          "UPDATE_SMOKE_PRE",
        );
      }
      incumbentHostClient.dispose();
    } else {
      assertEqual(await pathExists(hostSocketPath), false, `${input.name} starts without Host`);
    }

    if (input.artifactState === "current") {
      if (input.target.mode === "public" || targetInstallEnv === undefined) {
        throw new Error("Current-artifact scenarios require snapshotted target assets.");
      }
      // The old runtime must start before the exact target artifact replaces the installed binary.
      await run("/bin/sh", [input.target.installerPath, "--install-dir", installDir], {
        cwd: scenarioRoot,
        env: targetInstallEnv,
        timeoutMs: childTimeoutMs,
      });
      const installedTargetVersion = await run(installedBinary, ["--version"], {
        env,
      });
      assertEqual(
        installedTargetVersion.stdout.trim(),
        input.target.version,
        `${input.name} preinstalled target version`,
      );
      assertEqual(
        await processIdentityMatches(processIdentities.get("incumbent-observer")),
        true,
        `${input.name} target installation preserves incumbent Observer`,
      );
      if (scenarioHasHost(input)) {
        assertEqual(
          await processIdentityMatches(processIdentities.get("incumbent-host")),
          true,
          `${input.name} target installation preserves incumbent Host`,
        );
      }
    }

    if (input.invocation === "tmux") {
      tmuxServer = await startTmuxServer(tmuxPath, env, tmuxTempDir, input.name, processIdentities);
    }
    const dryRunStateInput = {
      installedBinary,
      installDir,
      dataHome,
      configPath,
      stateDir,
      socketPath,
      hostSocketPath,
      observerBuildVersion: incumbentObserver.version,
      hostBuildVersion: input.options.incumbentVersion,
      hasHost: scenarioHasHost(input),
    };
    const beforeDryRun = await captureDryRunState(dryRunStateInput);
    const dryRunResult =
      input.invocation === "external"
        ? await run(installedBinary, ["update", "--dry-run", "--json"], {
            env,
            timeoutMs: childTimeoutMs,
            allowedExitCodes: [0, 1],
          })
        : await runInTmuxPane(
            tmuxServer,
            "dry-run",
            [installedBinary, "update", "--dry-run", "--json"],
            scenarioRoot,
          );
    const dryRunJson = parseJson(dryRunResult.stdout, `${input.name} compiled dry-run report`);
    const dryRunReport = parseComposedUpdateReport(dryRunJson, reportEmitterVersion(input));
    const reportEvidence = {
      incumbentBuildIdentity,
      incumbentHostBuildIdentity,
      ptyIdentity,
      spawnedPty,
    };
    const expectedDryRunCode = assertDryUpdateReport(
      dryRunReport,
      dryRunJson,
      input,
      reportEvidence,
    );
    assertEqual(dryRunResult.code, expectedDryRunCode, `${input.name} dry-run outcome exit code`);
    assertDeepEqual(
      await captureDryRunState(dryRunStateInput),
      beforeDryRun,
      `${input.name} dry-run persistent and runtime state`,
    );
    assertEqual(
      await processIdentityMatches(processIdentities.get("incumbent-observer")),
      true,
      `${input.name} dry run preserves incumbent Observer`,
    );
    if (scenarioHasHost(input)) {
      assertEqual(
        await processIdentityMatches(processIdentities.get("incumbent-host")),
        true,
        `${input.name} dry run preserves incumbent Host`,
      );
    }
    if (scenarioHasBusyHost(input)) {
      assertEqual(
        await processIdentityMatches(processIdentities.get("pty-payload")),
        true,
        `${input.name} dry run preserves PTY payload`,
      );
    }

    const preservedRefusal = updateRequiresPreservation(input);
    let completedInstallRefusal = false;
    const expectedUpdateCode = preservedRefusal ? 1 : 0;
    const updateResult =
      input.invocation === "external"
        ? await run(installedBinary, ["update", "--json"], {
            env,
            timeoutMs: childTimeoutMs,
            allowedExitCodes: [expectedUpdateCode],
          })
        : await runInTmuxPane(
            tmuxServer,
            "update",
            [installedBinary, "update", "--json"],
            scenarioRoot,
          );
    assertEqual(
      updateResult.code,
      expectedUpdateCode,
      `${input.name} update exit code (${JSON.stringify({
        stdout: updateResult.stdout,
        stderr: updateResult.stderr,
      })})`,
    );
    const emitterVersion = reportEmitterVersion(input);
    const reportSchemaVersion = updateReportSchemaVersionForEmitter(emitterVersion);
    const allowsStderrOnlyRefusal = reportSchemaVersion === 1 || reportSchemaVersion === 4;
    if (preservedRefusal && updateResult.stdout.trim().length === 0 && allowsStderrOnlyRefusal) {
      assertIncludes(
        updateResult.stderr,
        "UPDATE_HOST_HANDOFF_PREFLIGHT_FAILED",
        `${input.name} refused update code`,
      );
      assertIncludes(
        updateResult.stderr,
        "Host terminals are not all eligible for live handoff.",
        `${input.name} refused update reason`,
      );
      assertDeepEqual(
        await captureDryRunState(dryRunStateInput),
        beforeDryRun,
        `${input.name} refused update persistent and runtime state`,
      );
    } else {
      const reportJson = parseJson(updateResult.stdout, `${input.name} update report`);
      const report = parseComposedUpdateReport(reportJson, emitterVersion);
      assertUpdateReport(report, reportJson, input, installedBinary, configPath, reportEvidence);
      assertNoMismatch(updateResult.stderr, `${input.name} update stderr`);
      completedInstallRefusal = preservedRefusal && report.status === "failed";
    }
    if (preservedRefusal) {
      assertDeepEqual(
        await captureDryRunState(dryRunStateInput),
        beforeDryRun,
        `${input.name} refused update persistent and runtime state`,
      );
    }
    if (updateTransportDir !== undefined) {
      await assertExactTransportRequests({
        updateTransportDir,
        targetInstallTransportDir,
        input,
        completedInstallRefusal,
      });
    }

    if (preservedRefusal && !completedInstallRefusal) {
      const preservedObserver = await waitForObserver(
        observerClient,
        input.options.incumbentVersion,
      );
      assertEqual(
        preservedObserver.pid,
        incumbentObserver.pid,
        `${input.name} incumbent Observer identity preserved`,
      );
      assertDeepEqual(
        readUnixSocketHolderPids(socketPath),
        [incumbentObserver.pid],
        `${input.name} incumbent Observer holder preserved`,
      );
    } else {
      const targetObserver = await waitForObserver(observerClient, input.target.version);
      diagnostics.observerPid = targetObserver.pid;
      await recordProcessIdentity(processIdentities, "target-observer", targetObserver.pid);
      assertObserverBuildIdentity(
        targetObserver.version,
        input.target.buildIdentity,
        `${input.name} target Observer`,
      );
      assertNotEqual(
        targetObserver.pid,
        incumbentObserver.pid,
        `${input.name} Observer replacement PID`,
      );
      assertEqual(
        await waitForExactProcessExit(processIdentities.get("incumbent-observer"), 10_000),
        true,
        `${input.name} incumbent Observer exit`,
      );
      assertDeepEqual(
        readUnixSocketHolderPids(socketPath),
        [targetObserver.pid],
        `${input.name} target Observer holder`,
      );
    }

    if (scenarioHasHost(input) && !preservedRefusal) {
      assertEqual(
        await waitForExactProcessExit(processIdentities.get("incumbent-host"), 10_000),
        true,
        `${input.name} incumbent Host exit`,
      );
      const holders = await waitForSocketHolders(hostSocketPath, 10_000);
      assertEqual(holders.length, 1, `${input.name} target Host holder count`);
      assertNotEqual(holders[0], incumbentHostProcess.pid, `${input.name} target Host replacement`);
      diagnostics.hostPid = holders[0];
      await recordProcessIdentity(processIdentities, "target-host", holders[0]);
      const targetHostClient = createStationHostClient({
        socketPath: hostSocketPath,
        timeoutMs: 3000,
        expectedBuildVersion: input.target.version,
      });
      const hostHealth = await targetHostClient.health();
      assertEqual(hostHealth.buildVersion, input.target.version, `${input.name} target Host build`);
      const targetInventory = await targetHostClient.list();
      if (scenarioHasBusyHost(input)) {
        const live = targetInventory.find((entry) => entry.ptyId === spawnedPty.ptyId);
        if (live === undefined) throw new Error(`${input.name} target Host lost the live PTY.`);
        assertEqual(live.ptyId, spawnedPty.ptyId, `${input.name} PTY ID`);
        assertEqual(live.ptyInstanceId, spawnedPty.ptyInstanceId, `${input.name} PTY instance`);
        assertEqual(live.pid, ptyChildPid, `${input.name} PTY child PID`);
        const attachment = await targetHostClient.attach(
          { ...ptyIdentity, ...spawnedPty },
          "viewer",
        );
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
      } else {
        assertDeepEqual(targetInventory, [], `${input.name} target Host empty inventory`);
      }
      targetHostClient.dispose();
    } else if (scenarioHasBusyHost(input)) {
      const incumbentHostIdentity = processIdentities.get("incumbent-host");
      assertEqual(
        await processIdentityMatches(incumbentHostIdentity),
        true,
        `${input.name} incumbent Host identity preserved`,
      );
      assertDeepEqual(
        readUnixSocketHolderPids(hostSocketPath),
        [incumbentHostProcess.pid],
        `${input.name} incumbent Host holder preserved`,
      );
      const preservedHostClient = createStationHostClient({
        socketPath: hostSocketPath,
        timeoutMs: 3000,
        expectedBuildVersion: input.options.incumbentVersion,
      });
      const preservedHealth = await preservedHostClient.health();
      assertEqual(
        preservedHealth.buildVersion,
        input.options.incumbentVersion,
        `${input.name} preserved Host build`,
      );
      const live = (await preservedHostClient.list()).find(
        (entry) => entry.ptyId === spawnedPty.ptyId,
      );
      assertPreservedPty(live, spawnedPty, ptyChildPid, input.name);
      const attachment = await preservedHostClient.attach(
        { ...ptyIdentity, ...spawnedPty },
        "viewer",
      );
      assertIncludes(
        replayText(attachment.ack),
        "UPDATE_SMOKE_PRE",
        `${input.name} preserved replay`,
      );
      const iterator = attachment.frames[Symbol.asyncIterator]();
      await writeFile(postSignal, "\n", { mode: 0o600 });
      const post = await waitForFrame(iterator, "UPDATE_SMOKE_POST", 10_000);
      assertIncludes(post, "UPDATE_SMOKE_POST", `${input.name} preserved live output`);
      await iterator.return?.();
      await attachment.detach();
      preservedHostClient.dispose();
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
      expectNativeRefusal:
        completedInstallRefusal || (input.artifactState === "current" && preservedRefusal),
      expectTmuxRefusal: input.artifactState === "current" && preservedRefusal,
      processIdentities,
    });
    if (scenarioHasHost(input)) {
      const expectedHostVersion = preservedRefusal
        ? input.options.incumbentVersion
        : input.target.version;
      const cleanupClient = createStationHostClient({
        socketPath: hostSocketPath,
        timeoutMs: 3000,
        expectedBuildVersion: expectedHostVersion,
      });
      if (preservedRefusal) {
        const live = (await cleanupClient.list()).find((entry) => entry.ptyId === spawnedPty.ptyId);
        assertPreservedPty(live, spawnedPty, ptyChildPid, input.name);
        await writeFile(releaseSignal, "\n", { mode: 0o600 });
        await waitForExactProcessExit(processIdentities.get("pty-payload"), 10_000);
        await cleanupClient.close(spawnedPty.ptyId).catch(() => undefined);
      }
      await cleanupClient.stopIfIdle(expectedHostVersion);
      cleanupClient.dispose();
      await waitForMissing(hostSocketPath, 10_000);
      assertEqual(
        await waitForExactProcessExit(
          processIdentities.get(preservedRefusal ? "incumbent-host" : "target-host"),
          10_000,
        ),
        true,
        `${input.name} target Host cleanup`,
      );
    }
    await observerClient.stop();
    await waitForMissing(socketPath, 10_000);
    assertEqual(
      await waitForExactProcessExit(
        processIdentities.get(
          preservedRefusal && !completedInstallRefusal ? "incumbent-observer" : "target-observer",
        ),
        10_000,
      ),
      true,
      `${input.name} active Observer cleanup`,
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
        processIdentities: [...processIdentities.values()],
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
      await run(wrapperPath, ["kill-server"], {
        env,
        allowedExitCodes: [0, 1],
      });
      const probe = await run(wrapperPath, ["has-session"], {
        env,
        allowedExitCodes: [0, 1],
      });
      assertEqual(probe.code, 1, "unadmitted private tmux server unreachable");
    });
    await cleanupAction(cleanupWarnings, "tmux residue", async () => {
      await assertNoSocketsUnder(tmuxTempDir);
      assertEqual((await readFile(tmuxAudit.bareLogPath, "utf8")).length, 0, "bare tmux audit log");
    });
    await cleanupAction(cleanupWarnings, "tmux temp directory", async () => {
      await rm(tmuxTempDir, { recursive: true, force: true });
    });
    await cleanupAction(cleanupWarnings, "state directory", async () => {
      await rm(stateDir, { recursive: true, force: true });
    });
    await cleanupAction(cleanupWarnings, "Host cleanup", async () => {
      if (!(await pathExists(hostSocketPath))) return;
      const raw = createStationHostClient({
        socketPath: hostSocketPath,
        timeoutMs: 2000,
        expectedBuildVersion: input.options.incumbentVersion,
      });
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
      const identity = processIdentities.get("incumbent-host");
      if (!(await processIdentityMatches(identity))) {
        return;
      }
      await terminateExactProcess(identity);
    });
    await cleanupAction(cleanupWarnings, "owned process cleanup", async () => {
      for (const identity of processIdentities.values()) {
        if (await processIdentityMatches(identity)) await terminateExactProcess(identity);
      }
    });
  }

  for (const warning of cleanupWarnings) process.stderr.write(`Update smoke warning: ${warning}\n`);
  if (failure !== undefined && cleanupWarnings.length > 0) {
    throw new AggregateError(
      [failure, ...cleanupWarnings.map((warning) => new Error(warning))],
      `${input.name} failed and cleanup was incomplete.`,
    );
  }
  if (failure !== undefined) throw failure;
  if (cleanupWarnings.length > 0) {
    throw new AggregateError(
      cleanupWarnings.map((warning) => new Error(warning)),
      `${input.name} cleanup failed.`,
    );
  }
  assertEqual(await pathExists(socketPath), false, `${input.name} Observer socket cleanup`);
  assertEqual(await pathExists(hostSocketPath), false, `${input.name} Host socket cleanup`);
  for (const identity of processIdentities.values()) {
    assertEqual(
      await processIdentityMatches(identity),
      false,
      `${input.name} ${identity.role} cleanup`,
    );
  }
}

async function prepareTarget(options, root) {
  if (options.target.mode === "public") {
    return {
      mode: "public",
      tag: options.target.tag,
      version: options.target.tag.slice(1),
      buildIdentity: options.target.buildIdentity,
    };
  }
  if (options.target.mode === "staged") {
    const target = {
      mode: "staged",
      tag: options.target.tag,
      version: options.target.tag.slice(1),
      buildIdentity: options.target.buildIdentity,
      releaseDir: options.target.releaseDir,
      archivePath: join(
        options.target.releaseDir,
        `stn-${options.target.tag}-${nativeTarget()}.tar.gz`,
      ),
      installerPath: join(options.target.releaseDir, "install.sh"),
      checksumsPath: join(options.target.releaseDir, "SHA256SUMS"),
    };
    await validateTargetFiles(target);
    return { ...target, assetSnapshots: await snapshotTargetAssets(target) };
  }

  const buildRoot = join(root, "target-source");
  const releaseDir = join(root, "target-release");
  await mkdir(releaseDir, { recursive: true, mode: 0o700 });
  await cloneCurrentSource(buildRoot);
  const buildEnv = buildEnvironment();
  await run(findExecutable("bun", process.env.PATH), ["install", "--frozen-lockfile"], {
    cwd: buildRoot,
    env: buildEnv,
    timeoutMs: buildTimeoutMs,
  });
  await run(
    findExecutable("bun", process.env.PATH),
    ["run", "build:binary", "--", "--version", options.target.version],
    { cwd: buildRoot, env: buildEnv, timeoutMs: buildTimeoutMs },
  );
  const buildIdentity = await readBuildIdentity(buildRoot);
  assertBuildIdentity(buildIdentity, "source target build identity");
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
    buildIdentity,
    releaseDir,
    archivePath,
    installerPath,
    checksumsPath,
  };
  await validateTargetFiles(target);
  return { ...target, assetSnapshots: await snapshotTargetAssets(target) };
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
    await cp(source, target, {
      dereference: false,
      preserveTimestamps: true,
      recursive: true,
    });
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

async function snapshotTargetAssets(target) {
  return Promise.all(
    [target.installerPath, target.checksumsPath, target.archivePath].map(async (path) => {
      const metadata = await lstat(path, { bigint: true });
      return {
        path,
        device: String(metadata.dev),
        inode: String(metadata.ino),
        size: String(metadata.size),
        sha256: await sha256File(path),
      };
    }),
  );
}

async function assertTargetAssetsUnchanged(target) {
  if (target.assetSnapshots === undefined) return;
  const current = await snapshotTargetAssets(target);
  assertDeepEqual(current, target.assetSnapshots, `${target.mode} target asset identity`);
}

async function captureDryRunState(input) {
  const observer = createObserverClient({
    socketPath: input.socketPath,
    timeoutMs: 5000,
    expectedBuildVersion: input.observerBuildVersion,
    acceptPreviousLifecycleSchema: true,
  });
  const observerHealth = await observer.health();
  const observerIdentity = {
    schemaVersion: observerHealth.schemaVersion,
    pid: observerHealth.pid,
    startedAt: observerHealth.startedAt,
    version: observerHealth.version,
    socketPath: observerHealth.socketPath,
    stateDir: observerHealth.stateDir,
  };
  const recoveryReadiness = await observer.getSessionRecoveryReadiness();
  let host;
  if (input.hasHost) {
    const client = createStationHostClient({
      socketPath: input.hostSocketPath,
      timeoutMs: 3000,
      expectedBuildVersion: input.hostBuildVersion,
    });
    try {
      host = { health: await client.health(), inventory: await client.list() };
    } finally {
      client.dispose();
    }
  }
  return {
    artifactAndReceipt: await snapshotEntries([
      input.installedBinary,
      join(input.installDir, ".station-install-receipt"),
      join(input.dataHome, "station", "LICENSE"),
    ]),
    configAndHooks: await snapshotEntries([
      input.configPath,
      join(input.installDir, "stn-ingress"),
      join(input.installDir, "stn-tmux-popup"),
    ]),
    observer: {
      files: await snapshotEntries([
        join(input.stateDir, "observer.sqlite"),
        join(input.stateDir, "observer.sqlite-wal"),
        join(input.stateDir, "diagnostics"),
        join(input.stateDir, "spool", "hooks"),
        input.socketPath,
      ]),
      holders: readUnixSocketHolderPids(input.socketPath),
      identity: observerIdentity,
      recoveryReadiness,
    },
    host: {
      socket: await snapshotEntry(input.hostSocketPath),
      holders: input.hasHost ? readUnixSocketHolderPids(input.hostSocketPath) : [],
      evidence: host,
    },
  };
}

async function snapshotEntries(paths) {
  return Promise.all(paths.map(snapshotEntry));
}

async function snapshotEntry(path) {
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { path, kind: "absent" };
    throw error;
  }
  const common = {
    path,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    mode: String(metadata.mode),
  };
  if (metadata.isFile()) {
    return {
      ...common,
      kind: "file",
      size: String(metadata.size),
      sha256: await sha256File(path),
    };
  }
  if (metadata.isSymbolicLink())
    return { ...common, kind: "symlink", target: await readlink(path) };
  if (metadata.isDirectory()) {
    return {
      ...common,
      kind: "directory",
      entries: (await readdir(path)).sort(),
    };
  }
  if (metadata.isSocket()) return { ...common, kind: "socket" };
  return { ...common, kind: "other", size: String(metadata.size) };
}

async function writeReleaseTransport(input) {
  const transportDir = join(input.scenarioRoot, input.ledger);
  await mkdir(transportDir, { recursive: true, mode: 0o700 });
  const curlPath = join(transportDir, "curl");
  const current = releaseMetadata(input.currentTag, 1001, "2026-01-01T00:00:00Z");
  const target = releaseMetadata(input.target.tag, 1002, "2026-01-02T00:00:00Z");
  const routes = [
    ...(input.includeMetadata === false
      ? []
      : [
          [releaseApiTagUrl(input.currentTag), { kind: "json", value: current }],
          [releaseApiTagUrl(input.target.tag), { kind: "json", value: target }],
          [
            "https://api.github.com/repos/jeremy0dell/station/releases?per_page=100&page=1",
            {
              kind: "json",
              value: input.currentTag === input.target.tag ? [target] : [current, target],
            },
          ],
        ]),
    ...(input.includeAssets === false
      ? []
      : [
          ...(input.includeInstaller === false
            ? []
            : [
                [
                  releaseDownloadUrl(input.target.tag, "install.sh"),
                  { kind: "file", path: input.target.installerPath },
                ],
              ]),
          [
            releaseDownloadUrl(input.target.tag, "SHA256SUMS"),
            { kind: "file", path: input.target.checksumsPath },
          ],
          [
            releaseDownloadUrl(input.target.tag, basename(input.target.archivePath)),
            { kind: "file", path: input.target.archivePath },
          ],
        ]),
  ];
  const fileRoutes = Object.fromEntries(
    await Promise.all(
      routes.flatMap(([url, route]) =>
        route.kind === "file"
          ? [
              (async () => {
                const [snapshot] = await snapshotTargetAssets({
                  installerPath: route.path,
                  checksumsPath: route.path,
                  archivePath: route.path,
                });
                return [url, snapshot];
              })(),
            ]
          : [],
      ),
    ),
  );
  const script =
    `#!${process.execPath}\n` +
    `const { createHash } = require("node:crypto");\n` +
    `const { appendFileSync, copyFileSync, lstatSync, readFileSync } = require("node:fs");\n` +
    `const routes = new Map(${JSON.stringify(routes)});\n` +
    `const fileRoutes = ${JSON.stringify(fileRoutes)};\n` +
    `const args = process.argv.slice(2);\n` +
    `const url = [...args].reverse().find((arg) => /^https:\\/\\//.test(arg));\n` +
    `appendFileSync(${JSON.stringify(join(transportDir, "curl.log"))}, String(url) + "\\n");\n` +
    `const route = routes.get(url);\n` +
    `if (!route) { process.stderr.write("unexpected update smoke URL: " + url + "\\n"); process.exit(22); }\n` +
    `if (route.kind === "file") { const expected = fileRoutes[url]; const stat = lstatSync(route.path, { bigint: true }); const actual = { path: route.path, device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), sha256: createHash("sha256").update(readFileSync(route.path)).digest("hex") }; if (JSON.stringify(actual) !== JSON.stringify(expected)) { process.stderr.write("update smoke target asset changed: " + route.path + "\\n"); process.exit(23); } }\n` +
    `const outputIndex = args.indexOf("--output");\n` +
    `const bytes = route.kind === "json" ? Buffer.from(JSON.stringify(route.value)) : readFileSync(route.path);\n` +
    `if (outputIndex >= 0) copyFileSync(route.kind === "file" ? route.path : (() => { throw new Error("JSON output route unsupported"); })(), args[outputIndex + 1]);\n` +
    `else process.stdout.write(bytes);\n`;
  await writeFile(curlPath, script, { mode: 0o700 });
  return transportDir;
}

async function assertExactTransportRequests({
  updateTransportDir,
  targetInstallTransportDir,
  input,
  completedInstallRefusal,
}) {
  const archiveName = `stn-${input.target.tag}-${nativeTarget()}.tar.gz`;
  const actual = (await readFile(join(updateTransportDir, "curl.log"), "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  const currentTag =
    input.artifactState === "current" ? input.target.tag : `v${input.options.incumbentVersion}`;
  const detectionRequests = [
    releaseApiTagUrl(currentTag),
    releaseApiTagUrl(currentTag),
    "https://api.github.com/repos/jeremy0dell/station/releases?per_page=100&page=1",
    "https://api.github.com/repos/jeremy0dell/station/releases?per_page=100&page=1",
  ];
  const expected = [
    ...detectionRequests,
    ...(input.artifactState === "current" ||
    (updateRequiresPreservation(input) && !completedInstallRefusal)
      ? []
      : [
          releaseDownloadUrl(input.target.tag, "install.sh"),
          releaseDownloadUrl(input.target.tag, "SHA256SUMS"),
          releaseDownloadUrl(input.target.tag, archiveName),
          releaseDownloadUrl(input.target.tag, "SHA256SUMS"),
        ]),
  ].sort();
  assertDeepEqual(actual, expected, `${input.name} exact update transport requests`);
  if (input.artifactState === "current") {
    if (targetInstallTransportDir === undefined) {
      throw new Error(`${input.name} target installer transport ledger is missing.`);
    }
    const targetInstallRequests = (
      await readFile(join(targetInstallTransportDir, "curl.log"), "utf8")
    )
      .split(/\r?\n/u)
      .filter(Boolean)
      .sort();
    assertDeepEqual(
      targetInstallRequests,
      [
        releaseDownloadUrl(input.target.tag, archiveName),
        releaseDownloadUrl(input.target.tag, "SHA256SUMS"),
      ].sort(),
      `${input.name} exact target installer transport requests`,
    );
  } else {
    assertEqual(
      targetInstallTransportDir,
      undefined,
      `${input.name} omits target installer transport`,
    );
  }
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
    input.tmuxShadowDir,
    input.installDir,
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

async function prepareTmuxAudit(scenarioRoot) {
  const shadowDir = join(scenarioRoot, "tmux-shadow");
  const bareLogPath = join(scenarioRoot, "bare-tmux.log");
  await mkdir(shadowDir, { recursive: true, mode: 0o700 });
  await writeFile(bareLogPath, "", { mode: 0o600 });
  await writeFile(
    join(shadowDir, "tmux"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(bareLogPath)}\nprintf '%s\\n' 'bare tmux invocation refused; use the private wrapper' >&2\nexit 97\n`,
    { mode: 0o700 },
  );
  return { shadowDir, bareLogPath };
}

async function startTmuxServer(tmuxPath, env, tmuxTempDir, label, processIdentities) {
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
  await assertOnlyPrivateTmuxSocket(socketPath);
  await recordProcessIdentity(processIdentities, `tmux-server:${label}`, pid);
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
    await terminateExactProcess(await snapshotProcessIdentity(client.pid, `tmux-client:${label}`));
    throw new Error("Private tmux client did not attach.");
  }
  await recordProcessIdentity(processIdentities, `tmux-client:${label}`, client.pid);
  return {
    tmuxPath: wrapperPath,
    env: serverEnv,
    args,
    key,
    label,
    session,
    pid,
    socketPath,
    client: { child: client, name: clientName, output: clientOutput },
    processIdentities,
  };
}

async function runInTmuxPane(server, name, argv, outputRoot) {
  const stdoutPath = join(outputRoot, `${name}.stdout`);
  const stderrPath = join(outputRoot, `${name}.stderr`);
  const statusPath = join(outputRoot, `${name}.status`);
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      command: argv[0],
      args: argv.slice(1),
      cwd: outputRoot,
      stdoutPath,
      stderrPath,
      statusPath,
    }),
    "utf8",
  ).toString("base64url");
  const shellCommand = [process.execPath, runnerPath, "__pane-child", payload]
    .map(shellQuote)
    .join(" ");
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
  const completion = parseJson(await readFile(statusPath, "utf8"), `${name} pane completion`);
  assertEqual(completion.schemaVersion, 1, `${name} pane completion schema`);
  const result = {
    code: completion.code,
    signal: completion.signal,
    stdout: await readFile(stdoutPath, "utf8").catch(() => ""),
    stderr: await readFile(stderrPath, "utf8").catch(() => ""),
  };
  if (completion.error !== undefined) {
    throw new Error(`tmux pane child failed: ${completion.error}`);
  }
  return result;
}

async function runPaneChild(encodedPayload) {
  if (encodedPayload === undefined) throw new Error("Missing pane child payload.");
  const payload = parseJson(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
    "pane child payload",
  );
  if (
    payload.schemaVersion !== 1 ||
    typeof payload.command !== "string" ||
    !Array.isArray(payload.args) ||
    !payload.args.every((value) => typeof value === "string") ||
    ![payload.cwd, payload.stdoutPath, payload.stderrPath, payload.statusPath].every(
      (value) => typeof value === "string" && isAbsolute(value),
    )
  ) {
    throw new Error("Invalid pane child payload.");
  }
  let result;
  let error;
  try {
    result = await run(payload.command, payload.args, {
      cwd: payload.cwd,
      timeoutMs: childTimeoutMs,
      maxOutputChars: paneOutputLimit,
      allowedExitCodes: Array.from({ length: 256 }, (_, code) => code),
    });
  } catch (cause) {
    if (cause instanceof SmokeCommandError) {
      result = cause.result;
      if (cause instanceof SmokeTimeoutError) error = cause.message;
    } else error = errorMessage(cause);
  }
  await writeFile(payload.stdoutPath, result?.stdout ?? "", { mode: 0o600 });
  await writeFile(payload.stderrPath, result?.stderr ?? "", { mode: 0o600 });
  const statusTempPath = `${payload.statusPath}.writing`;
  await writeFile(
    statusTempPath,
    `${JSON.stringify({
      schemaVersion: 1,
      code: result?.code ?? 1,
      signal: result?.signal ?? null,
      ...(error === undefined ? {} : { error }),
    })}\n`,
    { mode: 0o600 },
  );
  await rename(statusTempPath, payload.statusPath);
}

async function stopTmuxServer(server) {
  await run(server.tmuxPath, [...server.args, "detach-client", "-t", server.client.name], {
    env: server.env,
    allowedExitCodes: [0, 1],
  });
  server.client.child.stdin.end();
  const clientIdentity = server.processIdentities.get(`tmux-client:${server.label}`);
  if (!(await waitForExactProcessExit(clientIdentity, 5_000))) {
    await terminateExactProcess(clientIdentity);
    assertEqual(
      await waitForExactProcessExit(clientIdentity, 5_000),
      true,
      "private tmux client exit",
    );
  }
  await run(server.tmuxPath, [...server.args, "kill-server"], {
    env: server.env,
    allowedExitCodes: [0, 1],
  });
  assertEqual(
    await waitForExactProcessExit(
      server.processIdentities.get(`tmux-server:${server.label}`),
      10_000,
    ),
    true,
    "private tmux server exit",
  );
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

async function assertOnlyPrivateTmuxSocket(socketPath) {
  const sockets = [];
  for (const name of await readdir(dirname(socketPath))) {
    const candidate = join(dirname(socketPath), name);
    if ((await lstat(candidate)).isSocket()) sockets.push(candidate);
  }
  assertDeepEqual(sockets, [socketPath], "one expected private tmux socket");
}

async function assertNoSocketsUnder(root) {
  if (!(await pathExists(root))) return;
  for (const name of await readdir(root)) {
    const candidate = join(root, name);
    const metadata = await lstat(candidate);
    if (metadata.isSocket()) throw new Error(`Private tmux socket remained: ${candidate}`);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) await assertNoSocketsUnder(candidate);
  }
}

async function verifyBareLaunches(input) {
  const touch = findExecutable("touch", input.env.PATH);
  const nativeCanary = join(input.scenarioRoot, "native-renderer-canary");
  const nativeResult = await run(
    input.installedBinary,
    input.expectNativeRefusal ? ["__tui"] : [],
    {
      env: input.expectNativeRefusal
        ? input.env
        : {
            ...input.env,
            STATION_DASHBOARD_COMMAND: `${touch} ${shellQuote(nativeCanary)}`,
          },
      timeoutMs: 30_000,
      allowedExitCodes: [input.expectNativeRefusal ? 1 : 0],
    },
  );
  if (input.expectNativeRefusal) {
    assertEqual(await pathExists(nativeCanary), false, `${input.name} native refusal mutation`);
    assertVisibleRefusal(nativeResult, `${input.name} native bare stn`);
  } else {
    await waitForPath(nativeCanary, 10_000);
    assertNoMismatch(nativeResult.stderr, `${input.name} native bare stn`);
  }

  let server = input.tmuxServer;
  if (server === undefined) {
    server = await startTmuxServer(
      input.tmuxPath,
      input.env,
      input.tmuxTempDir,
      `${input.name}-canary`,
      input.processIdentities,
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
    const tmuxResult = await runInTmuxPane(
      server,
      "bare-stn",
      [input.installedBinary],
      input.scenarioRoot,
    );
    assertEqual(
      tmuxResult.code,
      input.expectTmuxRefusal ? 1 : 0,
      `${input.name} tmux bare exit code`,
    );
    if (input.expectTmuxRefusal) {
      assertEqual(await pathExists(tmuxCanary), false, `${input.name} tmux refusal mutation`);
      assertVisibleRefusal(tmuxResult, `${input.name} tmux bare stn`);
    } else {
      await waitForPath(tmuxCanary, 10_000);
      assertNoMismatch(tmuxResult.stderr, `${input.name} tmux bare stn`);
    }
  } finally {
    if (input.tmuxServer === undefined) await stopTmuxServer(server);
  }
}

function assertUpdateReport(report, reportJson, input, installedBinary, configPath, evidence) {
  if (report.schemaVersion === 1) {
    assertLegacyUpdateReport(report, input, installedBinary, configPath);
    return;
  }
  if (report.schemaVersion === 4) {
    assertPredecessorV4UpdateReport(report, input, installedBinary, configPath);
    return;
  }
  assertEqual(report.schemaVersion, 5, `${input.name} update schema`);
  assertEqual(report.kind, "result", `${input.name} update result kind`);
  assertEqual(report.channel, "installer-binary", `${input.name} update channel`);
  const refusal = updateRequiresPreservation(input);
  const expectedStatus = refusal
    ? "reap-required"
    : input.artifactState === "current"
      ? "current"
      : "updated";
  assertEqual(report.status, expectedStatus, `${input.name} update status`);
  assertV5ReportEvidence(report, reportJson, input, evidence);
  assertDeepEqual(report.warnings, [], `${input.name} update warnings`);
  const expectedRecovery = refusal
    ? [[installedBinary, "--config", configPath, "update", "--handoff=processes"]]
    : [];
  assertDeepEqual(
    report.recoveryCommands,
    expectedRecovery,
    `${input.name} recovery commands (${JSON.stringify({ error: report.error, steps: report.steps })})`,
  );
  assertEqual(report.error?.code, undefined, `${input.name} update error`);
  if (refusal) {
    assertEqual(report.finalInspection, undefined, `${input.name} refusal final inspection`);
  } else {
    assertEqual(
      report.finalInspection?.status,
      "completed",
      `${input.name} completed final inspection`,
    );
    assertEqual(
      report.finalInspection?.plan.outcome,
      "converged",
      `${input.name} final convergence plan`,
    );
  }
  assertDeepEqual(
    report.hookReconciliations,
    refusal ? [] : expectedNoOpHookReconciliations(report.initial.hooks),
    `${input.name} provider-neutral hook reconciliation`,
  );
  const expectedIds = refusal
    ? ["detect", "plan", "apply"]
    : [
        "detect",
        "plan",
        "apply",
        ...(input.artifactState === "predecessor" ? ["detect", "plan", "apply"] : []),
        "hook-reconciliation",
        "observer-restart",
        ...(scenarioHasHost(input) ? ["host-handoff"] : []),
        "persisted-state-reconcile",
        "final-verification",
      ];
  assertDeepEqual(
    report.steps.map((step) => step.id),
    expectedIds,
    `${input.name} exact ordered update steps`,
  );
  assertDeepEqual(
    report.steps.map((step) => step.status),
    refusal
      ? ["completed", "completed", "skipped"]
      : expectedIds.map((id, index) =>
          id === "apply" && (input.artifactState === "current" || index > 2)
            ? "skipped"
            : "completed",
        ),
    `${input.name} exact update step outcomes`,
  );
}

function assertPredecessorV4UpdateReport(report, input, installedBinary, configPath) {
  assertEqual(report.kind, "result", `${input.name} predecessor update result kind`);
  assertEqual(report.channel, "installer-binary", `${input.name} predecessor update channel`);
  const refusal = updateRequiresPreservation(input);
  assertEqual(
    report.status,
    refusal ? "failed" : "updated",
    `${input.name} predecessor update status`,
  );
  assertDeepEqual(
    report.current,
    { version: input.options.incumbentVersion },
    `${input.name} predecessor current artifact`,
  );
  assertDeepEqual(
    report.target,
    { version: input.target.version },
    `${input.name} predecessor target artifact`,
  );
  assertDeepEqual(report.warnings, [], `${input.name} predecessor update warnings`);
  assertDeepEqual(
    report.recoveryCommands,
    refusal
      ? [[installedBinary, "--config", configPath, "host", "handoff", "--fidelity", "processes"]]
      : [],
    `${input.name} predecessor recovery commands`,
  );
  assertEqual(
    report.error?.code,
    refusal ? "UPDATE_RUNTIME_CROSSOVER_FAILED" : undefined,
    `${input.name} predecessor update error`,
  );
  assertDeepEqual(
    report.hookReconciliation,
    {
      provider: "codex",
      status: "configured-disabled",
      changed: false,
      verified: false,
      followUp: { action: "enable-hooks" },
    },
    `${input.name} predecessor hook reconciliation`,
  );
  assertDeepEqual(
    report.steps.map((step) => step.id),
    ["detect", "plan", "apply", "hook-reconciliation", "observer-restart", "host-handoff"],
    `${input.name} exact ordered predecessor update steps`,
  );
  assertDeepEqual(
    report.steps.map((step) => step.status),
    [
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      refusal ? "failed" : "completed",
    ],
    `${input.name} exact predecessor update step outcomes`,
  );
}

function updateRequiresPreservation(input) {
  return input.hostState === "busy-compiled-non-bridge";
}

function scenarioHasHost(input) {
  return input.hostState !== "absent";
}

function scenarioHasBusyHost(input) {
  return input.hostState.startsWith("busy-");
}

function reportEmitterVersion(input) {
  return input.artifactState === "current" ? input.target.version : input.options.incumbentVersion;
}

function expectedNoOpHookReconciliations(hooks) {
  return hooks.map((hook) => {
    switch (hook.status) {
      case "configured-disabled":
        return {
          provider: hook.provider,
          status: hook.status,
          changed: false,
          verified: false,
          followUp: hook.followUp,
        };
      case "unsupported":
        return {
          provider: hook.provider,
          status: hook.status,
          changed: false,
          verified: false,
        };
      case "healthy":
        return {
          provider: hook.provider,
          status: hook.status,
          changed: false,
          verified: true,
        };
      default:
        throw new Error(
          `Expected a successful no-op hook health result, received ${hook.status} for ${hook.provider}.`,
        );
    }
  });
}

function assertLegacyUpdateReport(report, input, installedBinary, configPath) {
  assertEqual(report.schemaVersion, 1, `${input.name} legacy update schema`);
  assertEqual(report.channel, "installer-binary", `${input.name} legacy update channel`);
  const refusal = updateRequiresPreservation(input);
  assertEqual(report.status, refusal ? "failed" : "updated", `${input.name} legacy update status`);
  assertEqual(
    report.current?.version,
    input.options.incumbentVersion,
    `${input.name} legacy current`,
  );
  assertEqual(report.target?.version, input.target.version, `${input.name} legacy target`);
  assertDeepEqual(report.warnings, [], `${input.name} legacy update warnings`);
  const expectedRecovery = refusal
    ? [[installedBinary, "--config", configPath, "host", "handoff", "--fidelity", "processes"]]
    : [];
  assertDeepEqual(
    report.recoveryCommands,
    expectedRecovery,
    `${input.name} legacy recovery commands (${JSON.stringify({
      error: report.error,
      steps: report.steps,
    })})`,
  );
  assertEqual(
    report.error?.code,
    refusal ? "UPDATE_RUNTIME_CROSSOVER_FAILED" : undefined,
    `${input.name} legacy update error`,
  );
  assertDeepEqual(
    report.steps.map((step) => step.id),
    ["detect", "plan", "apply", "observer-restart", "host-handoff"],
    `${input.name} exact ordered legacy update steps`,
  );
  assertDeepEqual(
    report.steps.map((step) => step.status),
    [
      "completed",
      "completed",
      "completed",
      "completed",
      refusal
        ? "failed"
        : !scenarioHasHost(input) && input.target.mode === "public"
          ? "skipped"
          : "completed",
    ],
    `${input.name} exact legacy update step outcomes`,
  );
}

function assertDryUpdateReport(report, reportJson, input, evidence) {
  if (report.schemaVersion === 1) {
    assertEqual(report.status, "planned", `${input.name} legacy dry-run status`);
    assertEqual(report.channel, "installer-binary", `${input.name} legacy dry-run channel`);
    assertEqual(
      report.current?.version,
      input.options.incumbentVersion,
      `${input.name} legacy dry current`,
    );
    assertEqual(report.target?.version, input.target.version, `${input.name} legacy dry target`);
    assertDeepEqual(report.warnings, [], `${input.name} legacy dry-run warnings`);
    assertDeepEqual(report.recoveryCommands, [], `${input.name} legacy dry-run recovery commands`);
    assertEqual(report.error, undefined, `${input.name} legacy dry-run error`);
    assertDeepEqual(
      report.steps.map((step) => step.id),
      ["detect", "plan", "apply", "observer-restart", "host-handoff"],
      `${input.name} exact ordered legacy dry-run steps`,
    );
    assertDeepEqual(
      report.steps.map((step) => step.status),
      [
        "completed",
        "completed",
        "planned",
        "planned",
        scenarioHasHost(input) ? "planned" : "skipped",
      ],
      `${input.name} exact legacy dry-run step outcomes`,
    );
    return 0;
  }
  if (report.schemaVersion === 4) {
    return assertPredecessorV4DryUpdateReport(report, reportJson, input, evidence);
  }
  assertEqual(report.schemaVersion, 5, `${input.name} dry-run schema`);
  assertEqual(report.kind, "preview", `${input.name} dry-run kind`);
  assertEqual(report.channel, "installer-binary", `${input.name} dry-run channel`);
  assertV5ReportEvidence(report, reportJson, input, evidence);
  assertEqual(report.initial?.boundary.authorization, "none", `${input.name} dry authorization`);
  assertEqual(report.plan?.authorization, "none", `${input.name} dry plan authorization`);
  assertEqual("recoveryPreflight" in report, false, `${input.name} dry omits nested preflight`);
  assertEqual(
    report.plan.outcome,
    updateRequiresPreservation(input) ? "reap-required" : "actionable",
    `${input.name} dry-run classification`,
  );
  return ["blocked", "reap-required"].includes(report.plan.outcome) ? 1 : 0;
}

function assertPredecessorV4DryUpdateReport(report, reportJson, input, evidence) {
  assertEqual(report.kind, "preview", `${input.name} predecessor dry-run kind`);
  assertEqual(report.channel, "installer-binary", `${input.name} predecessor dry-run channel`);
  assertDeepEqual(
    report.current,
    { version: input.options.incumbentVersion },
    `${input.name} predecessor dry current artifact`,
  );
  assertDeepEqual(
    report.target,
    { version: input.target.version },
    `${input.name} predecessor dry target artifact`,
  );
  assertDeepEqual(
    report.plan.selectedTarget.artifact,
    { version: input.target.version },
    `${input.name} predecessor planned target artifact`,
  );
  assertDeepEqual(
    Object.keys(report.plan.phases),
    [
      "artifactApplication",
      "hookReconciliation",
      "observerConvergence",
      "terminalConvergence",
      "hostConvergence",
      "persistedStateReconcile",
      "finalVerification",
    ],
    `${input.name} predecessor ordered convergence phases`,
  );
  assertAggregateRuntime(
    report.initial,
    input,
    input.options.incumbentVersion,
    evidence.incumbentBuildIdentity,
    `${input.name} predecessor initial`,
    evidence.incumbentHostBuildIdentity,
  );
  assertDeepEqual(
    report.plan.selectedTarget.runtimeBuild,
    { status: "not-yet-provable" },
    `${input.name} predecessor target runtime`,
  );
  assertPublicIdentityAliases(reportJson, input, evidence);
  assertEqual(
    report.initial.boundary.authorization,
    "none",
    `${input.name} predecessor dry authorization`,
  );
  assertEqual(
    report.plan.authorization,
    "none",
    `${input.name} predecessor dry plan authorization`,
  );
  assertEqual(
    "recoveryPreflight" in report,
    false,
    `${input.name} predecessor dry omits nested preflight`,
  );
  return ["blocked", "reap-required"].includes(report.plan.outcome) ? 1 : 0;
}

function assertV5ReportEvidence(report, reportJson, input, evidence) {
  const incumbentArtifact = { version: input.options.incumbentVersion };
  const targetArtifact = { version: input.target.version };
  assertDeepEqual(
    report.current,
    input.artifactState === "current" ? targetArtifact : incumbentArtifact,
    `${input.name} exact current artifact`,
  );
  assertDeepEqual(report.target, targetArtifact, `${input.name} exact target artifact`);
  assertDeepEqual(
    report.plan.selectedTarget.artifact,
    targetArtifact,
    `${input.name} planned target artifact`,
  );
  assertDeepEqual(
    Object.keys(report.plan.phases),
    [
      "artifactApplication",
      "hookReconciliation",
      "observerConvergence",
      "terminalConvergence",
      "hostConvergence",
      "persistedStateReconcile",
      "finalVerification",
    ],
    `${input.name} ordered convergence phases`,
  );
  assertAggregateRuntime(
    report.initial,
    input,
    input.options.incumbentVersion,
    evidence.incumbentBuildIdentity,
    `${input.name} initial`,
    evidence.incumbentHostBuildIdentity,
  );
  if (input.artifactState === "current") {
    assertKnownTargetRuntime(
      report.plan.selectedTarget.runtimeBuild,
      input,
      `${input.name} planned target runtime`,
    );
  } else {
    assertDeepEqual(
      report.plan.selectedTarget.runtimeBuild,
      { status: "not-yet-provable" },
      `${input.name} preinstallation target runtime`,
    );
  }
  if (report.kind === "result" && report.finalInspection?.status === "completed") {
    assertDeepEqual(
      report.finalInspection.aggregate.installed,
      targetArtifact,
      `${input.name} final installed artifact`,
    );
    assertDeepEqual(
      report.finalInspection.aggregate.target,
      targetArtifact,
      `${input.name} final selected artifact`,
    );
    assertAggregateRuntime(
      report.finalInspection.aggregate,
      input,
      input.target.version,
      input.target.buildIdentity,
      `${input.name} final`,
    );
    assertKnownTargetRuntime(
      report.finalInspection.plan.selectedTarget.runtimeBuild,
      input,
      `${input.name} final target runtime`,
    );
  }
  assertPublicIdentityAliases(reportJson, input, evidence);
}

function assertAggregateRuntime(
  aggregate,
  input,
  version,
  observerBuildIdentity,
  label,
  hostBuildIdentity = observerBuildIdentity,
) {
  assertEqual(aggregate.observer.status, "exact", `${label} Observer status`);
  assertDisplayVersion(aggregate.observer.buildVersion, version, `${label} Observer`);
  assertObserverBuildIdentity(
    aggregate.observer.buildVersion,
    observerBuildIdentity,
    `${label} Observer`,
  );
  if (scenarioHasHost(input)) {
    assertEqual(aggregate.host.status, "inspected", `${label} Host status`);
    assertEqual(aggregate.host.buildVersion, version, `${label} Host version`);
    assertEqual(aggregate.host.buildIdentity, hostBuildIdentity, `${label} Host build identity`);
  } else {
    assertDeepEqual(aggregate.host, { status: "absent" }, `${label} Host absence`);
  }
}

function assertKnownTargetRuntime(runtimeBuild, input, label) {
  assertEqual(runtimeBuild.status, "known", `${label} status`);
  assertEqual(runtimeBuild.buildIdentity, input.target.buildIdentity, `${label} build identity`);
  assertDisplayVersion(runtimeBuild.observerSelector, input.target.version, label);
  assertObserverBuildIdentity(runtimeBuild.observerSelector, input.target.buildIdentity, label);
}

function assertPublicIdentityAliases(report, input, evidence) {
  const fields = {
    projectId: "project",
    worktreeId: "worktree",
    sessionId: "session",
    terminalTargetId: "terminal-target",
    ptyId: "pty",
    ptyInstanceId: "pty-instance",
  };
  const raw =
    evidence.ptyIdentity === undefined || evidence.spawnedPty === undefined
      ? {}
      : {
          projectId: evidence.ptyIdentity.projectId,
          worktreeId: evidence.ptyIdentity.worktreeId,
          sessionId: evidence.ptyIdentity.sessionId,
          terminalTargetId: evidence.ptyIdentity.terminalTargetId,
          ptyId: evidence.spawnedPty.ptyId,
          ptyInstanceId: evidence.spawnedPty.ptyInstanceId,
        };
  const serialized = JSON.stringify(report);
  for (const [field, label] of Object.entries(fields)) {
    const values = collectStringFieldValues(report, field);
    const expectedRaw = raw[field];
    assertDeepEqual(
      [...new Set(values)].sort(),
      expectedRaw === undefined ? [] : [`public-${label}-00000001`],
      `${input.name} stable public ${label} aliases`,
    );
    if (expectedRaw !== undefined) {
      assertEqual(
        serialized.includes(expectedRaw),
        false,
        `${input.name} omits raw ${label} identity`,
      );
    }
  }
}

function collectStringFieldValues(value, field) {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectStringFieldValues(entry, field));
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(key === field && typeof entry === "string" ? [entry] : []),
    ...collectStringFieldValues(entry, field),
  ]);
}

function assertVisibleRefusal(result, label) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/refus|mismatch|HOST_(?:UPGRADE_BLOCKED|VERSION_INCOMPATIBLE)/iu.test(output)) {
    throw new Error(`${label} did not visibly refuse the incumbent Host: ${output}`);
  }
}

function assertPreservedPty(live, spawnedPty, ptyChildPid, name) {
  if (live === undefined) throw new Error(`${name} preserved Host lost the live PTY.`);
  assertEqual(live.ptyId, spawnedPty.ptyId, `${name} preserved PTY ID`);
  assertEqual(live.ptyInstanceId, spawnedPty.ptyInstanceId, `${name} preserved PTY instance`);
  assertEqual(live.pid, ptyChildPid, `${name} preserved PTY child PID`);
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
        buildIdentity: input.target.buildIdentity ?? "unavailable",
      },
      incumbent: "current",
      requested: "alternate",
    },
    knownProcesses: input.processIdentities ?? [
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

async function snapshotTaggedPredecessorSource(path, version) {
  const resolvedPath = resolve(path);
  const packageJson = parseJson(
    await readFile(join(resolvedPath, "package.json"), "utf8"),
    "tagged predecessor package.json",
  );
  assertEqual(packageJson.version, version, "tagged predecessor source version");
  const expectedTag = `v${version}`;
  const head = await runGit(resolvedPath, ["rev-parse", "HEAD"]);
  const taggedCommit = await runGit(resolvedPath, ["rev-parse", `${expectedTag}^{commit}`]);
  assertEqual(head, taggedCommit, "tagged predecessor source commit");
  const sourceChanges = await runGit(resolvedPath, ["status", "--porcelain"]);
  assertEqual(sourceChanges, "", "tagged predecessor source state");
  const buildIdentity = (
    await readFile(join(resolvedPath, "packages", "runtime", "dist", "station-build-id"), "utf8")
  ).trim();
  assertBuildIdentity(buildIdentity, "tagged predecessor source build identity");
  await run(
    process.execPath,
    [join(resolvedPath, "scripts", "build-identity.mjs"), "--verify", buildIdentity],
    { cwd: resolvedPath, env: buildEnvironment() },
  );
  return { path: resolvedPath, version, tag: expectedTag, commit: head, buildIdentity };
}

async function assertTaggedPredecessorSourceUnchanged(snapshot) {
  const current = await snapshotTaggedPredecessorSource(snapshot.path, snapshot.version);
  assertDeepEqual(current, snapshot, "tagged predecessor source identity");
}

async function runGit(cwd, args) {
  const result = await run("/usr/bin/git", args, {
    cwd,
    env: buildEnvironment(),
  });
  return result.stdout.trim();
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
        "--target-build-identity",
        "--public-target-tag",
        "--predecessor-source-dir",
        "--scenarios",
        "--busy-host-outcome",
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
  const targetBuildIdentity = values.get("--target-build-identity");
  const publicTag = values.get("--public-target-tag");
  const predecessorSourceDir = values.get("--predecessor-source-dir");
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
    assertBuildIdentity(targetBuildIdentity, "--target-build-identity");
    target = {
      mode: "staged",
      releaseDir: resolve(releaseDir),
      tag: targetTag,
      buildIdentity: targetBuildIdentity,
    };
  } else {
    validateTag(publicTag, "--public-target-tag");
    assertBuildIdentity(targetBuildIdentity, "--target-build-identity");
    target = {
      mode: "public",
      tag: publicTag,
      buildIdentity: targetBuildIdentity,
    };
  }
  if (sourceVersion !== undefined && targetBuildIdentity !== undefined) {
    throw new Error("--target-build-identity is only valid for staged or public targets.");
  }
  const targetVersion = target.mode === "source" ? target.version : target.tag.slice(1);
  if (targetVersion === incumbentVersion) {
    throw new Error("Update smoke target must differ from the incumbent version.");
  }
  const scenarios = values.get("--scenarios") ?? "full";
  if (scenarios !== "full" && scenarios !== "no-host" && scenarios !== "release") {
    throw new Error("--scenarios must be full, no-host, or release.");
  }
  const busyHostOutcome = values.get("--busy-host-outcome") ?? "full-handoff";
  if (busyHostOutcome !== "full-handoff" && busyHostOutcome !== "preserved-refusal") {
    throw new Error("--busy-host-outcome must be full-handoff or preserved-refusal.");
  }
  if (scenarios === "no-host" && busyHostOutcome === "preserved-refusal") {
    throw new Error("--busy-host-outcome preserved-refusal requires --scenarios full.");
  }
  if (scenarios === "release" && busyHostOutcome !== "preserved-refusal") {
    throw new Error("--scenarios release requires --busy-host-outcome preserved-refusal.");
  }
  if (scenarios === "release" && target.mode === "public") {
    throw new Error("--scenarios release requires snapshotted source or staged target assets.");
  }
  if (predecessorSourceDir !== undefined && target.mode === "public") {
    throw new Error("--predecessor-source-dir is not valid for public targets.");
  }
  if (scenarios === "release" && target.mode === "staged" && predecessorSourceDir === undefined) {
    throw new Error("Staged release scenarios require --predecessor-source-dir.");
  }
  return {
    incumbentBinary: resolve(incumbentBinary),
    incumbentVersion,
    target,
    scenarios,
    busyHostOutcome,
    ...(predecessorSourceDir === undefined
      ? {}
      : { predecessorSourceDir: resolve(predecessorSourceDir) }),
    keepTemp,
  };
}

function updateSmokeUsage() {
  return "Usage: run-update-smoke.mjs --incumbent-binary <path> --incumbent-version <version> (--target-source-version <version> | --target-release-dir <path> --target-tag <tag> --target-build-identity <64-hex> | --public-target-tag <tag> --target-build-identity <64-hex>) [--predecessor-source-dir <path>] [--scenarios full|no-host|release] [--busy-host-outcome full-handoff|preserved-refusal] [--keep-temp]";
}

function assertBuildIdentity(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be exactly 64 lowercase hexadecimal characters.`);
  }
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
    let identity = trySnapshotProcessIdentitySync(child.pid, `command:${basename(command)}`);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer;
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
    const timer = setTimeout(() => {
      timedOut = true;
      identity ??= trySnapshotProcessIdentitySync(child.pid, `command:${basename(command)}`);
      signalExactProcessSync(identity, "SIGTERM");
      killTimer = setTimeout(() => {
        signalExactProcessSync(identity, "SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
      }, timeoutTerminationGraceMs);
    }, timeoutMs);
    const finish = (error, code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (error !== undefined) {
        rejectRun(error);
        return;
      }
      const result = {
        code: code ?? signalExitCode(signal),
        signal,
        stdout,
        stderr,
      };
      if (timedOut) {
        rejectRun(new SmokeTimeoutError(command, args, result, timeoutMs));
        return;
      }
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

async function recordProcessIdentity(processIdentities, role, pid) {
  const identity = await snapshotProcessIdentity(pid, role);
  processIdentities.set(role, identity);
  return identity;
}

async function snapshotProcessIdentity(pid, role) {
  return snapshotProcessIdentitySync(pid, role);
}

function snapshotProcessIdentitySync(pid, role) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Cannot record ${role} without a positive PID.`);
  }
  const result = spawnSync("/bin/ps", ["-o", "pgid=", "-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Could not inspect ${role} process ${pid}.`);
  const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(result.stdout);
  const pgid = Number(match?.[1]);
  const timestamp = Date.parse(match?.[2] ?? "");
  if (!Number.isSafeInteger(pgid) || pgid <= 0 || !Number.isFinite(timestamp)) {
    throw new Error(`Could not parse ${role} process identity for ${pid}.`);
  }
  return { role, pid, pgid, osStartTime: new Date(timestamp).toISOString() };
}

function trySnapshotProcessIdentitySync(pid, role) {
  try {
    return snapshotProcessIdentitySync(pid, role);
  } catch {
    return undefined;
  }
}

async function processIdentityMatches(identity) {
  return processIdentityMatchesSync(identity);
}

function processIdentityMatchesSync(identity) {
  if (identity === undefined) return false;
  try {
    const current = snapshotProcessIdentitySync(identity.pid, identity.role);
    return current.pgid === identity.pgid && current.osStartTime === identity.osStartTime;
  } catch {
    return false;
  }
}

function signalExactProcessSync(identity, signal) {
  if (!processIdentityMatchesSync(identity)) return false;
  process.kill(identity.pid, signal);
  return true;
}

async function waitForExactProcessExit(identity, timeoutMs) {
  if (identity === undefined) return true;
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await processIdentityMatches(identity))) return true;
    await delay(50);
  } while (Date.now() < deadline);
  return !(await processIdentityMatches(identity));
}

async function terminateExactProcess(identity) {
  if (identity === undefined || !(await processIdentityMatches(identity))) return;
  signalExactProcessSync(identity, "SIGTERM");
  if (await waitForExactProcessExit(identity, timeoutTerminationGraceMs)) return;
  signalExactProcessSync(identity, "SIGKILL");
  if (!(await waitForExactProcessExit(identity, 5_000))) {
    throw new Error(`Exact process ${identity.role} (${identity.pid}) did not exit after SIGKILL.`);
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

function assertObserverBuildIdentity(selector, expected, label) {
  if (selector === undefined) throw new Error(`${label} omitted its build selector.`);
  assertEqual(
    parseStationObserverBuildVersion(selector).buildIdentity,
    expected,
    `${label} build identity`,
  );
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
