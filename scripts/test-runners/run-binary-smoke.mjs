import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { openCodeForwardedEventTypes } from "../../integrations/harness/opencode/dist/ingressRules.js";
import { renderStationOpenCodePlugin } from "../../integrations/harness/opencode/dist/pluginScript.js";
import { ensureStationHostRunning } from "../../integrations/terminal/station/dist/index.js";
import {
  ObserverHealthSchema,
  ObserverProcessIdentitySchema,
  SafeErrorSchema,
} from "../../packages/contracts/dist/index.js";
import {
  createObserverClient,
  readUnixSocketHolderPids,
} from "../../packages/protocol/dist/index.js";
import {
  parseStationObserverBuildVersion,
  stationObserverBuildVersion,
} from "../../packages/runtime/dist/index.js";
import { createStationHostClient } from "../../packages/station-host/dist/index.js";
import {
  assertOwnedDisposableRuntimeChild,
  RuntimeLifecycleEventSchema,
  runOwnedDisposableRuntime,
} from "../runtime-owner.mjs";
import {
  BinarySmokeEvidenceManifestSchema,
  captureBinarySmokeEvidence,
  finalizeBinarySmokeEvidence,
  releaseBinarySmokeEvidenceReservation,
  reserveBinarySmokeEvidenceDestination,
  resetReservedBinarySmokeEvidenceDestination,
} from "./binary-smoke-evidence.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
let packageVersion;
try {
  const packageManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  if (typeof packageManifest.version !== "string") {
    throw new Error("package.json version must be a string");
  }
  packageVersion = packageManifest.version;
} catch (cause) {
  throw new Error("Failed to read expected version from package.json", { cause });
}
const alternateProductionSource = "apps/cli/src/commandRegistry.ts";
const alternateBuildMarker = " (alternate binary smoke build)";
let smokeRunSignal;

class SmokeRunCancelledError extends Error {}

class StressRoundTimeoutError extends Error {}

class SmokeCommandError extends Error {
  constructor(message, command, args, exitDisposition) {
    super(message);
    this.command = command;
    this.args = args;
    this.exitDisposition = exitDisposition;
  }
}

const smokeRunIdSchema = z.string().regex(/^run_[0-9a-f-]{36}$/i);
const ownedInnerResultSchema = z
  .object({
    runId: smokeRunIdSchema,
    warnings: z.array(z.string()),
  })
  .strict();

const externalOwner = process.env.STATION_BINARY_SMOKE_OWNED_CHILD === "1";
const handoffStress = process.argv.some(
  (arg, index, args) => arg === "--mode" && args[index + 1] === "handoff-stress",
);

if (process.env.STATION_BINARY_SMOKE_CANCELLATION_SELF_CHECK === "1") {
  await runObserverCancellationSelfCheck();
} else if (process.env.STATION_BINARY_SMOKE_FAKE_TMUX === "1") {
  await runFakeTmuxProcess(process.argv.slice(2));
} else if (!externalOwner) {
  await runOwnedBinarySmoke(
    process.argv.slice(2),
    handoffStress ? "handoff-stress" : "binary-smoke",
  );
} else {
  await assertOwnedDisposableRuntimeChild({
    role: "binary-smoke",
    stateDir: process.env.STATION_BINARY_SMOKE_OWNER_STATE_DIR,
    runtimeId: process.env.STATION_RUNTIME_OWNER_ID,
  });
  if (process.env.STATION_BINARY_SMOKE_OWNERSHIP_TEST_DESCRIPTOR !== undefined) {
    await runOwnedBinarySmokeTopologyTest();
  } else if (handoffStress) {
    await runHandoffStress(parseHandoffStressOptions(process.argv.slice(2)));
  } else {
    await runBinarySmoke();
  }
}

