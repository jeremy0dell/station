import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
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
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createObserverClient,
  readUnixSocketHolderPids,
} from "../../packages/protocol/dist/index.js";
import {
  parseStationObserverBuildVersion,
  stationObserverBuildVersion,
} from "../../packages/runtime/dist/index.js";
import { createStationHostClient } from "../../packages/station-host/dist/index.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const alternateProductionSource = "apps/cli/src/commandRegistry.ts";
const alternateBuildMarker = " (alternate binary smoke build)";
let smokeRunSignal;

class SmokeRunCancelledError extends Error {}

if (process.env.STATION_BINARY_SMOKE_CANCELLATION_SELF_CHECK === "1") {
  await runObserverCancellationSelfCheck();
} else if (process.env.STATION_BINARY_SMOKE_FAKE_TMUX === "1") {
  await runFakeTmuxProcess(process.argv.slice(2));
} else {
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
  const root = await mkdtemp(join(tmpdir(), "station-binary-smoke-"));
  const alternateWorktreePath = join(root, "alternate-worktree");
  const homeDir = join(root, "home");
  const stateDir = join(root, "state");
  const runtimeDir = join(root, "runtime");
  const hostileDir = join(root, "hostile");
  const socketPath = join(runtimeDir, "observer.sock");
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
  const cancellation = installSmokeCancellation();
  smokeRunSignal = cancellation.signal;

  try {
    if (process.env.STATION_BINARY_SMOKE_CANCELLATION_EXIT_SELF_CHECK === "1") {
      process.kill(process.pid, "SIGINT");
      await delay(0);
      throw runCancelledError(process.execPath, [], cancellation.signal);
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
      await hookObserverClient.stop();
      await waitForMissing(socketPath);
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

    const hostSocketPath = join(runtimeDir, "station-host.sock");
    hostProcess = spawn(
      binaryPath,
      ["__station-host", "--socket", hostSocketPath, "--state-dir", stateDir],
      {
        cwd: hostileDir,
        env: childEnv,
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

    const spawned = await hostClient.spawn({
      terminalTargetId: "native:binary-smoke",
      worktreeId: "binary-smoke",
      projectId: "binary-smoke",
      sessionId: "ses_binary_smoke",
      worktreePath: root,
      harnessProvider: "scripted",
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
    const attachment = await hostClient.attach(spawned.ptyId);
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
      if (expectedVersion.startsWith("0.0.0-") && sourceVersion !== expectedVersion) {
        const previousObserverPid = observerPid;
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
    process.stdout.write("binary smoke passed\n");
  } catch (error) {
    if (!(error instanceof SmokeRunCancelledError)) throw error;
  } finally {
    smokeRunSignal = undefined;
    try {
      if (observerClient !== undefined) {
        await observerClient.stop().catch(() => undefined);
        await waitForMissing(socketPath).catch(() => undefined);
      }
      if (observerPid !== undefined) {
        await terminateProcess(observerPid);
      }
      hostClient?.dispose();
      if (hostProcess !== undefined && hostProcess.exitCode === null) {
        hostProcess.kill("SIGTERM");
        try {
          await waitForExit(hostProcess, 3000);
        } catch {
          hostProcess.kill("SIGKILL");
          await waitForExit(hostProcess, 3000).catch(() => undefined);
        }
      }
      await stopFakeTmuxProcesses(fakeTmuxStatePath);
    } finally {
      try {
        if (alternateWorktreeAdded) {
          await removeTemporaryWorktree(alternateWorktreePath);
        }
      } finally {
        try {
          await rm(root, { recursive: true, force: true });
        } finally {
          cancellation.dispose();
        }
      }
    }
  }
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
  await run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: worktreePath,
    env: buildEnv,
    terminateDescendants: true,
    timeoutMs: 300_000,
  });
  await run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: join(worktreePath, "station"),
    env: buildEnv,
    terminateDescendants: true,
    timeoutMs: 300_000,
  });
  await run("pnpm", ["build:binary", "--", "--version", expectedVersion], {
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
  let pid;

  await Promise.all([
    mkdir(join(homeDir, "tmp"), { recursive: true, mode: 0o700 }),
    mkdir(stateDir, { recursive: true, mode: 0o700 }),
    mkdir(runtimeDir, { recursive: true, mode: 0o700 }),
  ]);
  await writeSmokeConfig(configPath, stateDir, socketPath);
  try {
    const version = await run(binaryPath, ["--version"], { env });
    assertEqual(version.stdout.trim(), expectedVersion, `${label} display version`);
    await runObserverStart(
      binaryPath,
      ["--config", configPath, "observer", "start", "--timeout-ms", "30000"],
      { client, env, socketPath },
    );
    const health = await client.health();
    pid = health.pid;
    assertEqual(health.status, "healthy", `${label} health`);
    if (health.version === undefined) {
      fail(`${label} did not publish an exact build selector`);
    }
    return health.version;
  } finally {
    await client.stop().catch(() => undefined);
    await waitForMissing(socketPath).catch(() => undefined);
    if (pid !== undefined) {
      await terminateProcess(pid);
    }
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
    return "0.7.1-rc.6";
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
  };
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
    writeFile(join(fakeBin, "diffnav"), "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
    writeFile(join(fakeBin, "delta"), "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
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

async function stopFakeTmuxProcesses(path) {
  let state;
  try {
    state = await readFakeTmuxState(path);
  } catch {
    return;
  }
  for (const pid of state.rendererPids ?? []) {
    if (Number.isInteger(pid) && pid > 0) {
      await terminateProcess(pid).catch(() => undefined);
    }
  }
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
    detached: true,
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
  signalProcess(session.rendererPid, "SIGTERM");
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
      options.terminateDescendants === true && process.platform !== "win32";
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
      terminate(new Error(`${command} ${args.join(" ")} timed out\n${stderr}`));
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
      finish(() => reject(error));
    });
    child.once("close", (code, signal) => {
      if (terminationError !== undefined) {
        finish(() => reject(terminationError));
        return;
      }
      const allowed = options.allowedExitCodes ?? [0];
      if (code === null || !allowed.includes(code)) {
        finish(() =>
          reject(
            new Error(
              `${command} ${args.join(" ")} exited ${code ?? signal ?? "unknown"}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
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

async function runObserverStart(command, args, { client, env, socketPath }) {
  const cancellationSignal = smokeRunSignal;
  if (cancellationSignal?.aborted === true) {
    throw runCancelledError(command, args, cancellationSignal);
  }
  // The launcher owns its detached child until startup resolves, so cancellation waits for that bounded handoff.
  await run(command, args, {
    deferSmokeCancellation: true,
    env,
    timeoutMs: 35_000,
  });
  if (cancellationSignal?.aborted !== true) return;

  const health = await client.health();
  await client.stop().catch(() => undefined);
  await waitForMissing(socketPath).catch(() => undefined);
  await terminateProcess(health.pid);
  throw runCancelledError(command, args, cancellationSignal);
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
    if (observerPid !== undefined) await terminateProcess(observerPid);
    await rm(root, { recursive: true, force: true });
  }
}

function installSmokeCancellation() {
  const controller = new AbortController();
  const handleSignal = (signal) => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort(signal);
  };
  const onInterrupt = () => handleSignal("SIGINT");
  const onTerminate = () => handleSignal("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", onInterrupt);
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

async function collectTerminalResult(attachment, timeoutMs) {
  let output = attachment.ack.scrollback.join("");
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

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveWait, reject) => {
    const timeout = setTimeout(() => reject(new Error("process did not exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveWait();
    });
  });
}

async function terminateProcess(pid) {
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

function fail(message) {
  throw new Error(message);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