async function runBinarySmoke() {
  const binaryPath = resolve(process.env.STATION_BINARY_PATH ?? "station/dist/bin/stn");
  const sourceCliPath = resolve("apps/cli/dist/main.js");
  const expectedVersion = parseExpectedVersion(process.argv.slice(2));
  const buildIdentity = (
    await readFile(resolve("packages/runtime/dist/station-build-id"), "utf8")
  ).trim();
  const compiledObserverVersion = stationObserverBuildVersion({
    version: expectedVersion,
    compiled: true,
    buildIdentity,
  });
  const ptyOnly = process.env.STATION_BINARY_SMOKE_PTY_ONLY === "1";
  const root = resolve(requiredOwnedEnvironment("STATION_BINARY_SMOKE_ROOT"));
  const smokeStartedAt = Date.now();
  const alternateWorktreePath = join(root, "alternate-worktree");
  const homeDir = join(root, "home");
  const stateDir = join(root, "state");
  const runtimeDir = join(root, "runtime");
  const hostileDir = join(root, "hostile");
  const socketPath = join(runtimeDir, "observer.sock");
  const hostSocketPath = join(runtimeDir, "station-host.sock");
  const configPath = join(root, "config.toml");
  const popupConfigPath = join(homeDir, ".config", "station", "config.toml");
  const markerPath = join(root, "ambient-config-pwned");
  const ptyReleasePath = join(root, "release-host-pty");
  const fakeTmuxDir = join(root, "fake-bin");
  const fakeTmuxPath = join(fakeTmuxDir, "tmux");
  const fakeTmuxStatePath = join(root, "fake-tmux-state.json");
  const childEnv = {
    ...isolatedBinaryEnv({ homeDir, runtimeDir }),
    STATION_TMUX_BIN: fakeTmuxPath,
  };
  const popupEnv = {
    ...childEnv,
    FAKE_TMUX_CLIENT_NAME: "/dev/ttys901",
    FAKE_TMUX_CLIENT_PID: String(process.pid),
    FAKE_TMUX_CLIENT_SESSION: "binary-smoke",
    FAKE_TMUX_STATE_PATH: fakeTmuxStatePath,
    PATH: `${fakeTmuxDir}:/usr/bin:/bin`,
    STATION_TMUX_BIN: fakeTmuxPath,
    TMUX: `${join(runtimeDir, "fake-tmux.sock")},${process.pid},0`,
  };

  let observerClient;
  let observerPid;
  let hostClient;
  let hostProcess;
  let alternateWorktreeAdded = false;
  let alternateBinaryPath;
  let alternateObserverVersion;
  let orderedSameVersionBuilds;
  let sourceArtifact;
  let evidenceDirection = { logical: "binary-smoke", physical: "current" };
  let evidenceIncumbent = "current";
  let evidenceRequested = "alternate";
  let primaryFailure;
  let evidenceCaptured = false;
  const cancellation = installSmokeCancellation();
  smokeRunSignal = cancellation.signal;

  try {
    if (process.env.STATION_BINARY_SMOKE_CANCELLATION_EXIT_SELF_CHECK === "1") {
      const signal = process.env.STATION_BINARY_SMOKE_CANCELLATION_SIGNAL_SELF_CHECK ?? "SIGINT";
      if (!["SIGINT", "SIGTERM", "SIGHUP"].includes(signal)) {
        throw new Error(`Unsupported cancellation self-check signal: ${signal}`);
      }
      await new Promise((resolve, reject) => {
        const signalWaitTimeout = setTimeout(
          () => reject(new Error(`Cancellation self-check did not receive ${signal}.`)),
          1_000,
        );
        cancellation.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(signalWaitTimeout);
            resolve();
          },
          { once: true },
        );
        process.kill(process.pid, signal);
      });
      throw runCancelledError(process.execPath, [], cancellation.signal);
    }
    if (process.env.STATION_BINARY_SMOKE_EVIDENCE_FAILURE_SELF_CHECK === "1") {
      throw new Error("synthetic binary smoke evidence failure");
    }
    await access(binaryPath, constants.X_OK);
    const installedRoot = dirname(await realpath(binaryPath));
    if (installedRoot === parse(installedRoot).root) {
      fail("compiled popup ownership unexpectedly resolved to filesystem root");
    }
    await assertExactBinaryAlias(installedRoot, "stn-ingress");
    await assertExactBinaryAlias(installedRoot, "stn-tmux-popup");
    await Promise.all([
      mkdir(homeDir, { recursive: true, mode: 0o700 }),
      mkdir(stateDir, { recursive: true, mode: 0o700 }),
      mkdir(runtimeDir, { recursive: true, mode: 0o700 }),
      mkdir(hostileDir, { recursive: true, mode: 0o700 }),
      mkdir(dirname(popupConfigPath), { recursive: true, mode: 0o700 }),
      mkdir(fakeTmuxDir, { recursive: true, mode: 0o700 }),
    ]);
    await writeFakeTmux(fakeTmuxPath, fakeTmuxStatePath);
    await writeSmokeConfig(configPath, stateDir, socketPath);
    await writeSmokeConfig(popupConfigPath, stateDir, socketPath, "tmux");
    await writeHostileConfig(hostileDir, markerPath);

    if (!ptyOnly) {
      await requireCommittedCleanCheckout(repoRoot);
      alternateWorktreeAdded = true;
      await runGit(["worktree", "add", "--detach", alternateWorktreePath, "HEAD"], {
        terminateDescendants: true,
      });
      alternateBinaryPath = await buildAlternateBinary({
        worktreePath: alternateWorktreePath,
        expectedVersion,
      });
      alternateObserverVersion = await queryBinaryObserverVersion({
        binaryPath: alternateBinaryPath,
        expectedVersion,
        // Keep the macOS Unix-domain socket path below sockaddr_un.sun_path's limit.
        root: join(root, "a"),
        label: "alternate compiled observer",
      });

      const version = await run(binaryPath, ["--version"], { env: childEnv });
      assertEqual(version.stdout.trim(), expectedVersion, "compiled --version");

      const help = await run(binaryPath, ["--help"], { env: childEnv });
      assertIncludes(help.stdout, "Usage:", "compiled --help");

      await verifyCompiledGitFailure({
        binaryPath,
        installedRoot,
        root: join(root, "git-setup-canary"),
      });
      await verifyCompiledSetupApplyLauncherWarning({
        binaryPath,
        installedRoot,
        root: join(root, "setup-apply-canary"),
      });

      const popupHelp = await run(join(dirname(binaryPath), "stn-tmux-popup"), ["--help"], {
        env: childEnv,
      });
      assertIncludes(popupHelp.stdout, "stn popup", "popup symlink dispatch");

      const setup = await run(binaryPath, ["setup", "check", "--json", "--no-brew"], {
        cwd: root,
        env: popupEnv,
        allowedExitCodes: [1],
      });
      const setupPlan = JSON.parse(setup.stdout);
      const healthyGitCheck = setupPlan.checks.find((check) => check.id === "git-project");
      assertEqual(healthyGitCheck?.status, "ok", "compiled setup healthy Git status");
      assertEqual(setupPlan.summary.launchReady, true, "compiled setup launchReady");
      assertEqual(setupPlan.summary.workflowReady, false, "compiled setup workflowReady");
      assertEqual(setupPlan.summary.requiredOk, false, "compiled setup requiredOk alias");
      const launcherCheck = setupPlan.checks.find((check) => check.id === "station-launchers");
      assertEqual(launcherCheck?.tier, "recommended", "compiled launcher PATH warning tier");
      assertEqual(launcherCheck?.status, "warn", "compiled launcher PATH warning status");
      assertEqual(
        launcherCheck?.message,
        "STATION is installed, but these bare launchers do not resolve to this installation on PATH: stn, stn-ingress, stn-tmux-popup. Use the installer's PATH guidance to repair bare launcher resolution.",
        "compiled launcher PATH warning message",
      );
      assertDeepEqual(
        launcherCheck?.details,
        {
          station: join(installedRoot, "stn"),
          ingress: join(installedRoot, "stn-ingress"),
          tmuxPopup: join(installedRoot, "stn-tmux-popup"),
          pathDirectory: installedRoot,
        },
        "compiled launcher PATH warning paths",
      );
      const persistedBindingAction = requiredSetupAction(setupPlan, "tmux-popup-binding");
      const liveBindingAction = requiredSetupAction(setupPlan, "tmux-live-popup-binding");
      assertEqual(persistedBindingAction.tier, "recommended", "compiled popup binding tier");
      assertEqual(persistedBindingAction.selected, false, "compiled popup binding remains opt-in");
      assertEqual(
        persistedBindingAction.data?.marker,
        "# >>> station popup binding >>>",
        "compiled popup binding start marker",
      );
      const bindingBlock = persistedBindingAction.data?.appendedText;
      if (typeof bindingBlock !== "string") {
        fail("compiled setup popup binding action did not include its marked block");
      }
      assertIncludes(bindingBlock, "bind-key Space run-shell -b", "compiled popup binding key");
      assertIncludes(
        bindingBlock,
        "# <<< station popup binding <<<",
        "compiled popup binding end marker",
      );
      const popupRunShellCommand = liveBindingAction.command?.at(-1);
      if (typeof popupRunShellCommand !== "string") {
        fail("compiled setup live popup binding action did not include its generated command");
      }
      assertEqual(
        liveBindingAction.command?.[0],
        fakeTmuxPath,
        "compiled popup binding resolved tmux executable",
      );
      assertIncludes(
        popupRunShellCommand,
        join(installedRoot, "stn-tmux-popup"),
        "compiled popup binding exact fallback alias",
      );
      assertIncludes(
        popupRunShellCommand,
        installedRoot,
        "compiled popup binding installed ownership",
      );
      const tmuxConfigPath = join(homeDir, ".tmux.conf");
      await writeFile(tmuxConfigPath, bindingBlock, { mode: 0o600 });
      await run(fakeTmuxPath, ["source-file", tmuxConfigPath], { env: popupEnv });
      const persistedPopupRunShellCommand = (
        await readFakeTmuxState(fakeTmuxStatePath)
      ).bindings.Space?.at(-1);
      if (typeof persistedPopupRunShellCommand !== "string") {
        fail("compiled setup popup binding did not load from its persisted marked block");
      }
      assertEqual(
        persistedPopupRunShellCommand,
        popupRunShellCommand,
        "compiled persisted popup command round trip",
      );

      const worktrunkConfigPath = join(root, "worktrunk", "config.toml");
      await writeWorktrunkHookSmokeConfig(configPath, stateDir, socketPath, worktrunkConfigPath);
      const hookInstall = await run(
        binaryPath,
        ["--config", configPath, "hooks", "install", "worktrunk", "--yes"],
        { env: childEnv },
      );
      assertEqual(JSON.parse(hookInstall.stdout).installed, true, "compiled hook install");
      assertIncludes(
        await readFile(worktrunkConfigPath, "utf8"),
        join(installedRoot, "stn-ingress"),
        "compiled hook absolute ingress launcher",
      );
      const standaloneHookDoctor = await run(
        binaryPath,
        ["--config", configPath, "hooks", "doctor", "worktrunk"],
        { env: childEnv },
      );
      assertEqual(
        JSON.parse(standaloneHookDoctor.stdout).status,
        "ok",
        "compiled standalone hook doctor",
      );
      const fullHookDoctor = await run(binaryPath, ["--config", configPath, "doctor"], {
        env: childEnv,
        allowedExitCodes: [0, 1],
      });
      const fullHookReport = JSON.parse(fullHookDoctor.stdout);
      const fullHookCheck = fullHookReport.checks?.find(
        (check) => check.name === "worktrunk-hooks",
      );
      assertEqual(fullHookCheck?.status, "ok", "compiled full hook doctor");
      const hookObserverClient = createObserverClient({ socketPath, timeoutMs: 5000 });
      const hookObserverPid = (await hookObserverClient.health()).pid;
      await hookObserverClient.stop();
      await waitForMissing(socketPath);
      assertEqual(
        await waitForProcessExit(hookObserverPid, 10_000),
        true,
        "worktrunk hook Observer exits before Codex hook setup",
      );

      const codexHome = join(root, "codex-home");
      const codexHookEnv = { ...childEnv, CODEX_HOME: codexHome };
      await writeCodexHookSmokeConfig(configPath, stateDir, socketPath);
      const codexHookInstall = await run(
        binaryPath,
        ["--config", configPath, "hooks", "install", "codex", "--yes"],
        { env: codexHookEnv },
      );
      const codexHookInstallReport = JSON.parse(codexHookInstall.stdout);
      assertEqual(codexHookInstallReport.installed, true, "compiled Codex hook install");
      assertIncludes(
        await readFile(codexHookInstallReport.hookScriptPath, "utf8"),
        join(installedRoot, "stn-ingress"),
        "compiled Codex hook absolute ingress launcher",
      );
      const codexStandaloneDoctor = await run(
        binaryPath,
        ["--config", configPath, "hooks", "doctor", "codex"],
        { env: codexHookEnv },
      );
      assertEqual(
        JSON.parse(codexStandaloneDoctor.stdout).status,
        "ok",
        "compiled standalone Codex hook doctor",
      );
      const codexSetupCheck = await run(
        binaryPath,
        ["--config", configPath, "setup", "check", "--json", "--no-brew"],
        { env: codexHookEnv, allowedExitCodes: [0, 1] },
      );
      const codexSetupPlan = JSON.parse(codexSetupCheck.stdout);
      const codexSetupHookCheck = codexSetupPlan.checks.find(
        (check) => check.id === "harness-tracking:codex",
      );
      assertEqual(codexSetupHookCheck?.status, "ok", "compiled setup Codex hook check");
      const codexFullDoctor = await run(binaryPath, ["--config", configPath, "doctor"], {
        env: codexHookEnv,
        allowedExitCodes: [0, 1],
      });
      const codexFullHookCheck = JSON.parse(codexFullDoctor.stdout).checks?.find(
        (check) => check.name === "codex-hooks",
      );
      assertEqual(codexFullHookCheck?.status, "ok", "compiled full Codex hook doctor");
      const codexObserverClient = createObserverClient({ socketPath, timeoutMs: 5000 });
      const codexObserverPid = (await codexObserverClient.health()).pid;
      await codexObserverClient.stop();
      await waitForMissing(socketPath);
      assertEqual(
        await waitForProcessExit(codexObserverPid, 10_000),
        true,
        "Codex hook Observer exits before compiled observer start",
      );

      const openCodeConfigDir = join(root, "opencode-config");
      const openCodePluginPath = join(openCodeConfigDir, "plugins", "station-agent-state.js");
      const openCodeHookEnv = { ...childEnv, OPENCODE_CONFIG_DIR: openCodeConfigDir };
      await writeOpenCodeHookSmokeConfig(configPath, stateDir, socketPath);
      const openCodeHookInstall = await run(
        binaryPath,
        ["--config", configPath, "hooks", "install", "opencode", "--yes"],
        { env: openCodeHookEnv },
      );
      const openCodeHookInstallReport = JSON.parse(openCodeHookInstall.stdout);
      assertEqual(openCodeHookInstallReport.installed, true, "compiled OpenCode hook install");
      assertEqual(
        openCodeHookInstallReport.pluginPath,
        openCodePluginPath,
        "compiled OpenCode plugin path",
      );
      const openCodePlugin = await readFile(openCodePluginPath, "utf8");
      const expectedOpenCodePluginBody = renderStationOpenCodePlugin({
        observerSocketPath: socketPath,
        stateDir,
        hookSpoolDir: join(stateDir, "spool", "hooks"),
        forwardedEventTypes: openCodeForwardedEventTypes,
      });
      assertEqual(
        openCodePlugin.endsWith(expectedOpenCodePluginBody),
        true,
        "compiled OpenCode plugin body matches source rendering",
      );
      assertIncludes(
        openCodePlugin,
        "station-opencode-observer-plugin:v1",
        "compiled OpenCode plugin marker",
      );
      assertIncludes(
        openCodePlugin,
        'import { spawn, spawnSync } from "node:child_process"',
        "compiled OpenCode embedded body",
      );
      assertExcludes(openCodePlugin, "__STATION_", "compiled OpenCode install-time placeholders");
      const openCodeStandaloneDoctor = await run(
        binaryPath,
        ["--config", configPath, "hooks", "doctor", "opencode"],
        { env: openCodeHookEnv },
      );
      assertEqual(
        JSON.parse(openCodeStandaloneDoctor.stdout).status,
        "ok",
        "compiled standalone OpenCode hook doctor",
      );
      await writeSmokeConfig(configPath, stateDir, socketPath);

      observerClient = createObserverClient({ socketPath, timeoutMs: 5000 });
      await runObserverStart(
        binaryPath,
        ["--config", configPath, "observer", "start", "--timeout-ms", "30000"],
        {
          client: observerClient,
          env: childEnv,
          socketPath,
        },
      );
      const health = await observerClient.health();
      observerPid = health.pid;
      assertEqual(health.status, "healthy", "compiled observer health");
      assertEqual(
        health.version,
        compiledObserverVersion,
        "compiled observer immutable build identity",
      );
      orderedSameVersionBuilds = orderSameVersionBuilds(
        [
          {
            binaryPath,
            label: "current",
            observerVersion: health.version,
          },
          {
            binaryPath: alternateBinaryPath,
            label: "alternate",
            observerVersion: alternateObserverVersion,
          },
        ],
        expectedVersion,
      );
      evidenceIncumbent = orderedSameVersionBuilds[0].label;
      evidenceRequested = orderedSameVersionBuilds[1].label;
      evidenceDirection = {
        logical: "lower-to-higher",
        physical: `${evidenceIncumbent}-to-${evidenceRequested}`,
      };
      await runObserverStart(
        binaryPath,
        ["--config", configPath, "observer", "start", "--timeout-ms", "30000"],
        {
          client: observerClient,
          env: childEnv,
          socketPath,
        },
      );
      assertEqual((await observerClient.health()).pid, observerPid, "same-build observer reuse");
      const snapshot = await observerClient.getSnapshot();
      assertEqual(snapshot.observer.healthy, true, "compiled observer snapshot");
      assertEqual(snapshot.observer.version, expectedVersion, "compiled observer display version");
      await verifyCompiledInaccessibleObserver({
        binaryPath,
        childEnv,
        configPath,
        observerClient,
        observerPid,
        socketPath,
        stateDir,
      });

      const coldPopup = await runManagedPopupBinding(
        persistedPopupRunShellCommand,
        popupEnv,
        fakeTmuxStatePath,
      );
      assertSilentHandledBinding(coldPopup, "compiled cold popup binding");
      const coldTmuxState = await readFakeTmuxState(fakeTmuxStatePath);
      const coldSession = requiredFakeTmuxSession(coldTmuxState, "_station-ui");
      const registeredRoute = coldTmuxState.serverOptions["@station_popup_ui_route"];
      if (typeof registeredRoute !== "string" || !registeredRoute.startsWith("v1.n.")) {
        fail("compiled cold popup did not commit a versioned fast route");
      }
      assertEqual(
        coldSession.options["@station_popup_ui_lease"],
        registeredRoute,
        "compiled popup route lease",
      );
      assertEqual(
        coldTmuxState.serverOptions["@station_popup_ui_root"],
        installedRoot,
        "compiled popup non-root installed ownership",
      );
      assertEqual(
        coldTmuxState.serverOptions["@station_popup_ui_session_name"],
        "_station-ui",
        "compiled popup registered session",
      );
      assertEqual(coldTmuxState.rendererStarts, 1, "compiled popup renderer start count");
      const rendererPid = coldSession.rendererPid;
      assertEqual(processIsAlive(rendererPid), true, "compiled popup renderer process");
      assertEqual(
        (await observerClient.health()).pid,
        observerPid,
        "compiled cold popup reuses observer",
      );

      const closeCount = coldTmuxState.tmuxProcessCount;
      const closePopup = await runManagedPopupBinding(
        persistedPopupRunShellCommand,
        popupEnv,
        fakeTmuxStatePath,
      );
      assertSilentHandledBinding(closePopup, "compiled warm popup close");
      const closedTmuxState = await readFakeTmuxState(fakeTmuxStatePath);
      assertEqual(
        closedTmuxState.tmuxProcessCount - closeCount,
        2,
        "compiled warm popup close tmux process budget",
      );
      assertEqual(
        closedTmuxState.popups[popupEnv.FAKE_TMUX_CLIENT_NAME]?.open,
        false,
        "compiled warm popup closed",
      );
      assertActivePopupMarkersCleared(closedTmuxState, "compiled warm popup close");

      await writeFile(popupConfigPath, 'schema_version = "malformed"\n', { mode: 0o600 });
      const reopenCount = closedTmuxState.tmuxProcessCount;
      const warmPopup = await runManagedPopupBinding(
        persistedPopupRunShellCommand,
        popupEnv,
        fakeTmuxStatePath,
      );
      assertSilentHandledBinding(warmPopup, "compiled malformed-config warm popup");
      const warmTmuxState = await readFakeTmuxState(fakeTmuxStatePath);
      assertEqual(
        warmTmuxState.tmuxProcessCount - reopenCount,
        2,
        "compiled warm popup open tmux process budget",
      );
      assertEqual(
        warmTmuxState.popups[popupEnv.FAKE_TMUX_CLIENT_NAME]?.open,
        true,
        "compiled warm popup bypasses malformed config",
      );
      assertEqual(
        requiredFakeTmuxSession(warmTmuxState, "_station-ui").rendererPid,
        rendererPid,
        "compiled warm popup renderer reuse",
      );
      assertEqual(
        (await observerClient.health()).pid,
        observerPid,
        "compiled warm popup does not replace observer",
      );

      const directFailure = await run(join(installedRoot, "stn-tmux-popup"), [], {
        env: popupEnv,
        allowedExitCodes: [1],
      });
      assertEqual(directFailure.stdout, "", "direct popup diagnostic stdout");
      assertEqual(directFailure.stderr.length > 0, true, "direct popup diagnostic stderr");
      const failingState = structuredClone(warmTmuxState);
      failingState.serverOptions["@station_popup_ui_route"] = "malformed";
      await writeFakeTmuxState(fakeTmuxStatePath, failingState);
      const failedBinding = await runManagedPopupBinding(
        persistedPopupRunShellCommand,
        popupEnv,
        fakeTmuxStatePath,
      );
      assertSilentHandledBinding(failedBinding, "compiled failing popup binding");
      const failedTmuxState = await readFakeTmuxState(fakeTmuxStatePath);
      assertEqual(
        failedTmuxState.statusMessages.at(-1),
        "Station popup failed; run stn popup for details",
        "compiled popup nonblocking failure message",
      );
      assertEqual(failedTmuxState.paneInMode, 0, "compiled popup failure pane mode");
      assertEqual(
        failedTmuxState.paneContent.includes("returned 1"),
        false,
        "compiled popup failure returned-status view",
      );
      assertEqual(
        failedTmuxState.paneContent.includes(persistedPopupRunShellCommand),
        false,
        "compiled popup failure dispatcher view",
      );
      assertEqual(
        failedTmuxState.popups[popupEnv.FAKE_TMUX_CLIENT_NAME]?.open,
        true,
        "compiled popup failure preserves existing UI",
      );
      assertEqual(
        requiredFakeTmuxSession(failedTmuxState, "_station-ui").rendererPid,
        rendererPid,
        "compiled popup failure preserves renderer",
      );
      assertEqual(
        (await observerClient.health()).pid,
        observerPid,
        "compiled popup failure preserves observer",
      );

      failedTmuxState.serverOptions["@station_popup_ui_route"] = registeredRoute;
      await writeFakeTmuxState(fakeTmuxStatePath, failedTmuxState);
      const cleanupCount = failedTmuxState.tmuxProcessCount;
      const cleanupPopup = await runManagedPopupBinding(
        persistedPopupRunShellCommand,
        popupEnv,
        fakeTmuxStatePath,
      );
      assertSilentHandledBinding(cleanupPopup, "compiled popup cleanup");
      const cleanedTmuxState = await readFakeTmuxState(fakeTmuxStatePath);
      assertEqual(
        cleanedTmuxState.tmuxProcessCount - cleanupCount,
        2,
        "compiled popup cleanup tmux process budget",
      );
      assertActivePopupMarkersCleared(cleanedTmuxState, "compiled popup cleanup");
      assertEqual(
        cleanedTmuxState.popups[popupEnv.FAKE_TMUX_CLIENT_NAME]?.open,
        false,
        "compiled popup cleanup closes existing UI",
      );
      await writeSmokeConfig(popupConfigPath, stateDir, socketPath, "tmux");

      const ingress = await run(
        join(dirname(binaryPath), "stn-ingress"),
        ["--socket", socketPath, "--state-dir", stateDir, "worktrunk", "post-create"],
        {
          env: childEnv,
          input: JSON.stringify({ branch: "station/binary-smoke" }),
        },
      );
      assertEqual(ingress.code, 0, "ingress symlink receipt");
      assertEqual(
        await directoryFileCount(join(stateDir, "spool", "hooks")),
        0,
        "online ingress must not spool",
      );
      assertEqual((await observerClient.health()).status, "healthy", "observer after ingress");

      const bootLog = await readFile(join(stateDir, "logs", "observer-boot.log"), "utf8");
      const bootHeader = JSON.parse(bootLog.split(/\r?\n/, 1)[0] ?? "{}");
      assertEqual(bootHeader.command?.[0], binaryPath, "detached observer executable");
      assertEqual(bootHeader.command?.[1], "__observer", "detached observer internal route");

      const piExtensionPath = await findFile(join(stateDir, "run", "assets", "pi"), (name) =>
        name.endsWith(".mjs"),
      );
      const piExtension = await import(
        `${pathToFileURL(piExtensionPath).href}?smoke=${Date.now()}`
      );
      assertEqual(typeof piExtension.default, "function", "packaged Pi default export");
      assertEqual(
        typeof piExtension.registerStationPiExtension,
        "function",
        "packaged Pi named export",
      );
      const piHandlers = new Map();
      const deliveredEvents = [];
      piExtension.registerStationPiExtension(
        { on: (eventType, handler) => piHandlers.set(eventType, handler) },
        {
          env: { STATION_WORKTREE_PATH: root },
          sendReport: async (input) => deliveredEvents.push(input),
        },
      );
      assertEqual(piHandlers.size > 0, true, "packaged Pi handler registration");
      await piHandlers.get("session_start")?.({ reason: "startup" }, { cwd: root });
      assertEqual(deliveredEvents.length, 1, "packaged Pi injected event delivery");

      const lowerBuild = orderedSameVersionBuilds?.[0];
      if (lowerBuild === undefined) {
        fail("same-version binary ordering was not initialized");
      }
      if ((await observerClient.health()).version !== lowerBuild.observerVersion) {
        const previousObserverPid = observerPid;
        await observerClient.stop();
        await waitForMissing(socketPath);
        if (previousObserverPid !== undefined) {
          assertEqual(
            await waitForProcessExit(previousObserverPid, 10_000),
            true,
            "current observer exits before lower-build setup",
          );
        }
        await runObserverStart(
          lowerBuild.binaryPath,
          ["--config", configPath, "observer", "start", "--timeout-ms", "30000"],
          { client: observerClient, env: childEnv, socketPath },
        );
        const lowerHealth = await observerClient.health();
        observerPid = lowerHealth.pid;
        assertEqual(
          lowerHealth.version,
          lowerBuild.observerVersion,
          "deterministic lower-build incumbent",
        );
      }
    }

    await verifyGenericHostEnsureColdStart({
      binaryPath,
      expectedVersion,
      // Keep exact lsof pathname matching below macOS's Unix-socket path limit.
      socketPath: join(runtimeDir, "g.sock"),
      stateDir,
      childEnv,
    });

    hostProcess = spawn(
      binaryPath,
      ["__station-host", "--socket", hostSocketPath, "--state-dir", stateDir],
      {
        cwd: hostileDir,
        env: childEnv,
        detached: process.env.STATION_RUNTIME_OWNER_FOREGROUND !== "1",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const hostDiagnostics = collectOutput(hostProcess);
    hostClient = createStationHostClient({
      socketPath: hostSocketPath,
      timeoutMs: 1000,
      expectedBuildVersion: expectedVersion,
    });
    await waitForHost(hostClient, hostDiagnostics);
    const hostHealth = await hostClient.health();
    assertEqual(hostHealth.buildVersion, expectedVersion, "compiled station-host build version");
    await access(markerPath).then(
      () => fail("hostile .env or bunfig preload created its marker"),
      () => undefined,
    );

    const ptyIdentity = {
      terminalTargetId: "native:binary-smoke",
      worktreeId: "binary-smoke",
      projectId: "binary-smoke",
      sessionId: "ses_binary_smoke",
      worktreePath: root,
      harnessProvider: "scripted",
      kind: "agent",
    };
    const spawned = await hostClient.spawn({
      ...ptyIdentity,
      command: "/bin/sh",
      args: [
        "-c",
        'printf STATION_BINARY_PTY_OK; while [ ! -f "$1" ]; do sleep 1; done; exit 7',
        "station-binary-pty",
        ptyReleasePath,
      ],
      cwd: root,
      cols: 80,
      rows: 24,
    });
    const attachment = await hostClient.attach({ ...ptyIdentity, ...spawned }, "viewer");
    if (!ptyOnly) {
      const lowerBuild = orderedSameVersionBuilds?.[0];
      const higherBuild = orderedSameVersionBuilds?.[1];
      if (lowerBuild === undefined || higherBuild === undefined) {
        fail("same-version binary ordering was not initialized");
      }
      const lowerObserverPid = observerPid;
      await runObserverStart(
        higherBuild.binaryPath,
        ["--config", configPath, "observer", "start", "--timeout-ms", "30000"],
        { client: observerClient, env: childEnv, socketPath },
      );
      const higherHealth = await observerClient.health();
      observerPid = higherHealth.pid;
      assertEqual(
        higherHealth.version,
        higherBuild.observerVersion,
        "higher same-version build replaces lower incumbent",
      );
      assertEqual(
        observerPid === lowerObserverPid,
        false,
        "same-version handoff replaces the Observer process",
      );
      if (lowerObserverPid !== undefined) {
        assertEqual(
          await waitForProcessExit(lowerObserverPid, 10_000),
          true,
          "same-version handoff waits for lower Observer exit",
        );
      }
      assertEqual(processIsAlive(hostProcess.pid), true, "same-version handoff preserves host");
      assertEqual(
        (await hostClient.health()).buildVersion,
        expectedVersion,
        "same-version handoff preserves host build",
      );
      const handedOffPty = (await hostClient.list()).find((entry) => entry.ptyId === spawned.ptyId);
      assertEqual(handedOffPty?.alive, true, "same-version handoff preserves live PTY");

      const commandCountBeforeRefusal = readCommandCount(join(stateDir, "observer.sqlite"));
      const refusedMutation = await run(
        lowerBuild.binaryPath,
        [
          "--config",
          configPath,
          "command",
          "dispatch",
          "--stdin",
          "--wait",
          "--timeout-ms",
          "10000",
        ],
        {
          env: childEnv,
          input: JSON.stringify({
            type: "observer.reconcile",
            payload: { reason: "binary-smoke-losing-same-version-build" },
          }),
          allowedExitCodes: [1],
        },
      );
      assertIncludes(
        refusedMutation.stderr,
        "OBSERVER_HANDOFF_REFUSED",
        "losing same-version mutation refusal code",
      );
      assertIncludes(
        refusedMutation.stderr,
        lowerBuild.buildIdentity.slice(0, 12),
        "losing same-version mutation caller identity",
      );
      assertIncludes(
        refusedMutation.stderr,
        higherBuild.buildIdentity.slice(0, 12),
        "losing same-version mutation incumbent identity",
      );
      const healthAfterRefusal = await observerClient.health();
      assertEqual(
        healthAfterRefusal.pid,
        observerPid,
        "losing same-version mutation preserves Observer process",
      );
      assertEqual(
        healthAfterRefusal.version,
        higherBuild.observerVersion,
        "losing same-version mutation preserves Observer build",
      );
      assertEqual(
        readCommandCount(join(stateDir, "observer.sqlite")),
        commandCountBeforeRefusal,
        "losing same-version mutation is not recorded",
      );
      assertEqual(processIsAlive(hostProcess.pid), true, "same-version refusal preserves host");
      const refusedMutationPty = (await hostClient.list()).find(
        (entry) => entry.ptyId === spawned.ptyId,
      );
      assertEqual(refusedMutationPty?.alive, true, "same-version refusal preserves live PTY");

      const sourceVersion = (
        await run(process.execPath, [sourceCliPath, "--version"], { env: childEnv })
      ).stdout.trim();
      const sourceObserverVersion = stationObserverBuildVersion({
        version: sourceVersion,
        compiled: false,
        buildIdentity,
      });
      sourceArtifact = {
        path: relative(repoRoot, sourceCliPath),
        displayVersion: sourceVersion,
        buildIdentity,
      };
      if (expectedVersion.startsWith("0.0.0-") && sourceVersion !== expectedVersion) {
        const previousObserverPid = observerPid;
        evidenceIncumbent = higherBuild.label;
        evidenceRequested = "source";
        evidenceDirection = {
          logical: "compiled-to-source-version",
          physical: `${higherBuild.label}-to-source`,
        };
        await runObserverStart(
          process.execPath,
          [sourceCliPath, "--config", configPath, "observer", "start", "--timeout-ms", "30000"],
          { client: observerClient, env: childEnv, socketPath },
        );
        const successorHealth = await observerClient.health();
        observerPid = successorHealth.pid;
        assertEqual(
          successorHealth.version,
          sourceObserverVersion,
          "higher source observer handoff",
        );
        assertEqual(
          observerPid === previousObserverPid,
          false,
          "higher source observer replaces lower compiled observer",
        );
        if (previousObserverPid !== undefined) {
          assertEqual(
            await waitForProcessExit(previousObserverPid, 10_000),
            true,
            "replaced observer exact process exit",
          );
        }

        evidenceIncumbent = "source";
        evidenceRequested = "current";
        evidenceDirection = {
          logical: "losing-caller-reuse",
          physical: "source-to-current",
        };
        await runObserverStart(
          binaryPath,
          ["--config", configPath, "observer", "start", "--timeout-ms", "30000"],
          { client: observerClient, env: childEnv, socketPath },
        );
        assertEqual(
          (await observerClient.health()).pid,
          observerPid,
          "lower compiled build reuses higher observer",
        );
        await run(
          join(dirname(binaryPath), "stn-ingress"),
          ["--socket", socketPath, "--state-dir", stateDir, "worktrunk", "post-create"],
          {
            env: childEnv,
            input: JSON.stringify({ branch: "station/binary-smoke-after-handoff" }),
          },
        );
        assertEqual(
          await directoryFileCount(join(stateDir, "spool", "hooks")),
          0,
          "lower-build ingress reuses the higher observer",
        );
        assertEqual(
          processIsAlive(hostProcess.pid),
          true,
          "station-host survives observer handoff",
        );
        assertEqual(
          (await hostClient.health()).buildVersion,
          expectedVersion,
          "station-host build remains unchanged across observer handoff",
        );
        await verifyMixedBuildStationUiAdmission({
          binaryPath,
          compiledObserverVersion,
          sourceObserverVersion,
          observerClient,
          stateDir,
          socketPath,
          hostClient,
          hostSocketPath,
          hostProcess,
          spawned,
          childEnv,
          popupEnv,
          popupConfigPath,
          configPath,
          root,
          fakeTmuxStatePath,
        });
      }
    }
    const livePty = (await hostClient.list()).find((entry) => entry.ptyId === spawned.ptyId);
    assertEqual(
      livePty?.ptyId,
      spawned.ptyId,
      "same host PTY remains listed across observer handoff",
    );
    assertEqual(livePty?.alive, true, "same host PTY remains live across observer handoff");
    await writeFile(ptyReleasePath, "", { mode: 0o600 });
    const terminalResult = await collectTerminalResult(attachment, 10_000);
    assertIncludes(terminalResult.output, "STATION_BINARY_PTY_OK", "compiled host PTY output");
    assertEqual(terminalResult.exitCode, 7, "compiled host PTY exit code");

    const hostLog = await readFile(join(stateDir, "logs", "station-host.jsonl"), "utf8");
    assertIncludes(hostLog, '"ptyImplementation":"bun"', "compiled host PTY implementation");
    await findFile(
      join(stateDir, "run", "assets", "ctty"),
      (name) => name === "station-ctty-helper",
    );
  } catch (error) {
    primaryFailure = error;
  }

  smokeRunSignal = undefined;
  const cleanupWarnings = [];
  const evidenceDir = process.env.STATION_BINARY_SMOKE_EVIDENCE_DIR;
  if (primaryFailure !== undefined && evidenceDir !== undefined && evidenceDir.length > 0) {
    try {
      await captureSmokeFailureEvidence({
        evidenceDir,
        root,
        stateDir,
        socketPath,
        primaryFailure,
        smokeStartedAt,
        evidenceDirection,
        evidenceIncumbent,
        evidenceRequested,
        binaryPath,
        expectedVersion,
        buildIdentity,
        alternateBinaryPath,
        alternateObserverVersion,
        sourceArtifact,
        observerPid,
        hostPid: hostProcess?.pid,
      });
      evidenceCaptured = true;
    } catch (error) {
      cleanupWarnings.push(`Evidence capture failed: ${errorMessage(error)}`);
    }
  }
  await cleanupAction(cleanupWarnings, "cleanup self-check", async () => {
    if (process.env.STATION_BINARY_SMOKE_CLEANUP_FAILURE_SELF_CHECK === "1") {
      throw new Error("synthetic binary smoke cleanup failure");
    }
  });

  await cleanupAction(cleanupWarnings, "Observer stop", async () => {
    if (observerClient === undefined) return;
    await observerClient.stop();
    await waitForMissing(socketPath);
  });
  await cleanupAction(cleanupWarnings, "Station Host client cleanup", async () =>
    hostClient?.dispose(),
  );
  await cleanupAction(cleanupWarnings, "Station Host process cleanup", async () => {
    if (
      hostProcess === undefined ||
      hostProcess.exitCode !== null ||
      hostProcess.signalCode !== null
    ) {
      return;
    }
    hostProcess.kill("SIGTERM");
    await waitForExit(hostProcess, 3000);
  });
  await cleanupAction(cleanupWarnings, "alternate worktree cleanup", async () => {
    if (alternateWorktreeAdded) await removeTemporaryWorktree(alternateWorktreePath);
  });

  if (primaryFailure === undefined && cleanupWarnings.length > 0) {
    primaryFailure = new AggregateError(
      cleanupWarnings.map((warning) => new Error(warning)),
      "Binary smoke cleanup failed.",
    );
    if (evidenceDir !== undefined && evidenceDir.length > 0) {
      try {
        await captureSmokeFailureEvidence({
          evidenceDir,
          root,
          stateDir,
          socketPath,
          primaryFailure,
          smokeStartedAt,
          evidenceDirection,
          evidenceIncumbent,
          evidenceRequested,
          binaryPath,
          expectedVersion,
          buildIdentity,
          alternateBinaryPath,
          alternateObserverVersion,
          sourceArtifact,
          observerPid,
          hostPid: hostProcess?.pid,
        });
        evidenceCaptured = true;
      } catch (error) {
        cleanupWarnings.push(`Evidence capture failed: ${errorMessage(error)}`);
      }
    }
  }

  if (primaryFailure === undefined && cleanupWarnings.length > 0) {
    primaryFailure = new AggregateError(
      cleanupWarnings.map((warning) => new Error(warning)),
      "Binary smoke cleanup failed.",
    );
    if (!evidenceCaptured && evidenceDir !== undefined && evidenceDir.length > 0) {
      try {
        await captureSmokeFailureEvidence({
          evidenceDir,
          root,
          stateDir,
          socketPath,
          primaryFailure,
          smokeStartedAt,
          evidenceDirection,
          evidenceIncumbent,
          evidenceRequested,
          binaryPath,
          expectedVersion,
          buildIdentity,
          alternateBinaryPath,
          alternateObserverVersion,
          sourceArtifact,
          observerPid,
          hostPid: hostProcess?.pid,
        });
        evidenceCaptured = true;
      } catch (error) {
        cleanupWarnings.push(`Evidence capture failed: ${errorMessage(error)}`);
      }
    }
  }
  cancellation.dispose();
  await writeOwnedInnerResult(cleanupWarnings);

  reportCleanupWarnings("Binary smoke", cleanupWarnings);
  if (primaryFailure !== undefined && !(primaryFailure instanceof SmokeRunCancelledError)) {
    throw primaryFailure;
  }
  if (primaryFailure === undefined) {
    process.stdout.write("binary smoke passed\n");
  }
}

async function runOwnedBinarySmoke(args, mode) {
  const prefix = mode === "handoff-stress" ? "stn-h-" : "station-binary-smoke-";
  const root = resolve(await mkdtemp(join(tmpdir(), prefix)));
  const rootIdentity = fileIdentity(await lstat(root));
  const stateDir = join(root, "state");
  const runtimeDir = join(root, "runtime");
  const socketPath = join(runtimeDir, "observer.sock");
  const hostSocketPath = join(runtimeDir, "station-host.sock");
  const configuredEvidenceDir = process.env.STATION_BINARY_SMOKE_EVIDENCE_DIR;
  const evidenceDir =
    configuredEvidenceDir === undefined || configuredEvidenceDir.length === 0
      ? undefined
      : configuredEvidenceDir;
  const runId = `run_${randomUUID()}`;
  const ownerStateDir = await binarySmokeOwnerStateDirectory(mode);
  const ownerLogPath = join(ownerStateDir, "logs", "cli.jsonl");
  const ownerLogOffset = await fileSizeOrZero(ownerLogPath);
  const startedAt = Date.now();
  if (evidenceDir !== undefined) {
    try {
      await reserveBinarySmokeEvidenceDestination({ evidenceDir, smokeRoot: root, runId });
    } catch (error) {
      await removeExactTemporaryRoot(root, rootIdentity, prefix);
      throw error;
    }
  }
  let result;
  let ownerError;
  try {
    result = await runOwnedDisposableRuntime({
      role: "binary-smoke",
      checkoutRoot: repoRoot,
      stateDir: ownerStateDir,
      socketRoots: [runtimeDir],
      persistenceRoots: [root, stateDir],
      cleanupRoots: [
        {
          path: await realpath(root),
          device: String(rootIdentity.device),
          inode: String(rootIdentity.inode),
        },
      ],
      survivorPolicy: "preserve-persistent-station-runtime",
      terminalKey: "binary-smoke-runner",
      recoveryKey: mode,
      correlation: {
        traceId: `trc_${randomUUID()}`,
        spanId: `spn_${randomUUID()}`,
      },
      launch: {
        cwd: repoRoot,
        steps: [
          {
            command: process.execPath,
            args: [fileURLToPath(import.meta.url), ...args],
          },
        ],
        env: {
          STATION_BINARY_SMOKE_OWNED_CHILD: "1",
          STATION_BINARY_SMOKE_OWNER_LOG_OFFSET: String(ownerLogOffset),
          STATION_BINARY_SMOKE_OWNER_STATE_DIR: ownerStateDir,
          STATION_BINARY_SMOKE_ROOT: root,
          STATION_BINARY_SMOKE_RUN_ID: runId,
          STATION_RUNTIME_OWNER_FOREGROUND: "1",
        },
      },
    });
  } catch (error) {
    ownerError = error;
  }

  const finalizationWarnings = [];
  let lifecycleEvents = [];
  try {
    lifecycleEvents = await readRuntimeLifecycleEvents(ownerLogPath, ownerLogOffset);
  } catch (error) {
    finalizationWarnings.push(`runtime lifecycle read: ${errorMessage(error)}`);
  }
  try {
    finalizationWarnings.push(...(await readOwnedInnerResult(root, runId)).warnings);
  } catch (error) {
    finalizationWarnings.push(`inner cleanup result: ${errorMessage(error)}`);
  }

  const ownerFailure = ownerError ?? ownedResultFailure(result);
  if (evidenceDir !== undefined && ownerFailure !== undefined) {
    await captureMissingOwnedSmokeEvidence({
      args,
      evidenceDir,
      lifecycleEvents,
      mode,
      ownerFailure,
      root,
      runId,
      startedAt,
      stateDir,
      socketPath,
      warnings: finalizationWarnings,
    });
  }

  if (ownerError === undefined) {
    for (const cleanupRoot of result?.cleanupRoots ?? [{ path: root, ...rootIdentity }]) {
      try {
        if (await pathExists(cleanupRoot.path)) {
          await removeExactTemporaryRoot(cleanupRoot.path, cleanupRoot, prefix);
        }
      } catch (error) {
        finalizationWarnings.push(
          `owned smoke root cleanup: ${errorMessage(error).replaceAll(cleanupRoot.path, "$SMOKE_ROOT")}`,
        );
      }
    }
  }

  if (
    evidenceDir !== undefined &&
    ownerFailure === undefined &&
    finalizationWarnings.some((warning) => warning.startsWith("owned smoke root cleanup:"))
  ) {
    await captureMissingOwnedSmokeEvidence({
      args,
      evidenceDir,
      lifecycleEvents,
      mode,
      ownerFailure: new Error("Binary smoke final root cleanup failed."),
      root,
      runId,
      startedAt,
      stateDir,
      socketPath,
      warnings: finalizationWarnings,
    });
  }

  const cleanupFailed = () =>
    finalizationWarnings.some(
      (warning) =>
        warning.startsWith("owned smoke root cleanup:") ||
        warning.startsWith("evidence reservation cleanup:"),
    );
  if (
    evidenceDir !== undefined &&
    ownerFailure === undefined &&
    !cleanupFailed() &&
    !(await pathExists(join(resolve(evidenceDir), "manifest.json")))
  ) {
    try {
      await releaseBinarySmokeEvidenceReservation({
        evidenceDir,
        smokeRoot: root,
        runId,
      });
    } catch (error) {
      finalizationWarnings.push(`evidence reservation cleanup: ${errorMessage(error)}`);
    }
  }

  if (evidenceDir !== undefined) {
    const manifest = await readCurrentEvidenceManifest(evidenceDir, runId).catch((error) => {
      finalizationWarnings.push(`Evidence finalization refused: ${errorMessage(error)}`);
      return undefined;
    });
    if (manifest !== undefined) {
      await finalizeOwnedSmokeEvidence({
        evidenceDir,
        hostSocketPath,
        lifecycleEvents,
        manifest,
        ownerError,
        result,
        cleanupRoots: result?.cleanupRoots ?? [{ path: root, ...rootIdentity }],
        root,
        runId,
        socketPath,
        warnings: finalizationWarnings,
      });
    }
  }

  for (const warning of finalizationWarnings)
    process.stderr.write(`Binary smoke warning: ${warning}\n`);
  if (ownerError !== undefined) throw ownerError;
  if (cleanupFailed()) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = result?.exitCode ?? 1;
}

async function finalizeOwnedSmokeEvidence(input) {
  try {
    const runtimeId = input.result?.runtimeId;
    const groupExited =
      input.ownerError === undefined &&
      runtimeId !== undefined &&
      input.lifecycleEvents.some(
        (event) =>
          event.attributes.runtimeId === runtimeId &&
          event.message === "runtime.cleanup.completed" &&
          event.attributes.memberCount === 0,
      ) &&
      input.lifecycleEvents.some(
        (event) =>
          event.attributes.runtimeId === runtimeId && event.message === "runtime.owner.retired",
      );
    const cleanup = {
      observerExited: groupExited,
      hostExited: groupExited,
      socketRemoved: !(await pathExists(input.socketPath)),
      pidfileRemoved: !(await pathExists(`${input.socketPath}.pid`)),
      hostSocketRemoved: !(await pathExists(input.hostSocketPath)),
      rootRemoved: (
        await Promise.all(input.cleanupRoots.map((root) => pathExists(root.path)))
      ).every((exists) => !exists),
    };
    const complete =
      groupExited &&
      Object.values(cleanup).every(Boolean) &&
      !input.warnings.some((warning) => warning.startsWith("owned smoke root cleanup:"));
    await finalizeBinarySmokeEvidence({
      evidenceDir: input.evidenceDir,
      expectedRunId: input.runId,
      cleanup: { status: complete ? "complete" : "incomplete", ...cleanup },
      ...(groupExited
        ? {
            processes: input.manifest.rounds[0].runtime.processes.map((process) => ({
              ...process,
              exists: false,
            })),
          }
        : {}),
      warnings: [
        ...input.warnings,
        ...(input.ownerError === undefined
          ? []
          : [`runtime owner: ${errorMessage(input.ownerError)}`]),
      ],
      lifecycleEvents: input.lifecycleEvents,
    });
  } catch (error) {
    input.warnings.push(`Evidence finalization failed: ${errorMessage(error)}`);
  }
}

async function readRuntimeLifecycleEvents(source, offset = 0) {
  const path = source.endsWith(".jsonl") ? source : join(source, "logs", "cli.jsonl");
  let content;
  try {
    const bytes = await readFile(path);
    content = bytes.subarray(Math.min(offset, bytes.length)).toString("utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return content
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const event = RuntimeLifecycleEventSchema.safeParse(JSON.parse(line));
        return event.success ? [event.data] : [];
      } catch {
        return [];
      }
    });
}

async function binarySmokeOwnerStateDirectory(mode) {
  const checkoutRoot = await realpath(repoRoot);
  const checkout = await lstat(checkoutRoot);
  const key = createHash("sha256")
    .update(`${checkoutRoot}\0${checkout.dev}\0${checkout.ino}`)
    .digest("hex")
    .slice(0, 24);
  const stateDir = join(resolve(tmpdir()), `station-binary-smoke-owner-${key}-${mode}`);
  try {
    await mkdir(stateDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(stateDir);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700 ||
    (typeof process.geteuid === "function" && metadata.uid !== process.geteuid())
  ) {
    throw new Error(`Binary smoke owner state is not a private owned directory: ${stateDir}`);
  }
  return stateDir;
}

async function fileSizeOrZero(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Runtime lifecycle path is not a regular file: ${path}`);
    }
    return metadata.size;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

function requiredOwnedEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Owned binary smoke environment is missing ${name}.`);
  }
  return value;
}

function ownerLifecycleOffset() {
  const value = requiredOwnedEnvironment("STATION_BINARY_SMOKE_OWNER_LOG_OFFSET");
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("Owned binary smoke lifecycle offset is invalid.");
  }
  return Number(value);
}

async function readCurrentOwnerLifecycleEvents() {
  return readRuntimeLifecycleEvents(
    requiredOwnedEnvironment("STATION_BINARY_SMOKE_OWNER_STATE_DIR"),
    ownerLifecycleOffset(),
  );
}

function ownedInnerResultPath(root) {
  return join(root, "runtime", "binary-smoke-inner-result.json");
}

async function writeOwnedInnerResult(warnings) {
  const root = resolve(requiredOwnedEnvironment("STATION_BINARY_SMOKE_ROOT"));
  const result = ownedInnerResultSchema.parse({
    runId: requiredOwnedEnvironment("STATION_BINARY_SMOKE_RUN_ID"),
    warnings,
  });
  await mkdir(dirname(ownedInnerResultPath(root)), { recursive: true, mode: 0o700 });
  await writeFile(ownedInnerResultPath(root), `${JSON.stringify(result)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

async function readOwnedInnerResult(root, runId) {
  try {
    const result = ownedInnerResultSchema.parse(
      JSON.parse(await readFile(ownedInnerResultPath(root), "utf8")),
    );
    if (result.runId !== runId) throw new Error("Inner result belongs to a different smoke run.");
    return result;
  } catch (error) {
    if (error?.code === "ENOENT") return { runId, warnings: [] };
    throw error;
  }
}

function ownedResultFailure(result) {
  if (result === undefined || result.exitCode === 0) return undefined;
  const exitDisposition =
    result.signal === undefined
      ? { type: "code", code: result.exitCode }
      : { type: "signal", signal: result.signal };
  return new SmokeCommandError(
    `Owned binary smoke runner exited ${result.exitCode}${result.signal === undefined ? "" : ` after ${result.signal}`}.`,
    process.execPath,
    [],
    exitDisposition,
  );
}

async function captureMissingOwnedSmokeEvidence(input) {
  if (await pathExists(join(input.evidenceDir, "manifest.json"))) return;
  try {
    await resetReservedBinarySmokeEvidenceDestination({
      evidenceDir: input.evidenceDir,
      smokeRoot: input.root,
      runId: input.runId,
    });
    const expectedVersion =
      input.mode === "handoff-stress"
        ? parseHandoffStressOptions(input.args).expectedVersion
        : parseExpectedVersion(input.args);
    const buildIdentity = await readFile(resolve("packages/runtime/dist/station-build-id"), "utf8")
      .then((value) => value.trim())
      .catch(() => "unavailable");
    const exitDisposition =
      input.ownerFailure instanceof SmokeCommandError
        ? input.ownerFailure.exitDisposition
        : { type: "unavailable" };
    const cancelled =
      exitDisposition.type === "signal" &&
      ["SIGINT", "SIGTERM", "SIGHUP"].includes(exitDisposition.signal);
    await captureBinarySmokeEvidence({
      runId: input.runId,
      evidenceDir: input.evidenceDir,
      smokeRoot: input.root,
      stateDir: input.stateDir,
      socketPath: input.socketPath,
      status: cancelled ? "cancelled" : "failed",
      round: 1,
      elapsedMs: Date.now() - input.startedAt,
      direction: {
        logical: input.mode === "handoff-stress" ? "lower-to-higher" : "binary-smoke",
        physical: "runner",
      },
      error: input.ownerFailure,
      failure: {
        message: errorMessage(input.ownerFailure),
        command: { artifact: "runner", argv: input.args },
        exitDisposition,
      },
      artifacts: {
        current: {
          path: relative(
            repoRoot,
            resolve(process.env.STATION_BINARY_PATH ?? "station/dist/bin/stn"),
          ),
          displayVersion: expectedVersion,
          buildIdentity,
        },
        alternate: {
          path: join(input.root, "alternate-worktree", "station", "dist", "bin", "stn"),
          displayVersion: expectedVersion,
          buildIdentity: "unavailable",
        },
        incumbent: "current",
        requested: "alternate",
      },
      knownProcesses: [],
      lifecycleEvents: input.lifecycleEvents,
    });
  } catch (error) {
    input.warnings.push(`Evidence capture failed: ${errorMessage(error)}`);
  }
}

async function readCurrentEvidenceManifest(evidenceDir, runId) {
  const manifestPath = join(resolve(evidenceDir), "manifest.json");
  if (!(await pathExists(manifestPath))) return undefined;
  const manifest = BinarySmokeEvidenceManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  if (manifest.runId !== runId) {
    throw new Error("Evidence manifest belongs to a different binary smoke run.");
  }
  return manifest;
}

async function runHandoffStress(options) {
  const binaryPath = resolve(process.env.STATION_BINARY_PATH ?? "station/dist/bin/stn");
  const baseRoot = resolve(requiredOwnedEnvironment("STATION_BINARY_SMOKE_ROOT"));
  const alternateWorktreePath = join(baseRoot, "alternate-worktree");
  const evidenceDir = process.env.STATION_BINARY_SMOKE_EVIDENCE_DIR;
  const cancellation = installSmokeCancellation();
  smokeRunSignal = cancellation.signal;
  let alternateWorktreeAdded = false;
  let primaryFailure;
  const cleanupWarnings = [];

  try {
    if (
      evidenceDir !== undefined &&
      (resolve(evidenceDir) === baseRoot || resolve(evidenceDir).startsWith(`${baseRoot}/`))
    ) {
      throw new Error("STATION_BINARY_SMOKE_EVIDENCE_DIR must be outside the stress root.");
    }
    await access(binaryPath, constants.X_OK);
    await requireCommittedCleanCheckout(repoRoot);
    alternateWorktreeAdded = true;
    await runGit(["worktree", "add", "--detach", alternateWorktreePath, "HEAD"], {
      terminateDescendants: true,
    });
    const alternateBinaryPath = await buildAlternateBinary({
      worktreePath: alternateWorktreePath,
      expectedVersion: options.expectedVersion,
    });
    const currentObserverVersion = await queryBinaryObserverVersion({
      binaryPath,
      expectedVersion: options.expectedVersion,
      root: join(baseRoot, "current-selector"),
      label: "current compiled observer",
    });
    const alternateObserverVersion = await queryBinaryObserverVersion({
      binaryPath: alternateBinaryPath,
      expectedVersion: options.expectedVersion,
      root: join(baseRoot, "alternate-selector"),
      label: "alternate compiled observer",
    });
    const orderedBuilds = orderSameVersionBuilds(
      [
        { binaryPath, label: "current", observerVersion: currentObserverVersion },
        {
          binaryPath: alternateBinaryPath,
          label: "alternate",
          observerVersion: alternateObserverVersion,
        },
      ],
      options.expectedVersion,
    );

    for (let round = 1; round <= options.rounds; round += 1) {
      await runHandoffStressRound({
        round,
        baseRoot,
        orderedBuilds,
        expectedVersion: options.expectedVersion,
        roundTimeoutMs: options.roundTimeoutMs,
        evidenceDir,
        cancellationSignal: cancellation.signal,
      });
    }
  } catch (error) {
    primaryFailure = error;
  }

  smokeRunSignal = undefined;
  await cleanupAction(cleanupWarnings, "alternate worktree cleanup", async () => {
    if (alternateWorktreeAdded) await removeTemporaryWorktree(alternateWorktreePath);
  });
  cancellation.dispose();
  await writeOwnedInnerResult(cleanupWarnings);

  if (primaryFailure === undefined && cleanupWarnings.length > 0) {
    primaryFailure = new AggregateError(
      cleanupWarnings.map((warning) => new Error(warning)),
      "Binary handoff stress cleanup failed.",
    );
  }
  reportCleanupWarnings("Binary handoff stress", cleanupWarnings);
  if (primaryFailure !== undefined && !(primaryFailure instanceof SmokeRunCancelledError)) {
    throw primaryFailure;
  }
}

async function runHandoffStressRound(input) {
  const roundRoot = join(input.baseRoot, `r${String(input.round).padStart(4, "0")}`);
  await mkdir(roundRoot, { mode: 0o700 });
  const roundIdentity = fileIdentity(await lstat(roundRoot));
  const context = await createStressRoundContext(input, roundRoot);
  const roundController = new AbortController();
  const roundTimeout = setTimeout(
    () =>
      roundController.abort(
        new StressRoundTimeoutError(
          `Binary handoff stress round ${input.round} exceeded ${input.roundTimeoutMs} ms.`,
        ),
      ),
    input.roundTimeoutMs,
  );
  smokeRunSignal = AbortSignal.any([input.cancellationSignal, roundController.signal]);
  let primaryFailure;
  const cleanupWarnings = [];
  const startedAt = Date.now();

  try {
    const result = await executeStressRound(context);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    primaryFailure = error;
  } finally {
    clearTimeout(roundTimeout);
    smokeRunSignal = input.cancellationSignal;
  }

  if (primaryFailure !== undefined && input.evidenceDir !== undefined) {
    try {
      await captureStressRoundEvidence(context, primaryFailure, startedAt, input.evidenceDir);
    } catch (error) {
      cleanupWarnings.push(`Evidence capture failed: ${errorMessage(error)}`);
    }
  }

  await cleanupStressRound(context, cleanupWarnings);
  if (primaryFailure === undefined && cleanupWarnings.length > 0) {
    primaryFailure = new AggregateError(
      cleanupWarnings.map((warning) => new Error(warning)),
      `Binary handoff stress round ${input.round} cleanup failed.`,
    );
    if (input.evidenceDir !== undefined) {
      try {
        await captureStressRoundEvidence(context, primaryFailure, startedAt, input.evidenceDir);
      } catch (error) {
        cleanupWarnings.push(`Evidence capture failed: ${errorMessage(error)}`);
      }
    }
  }

  await cleanupAction(cleanupWarnings, "stress round root cleanup", () => {
    return removeExactDirectory(roundRoot, roundIdentity, input.baseRoot);
  });

  reportCleanupWarnings(`Binary handoff stress round ${input.round}`, cleanupWarnings);
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupWarnings.length > 0) {
    throw new AggregateError(
      cleanupWarnings.map((warning) => new Error(warning)),
      `Binary handoff stress round ${input.round} cleanup failed.`,
    );
  }
}

async function createStressRoundContext(input, roundRoot) {
  const homeDir = join(roundRoot, "home");
  const stateDir = join(roundRoot, "state");
  const runtimeDir = join(roundRoot, "runtime");
  const socketPath = join(runtimeDir, "observer.sock");
  const hostSocketPath = join(runtimeDir, "station-host.sock");
  const configPath = join(roundRoot, "config.toml");
  const releasePath = join(roundRoot, "release-host-pty");
  for (const path of [socketPath, hostSocketPath]) {
    if (process.platform === "darwin" && Buffer.byteLength(path) >= 104) {
      fail(`Binary handoff stress socket path exceeds macOS's 103-byte limit: ${path}`);
    }
  }
  await Promise.all(
    [join(homeDir, "tmp"), stateDir, runtimeDir].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  await writeSmokeConfig(configPath, stateDir, socketPath);
  return {
    ...input,
    roundRoot,
    homeDir,
    stateDir,
    runtimeDir,
    socketPath,
    hostSocketPath,
    configPath,
    releasePath,
    ownerEventsPath: join(
      requiredOwnedEnvironment("STATION_BINARY_SMOKE_OWNER_STATE_DIR"),
      "logs",
      "cli.jsonl",
    ),
    ownerEventsOffset: ownerLifecycleOffset(),
    env: isolatedBinaryEnv({ homeDir, runtimeDir }),
    client: createObserverClient({ socketPath, timeoutMs: 5000 }),
    timings: {},
  };
}

async function executeStressRound(context) {
  const lower = context.orderedBuilds[0];
  const higher = context.orderedBuilds[1];
  const startedAt = Date.now();
  const mark = (stage) => {
    context.timings[stage] = Date.now() - startedAt;
  };

  const lowerStartup = await runObserverStart(
    lower.binaryPath,
    [
      "--config",
      context.configPath,
      "observer",
      "start",
      "--timeout-ms",
      String(context.roundTimeoutMs),
    ],
    {
      client: context.client,
      env: context.env,
      socketPath: context.socketPath,
      timeoutMs: context.roundTimeoutMs,
    },
  );
  context.incumbentPid = lowerStartup.health.pid;
  context.observerPid = lowerStartup.health.pid;
  const lowerHealth = await waitForObserverClientHealth(context.client, 5_000);
  assertEqual(lowerHealth.pid, lowerStartup.health.pid, "stress lower startup PID");
  mark("lowerHealthyMs");
  await assertStressObserverOwnership(context, lowerHealth, lower.observerVersion, "lower");

  context.hostProcess = spawn(
    lower.binaryPath,
    ["__station-host", "--socket", context.hostSocketPath, "--state-dir", context.stateDir],
    {
      detached: process.env.STATION_RUNTIME_OWNER_FOREGROUND !== "1",
      env: context.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const hostDiagnostics = collectOutput(context.hostProcess);
  context.hostClient = createStationHostClient({
    socketPath: context.hostSocketPath,
    timeoutMs: 1000,
    expectedBuildVersion: context.expectedVersion,
  });
  await waitForHost(context.hostClient, hostDiagnostics);
  const ptyIdentity = {
    terminalTargetId: `native:binary-handoff-stress-${context.round}`,
    worktreeId: `binary-handoff-stress-${context.round}`,
    projectId: "binary-handoff-stress",
    sessionId: `ses_binary_handoff_stress_${context.round}`,
    worktreePath: context.roundRoot,
    harnessProvider: "scripted",
    kind: "agent",
  };
  context.spawnedPty = await context.hostClient.spawn({
    ...ptyIdentity,
    command: "/bin/sh",
    args: [
      "-c",
      'printf STATION_BINARY_HANDOFF_STRESS_OK; while [ ! -f "$1" ]; do sleep 1; done; exit 7',
      "station-binary-handoff-stress",
      context.releasePath,
    ],
    cwd: context.roundRoot,
    cols: 80,
    rows: 24,
  });
  context.attachment = await context.hostClient.attach(
    { ...ptyIdentity, ...context.spawnedPty },
    "viewer",
  );
  mark("hostPtyReadyMs");

  const higherStartup = await runObserverStart(
    higher.binaryPath,
    [
      "--config",
      context.configPath,
      "observer",
      "start",
      "--timeout-ms",
      String(context.roundTimeoutMs),
    ],
    {
      client: context.client,
      env: context.env,
      socketPath: context.socketPath,
      timeoutMs: context.roundTimeoutMs,
    },
  );
  context.replacementPid = higherStartup.health.pid;
  context.observerPid = higherStartup.health.pid;
  const higherHealth = await waitForObserverClientHealth(context.client, 5_000);
  assertEqual(higherHealth.pid, higherStartup.health.pid, "stress higher startup PID");
  mark("higherHealthyMs");
  assertEqual(higherHealth.version, higher.observerVersion, "stress higher Observer build");
  assertEqual(higherHealth.pid === lowerHealth.pid, false, "stress replacement changes PID");
  assertEqual(
    await waitForProcessExit(lowerHealth.pid, 10_000),
    true,
    "stress lower Observer exact exit",
  );
  await assertStressObserverOwnership(context, higherHealth, higher.observerVersion, "higher");
  assertEqual(processIsAlive(context.hostProcess.pid), true, "stress handoff preserves Host");
  const livePty = (await context.hostClient.list()).find(
    (entry) => entry.ptyId === context.spawnedPty.ptyId,
  );
  assertEqual(livePty?.alive, true, "stress handoff preserves live PTY");

  const losingCaller = await run(
    lower.binaryPath,
    [
      "--config",
      context.configPath,
      "observer",
      "start",
      "--timeout-ms",
      String(context.roundTimeoutMs),
    ],
    {
      env: context.env,
      timeoutMs: context.roundTimeoutMs,
      allowedExitCodes: [0, 1],
    },
  );
  if (losingCaller.code === 1) {
    assertIncludes(
      `${losingCaller.stdout}${losingCaller.stderr}`,
      "OBSERVER_HANDOFF_REFUSED",
      "stress losing caller refusal",
    );
  }
  const afterLosingCaller = await context.client.health();
  assertEqual(afterLosingCaller.pid, higherHealth.pid, "stress losing caller preserves PID");
  assertEqual(
    afterLosingCaller.version,
    higher.observerVersion,
    "stress losing caller preserves build",
  );
  await assertStressObserverOwnership(
    context,
    afterLosingCaller,
    higher.observerVersion,
    "post-refusal",
  );
  mark("losingCallerVerifiedMs");

  await writeFile(context.releasePath, "", { mode: 0o600 });
  const terminal = await collectTerminalResult(context.attachment, 10_000);
  assertIncludes(terminal.output, "STATION_BINARY_HANDOFF_STRESS_OK", "stress live PTY output");
  assertEqual(terminal.exitCode, 7, "stress live PTY exit code");
  mark("ptyCompletedMs");

  return {
    round: context.round,
    direction: {
      logical: "lower-to-higher",
      replacementPhysical: `${lower.label}-to-${higher.label}`,
      losingCallerPhysical: `${higher.label}-to-${lower.label}`,
    },
    builds: {
      lower: lower.buildIdentity,
      higher: higher.buildIdentity,
    },
    pids: { incumbent: lowerHealth.pid, requested: higherHealth.pid },
    timings: context.timings,
    elapsedMs: Date.now() - startedAt,
    disposition: "passed",
  };
}

async function assertStressObserverOwnership(context, health, version, label) {
  assertEqual(health.status, "healthy", `${label} Observer health`);
  assertEqual(health.version, version, `${label} Observer selector`);
  const pidfileText = await readFile(`${context.socketPath}.pid`, "utf8");
  let pidfileJson;
  try {
    pidfileJson = JSON.parse(pidfileText);
  } catch (cause) {
    throw new Error(`Failed to parse Observer pidfile at ${context.socketPath}.pid`, { cause });
  }
  const identity = ObserverProcessIdentitySchema.parse(pidfileJson);
  assertEqual(identity.pid, health.pid, `${label} pidfile PID`);
  assertEqual(identity.version, version, `${label} pidfile selector`);
  assertEqual(identity.socketPath, context.socketPath, `${label} pidfile socket`);
  assertDeepEqual(
    readUnixSocketHolderPids(context.socketPath),
    [health.pid],
    `${label} sole socket holder`,
  );
  assertEqual((await lstat(context.socketPath)).isSocket(), true, `${label} socket type`);
  assertEqual(
    (await observerProcessInventory(context.socketPath)).length,
    1,
    `${label} exact Observer process count`,
  );
}

async function captureStressRoundEvidence(context, primaryFailure, startedAt, evidenceDir) {
  const lower = context.orderedBuilds[0];
  const higher = context.orderedBuilds[1];
  const failure = {
    message: errorMessage(primaryFailure),
    exitDisposition:
      primaryFailure instanceof SmokeCommandError
        ? primaryFailure.exitDisposition
        : { type: "unavailable" },
  };
  if (primaryFailure instanceof SmokeCommandError) {
    failure.command = {
      artifact: commandArtifact(
        primaryFailure.command,
        context.orderedBuilds.find((build) => build.label === "current")?.binaryPath ?? "",
        context.orderedBuilds.find((build) => build.label === "alternate")?.binaryPath,
      ),
      argv: primaryFailure.args,
    };
  }
  await captureBinarySmokeEvidence({
    runId: requiredOwnedEnvironment("STATION_BINARY_SMOKE_RUN_ID"),
    evidenceDir,
    smokeRoot: context.roundRoot,
    stateDir: context.stateDir,
    socketPath: context.socketPath,
    status: primaryFailure instanceof SmokeRunCancelledError ? "cancelled" : "failed",
    round: context.round,
    elapsedMs: Date.now() - startedAt,
    direction: {
      logical: "lower-to-higher",
      physical: `${lower.label}-to-${higher.label}`,
    },
    error: primaryFailure,
    failure,
    artifacts: {
      current: stressArtifact(context, "current"),
      alternate: stressArtifact(context, "alternate"),
      incumbent: lower.label,
      requested: higher.label,
    },
    knownProcesses: stressKnownProcesses(context),
    lifecycleEvents: await readRuntimeLifecycleEvents(
      context.ownerEventsPath,
      context.ownerEventsOffset,
    ),
  });
}

function stressArtifact(context, label) {
  const artifact = context.orderedBuilds.find((candidate) => candidate.label === label);
  if (artifact === undefined) throw new Error(`Missing ${label} stress artifact.`);
  return {
    path:
      label === "current"
        ? relative(repoRoot, artifact.binaryPath)
        : "alternate-worktree/station/dist/bin/stn",
    displayVersion: context.expectedVersion,
    buildIdentity: artifact.buildIdentity,
  };
}

async function cleanupStressRound(context, warnings) {
  smokeRunSignal = undefined;
  await cleanupAction(warnings, "Observer stop", async () => {
    await context.client.stop();
    await waitForMissing(context.socketPath);
  });
  await cleanupAction(warnings, "Station Host client cleanup", async () =>
    context.hostClient?.dispose(),
  );
  await cleanupAction(warnings, "Station Host process cleanup", async () => {
    if (
      context.hostProcess === undefined ||
      context.hostProcess.exitCode !== null ||
      context.hostProcess.signalCode !== null
    ) {
      return;
    }
    context.hostProcess.kill("SIGTERM");
    await waitForExit(context.hostProcess, 3000);
  });
  await cleanupAction(warnings, "Observer cleanup proof", async () => {
    const survivingObserver = stressKnownProcesses(context).find(
      (process) => process.role !== "station-host" && processIsAlive(process.pid),
    );
    if (survivingObserver !== undefined) {
      throw new Error(`Observer PID ${survivingObserver.pid} remained alive.`);
    }
    const observerProcesses = await observerProcessInventory(context.socketPath);
    if (observerProcesses.length > 0) {
      throw new Error(`Observer processes remained: ${observerProcesses.join("; ")}`);
    }
    if (await pathExists(context.socketPath)) throw new Error("Observer socket remained present.");
    if (await pathExists(`${context.socketPath}.pid`))
      throw new Error("Observer pidfile remained present.");
  });
  await cleanupAction(warnings, "Station Host cleanup proof", async () => {
    if (context.hostProcess?.pid !== undefined && processIsAlive(context.hostProcess.pid)) {
      throw new Error(`Station Host PID ${context.hostProcess.pid} remained alive.`);
    }
    if (await pathExists(context.hostSocketPath))
      throw new Error("Station Host socket remained present.");
  });
}

function parseHandoffStressOptions(args) {
  const normalized = args.filter((arg) => arg !== "--");
  const values = new Map();
  for (let index = 0; index < normalized.length; index += 2) {
    const key = normalized[index];
    const value = normalized[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error(handoffStressUsage());
    }
    if (values.has(key)) throw new Error(`Duplicate handoff stress flag: ${key}`);
    values.set(key, value);
  }
  if (values.get("--mode") !== "handoff-stress") throw new Error(handoffStressUsage());
  for (const key of values.keys()) {
    if (!["--mode", "--expected-version", "--rounds", "--round-timeout-ms"].includes(key)) {
      throw new Error(`Unknown handoff stress flag: ${key}`);
    }
  }
  const expectedVersion = values.get("--expected-version");
  if (expectedVersion === undefined || !isSemver(expectedVersion)) {
    throw new Error("--expected-version must be a SemVer value.");
  }
  return {
    expectedVersion,
    rounds: parsePositiveInteger(values.get("--rounds") ?? "50", "--rounds", 1000),
    roundTimeoutMs: parsePositiveInteger(
      values.get("--round-timeout-ms") ?? "30000",
      "--round-timeout-ms",
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function parsePositiveInteger(value, flag, maximum) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${flag} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${flag} must be between 1 and ${maximum}.`);
  }
  return parsed;
}

function isSemver(value) {
  return /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  );
}

function handoffStressUsage() {
  return "Usage: run-binary-smoke.mjs --mode handoff-stress --expected-version <semver> --rounds <1..1000> --round-timeout-ms <positive-safe-integer>";
}

async function captureSmokeFailureEvidence(input) {
  const alternateIdentity =
    input.alternateObserverVersion === undefined
      ? "unavailable"
      : (parseStationObserverBuildVersion(input.alternateObserverVersion).buildIdentity ??
        "unavailable");
  const command =
    input.primaryFailure instanceof SmokeCommandError
      ? {
          artifact: commandArtifact(
            input.primaryFailure.command,
            input.binaryPath,
            input.alternateBinaryPath,
            input.primaryFailure.args,
            input.sourceArtifact?.path,
          ),
          argv: input.primaryFailure.args,
        }
      : undefined;
  const failure = {
    message: errorMessage(input.primaryFailure),
    exitDisposition:
      input.primaryFailure instanceof SmokeCommandError
        ? input.primaryFailure.exitDisposition
        : { type: "unavailable" },
  };
  if (command !== undefined) failure.command = command;
  await captureBinarySmokeEvidence({
    runId: requiredOwnedEnvironment("STATION_BINARY_SMOKE_RUN_ID"),
    evidenceDir: input.evidenceDir,
    smokeRoot: input.root,
    stateDir: input.stateDir,
    socketPath: input.socketPath,
    status: input.primaryFailure instanceof SmokeRunCancelledError ? "cancelled" : "failed",
    round: 1,
    elapsedMs: Date.now() - input.smokeStartedAt,
    direction: input.evidenceDirection,
    error: input.primaryFailure,
    failure,
    artifacts: {
      current: {
        path: relative(repoRoot, input.binaryPath),
        displayVersion: input.expectedVersion,
        buildIdentity: input.buildIdentity,
      },
      alternate: {
        path:
          input.alternateBinaryPath ??
          join(input.root, "alternate-worktree", "station", "dist", "bin", "stn"),
        displayVersion: input.expectedVersion,
        buildIdentity: alternateIdentity,
      },
      ...(input.sourceArtifact === undefined ? {} : { source: input.sourceArtifact }),
      incumbent: input.evidenceIncumbent,
      requested: input.evidenceRequested,
    },
    knownProcesses: knownProcesses(input.observerPid, input.hostPid),
    lifecycleEvents: await readCurrentOwnerLifecycleEvents(),
  });
}

function commandArtifact(command, currentBinaryPath, alternateBinaryPath, args, sourceCliPath) {
  if (resolve(command) === resolve(currentBinaryPath)) return "current";
  if (alternateBinaryPath !== undefined && resolve(command) === resolve(alternateBinaryPath)) {
    return "alternate";
  }
  if (
    sourceCliPath !== undefined &&
    (resolve(command) === resolve(sourceCliPath) ||
      resolve(args?.[0] ?? "") === resolve(sourceCliPath))
  ) {
    return "source";
  }
  return "runner";
}

function knownProcesses(observerPid, hostPid) {
  const processes = [];
  if (observerPid !== undefined) processes.push({ role: "observer", pid: observerPid });
  if (hostPid !== undefined) processes.push({ role: "station-host", pid: hostPid });
  return processes;
}

function stressKnownProcesses(context) {
  const processes = [];
  if (context.incumbentPid !== undefined) {
    processes.push({ role: "incumbent", pid: context.incumbentPid });
  }
  if (context.replacementPid !== undefined && context.replacementPid !== context.incumbentPid) {
    processes.push({ role: "replacement", pid: context.replacementPid });
  }
  if (context.hostProcess?.pid !== undefined) {
    processes.push({ role: "station-host", pid: context.hostProcess.pid });
  }
  return processes;
}

async function cleanupAction(warnings, label, action) {
  try {
    await action();
  } catch (error) {
    warnings.push(`${label}: ${errorMessage(error)}`);
  }
}

function reportCleanupWarnings(scope, warnings) {
  for (const warning of warnings) process.stderr.write(`${scope} warning: ${warning}\n`);
}

async function removeExactTemporaryRoot(root, expectedIdentity, prefix) {
  const resolvedRoot = resolve(root);
  const canonicalRoot = await realpath(resolvedRoot);
  const canonicalTemporaryDirectory = await realpath(tmpdir());
  if (
    dirname(canonicalRoot) !== canonicalTemporaryDirectory ||
    !canonicalRoot.startsWith(join(canonicalTemporaryDirectory, prefix))
  ) {
    throw new Error(`Refusing unexpected temporary deletion target: ${resolvedRoot}`);
  }
  await removeExactDirectory(canonicalRoot, expectedIdentity, canonicalTemporaryDirectory);
}

async function removeExactDirectory(path, expectedIdentity, expectedParent) {
  const resolvedPath = resolve(path);
  if (dirname(resolvedPath) !== resolve(expectedParent)) {
    throw new Error(`Refusing unexpected deletion target: ${resolvedPath}`);
  }
  const stats = await lstat(resolvedPath);
  const identity = fileIdentity(stats);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    String(identity.device) !== String(expectedIdentity.device) ||
    String(identity.inode) !== String(expectedIdentity.inode)
  ) {
    throw new Error(`Refusing replaced deletion target: ${resolvedPath}`);
  }
  await rm(resolvedPath, { recursive: true, force: true });
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

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  const safeError = SafeErrorSchema.safeParse(error);
  return safeError.success ? `${safeError.data.code}: ${safeError.data.message}` : String(error);
}

async function requireCommittedCleanCheckout(root) {
  const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root });
  if (status.stdout.length === 0) {
    return;
  }
  fail(
    `binary smoke's two-artifact acceptance requires a committed clean checkout; commit or remove:\n${status.stdout}`,
  );
}

async function buildAlternateBinary({ worktreePath, expectedVersion }) {
  const sourcePath = join(worktreePath, alternateProductionSource);
  const source = await readFile(sourcePath, "utf8");
  const originalMessage =
    'description: "STATION is a terminal-native control plane for AI-agent worktree sessions.",';
  const alternateMessage = `description: "STATION is a terminal-native control plane for AI-agent worktree sessions${alternateBuildMarker}.",`;
  if (source.split(originalMessage).length !== 2) {
    fail(
      `alternate binary smoke could not apply its production change to ${alternateProductionSource}`,
    );
  }
  await writeFile(sourcePath, source.replace(originalMessage, alternateMessage), "utf8");
  await assertOnlyAlternateProductionChange(worktreePath);

  const buildEnv = environmentWithoutGitLocals({ ...process.env, CI: "1" });
  await run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: worktreePath,
    env: buildEnv,
    terminateDescendants: true,
    timeoutMs: 300_000,
  });
  await run("bun", ["run", "build:binary", "--", "--version", expectedVersion], {
    cwd: worktreePath,
    env: buildEnv,
    terminateDescendants: true,
    timeoutMs: 900_000,
  });
  await assertOnlyAlternateProductionChange(worktreePath);

  const path = join(worktreePath, "station", "dist", "bin", "stn");
  await access(path, constants.X_OK);
  const help = await run(path, ["--help"], { env: buildEnv });
  assertIncludes(help.stdout, alternateBuildMarker, "alternate binary production-source delta");
  return path;
}

async function assertOnlyAlternateProductionChange(worktreePath) {
  const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: worktreePath,
  });
  assertEqual(
    status.stdout.trim(),
    `M ${alternateProductionSource}`,
    "alternate artifact production-source delta",
  );
}

async function queryBinaryObserverVersion({ binaryPath, expectedVersion, root, label }) {
  const homeDir = join(root, "home");
  const stateDir = join(root, "state");
  const runtimeDir = join(root, "runtime");
  const socketPath = join(runtimeDir, "observer.sock");
  const configPath = join(root, "config.toml");
  const env = isolatedBinaryEnv({ homeDir, runtimeDir });
  const client = createObserverClient({ socketPath, timeoutMs: 5000 });

  await Promise.all([
    mkdir(join(homeDir, "tmp"), { recursive: true, mode: 0o700 }),
    mkdir(stateDir, { recursive: true, mode: 0o700 }),
    mkdir(runtimeDir, { recursive: true, mode: 0o700 }),
  ]);
  await writeSmokeConfig(configPath, stateDir, socketPath);
  try {
    const version = await run(binaryPath, ["--version"], { env });
    assertEqual(version.stdout.trim(), expectedVersion, `${label} display version`);
    const startup = await runObserverStart(
      binaryPath,
      ["--config", configPath, "observer", "start", "--timeout-ms", "30000"],
      { client, env, socketPath },
    );
    const health = startup.health;
    assertEqual(health.status, "healthy", `${label} health`);
    if (health.version === undefined) {
      fail(`${label} did not publish an exact build selector`);
    }
    return health.version;
  } finally {
    await client.stop().catch(() => undefined);
    await waitForMissing(socketPath).catch(() => undefined);
  }
}

function orderSameVersionBuilds(builds, expectedVersion) {
  const identified = builds.map((build) => {
    if (build.binaryPath === undefined || build.observerVersion === undefined) {
      fail(`${build.label} binary did not produce complete build evidence`);
    }
    const parsed = parseStationObserverBuildVersion(build.observerVersion);
    assertEqual(parsed.version, expectedVersion, `${build.label} Observer display version`);
    if (parsed.buildIdentity === undefined) {
      fail(`${build.label} Observer did not publish immutable build identity`);
    }
    return { ...build, buildIdentity: parsed.buildIdentity };
  });
  if (identified[0]?.buildIdentity === identified[1]?.buildIdentity) {
    fail("independently built artifacts unexpectedly published the same build identity");
  }
  return identified.sort((left, right) =>
    left.buildIdentity < right.buildIdentity
      ? -1
      : left.buildIdentity > right.buildIdentity
        ? 1
        : 0,
  );
}

async function removeTemporaryWorktree(worktreePath) {
  await Promise.all([
    rm(join(worktreePath, "node_modules"), { recursive: true, force: true }),
    rm(join(worktreePath, "station", "node_modules"), { recursive: true, force: true }),
  ]);
  try {
    await runGit(["worktree", "remove", "--force", "--force", worktreePath], {
      timeoutMs: 300_000,
    });
  } catch {
    await rm(worktreePath, { recursive: true, force: true });
    await runGit(["worktree", "prune", "--expire", "now"], { timeoutMs: 300_000 });
  }
}

function runGit(args, options = {}) {
  return run("git", ["-C", options.cwd ?? repoRoot, ...args], {
    ...options,
    env: environmentWithoutGitLocals(options.env ?? process.env),
  });
}

function environmentWithoutGitLocals(source) {
  const env = { ...source };
  for (const key of [
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
  ]) {
    delete env[key];
  }
  return env;
}

function parseExpectedVersion(args) {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.length === 0) {
    return packageVersion;
  }
  if (
    normalized.length === 2 &&
    normalized[0] === "--expected-version" &&
    normalized[1]?.length > 0
  ) {
    return normalized[1];
  }
  throw new Error("Usage: run-binary-smoke.mjs --expected-version <version>");
}

function isolatedBinaryEnv({ homeDir: home, runtimeDir: runtime }) {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_RUNTIME_DIR: runtime,
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/sh",
    LANG: "C",
    TERM: "xterm-256color",
    TMPDIR: join(home, "tmp"),
    STATION_RUNTIME_OWNER_FOREGROUND: "1",
  };
}

async function verifyMixedBuildStationUiAdmission(input) {
  await waitForStableObserverReconcile(input.observerClient, 300, 10_000);
  const baselineReason = "binary-smoke-ui-build-admission-baseline";
  await input.observerClient.reconcile(baselineReason);
  const observerHealth = await waitForObserverLastReconcile(
    input.observerClient,
    baselineReason,
    5_000,
  );
  const observerIdentity = stableObserverIdentity(observerHealth);
  assertEqual(
    observerIdentity.version,
    input.sourceObserverVersion,
    "UI admission baseline Observer selector",
  );
  assertEqual(
    observerIdentity.socketPath,
    input.socketPath,
    "UI admission baseline Observer socket",
  );
  assertEqual(
    observerIdentity.stateDir,
    input.stateDir,
    "UI admission baseline Observer state directory",
  );

  const pidfilePath = `${input.socketPath}.pid`;
  const observerSocket = await socketState(input.socketPath);
  const observerPidfile = await observerPidfileState(pidfilePath);
  const commandCount = readCommandCount(join(input.stateDir, "observer.sqlite"));
  const hostHealth = await input.hostClient.health();
  const hostList = await input.hostClient.list();
  const hostSocket = await socketState(input.hostSocketPath);
  const hostPid = input.hostProcess.pid;
  assertEqual(processIsAlive(hostPid), true, "UI admission baseline Host process");
  const livePty = hostList.find((entry) => entry.ptyId === input.spawned.ptyId);
  assertEqual(livePty?.alive, true, "UI admission baseline live PTY");
  const ptyPid = livePty?.pid;
  if (ptyPid === undefined) {
    fail("UI admission baseline PTY did not report its child PID");
  }
  assertEqual(processIsAlive(ptyPid), true, "UI admission baseline PTY child");
  const layoutPath = join(input.childEnv.XDG_STATE_HOME, "station", "station", "layout.json");
  const layout = await optionalFileState(layoutPath);
  const tmuxState = await readFakeTmuxState(input.fakeTmuxStatePath);

  const popupRendererCanary = join(input.root, "lower-build-popup-renderer-started");
  const refusedPopup = await run(input.binaryPath, ["--config", input.popupConfigPath, "popup"], {
    env: {
      ...input.popupEnv,
      STATION_DASHBOARD_COMMAND: `/usr/bin/touch ${quoteShellWord(popupRendererCanary)}`,
    },
    allowedExitCodes: [1],
    timeoutMs: 5_000,
    terminateDescendants: true,
  });
  assertUiBuildAdmissionRefusal(
    refusedPopup.stderr,
    input.compiledObserverVersion,
    input.sourceObserverVersion,
    "lower-build public popup",
  );
  assertEqual(
    await pathExists(popupRendererCanary),
    false,
    "lower-build public popup renderer canary",
  );
  assertDeepEqual(
    await readFakeTmuxState(input.fakeTmuxStatePath),
    tmuxState,
    "lower-build public popup tmux state",
  );

  const nativeRendererCanary = join(input.root, "lower-build-native-renderer-started");
  const refusedNative = await run(input.binaryPath, ["--config", input.configPath, "tui"], {
    env: {
      ...input.childEnv,
      STATION_DASHBOARD_COMMAND: `/usr/bin/touch ${quoteShellWord(nativeRendererCanary)}`,
    },
    allowedExitCodes: [1],
    timeoutMs: 5_000,
    terminateDescendants: true,
  });
  assertUiBuildAdmissionRefusal(
    refusedNative.stderr,
    input.compiledObserverVersion,
    input.sourceObserverVersion,
    "lower-build native",
  );
  assertEqual(await pathExists(nativeRendererCanary), false, "lower-build native renderer canary");

  await delay(350);
  const healthAfterRefusal = await input.observerClient.health();
  assertDeepEqual(
    stableObserverIdentity(healthAfterRefusal),
    observerIdentity,
    "UI refusal preserves Observer identity",
  );
  assertDeepEqual(
    healthAfterRefusal.lastReconcile,
    observerHealth.lastReconcile,
    "UI refusal preserves explicit reconcile baseline",
  );
  assertEqual(
    healthAfterRefusal.lastReconcile?.reason,
    baselineReason,
    "UI refusal schedules no popup-open or tui-startup reconcile",
  );
  assertDeepEqual(
    await socketState(input.socketPath),
    observerSocket,
    "UI refusal preserves Observer socket identity and holders",
  );
  assertDeepEqual(
    await observerPidfileState(pidfilePath),
    observerPidfile,
    "UI refusal preserves Observer pidfile",
  );
  assertEqual(
    readCommandCount(join(input.stateDir, "observer.sqlite")),
    commandCount,
    "UI refusal records no Observer command",
  );
  assertEqual(processIsAlive(hostPid), true, "UI refusal preserves Host process");
  assertDeepEqual(await input.hostClient.health(), hostHealth, "UI refusal preserves Host health");
  assertDeepEqual(
    await socketState(input.hostSocketPath),
    hostSocket,
    "UI refusal preserves Host socket identity and holders",
  );
  assertDeepEqual(
    await input.hostClient.list(),
    hostList,
    "UI refusal preserves complete Host PTY inventory",
  );
  assertDeepEqual(
    await optionalFileState(layoutPath),
    layout,
    "UI refusal preserves Station layout",
  );
  assertDeepEqual(
    await readFakeTmuxState(input.fakeTmuxStatePath),
    tmuxState,
    "UI refusal preserves final tmux state",
  );
  assertEqual(processIsAlive(ptyPid), true, "UI refusal preserves PTY child");
  for (const rendererPid of tmuxState.rendererPids) {
    assertEqual(processIsAlive(rendererPid), true, "UI refusal preserves existing popup renderer");
  }
}

function assertUiBuildAdmissionRefusal(stderr, callerSelector, observerSelector, label) {
  assertIncludes(stderr, "TUI_OBSERVER_BUILD_MISMATCH", `${label} refusal code`);
  assertIncludes(stderr, callerSelector, `${label} caller selector`);
  assertIncludes(stderr, observerSelector, `${label} Observer selector`);
}

async function verifyCompiledInaccessibleObserver(input) {
  const pidfilePath = `${input.socketPath}.pid`;
  const spoolDir = join(input.stateDir, "spool", "hooks");
  const observerLogPath = join(input.stateDir, "logs", "observer.jsonl");
  const socketBefore = fileIdentity(await lstat(input.socketPath));
  const pidfileBefore = fileIdentity(await lstat(pidfilePath));
  const pidfileBytes = await readFile(pidfilePath);
  const pidfileHash = sha256(pidfileBytes);
  const holdersBefore = readUnixSocketHolderPids(input.socketPath);
  const processesBefore = await observerProcessInventory(input.socketPath);
  const observerLogBefore = await readFile(observerLogPath, "utf8");
  const spoolDepthBefore = await directoryFileCount(spoolDir);
  assertEqual(spoolDepthBefore, 0, "compiled inaccessible precondition spool depth");

  await chmod(input.socketPath, 0o000);
  try {
    const status = await run(
      input.binaryPath,
      ["--config", input.configPath, "observer", "status"],
      { env: input.childEnv },
    );
    assertEqual(
      JSON.parse(status.stdout).error?.code,
      "OBSERVER_SOCKET_INACCESSIBLE",
      "compiled inaccessible status code",
    );
    for (const action of ["start", "restart"]) {
      const result = await run(
        input.binaryPath,
        ["--config", input.configPath, "observer", action],
        { env: input.childEnv, allowedExitCodes: [1] },
      );
      assertEqual(
        JSON.parse(result.stdout).error?.code,
        "OBSERVER_SOCKET_INACCESSIBLE",
        `compiled inaccessible ${action} code`,
      );
    }
    const doctor = await run(input.binaryPath, ["--config", input.configPath, "doctor"], {
      env: input.childEnv,
      allowedExitCodes: [1],
    });
    assertIncludes(
      `${doctor.stdout}${doctor.stderr}`,
      "OBSERVER_SOCKET_INACCESSIBLE",
      "compiled inaccessible doctor code",
    );

    const branch = "station/binary-inaccessible-socket";
    const ingress = await run(
      join(dirname(input.binaryPath), "stn-ingress"),
      ["--socket", input.socketPath, "--state-dir", input.stateDir, "worktrunk", "post-create"],
      { env: input.childEnv, input: JSON.stringify({ branch }) },
    );
    assertEqual(ingress.code, 0, "compiled inaccessible ingress acceptance");

    await delay(7000);
    assertEqual(processIsAlive(input.observerPid), true, "compiled inaccessible original process");
    assertDeepEqual(
      fileIdentity(await lstat(input.socketPath)),
      socketBefore,
      "compiled inaccessible socket identity",
    );
    assertDeepEqual(
      fileIdentity(await lstat(pidfilePath)),
      pidfileBefore,
      "compiled inaccessible pidfile identity",
    );
    assertEqual(
      sha256(await readFile(pidfilePath)),
      pidfileHash,
      "compiled inaccessible pidfile hash",
    );
    assertDeepEqual(
      readUnixSocketHolderPids(input.socketPath),
      holdersBefore,
      "compiled inaccessible holder set",
    );
    assertDeepEqual(
      await observerProcessInventory(input.socketPath),
      processesBefore,
      "compiled inaccessible process inventory",
    );
    assertEqual(
      await readFile(observerLogPath, "utf8"),
      observerLogBefore,
      "compiled inaccessible observer log position",
    );
    assertEqual(
      await directoryFileCount(spoolDir),
      spoolDepthBefore + 1,
      "compiled inaccessible single spool record",
    );
    const spoolFiles = await readdir(spoolDir);
    const spoolRecord = JSON.parse(await readFile(join(spoolDir, spoolFiles[0]), "utf8"));
    assertEqual(spoolRecord.event.payload.branch, branch, "compiled inaccessible spool payload");
    assertEqual(
      spoolRecord.lastError?.code,
      "OBSERVER_SOCKET_INACCESSIBLE",
      "compiled inaccessible spool error",
    );
  } finally {
    await chmod(input.socketPath, 0o600);
  }

  const restoredStatus = await run(
    input.binaryPath,
    ["--config", input.configPath, "observer", "status"],
    { env: input.childEnv },
  );
  assertEqual(
    parseSmokeJson(restoredStatus.stdout, "compiled restored observer status").health?.pid,
    input.observerPid,
    "compiled restored observer identity",
  );
  const restoredDoctor = await run(input.binaryPath, ["--config", input.configPath, "doctor"], {
    env: input.childEnv,
  });
  assertEqual(restoredDoctor.code, 0, "compiled restored doctor");
  await run(
    input.binaryPath,
    ["--config", input.configPath, "reconcile", "--reason", "binary-smoke"],
    {
      env: input.childEnv,
    },
  );
  await waitForDirectoryFileCount(spoolDir, 0);
  assertEqual(
    (await input.observerClient.health()).pid,
    input.observerPid,
    "compiled restored original observer",
  );
}

function fileIdentity(stats) {
  return { device: stats.dev, inode: stats.ino, birthtimeMs: stats.birthtimeMs };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableObserverIdentity(health) {
  return {
    pid: health.pid,
    startedAt: health.startedAt,
    version: health.version,
    socketPath: health.socketPath,
    stateDir: health.stateDir,
  };
}

async function socketState(path) {
  const stats = await lstat(path);
  assertEqual(stats.isSocket(), true, `socket type at ${path}`);
  return {
    identity: fileIdentity(stats),
    holders: readUnixSocketHolderPids(path),
  };
}

async function observerPidfileState(path) {
  const bytes = await readFile(path);
  const identityText = bytes.toString("utf8");
  let identityJson;
  try {
    identityJson = JSON.parse(identityText);
  } catch (cause) {
    throw new Error(`Failed to parse Observer pidfile at ${path}`, { cause });
  }
  return {
    identity: fileIdentity(await lstat(path)),
    hash: sha256(bytes),
    process: ObserverProcessIdentitySchema.parse(identityJson),
  };
}

async function optionalFileState(path) {
  try {
    const stats = await lstat(path);
    return {
      status: "present",
      identity: fileIdentity(stats),
      hash: sha256(await readFile(path)),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }
}

async function observerProcessInventory(socketPath) {
  const psPath = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
  const result = await run(psPath, ["-axo", "pid=,command="]);
  return result.stdout
    .split("\n")
    .filter((line) => line.includes(socketPath))
    .map((line) => line.trim())
    .sort();
}

async function waitForDirectoryFileCount(directory, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await directoryFileCount(directory)) === expected) return;
    await delay(25);
  }
  fail(`directory file count did not reach ${expected}: ${directory}`);
}

async function verifyCompiledGitFailure({ binaryPath, installedRoot, root }) {
  const homeDir = join(root, "home");
  const runtimeDir = join(root, "runtime");
  const stateDir = join(root, "state");
  const cwd = join(root, "outside-repository");
  const fakeBin = join(root, "fake-bin");
  const configPath = join(root, "config.toml");
  await Promise.all(
    [homeDir, join(homeDir, "tmp"), runtimeDir, stateDir, cwd, fakeBin].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  await Promise.all([
    writeFile(
      join(fakeBin, "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = --version ]; then',
        "  echo 'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun' >&2",
        "  exit 1",
        "fi",
        "echo 'unexpected repository probe after failed git --version' >&2",
        "exit 97",
        "",
      ].join("\n"),
      { mode: 0o700 },
    ),
    writeFile(join(fakeBin, "wt"), "#!/bin/sh\necho 'worktrunk 1.2.3'\n", { mode: 0o700 }),
    writeFile(join(fakeBin, "tmux"), "#!/bin/sh\necho 'tmux 3.5a'\n", { mode: 0o700 }),
    writeFile(join(fakeBin, "hunk"), "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
    writeFile(join(fakeBin, "pi"), "#!/bin/sh\necho 'pi 0.80.10'\n", { mode: 0o700 }),
    writeFile(
      configPath,
      [
        "schema_version = 1",
        "projects = []",
        "",
        "[observer]",
        `state_dir = ${JSON.stringify(stateDir)}`,
        "",
        "[defaults]",
        'worktree_provider = "worktrunk"',
        'terminal = "tmux"',
        'harness = "pi"',
        'layout = "agent-shell"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    ),
  ]);

  const env = {
    ...isolatedBinaryEnv({ homeDir, runtimeDir }),
    PATH: `${fakeBin}:${installedRoot}:/usr/bin:/bin`,
  };
  const result = await run(
    binaryPath,
    ["--config", configPath, "setup", "check", "--json", "--no-brew"],
    { cwd, env, allowedExitCodes: [1] },
  );
  const plan = parseSmokeJson(result.stdout, "compiled Git canary setup plan");
  const requiredFailures = plan.checks.filter(
    (check) => check.tier === "required" && check.status === "missing",
  );
  const gitCheck = plan.checks.find((check) => check.id === "git-project");

  assertEqual(result.code, 1, "compiled Git canary exit code");
  assertEqual(gitCheck?.status, "missing", "compiled Git canary git-project status");
  assertEqual(gitCheck?.details?.reason, "git-unusable", "compiled Git canary reason");
  assertIncludes(
    gitCheck?.message ?? "",
    "Git is installed but unusable.",
    "compiled Git canary unusable message",
  );
  assertIncludes(gitCheck?.message ?? "", "xcode-select --install", "compiled Git remediation");
  assertEqual(requiredFailures.length, 1, "compiled Git canary required failure count");
  assertEqual(plan.summary.requiredMissing, 1, "compiled Git canary requiredMissing");
  assertEqual(plan.summary.workflowReady, false, "compiled Git canary workflowReady");
  assertEqual(plan.summary.requiredOk, false, "compiled Git canary requiredOk");
  assertEqual(plan.summary.launchReady, true, "compiled Git canary launchReady");
  assertEqual(
    plan.checks.some((check) => check.id === "command-line-tools"),
    false,
    "compiled Git canary omits Command Line Tools",
  );
}

async function verifyCompiledSetupApplyLauncherWarning({ binaryPath, installedRoot, root }) {
  const homeDir = join(root, "home");
  const runtimeDir = join(root, "runtime");
  const stateDir = join(root, "state");
  const cwd = join(root, "outside-repository");
  const fakeBin = join(root, "fake-bin");
  const configPath = join(root, "config.toml");
  await Promise.all(
    [homeDir, join(homeDir, "tmp"), runtimeDir, stateDir, cwd, fakeBin].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  await Promise.all([
    writeFile(
      join(fakeBin, "wt"),
      "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'worktrunk 1.2.3'; exit 0; fi\nexit 1\n",
      { mode: 0o700 },
    ),
    writeFile(
      join(fakeBin, "tmux"),
      "#!/bin/sh\nif [ \"$1\" = -V ]; then echo 'tmux 3.5a'; exit 0; fi\nexit 1\n",
      { mode: 0o700 },
    ),
    writeFile(join(fakeBin, "hunk"), "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
    writeFile(join(fakeBin, "pi"), "#!/bin/sh\necho 'pi 0.80.10'\n", { mode: 0o700 }),
    writeFile(
      configPath,
      [
        "schema_version = 1",
        "projects = []",
        "",
        "[observer]",
        `state_dir = ${JSON.stringify(stateDir)}`,
        `socket_path = ${JSON.stringify(join(runtimeDir, "observer.sock"))}`,
        "",
        "[defaults]",
        'worktree_provider = "worktrunk"',
        'terminal = "tmux"',
        'harness = "pi"',
        'layout = "agent-shell"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    ),
  ]);

  const env = {
    ...isolatedBinaryEnv({ homeDir, runtimeDir }),
    PATH: `${fakeBin}:/usr/bin:/bin`,
  };
  const result = await run(
    binaryPath,
    ["--config", configPath, "setup", "apply", "--yes", "--no-brew"],
    { cwd, env },
  );
  const stationLauncher = join(installedRoot, "stn");

  assertEqual(result.code, 0, "compiled successful setup apply exit code");
  assertIncludes(result.stdout, "Core setup complete.", "compiled setup apply completion");
  assertIncludes(result.stdout, "Remaining", "compiled setup apply remaining section");
  assertIncludes(
    result.stdout,
    `PATH=${quoteShellWord(installedRoot)}\${PATH:+":$PATH"}`,
    "compiled setup apply current-shell PATH recovery",
  );
  assertIncludes(
    result.stdout,
    `  ${quoteShellWord(stationLauncher)} doctor`,
    "compiled setup apply absolute doctor command",
  );
  assertIncludes(
    result.stdout,
    `  ${quoteShellWord(stationLauncher)}\n`,
    "compiled setup apply absolute launch command",
  );
  assertIncludes(
    result.stdout,
    "Use stn instead of the absolute path (optional):",
    "compiled setup apply optional bare launcher guidance",
  );
  assertIncludes(
    result.stdout,
    `For future shells, add ${quoteShellWord(installedRoot)} to PATH in a shell configuration you choose.`,
    "compiled setup apply future-shell PATH guidance",
  );
  assertIncludes(
    result.stdout,
    "Use PATH rather than an alias so all three STATION launcher names resolve together.",
    "compiled setup apply PATH over alias guidance",
  );
  assertIncludes(
    result.stdout,
    "command -v stn-tmux-popup",
    "compiled setup apply all-launcher verification",
  );
  assertIncludes(
    result.stdout,
    "Future login shell launcher resolution remains unverified",
    "compiled setup apply future-shell status",
  );
  assertExcludes(result.stdout, "\n  stn doctor\n", "compiled setup apply bare doctor command");
  assertExcludes(result.stdout, "\n  stn\n", "compiled setup apply bare launch command");
  assertExcludes(result.stdout, "station:link", "compiled setup apply checkout link command");
}

async function writeWorktrunkHookSmokeConfig(path, state, socket, worktrunkConfigPath) {
  await writeFile(
    path,
    [
      "schema_version = 1",
      "projects = []",
      "",
      "[observer]",
      `state_dir = ${JSON.stringify(state)}`,
      `socket_path = ${JSON.stringify(socket)}`,
      "",
      "[defaults]",
      'worktree_provider = "worktrunk"',
      'terminal = "noop-terminal"',
      'harness = "noop-harness"',
      'layout = "agent-shell"',
      "",
      "[worktree.worktrunk]",
      'command = "/usr/bin/true"',
      `config_path = ${JSON.stringify(worktrunkConfigPath)}`,
      "use_lifecycle_hooks = true",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

async function writeCodexHookSmokeConfig(path, state, socket) {
  await writeFile(
    path,
    [
      "schema_version = 1",
      "projects = []",
      "",
      "[observer]",
      `state_dir = ${JSON.stringify(state)}`,
      `socket_path = ${JSON.stringify(socket)}`,
      "",
      "[defaults]",
      'worktree_provider = "noop-worktree"',
      'terminal = "noop-terminal"',
      'harness = "codex"',
      'layout = "agent-shell"',
      "",
      "[harness.codex]",
      'command = "/usr/bin/true"',
      "install_hooks = true",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

async function writeOpenCodeHookSmokeConfig(path, state, socket) {
  await writeFile(
    path,
    [
      "schema_version = 1",
      "projects = []",
      "",
      "[observer]",
      `state_dir = ${JSON.stringify(state)}`,
      `socket_path = ${JSON.stringify(socket)}`,
      "",
      "[defaults]",
      'worktree_provider = "noop-worktree"',
      'terminal = "noop-terminal"',
      'harness = "opencode"',
      'layout = "agent-shell"',
      "",
      "[harness.opencode]",
      'command = "/usr/bin/true"',
      "install_hooks = true",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

async function writeSmokeConfig(path, state, socket, terminal = "noop-terminal") {
  await writeFile(
    path,
    [
      "schema_version = 1",
      "projects = []",
      "",
      "[observer]",
      `state_dir = ${JSON.stringify(state)}`,
      `socket_path = ${JSON.stringify(socket)}`,
      "",
      "[defaults]",
      'worktree_provider = "noop-worktree"',
      `terminal = ${JSON.stringify(terminal)}`,
      'harness = "noop-harness"',
      'layout = "agent-shell"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

async function writeHostileConfig(directory, marker) {
  await writeFile(
    join(directory, ".env"),
    [
      "STATION_PTY_IMPL=ambient-config-must-not-load",
      `STATION_DASHBOARD_COMMAND=touch ${marker}`,
    ].join("\n"),
  );
  await writeFile(join(directory, "bunfig.toml"), '[run]\npreload = ["./preload.mjs"]\n');
  await writeFile(
    join(directory, "preload.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "pwned");\n`,
  );
}

async function assertExactBinaryAlias(installedRoot, name) {
  const path = join(installedRoot, name);
  const stat = await lstat(path);
  assertEqual(stat.isSymbolicLink(), true, `${name} exact symlink`);
  assertEqual(await readlink(path), "stn", `${name} exact symlink target`);
  assertEqual(await realpath(path), join(installedRoot, "stn"), `${name} binary identity`);
}

function requiredSetupAction(plan, id) {
  const action = plan.actions?.find((candidate) => candidate.id === id);
  if (action === undefined) {
    fail(`compiled setup did not offer ${id}`);
  }
  return action;
}

async function runManagedPopupBinding(command, env, fakeTmuxStatePath) {
  const expandedCommand = command
    .replaceAll("#{q:client_name}", env.FAKE_TMUX_CLIENT_NAME)
    .replaceAll("#{client_pid}", env.FAKE_TMUX_CLIENT_PID)
    .replaceAll("#{q:client_session}", env.FAKE_TMUX_CLIENT_SESSION);
  const result = await run("/bin/sh", ["-c", expandedCommand], {
    env,
    allowedExitCodes: Array.from({ length: 256 }, (_, code) => code),
  });
  if (result.code !== 0) {
    const state = await readFakeTmuxState(fakeTmuxStatePath);
    state.paneInMode = 1;
    state.paneContent += `returned ${result.code}\n${expandedCommand}\n`;
    await writeFakeTmuxState(fakeTmuxStatePath, state);
  }
  return result;
}

function assertSilentHandledBinding(result, label) {
  if (result.code !== 0) {
    fail(
      `${label} status: expected 0, received ${result.code}; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  assertEqual(result.stdout, "", `${label} stdout`);
  assertEqual(result.stderr, "", `${label} stderr`);
}

function requiredFakeTmuxSession(state, sessionName) {
  const session = state.sessions[sessionName];
  if (session === undefined || !Number.isInteger(session.rendererPid)) {
    fail(`fake tmux session ${sessionName} was not created with a renderer process`);
  }
  return session;
}

function assertActivePopupMarkersCleared(state, label) {
  for (const optionName of [
    "@station_popup_active_claim",
    "@station_popup_client",
    "@station_popup_focus_client",
  ]) {
    assertEqual(state.serverOptions[optionName], undefined, `${label} ${optionName}`);
  }
}

function initialFakeTmuxState() {
  return {
    bindings: {},
    commandLog: [],
    paneContent: "",
    paneInMode: 0,
    popups: {},
    rendererPids: [],
    rendererStarts: 0,
    serverOptions: {},
    sessions: {},
    statusMessages: [],
    tmuxProcessCount: 0,
  };
}

async function writeFakeTmux(path, statePath) {
  await writeFakeTmuxState(statePath, initialFakeTmuxState());
  const runnerPath = fileURLToPath(import.meta.url);
  await writeFile(
    path,
    [
      "#!/bin/sh",
      "export STATION_BINARY_SMOKE_FAKE_TMUX=1",
      `export FAKE_TMUX_STATE_PATH=${quoteShellWord(statePath)}`,
      `exec ${quoteShellWord(process.execPath)} ${quoteShellWord(runnerPath)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
}

async function readFakeTmuxState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse fake tmux state at ${path}.`, { cause: error });
  }
}

async function writeFakeTmuxState(path, state) {
  await writeFile(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

async function runFakeTmuxProcess(args) {
  const statePath = process.env.FAKE_TMUX_STATE_PATH;
  if (statePath === undefined) {
    process.stderr.write("fake tmux state path is missing\n");
    process.exitCode = 2;
    return;
  }
  const state = await readFakeTmuxState(statePath);
  state.tmuxProcessCount += 1;
  state.commandLog.push(args);
  const result = await executeFakeTmuxCommand(state, args);
  await writeFakeTmuxState(statePath, state);
  if (result.stdout !== undefined) process.stdout.write(result.stdout);
  if (result.stderr !== undefined) process.stderr.write(result.stderr);
  process.exitCode = result.status;
}

async function executeFakeTmuxCommand(state, args) {
  const [command] = args;
  switch (command) {
    case "-V":
      return fakeTmuxResult(0, "tmux 3.5a\n");
    case "bind-key":
      return bindFakeTmuxKey(state, args);
    case "display-message":
      return displayFakeTmuxMessage(state, args);
    case "display-popup":
      return displayFakeTmuxPopup(state, args);
    case "has-session":
      return hasFakeTmuxSession(state, args);
    case "if-shell":
      return executeFakeTmuxIfShell(state, args);
    case "kill-session":
      return killFakeTmuxSession(state, args);
    case "list-panes":
      return fakeTmuxResult(0, "");
    case "list-keys":
      return listFakeTmuxKeys(state);
    case "new-session":
      return createFakeTmuxSession(state, args);
    case "set-option":
      return setFakeTmuxOption(state, args);
    case "show-options":
      return showFakeTmuxOption(state, args);
    case "source-file":
      return sourceFakeTmuxFile(state, args);
    default:
      return fakeTmuxResult(1, undefined, `unsupported fake tmux command: ${args.join(" ")}\n`);
  }
}

function fakeTmuxResult(status, stdout, stderr, blocked = false) {
  return { status, stdout, stderr, blocked };
}

function bindFakeTmuxKey(state, args) {
  const key = args[1];
  if (key === undefined) return fakeTmuxResult(1);
  state.bindings[key] = args.slice(2);
  return fakeTmuxResult(0);
}

function listFakeTmuxKeys(state) {
  const lines = Object.entries(state.bindings).map(
    ([key, args]) => `bind-key -T prefix ${key} ${args.join(" ")}`,
  );
  return fakeTmuxResult(0, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

async function sourceFakeTmuxFile(state, args) {
  const path = args[1];
  if (path === undefined) return fakeTmuxResult(1);
  const source = await readFile(path, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const words = splitFakeTmuxWords(trimmed);
    if (words[0] !== "bind-key") {
      return fakeTmuxResult(1, undefined, `unsupported fake tmux config: ${trimmed}\n`);
    }
    const result = bindFakeTmuxKey(state, words);
    if (result.status !== 0) return result;
  }
  return fakeTmuxResult(0);
}

function fakeTmuxClient() {
  return {
    name: process.env.FAKE_TMUX_CLIENT_NAME ?? "/dev/ttys901",
    pid: process.env.FAKE_TMUX_CLIENT_PID ?? "41001",
    sessionName: process.env.FAKE_TMUX_CLIENT_SESSION ?? "binary-smoke",
  };
}

function displayFakeTmuxMessage(state, args) {
  if (args.includes("-d")) {
    state.statusMessages.push(args.at(-1) ?? "");
    return fakeTmuxResult(0);
  }
  if (!args.includes("-p")) return fakeTmuxResult(0);

  const target = optionValue(args, "-t");
  const format = args.at(-1) ?? "";
  const client = fakeTmuxClient();
  if (target !== undefined && format.includes("@station_popup_ui_route")) {
    const sessionName = normalizeFakeTmuxSessionName(target);
    const session = state.sessions[sessionName];
    if (session === undefined) return fakeTmuxResult(1);
    const fields = [
      state.serverOptions["@station_popup_ui_route"],
      session.options["@station_popup_ui_lease"],
      state.serverOptions["@station_popup_active_claim"],
      session.options["@station_popup_ui_signature"],
      state.serverOptions["@station_popup_ui_session_name"],
      state.serverOptions["@station_popup_ui_expected_signature"],
      state.serverOptions["@station_popup_ui_root"],
      state.serverOptions["@station_popup_client"],
      state.serverOptions["@station_popup_focus_client"],
      state.serverOptions["@station_tui_dev_session_name"],
      state.serverOptions["@station_tui_dev_command"],
      state.serverOptions["@station_tui_dev_owner"],
      state.serverOptions["@station_tui_dev_root"],
      "v1",
    ].map((value) => value ?? "");
    return fakeTmuxResult(0, `${fields.join("\u001f")}\n`);
  }
  if (format === "#{client_name}") return fakeTmuxResult(0, `${client.name}\n`);
  if (format === "#{client_pid}") return fakeTmuxResult(0, `${client.pid}\n`);
  if (format === "#{client_session}") return fakeTmuxResult(0, `${client.sessionName}\n`);
  if (format.includes("\t")) {
    return fakeTmuxResult(0, `${client.pid}\t${client.name}\t${client.sessionName}\n`);
  }
  return fakeTmuxResult(0, `${format}\n`);
}

function hasFakeTmuxSession(state, args) {
  const sessionName = normalizeFakeTmuxSessionName(optionValue(args, "-t") ?? "");
  return fakeTmuxResult(state.sessions[sessionName] === undefined ? 1 : 0);
}

function createFakeTmuxSession(state, args) {
  const sessionName = normalizeFakeTmuxSessionName(optionValue(args, "-s") ?? "");
  if (sessionName.length === 0) return fakeTmuxResult(1);
  if (state.sessions[sessionName] !== undefined) return fakeTmuxResult(1);
  const renderer = spawn("/bin/sleep", ["2147483647"], {
    detached: process.env.STATION_RUNTIME_OWNER_FOREGROUND !== "1",
    stdio: "ignore",
  });
  renderer.unref();
  state.rendererStarts += 1;
  state.rendererPids.push(renderer.pid);
  state.sessions[sessionName] = {
    command: args.at(-1) ?? "",
    options: {},
    rendererPid: renderer.pid,
  };
  return fakeTmuxResult(0);
}

function killFakeTmuxSession(state, args) {
  const sessionName = normalizeFakeTmuxSessionName(optionValue(args, "-t") ?? "");
  const session = state.sessions[sessionName];
  if (session === undefined) return fakeTmuxResult(1);
  delete state.sessions[sessionName];
  return fakeTmuxResult(0);
}

function showFakeTmuxOption(state, args) {
  const target = optionValue(args, "-t");
  const optionName = args.at(-1);
  if (optionName === undefined) return fakeTmuxResult(1);
  const source =
    target === undefined
      ? state.serverOptions
      : state.sessions[normalizeFakeTmuxSessionName(target)]?.options;
  if (source === undefined) return fakeTmuxResult(1);
  const value = source[optionName];
  return fakeTmuxResult(0, value === undefined ? "" : `${value}\n`);
}

function setFakeTmuxOption(state, args) {
  let target;
  let global = false;
  let unset = false;
  let optionName;
  let value;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-t") {
      target = args[index + 1];
      index += 1;
      continue;
    }
    if (arg?.startsWith("-")) {
      global ||= arg.includes("g");
      unset ||= arg.includes("u");
      continue;
    }
    if (optionName === undefined) optionName = arg;
    else if (value === undefined) value = arg;
  }
  if (optionName === undefined) return fakeTmuxResult(1);
  const source = global
    ? state.serverOptions
    : state.sessions[normalizeFakeTmuxSessionName(target ?? "")]?.options;
  if (source === undefined) return fakeTmuxResult(1);
  if (unset) delete source[optionName];
  else source[optionName] = value ?? "";
  return fakeTmuxResult(0);
}

function displayFakeTmuxPopup(state, args) {
  const client = optionValue(args, "-c") ?? fakeTmuxClient().name;
  if (args.includes("-C")) {
    state.popups[client] = { ...(state.popups[client] ?? {}), open: false };
    return fakeTmuxResult(0);
  }
  if (state.failNextDisplay === true) {
    state.failNextDisplay = false;
    return fakeTmuxResult(1);
  }
  state.popups[client] = {
    command: optionValue(args, "-E") ?? "",
    open: true,
  };
  return fakeTmuxResult(0, undefined, undefined, true);
}

async function executeFakeTmuxIfShell(state, args) {
  let index = 1;
  let target;
  while (index < args.length && args[index]?.startsWith("-")) {
    if (args[index] === "-t") {
      target = args[index + 1];
      index += 2;
    } else {
      index += 1;
    }
  }
  if (target !== undefined && state.sessions[normalizeFakeTmuxSessionName(target)] === undefined) {
    return fakeTmuxResult(1);
  }
  const condition = args[index] ?? "";
  const targetSession =
    target === undefined ? undefined : state.sessions[normalizeFakeTmuxSessionName(target)];
  const selected = fakeTmuxFormatTruthy(evaluateFakeTmuxFormat(state, condition, targetSession))
    ? args[index + 1]
    : args[index + 2];
  if (selected === undefined || selected.length === 0) return fakeTmuxResult(0);
  return executeFakeTmuxCommandList(state, selected);
}

async function executeFakeTmuxCommandList(state, source) {
  let stdout = "";
  for (const command of splitFakeTmuxCommands(source)) {
    const words = splitFakeTmuxWords(command);
    if (words.length === 0) continue;
    const result = await executeFakeTmuxCommand(state, words);
    if (result.stdout !== undefined) stdout += result.stdout;
    if (result.status !== 0 || result.blocked === true) {
      return fakeTmuxResult(result.status, stdout.length === 0 ? undefined : stdout, result.stderr);
    }
  }
  return fakeTmuxResult(0, stdout.length === 0 ? undefined : stdout);
}

function evaluateFakeTmuxFormat(state, expression, targetSession) {
  if (!isWholeFakeTmuxFormat(expression)) return expression;
  const inner = expression.slice(2, -1);
  if (inner.startsWith("==:")) {
    const [left = "", right = ""] = splitFakeTmuxFormatArgs(inner.slice(3));
    return evaluateFakeTmuxFormat(state, left, targetSession) ===
      evaluateFakeTmuxFormat(state, right, targetSession)
      ? "1"
      : "0";
  }
  if (inner.startsWith("&&:")) {
    const [left = "", right = ""] = splitFakeTmuxFormatArgs(inner.slice(3));
    return fakeTmuxFormatTruthy(evaluateFakeTmuxFormat(state, left, targetSession)) &&
      fakeTmuxFormatTruthy(evaluateFakeTmuxFormat(state, right, targetSession))
      ? "1"
      : "0";
  }
  if (inner.startsWith("@")) {
    return state.serverOptions[inner] ?? targetSession?.options[inner] ?? "";
  }
  return "";
}

function isWholeFakeTmuxFormat(value) {
  if (!value.startsWith("#{") || !value.endsWith("}")) return false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith("#{", index)) {
      depth += 1;
      index += 1;
      continue;
    }
    if (value[index] === "}") {
      depth -= 1;
      if (depth === 0 && index !== value.length - 1) return false;
    }
  }
  return depth === 0;
}

function splitFakeTmuxFormatArgs(source) {
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source.startsWith("#{", index)) {
      depth += 1;
      index += 1;
      continue;
    }
    if (source[index] === "}") {
      depth -= 1;
      continue;
    }
    if (source[index] === "," && depth === 0) {
      return [source.slice(0, index), source.slice(index + 1)];
    }
  }
  return [source];
}

function fakeTmuxFormatTruthy(value) {
  return value.length > 0 && value !== "0";
}

function splitFakeTmuxCommands(source) {
  return splitFakeTmuxShell(source, true);
}

function splitFakeTmuxWords(source) {
  return splitFakeTmuxShell(source, false);
}

function splitFakeTmuxShell(source, commands) {
  const result = [];
  let current = "";
  let quote;
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      if (commands) current += character;
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        if (commands) current += character;
        quote = undefined;
      } else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      if (commands) current += character;
      quote = character;
      continue;
    }
    if (commands ? character === ";" : /\s/.test(character)) {
      if (current.length > 0) result.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  if (current.length > 0) result.push(current);
  return result;
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

function normalizeFakeTmuxSessionName(value) {
  return value.endsWith(":") ? value.slice(0, -1) : value;
}

function quoteShellWord(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const cancellationSignal =
      options.deferSmokeCancellation === true ? undefined : (options.signal ?? smokeRunSignal);
    if (cancellationSignal?.aborted === true) {
      reject(runCancelledError(command, args, cancellationSignal));
      return;
    }
    const terminateDescendants =
      options.terminateDescendants === true &&
      process.platform !== "win32" &&
      process.env.STATION_RUNTIME_OWNER_FOREGROUND !== "1";
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: terminateDescendants,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let terminationError;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cancellationSignal?.removeEventListener("abort", onAbort);
      callback();
    };
    const terminate = (error) => {
      if (terminationError !== undefined) return;
      terminationError = error;
      killRunChild(child, terminateDescendants);
    };
    const timeout = setTimeout(() => {
      terminate(
        new SmokeCommandError(`${command} ${args.join(" ")} timed out\n${stderr}`, command, args, {
          type: "unknown",
        }),
      );
    }, options.timeoutMs ?? 30_000);
    const onAbort = () => {
      terminate(runCancelledError(command, args, cancellationSignal));
    };
    cancellationSignal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      finish(() =>
        reject(
          new SmokeCommandError(error.message, command, args, {
            type: "spawn_error",
            message: error.message,
          }),
        ),
      );
    });
    child.once("close", (code, signal) => {
      if (terminationError !== undefined) {
        finish(() => reject(terminationError));
        return;
      }
      const allowed = options.allowedExitCodes ?? [0];
      if (code === null || !allowed.includes(code)) {
        const exitDisposition =
          code !== null
            ? { type: "code", code }
            : signal !== null
              ? { type: "signal", signal }
              : { type: "unknown" };
        finish(() =>
          reject(
            new SmokeCommandError(
              `${command} ${args.join(" ")} exited ${code ?? signal ?? "unknown"}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
              command,
              args,
              exitDisposition,
            ),
          ),
        );
        return;
      }
      finish(() => resolveRun({ code, stdout, stderr }));
    });
    child.stdin.end(options.input);
  });
}

async function runObserverStart(command, args, { client, env, socketPath, timeoutMs = 30_000 }) {
  const cancellationSignal = smokeRunSignal;
  if (cancellationSignal?.aborted === true) {
    throw runCancelledError(command, args, cancellationSignal);
  }
  // Defer cancellation while the command publishes its Observer health so the owner can reap one group.
  const result = await run(command, args, {
    deferSmokeCancellation: true,
    env,
    timeoutMs: timeoutMs + 5_000,
  });
  if (cancellationSignal?.aborted !== true) {
    const health = ObserverHealthSchema.parse(
      parseSmokeJson(result.stdout, `${command} observer start`).health,
    );
    return { ...result, health };
  }

  const health = await client.health().catch(() => undefined);
  if (health !== undefined) {
    await client.stop().catch(() => undefined);
    await waitForMissing(socketPath).catch(() => undefined);
  }
  throw runCancelledError(command, args, cancellationSignal);
}

async function waitForObserverClientHealth(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      return await client.health();
    } catch (error) {
      lastError = error;
    }
    if (smokeRunSignal?.aborted === true) {
      throw smokeRunSignal.reason ?? new SmokeRunCancelledError("Observer health wait cancelled.");
    }
    await delay(25);
  } while (Date.now() < deadline);
  throw lastError ?? new Error("Observer did not become reachable.");
}

async function waitForObserverLastReconcile(client, reason, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const health = await client.health();
    if (health.lastReconcile?.reason === reason) {
      return health;
    }
    if (smokeRunSignal?.aborted === true) {
      throw (
        smokeRunSignal.reason ?? new SmokeRunCancelledError("Observer reconcile wait cancelled.")
      );
    }
    await delay(25);
  } while (Date.now() < deadline);
  fail(`Observer last reconcile did not reach ${reason}.`);
}

async function waitForStableObserverReconcile(client, quietMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previous;
  let unchangedSince = Date.now();
  do {
    const health = await client.health();
    const current =
      health.lastReconcile === undefined ? undefined : JSON.stringify(health.lastReconcile);
    if (current !== undefined && current === previous) {
      if (Date.now() - unchangedSince >= quietMs) {
        return health;
      }
    } else {
      previous = current;
      unchangedSince = Date.now();
    }
    if (smokeRunSignal?.aborted === true) {
      throw (
        smokeRunSignal.reason ?? new SmokeRunCancelledError("Observer reconcile wait cancelled.")
      );
    }
    await delay(25);
  } while (Date.now() < deadline);
  fail("Observer reconcile activity did not settle.");
}

async function runObserverCancellationSelfCheck() {
  const root = await mkdtemp(join(tmpdir(), "station-binary-smoke-cancel-"));
  const pidPath = join(root, "observer.pid");
  const socketPath = join(root, "observer.sock");
  const controller = new AbortController();
  let observerPid;
  smokeRunSignal = controller.signal;
  const cancel = setTimeout(() => controller.abort("SIGINT"), 50);
  const launcher = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
    writeFileSync(${JSON.stringify(socketPath)}, "published");
    setTimeout(() => {}, 150);
  `;
  const client = {
    health: async () => {
      observerPid = Number(await readFile(pidPath, "utf8"));
      return { pid: observerPid };
    },
    stop: async () => {
      if (observerPid !== undefined) signalProcess(observerPid, "SIGTERM");
      await rm(socketPath, { force: true });
    },
  };

  try {
    await runObserverStart(process.execPath, ["-e", launcher], {
      client,
      env: process.env,
      socketPath,
    });
    fail("cancelled observer startup unexpectedly completed");
  } catch (error) {
    assertIncludes(String(error), "was cancelled by SIGINT", "observer startup cancellation");
  } finally {
    clearTimeout(cancel);
    smokeRunSignal = undefined;
    if (observerPid !== undefined) await terminateSelfCheckProcess(observerPid);
    await rm(root, { recursive: true, force: true });
  }
}

async function runOwnedBinarySmokeTopologyTest() {
  const descriptorPath = resolve(
    requiredOwnedEnvironment("STATION_BINARY_SMOKE_OWNERSHIP_TEST_DESCRIPTOR"),
  );
  const termResistant = process.env.STATION_BINARY_SMOKE_OWNERSHIP_TEST_TERM_RESISTANT === "1";
  if (termResistant) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});
  }
  const children = ["observer", "station-host", "popup-renderer"].map((role) =>
    spawn(
      process.execPath,
      [
        "-e",
        [
          `process.title = ${JSON.stringify(`station-${role}-ownership-test`)};`,
          ...(termResistant && role === "popup-renderer"
            ? [
                "process.on('SIGINT', () => {});",
                "process.on('SIGTERM', () => {});",
                "process.on('SIGHUP', () => {});",
              ]
            : []),
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      { stdio: "ignore" },
    ),
  );
  await writeFile(
    descriptorPath,
    `${JSON.stringify({
      root: requiredOwnedEnvironment("STATION_BINARY_SMOKE_ROOT"),
      ownerStateDir: requiredOwnedEnvironment("STATION_BINARY_SMOKE_OWNER_STATE_DIR"),
      runId: requiredOwnedEnvironment("STATION_BINARY_SMOKE_RUN_ID"),
      innerPid: process.pid,
      pids: {
        observer: children[0].pid,
        stationHost: children[1].pid,
        popupRenderer: children[2].pid,
      },
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  if (process.env.STATION_BINARY_SMOKE_OWNERSHIP_TEST_EXIT_IMMEDIATELY === "1") {
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(children.map((child) => waitForExit(child, 3_000)));
    if (process.env.STATION_BINARY_SMOKE_OWNERSHIP_TEST_REPLACE_ROOT === "1") {
      const root = resolve(requiredOwnedEnvironment("STATION_BINARY_SMOKE_ROOT"));
      await rename(root, `${root}-original`);
      await mkdir(root, { mode: 0o700 });
      await writeFile(join(root, "replacement-sentinel"), "preserve\n", { mode: 0o600 });
    }
    return;
  }
  await new Promise(() => {});
}

function installSmokeCancellation() {
  const controller = new AbortController();
  const handleSignal = (signal) => {
    process.exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
    controller.abort(signal);
  };
  const onInterrupt = () => handleSignal("SIGINT");
  const onHangup = () => handleSignal("SIGHUP");
  const onTerminate = () => handleSignal("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGHUP", onHangup);
  process.on("SIGTERM", onTerminate);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGHUP", onHangup);
      process.off("SIGTERM", onTerminate);
    },
  };
}

function killRunChild(child, terminateDescendants) {
  if (terminateDescendants && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The direct child remains the safe fallback if its process group has already exited.
    }
  }
  child.kill("SIGKILL");
}

function runCancelledError(command, args, signal) {
  if (signal.reason instanceof Error) return signal.reason;
  const reason = signal.reason === undefined ? "" : ` by ${String(signal.reason)}`;
  return new SmokeRunCancelledError(`${command} ${args.join(" ")} was cancelled${reason}.`);
}

function collectOutput(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  return () => ({ stdout, stderr });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.off("close", onClose);
      child.off("error", onError);
      reject(new Error(`child did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timeout);
      resolvePromise();
    };
    const onError = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function waitForHost(client, diagnostics) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await client.health();
      return;
    } catch {
      await delay(50);
    }
  }
  const output = diagnostics();
  fail(`compiled station-host did not become healthy\n${output.stdout}\n${output.stderr}`);
}

async function verifyGenericHostEnsureColdStart(input) {
  assertEqual(await pathExists(input.socketPath), false, "generic Host ensure starts absent");
  const envArgs = Object.entries(input.childEnv).map(([key, value]) => `${key}=${value}`);
  const ensured = await ensureStationHostRunning({
    socketPath: input.socketPath,
    stateDir: input.stateDir,
    hostCommand: ["/usr/bin/env", ...envArgs, input.binaryPath, "__station-host"],
    expectedBuildVersion: input.expectedVersion,
    timeoutMs: 10_000,
  });
  if (ensured.status !== "running") throw ensured.error;
  try {
    assertEqual(ensured.ensuredBy, "start", "public generic Host ensure cold start");
    const health = await ensured.client.health();
    assertEqual(health.buildVersion, input.expectedVersion, "generic Host ensure build");
    assertDeepEqual(await ensured.client.list(), [], "generic Host ensure empty registry");
    await ensured.client.stopIfIdle("binary-smoke-cleanup");
  } finally {
    ensured.client.dispose();
  }
  await waitForMissing(input.socketPath);
}

async function collectTerminalResult(attachment, timeoutMs) {
  let output = "";
  for (const event of attachment.ack.replay.events) {
    if (event.type === "data") output += event.data;
  }
  if (attachment.ack.exited) {
    fail("compiled PTY exited before its exit frame could be observed");
  }
  const iterator = attachment.frames[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const next = await Promise.race([
        iterator.next(),
        delay(remaining).then(() => ({ timeout: true })),
      ]);
      if (next.timeout === true) break;
      if (next.done) break;
      if (next.value.type === "data") output += next.value.data;
      if (next.value.type === "exit") {
        return { output, exitCode: next.value.exitCode };
      }
    }
  } finally {
    await iterator.return?.();
  }
  fail(`timed out waiting for compiled PTY exit; output=${JSON.stringify(output)}`);
}

async function findFile(directory, matches) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      try {
        return await findFile(path, matches);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("No matching file")) throw error;
      }
    } else if (entry.isFile() && matches(entry.name)) {
      return path;
    }
  }
  throw new Error(`No matching file under ${directory}`);
}

async function directoryFileCount(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile())
      .length;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

function readCommandCount(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("SELECT count(*) AS count FROM commands").get();
    return row?.count;
  } finally {
    database.close();
  }
}

async function waitForMissing(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      await delay(25);
    } catch {
      return;
    }
  }
  fail(`path remained present: ${path}`);
}

async function terminateSelfCheckProcess(pid) {
  if (await waitForProcessExit(pid, 3000)) return;
  if (!signalProcess(pid, "SIGTERM")) return;
  if (await waitForProcessExit(pid, 3000)) return;
  if (!signalProcess(pid, "SIGKILL")) return;
  if (!(await waitForProcessExit(pid, 3000))) {
    throw new Error(`observer process ${pid} survived SIGKILL`);
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await delay(25);
  }
  return !processIsAlive(pid);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function parseSmokeJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    fail(`${label} did not return valid JSON`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    fail(`${label}: expected ${JSON.stringify(value)} to include ${JSON.stringify(expected)}`);
  }
}

function assertExcludes(value, unexpected, label) {
  if (value.includes(unexpected)) {
    fail(`${label}: expected ${JSON.stringify(value)} to exclude ${JSON.stringify(unexpected)}`);
  }
}

function fail(message) {
  throw new Error(message);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
