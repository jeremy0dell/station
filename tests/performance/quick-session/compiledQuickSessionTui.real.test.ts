import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, loadavg, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { StationEvent, StationSnapshot, WorktreeRow } from "@station/contracts";
import {
  createStationHostClient,
  HOST_PROTOCOL_VERSION,
  type HostAttachment,
  type HostFrame,
  type HostListEntry,
  STATION_HOST_PROVIDER_ID,
} from "@station/host";
import { createObserverClient, type ObserverClient } from "@station/protocol";
import {
  createStationHostController,
  type SpawnStationHostInput,
  type StationHostHandle,
} from "@station/terminal";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildRemoveWorktreeCommand } from "../../../packages/dashboard-core/src/entrypoints/runtime.js";
import type { RealE2eEnvironment } from "../../support/real-station/env.js";
import {
  type AttachedTmuxPtyClient,
  captureTmuxPane,
  killTmuxSession,
  startAttachedTmuxPtyClient,
  tmuxSessionExists,
} from "../../support/real-station/tmux.js";
import { distribution } from "./statistics.js";

const execFileAsync = promisify(execFile);
const runFocusComparison =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_FOCUS_COMPARE === "1";
const runSafetyAudit = process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_SAFETY_AUDIT === "1";
const runReal =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI === "1" ||
  runFocusComparison ||
  runSafetyAudit;
const describeReal = runReal ? describe : describe.skip;
const outputPath = resolve(
  z
    .string()
    .min(1)
    .parse(
      process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_OUTPUT ??
        (runFocusComparison
          ? ".dev-state/performance/quick-session/compiled-quick-session-focus.real.json"
          : runSafetyAudit
            ? ".dev-state/performance/quick-session/compiled-quick-session-safety.real.json"
            : ".dev-state/performance/quick-session/compiled-quick-session-tui.real.json"),
    ),
);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const binaryPath = fileURLToPath(new URL("../../../station/dist/bin/stn", import.meta.url));
const buildIdentityPath = fileURLToPath(
  new URL("../../../packages/runtime/dist/station-build-id", import.meta.url),
);
const packageJsonPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
const worktrunkCommand = process.env.STATION_WORKTRUNK_BIN ?? "wt";
const tmuxCommand = process.env.STATION_TMUX_BIN ?? "tmux";
const repetitions = runFocusComparison ? 10 : runSafetyAudit ? 1 : 5;
const ordinaryLinkedWorktrees = 48;
const initialInventoryCount = ordinaryLinkedWorktrees + 1;
const projectId = "compiled-tui-project";
const projectLabel = "Compiled TUI benchmark";
const readyPrefix = "__STATION_COMPILED_TUI_READY__:";
const acknowledgementPrefix = "__STATION_COMPILED_TUI_ACK__:";
const dimensions = { columns: 160, rows: 50 } as const;
const thresholds = {
  launchToDashboardMedianMs: 1_500,
  launchToDashboardP95Ms: 2_500,
  intentToOptimisticP95Ms: 50,
  intentToInteractiveMedianMs: 100,
  intentToInteractiveP95Ms: 200,
  intentToCanonicalUiP95Ms: 350,
  launchToInteractiveP95Ms: 2_700,
} as const;
const focusThresholds = {
  focusToInputAckP95Ms: 100,
  focusToInputAckMinimumImprovementFraction: 0.75,
  intentToInteractiveMedianMs: 250,
  intentToInteractiveP95Ms: 350,
} as const;
const expectedUiProgress = "Launching STATION TUI…\n";

type FocusStrategy = "escape" | "toggle";

type BenchmarkFixture = Awaited<ReturnType<typeof createBenchmarkFixture>>;
type BenchmarkRun = Awaited<ReturnType<typeof runRepetition>>;

describeReal("compiled CLI native Quick Session product boundary", () => {
  it("measures cold CLI startup and raw native Quick Session input independently", async () => {
    const report = {
      schemaVersion: 1,
      benchmark: runFocusComparison
        ? "station-quick-session-compiled-cli-native-focus-comparison"
        : runSafetyAudit
          ? "station-quick-session-compiled-cli-native-safety-audit"
          : "station-quick-session-compiled-cli-native-tui",
      generatedAt: new Date().toISOString(),
      machine: {
        platform: platform(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
      },
      tools: {
        bun: "",
        worktrunk: "",
        tmux: "",
        hostProtocolVersion: HOST_PROTOCOL_VERSION,
        displayBuildVersion: "",
        observerBuildVersion: "",
      },
      binary: { buildMs: 0, bytes: 0, buildExcludedFromTiming: true },
      repositoryShape: {
        worktrees: initialInventoryCount,
        repetitions,
        lifecycleHooks: false,
        ordinaryObserverRestartPerRun: true,
        ptyUsedHostPreservedAcrossRuns: true,
      },
      thresholds: runFocusComparison ? focusThresholds : thresholds,
      setup: {
        repositoryShapeMs: 0,
        hostSeedMs: 0,
        hostSeedSafe: false,
        hostStoppedCleanly: false,
        hostStderrEmpty: false,
        rootRemoved: false,
      },
      runs: [] as BenchmarkRun[],
      distributions: emptyDistributions(),
      focusComparison: null as ReturnType<typeof summarizeFocusComparison> | null,
      falseSafetyPredicates: [] as string[],
      safetyAuditPassed: false,
      allSafe: false,
      thresholdsPassed: false,
      failure: null as string | null,
    };
    let fixture: BenchmarkFixture | undefined;
    let hostRuntime: ReturnType<typeof createHostRuntime> | undefined;
    try {
      await Promise.all([access(worktrunkCommand), access(tmuxCommand)]).catch(async () => {
        await execFileAsync(worktrunkCommand, ["--version"], { timeout: 15_000 });
        await execFileAsync(tmuxCommand, ["-V"], { timeout: 10_000 });
      });
      const packageJson = z
        .object({ version: z.string().min(1) })
        .passthrough()
        .parse(JSON.parse(await readFile(packageJsonPath, "utf8")));
      report.tools.displayBuildVersion = packageJson.version;
      const buildStartedAt = performance.now();
      await execFileAsync("pnpm", ["build:binary", "--version", packageJson.version], {
        cwd: repoRoot,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 300_000,
      });
      report.binary.buildMs = performance.now() - buildStartedAt;
      report.binary.bytes = (await stat(binaryPath)).size;
      const buildIdentity = z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .parse((await readFile(buildIdentityPath, "utf8")).trim());
      report.tools.observerBuildVersion = `${packageJson.version}+station.${buildIdentity}`;
      const [bunVersion, worktrunkVersion, tmuxVersion] = await Promise.all([
        execFileAsync(process.env.STATION_BUN ?? "bun", ["--version"]),
        execFileAsync(worktrunkCommand, ["--version"]),
        execFileAsync(tmuxCommand, ["-V"]),
      ]);
      report.tools.bun = bunVersion.stdout.trim();
      report.tools.worktrunk = worktrunkVersion.stdout.trim();
      report.tools.tmux = tmuxVersion.stdout.trim();

      const temporaryRoot = await mkdtemp(join(tmpdir(), "st-qtu-"));
      const shapeStartedAt = performance.now();
      fixture = await createBenchmarkFixture(temporaryRoot);
      report.setup.repositoryShapeMs = performance.now() - shapeStartedAt;
      hostRuntime = createHostRuntime(fixture, packageJson.version);
      const seed = await seedHost(hostRuntime, fixture);
      report.setup.hostSeedMs = seed.durationMs;
      report.setup.hostSeedSafe = seed.safe;

      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        report.runs.push(
          await runRepetition({
            fixture,
            hostRuntime,
            repetition,
            expectedObserverBuildVersion: report.tools.observerBuildVersion,
          }),
        );
      }
      const stopped = await hostRuntime.client.stopIfIdle(packageJson.version);
      const hostExit = await waitForExit(hostRuntime.child(), 7_000);
      report.setup.hostStoppedCleanly =
        stopped.stopping && hostExit.code === 0 && hostExit.signal === null;
      report.setup.hostStderrEmpty = hostRuntime.stderr().length === 0;
    } catch (error) {
      report.failure = diagnosticError(error);
    } finally {
      if (hostRuntime !== undefined) {
        await stopHostRuntime(hostRuntime).catch(() => undefined);
      }
      if (fixture !== undefined) {
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
        await rm(fixture.runtimeRoot, { recursive: true, force: true });
        report.setup.rootRemoved =
          !(await pathExists(fixture.temporaryRoot)) && !(await pathExists(fixture.runtimeRoot));
      }
    }

    report.distributions = summarizeRuns(report.runs);
    report.focusComparison = summarizeFocusComparison(report.runs);
    report.falseSafetyPredicates = report.runs.flatMap((run) =>
      Object.entries(run.safetyPredicates)
        .filter(([, passed]) => !passed)
        .map(([predicate]) => predicate),
    );
    report.allSafe =
      report.failure === null &&
      report.runs.length === repetitions &&
      report.runs.every((run) => run.safe) &&
      report.setup.hostSeedSafe &&
      report.setup.hostStoppedCleanly &&
      report.setup.hostStderrEmpty &&
      report.setup.rootRemoved;
    report.safetyAuditPassed =
      runSafetyAudit &&
      report.failure === null &&
      report.runs.length === repetitions &&
      report.falseSafetyPredicates.length === 0 &&
      report.runs.every((run) => run.phaseCoherent && run.safe) &&
      report.setup.hostSeedSafe &&
      report.setup.hostStoppedCleanly &&
      report.setup.hostStderrEmpty &&
      report.setup.rootRemoved;
    report.thresholdsPassed = runSafetyAudit
      ? report.safetyAuditPassed
      : runFocusComparison
        ? report.runs.length === repetitions &&
          report.runs.every((run) => run.phaseCoherent) &&
          report.focusComparison.escape.runs === 5 &&
          report.focusComparison.toggle.runs === 5 &&
          report.focusComparison.toggle.focusToInputAckMs.p95 <=
            focusThresholds.focusToInputAckP95Ms &&
          report.focusComparison.focusToInputAckP95ImprovementFraction >=
            focusThresholds.focusToInputAckMinimumImprovementFraction &&
          report.focusComparison.toggle.intentToInteractiveMs.median <=
            focusThresholds.intentToInteractiveMedianMs &&
          report.focusComparison.toggle.intentToInteractiveMs.p95 <=
            focusThresholds.intentToInteractiveP95Ms
        : report.runs.length === repetitions &&
          report.distributions.launchToDashboardMs.median <= thresholds.launchToDashboardMedianMs &&
          report.distributions.launchToDashboardMs.p95 <= thresholds.launchToDashboardP95Ms &&
          report.distributions.intentToOptimisticMs.p95 <= thresholds.intentToOptimisticP95Ms &&
          report.distributions.intentToInteractiveMs.median <=
            thresholds.intentToInteractiveMedianMs &&
          report.distributions.intentToInteractiveMs.p95 <= thresholds.intentToInteractiveP95Ms &&
          report.distributions.intentToCanonicalUiMs.p95 <= thresholds.intentToCanonicalUiP95Ms &&
          report.distributions.launchToInteractiveMs.p95 <= thresholds.launchToInteractiveP95Ms;

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`[compiled native Quick Session benchmark] ${outputPath}\n`);

    expect(report.failure).toBeNull();
    if (runSafetyAudit) {
      expect(report.safetyAuditPassed).toBe(true);
    } else {
      expect(report.allSafe).toBe(true);
    }
    expect(report.thresholdsPassed).toBe(true);
  }, 600_000);
});

async function createBenchmarkFixture(temporaryRootInput: string) {
  const temporaryRoot = await realpath(temporaryRootInput);
  // Unix-domain sockets retain the short /tmp spelling while repository paths
  // stay canonical for exact Worktrunk/Git identity checks.
  const runtimeRoot = await mkdtemp(join("/tmp", "st-qtu-run-"));
  const repositoryRoot = join(temporaryRoot, "repo");
  const managedRoot = join(temporaryRoot, "worktrees");
  const stateDir = join(temporaryRoot, "state");
  const runDir = join(runtimeRoot, "run");
  const observerSocketPath = join(runDir, "observer.sock");
  const hostSocketPath = join(runDir, "station-host.sock");
  const configPath = join(temporaryRoot, "station.toml");
  const worktrunkConfigPath = join(temporaryRoot, "worktrunk.toml");
  const harnessPath = join(temporaryRoot, "benchmark-scripted.sh");
  await Promise.all([
    mkdir(repositoryRoot, { recursive: true }),
    mkdir(managedRoot, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(runDir, { recursive: true }),
    writeFile(worktrunkConfigPath, "", "utf8"),
  ]);
  await runCommand("git", ["init", "--initial-branch=main", "--quiet"], repositoryRoot);
  await runCommand("git", ["config", "user.name", "Station Benchmark"], repositoryRoot);
  await runCommand(
    "git",
    ["config", "user.email", "station-benchmark@example.invalid"],
    repositoryRoot,
  );
  await runCommand(
    "git",
    ["commit", "--allow-empty", "--message=baseline", "--quiet"],
    repositoryRoot,
  );
  for (let index = 0; index < ordinaryLinkedWorktrees; index += 1) {
    await runCommand(
      "git",
      [
        "worktree",
        "add",
        "--quiet",
        "-b",
        `shape-${index}`,
        join(managedRoot, `shape-${index}`),
        "main",
      ],
      repositoryRoot,
    );
  }
  await writeFile(
    harnessPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
      '  printf "Logged in\\n"',
      "  exit 0",
      "fi",
      `printf '${readyPrefix}%s\\n' "$STATION_SESSION_ID"`,
      "while IFS= read -r line; do",
      `  printf '${acknowledgementPrefix}%s:%s\\n' "$STATION_SESSION_ID" "$line"`,
      "done",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(harnessPath, 0o755);
  await writeFile(
    configPath,
    [
      "schema_version = 1",
      "",
      "[observer]",
      `socket_path = ${JSON.stringify(observerSocketPath)}`,
      `state_dir = ${JSON.stringify(stateDir)}`,
      "auto_start_from_hooks = false",
      "",
      "[defaults]",
      'worktree_provider = "worktrunk"',
      'terminal = "tmux"',
      'harness = "scripted"',
      'layout = "agent-shell"',
      'default_branch = "main"',
      "",
      "[worktree.worktrunk]",
      `command = ${JSON.stringify(worktrunkCommand)}`,
      `config_path = ${JSON.stringify(worktrunkConfigPath)}`,
      "use_lifecycle_hooks = false",
      'hook_mode = "disabled"',
      "",
      "[terminal.tmux]",
      `command = ${JSON.stringify(tmuxCommand)}`,
      `workbench_session = ${JSON.stringify(`st-qtu-workbench-${process.pid}`)}`,
      "",
      "[harness.scripted]",
      "enabled = true",
      `command = ${JSON.stringify(harnessPath)}`,
      "",
      "[feature_flags]",
      "station_persistent_agents = true",
      "",
      "[[projects]]",
      `id = ${JSON.stringify(projectId)}`,
      `label = ${JSON.stringify(projectLabel)}`,
      `root = ${JSON.stringify(repositoryRoot)}`,
      'default_branch = "main"',
      "",
      "[projects.defaults]",
      'harness = "scripted"',
      'terminal = "tmux"',
      'layout = "agent-shell"',
      "",
      "[projects.worktrunk]",
      "enabled = true",
      'base = "main"',
      `managed_root = ${JSON.stringify(managedRoot)}`,
      "include_main = true",
      "include_external = true",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    temporaryRoot,
    runtimeRoot,
    repositoryRoot,
    managedRoot,
    stateDir,
    observerSocketPath,
    hostSocketPath,
    configPath,
  };
}

function createHostRuntime(fixture: BenchmarkFixture, expectedBuildVersion: string) {
  const client = createStationHostClient({
    socketPath: fixture.hostSocketPath,
    expectedBuildVersion,
    timeoutMs: 5_000,
  });
  let childProcess: ChildProcess | undefined;
  let stderr = "";
  const controller = createStationHostController(
    {
      socketPath: fixture.hostSocketPath,
      stateDir: fixture.stateDir,
      hostCommand: [binaryPath, "__station-host"],
      expectedBuildVersion,
      timeoutMs: 7_000,
    },
    {
      clientFactory: () => client,
      spawnHost: (input: SpawnStationHostInput) => {
        childProcess = spawn(input.argv[0], input.argv.slice(1), {
          stdio: ["ignore", "ignore", "pipe"],
          env: { ...process.env, STATION_PTY_IMPL: "bun" },
        });
        childProcess.stderr?.on("data", (data: Buffer) => {
          if (stderr.length < 64 * 1024) stderr += data.toString("utf8");
        });
        return childProcess;
      },
    },
  );
  return {
    controller,
    client,
    child: () => childProcess,
    stderr: () => stderr,
    expectedBuildVersion,
  };
}

async function seedHost(runtime: ReturnType<typeof createHostRuntime>, fixture: BenchmarkFixture) {
  const startedAt = performance.now();
  const handle = await runtime.controller.ensure();
  if (handle.status !== "running") throw unavailableHostError(handle);
  const health = await handle.client.health();
  const identity = {
    kind: "agent" as const,
    terminalTargetId: "station:compiled-tui-seed",
    worktreeId: "wt-compiled-tui-seed",
    projectId,
    sessionId: "session-compiled-tui-seed",
    worktreePath: fixture.repositoryRoot,
    harnessProvider: "scripted",
  };
  const readyMarker = "__STATION_COMPILED_TUI_SEED_READY__";
  const acknowledgement = "__STATION_COMPILED_TUI_SEED_ACK__";
  const spawned = await handle.client.spawn({
    ...identity,
    command: "/bin/sh",
    args: [
      "-c",
      'printf "%s\\n" "$1"; IFS= read -r line || exit 31; printf "%s:%s\\n" "$2" "$line"; while :; do sleep 60; done',
      "station-compiled-tui-seed",
      readyMarker,
      acknowledgement,
    ],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color", LC_ALL: "C" },
    cwd: fixture.repositoryRoot,
    cols: 80,
    rows: 24,
  });
  const attachment = await handle.client.attach({ ...identity, ...spawned }, "controller");
  const iterator = attachment.frames[Symbol.asyncIterator]();
  let output = replayData(attachment);
  output = await readUntilMarker(iterator, output, readyMarker, 5_000);
  await attachment.write("seed-input\n");
  output = await readUntilMarker(iterator, output, `${acknowledgement}:seed-input`, 5_000);
  await iterator.return?.();
  await attachment.detach();
  const closed = await handle.client.close(spawned.ptyId);
  const empty = (await handle.client.list()).length === 0;
  return {
    durationMs: performance.now() - startedAt,
    safe:
      health.ok &&
      health.protocolVersion === HOST_PROTOCOL_VERSION &&
      health.buildVersion === runtime.expectedBuildVersion &&
      output.includes(readyMarker) &&
      output.includes(`${acknowledgement}:seed-input`) &&
      closed.closed &&
      empty,
  };
}

async function runRepetition(input: {
  fixture: BenchmarkFixture;
  hostRuntime: ReturnType<typeof createHostRuntime>;
  repetition: number;
  expectedObserverBuildVersion: string;
}) {
  const { fixture, hostRuntime, repetition, expectedObserverBuildVersion } = input;
  const focusStrategy: FocusStrategy =
    runSafetyAudit || (runFocusComparison && repetition % 2 === 1) ? "toggle" : "escape";
  const sessionName = `st-qtu-${process.pid}-${repetition}`;
  const uiStderrPath = join(fixture.temporaryRoot, `ui-${repetition}.stderr`);
  const env: RealE2eEnvironment = {
    repoRoot,
    stationBin: binaryPath,
    stationIngressBin: binaryPath,
    worktrunkBin: worktrunkCommand,
    tmuxBin: tmuxCommand,
  };
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  const launchStartedAt = performance.now();
  let dashboardReadyAt: number | undefined;
  let intentAt: number | undefined;
  let optimisticAt: number | undefined;
  let commandAcceptedAt: number | undefined;
  let commandCompletedAt: number | undefined;
  let hostReadyAt: number | undefined;
  let canonicalUiAt: number | undefined;
  let focusAt: number | undefined;
  let overlayDismissedAt: number | undefined;
  let inputSentAt: number | undefined;
  let inputAcknowledgedAt: number | undefined;
  let commandId: string | undefined;
  let traceId: string | undefined;
  let branch: string | undefined;
  let worktree: WorktreeRow | undefined;
  let sessionId: string | undefined;
  let hostEntry: HostListEntry | undefined;
  let uiPid = -1;
  let observerPid = -1;
  let observerStoppedCleanly = false;
  let uiStoppedCleanly = false;
  let cleanupInventoryCount = -1;
  let gitCleanupInventoryCount = -1;
  let uiStderr = "";
  let subscription: AsyncIterator<StationEvent> | undefined;
  let ptyClient: AttachedTmuxPtyClient | undefined;
  let viewer: HostAttachment | undefined;
  try {
    const initialHostHealth = await hostRuntime.client.health();
    const initialHostInventory = await hostRuntime.client.list();
    if (
      !initialHostHealth.ok ||
      initialHostHealth.buildVersion !== hostRuntime.expectedBuildVersion ||
      initialHostInventory.length !== 0
    ) {
      throw new Error("Compiled TUI run did not begin with the exact warm empty Host.");
    }
    const launched = await launchNativeStation({
      env,
      fixture,
      sessionName,
      stderrPath: uiStderrPath,
    });
    uiPid = launched.panePid;
    ptyClient = await startAttachedTmuxPtyClient({
      env,
      sessionName,
      dimensions,
    });
    const entryFrame = await waitForFrame(
      env,
      launched.target,
      (frame) => frame.includes(projectLabel) || frame.includes("Open project view"),
      30_000,
      "Compiled native Station did not expose its entry surface.",
    );
    if (entryFrame.includes("Open project view")) {
      await writeSgrClick(ptyClient, cellForText(entryFrame, "Open project view"));
    }
    const dashboardFrame = await waitForFrame(
      env,
      launched.target,
      (frame) => frame.includes(projectLabel) && frame.includes("[quick session]"),
      30_000,
      "Compiled native dashboard did not become ready.",
    );
    dashboardReadyAt = performance.now();
    const observerProbe = createObserverClient({
      socketPath: fixture.observerSocketPath,
      timeoutMs: 7_000,
    });
    const health = await observerProbe.health();
    observerPid = health.pid ?? -1;
    const observer = createObserverClient({
      socketPath: fixture.observerSocketPath,
      expectedBuildVersion: expectedObserverBuildVersion,
      timeoutMs: 15_000,
      requestId: requestIdFactory(repetition),
    });
    const initialSnapshot = await observer.getSnapshot({ includeDebug: true });
    if (
      health.status !== "healthy" ||
      health.version !== expectedObserverBuildVersion ||
      initialSnapshot.counts.worktrees !== initialInventoryCount
    ) {
      throw new Error(
        `Compiled TUI Observer did not expose the exact startup snapshot: ${JSON.stringify({
          status: health.status,
          version: health.version,
          expectedObserverBuildVersion,
          lastReconcileReason: health.lastReconcile?.reason,
          worktrees: initialSnapshot.counts.worktrees,
          expectedWorktrees: initialInventoryCount,
        })}`,
      );
    }
    subscription = observer
      .subscribe({
        type: ["command.accepted", "command.started", "command.succeeded", "command.failed"],
      })
      [Symbol.asyncIterator]();
    const acceptedPromise = waitForEvent(
      subscription,
      (event) => event.type === "command.accepted" && event.command.type === "worktree.create",
      10_000,
      "Native Quick Session did not emit a worktree.create acceptance.",
    );
    await delay(100);
    const optimisticPromise = waitForOutput(ptyClient, "starting session...", 2_000).then(() =>
      performance.now(),
    );
    const quickCell = cellForText(dashboardFrame, "[quick session]");
    intentAt = performance.now();
    await writeSgrClick(ptyClient, quickCell);
    const accepted = await acceptedPromise;
    commandAcceptedAt = performance.now();
    commandId = accepted.commandId;
    traceId = accepted.traceId;
    branch = accepted.command.payload.branch;
    optimisticAt = await optimisticPromise;
    const completed = await waitForEvent(
      subscription,
      (event) =>
        (event.type === "command.succeeded" || event.type === "command.failed") &&
        event.commandId === commandId,
      30_000,
      "Native Quick Session command did not settle.",
    );
    commandCompletedAt = performance.now();
    if (completed.type !== "command.succeeded") {
      throw new Error(`Native Quick Session command failed: ${completed.error.code}`);
    }
    const command = await observer.waitForCommand(accepted.commandId, { timeoutMs: 30_000 });
    if (command.status !== "succeeded" || command.traceId !== traceId) {
      throw new Error("Native Quick Session command record lost its successful trace identity.");
    }
    const canonical = await waitForSnapshot(
      observer,
      (snapshot) => {
        const row = snapshot.rows.find(
          (candidate) => candidate.projectId === projectId && candidate.branch === branch,
        );
        const session = snapshot.sessions.find((candidate) => candidate.worktreeId === row?.id);
        return row !== undefined && session !== undefined ? { snapshot, row, session } : undefined;
      },
      30_000,
      "Native Quick Session did not reach canonical session projection.",
    );
    worktree = canonical.row;
    sessionId = canonical.session.id;
    hostEntry = await waitForHostEntry(
      hostRuntime.client,
      (entry) =>
        entry.alive &&
        entry.kind === "agent" &&
        entry.projectId === projectId &&
        entry.worktreeId === worktree?.id &&
        entry.sessionId === sessionId,
      15_000,
    );
    viewer = await hostRuntime.client.attach(hostEntry, "viewer");
    const viewerIterator = viewer.frames[Symbol.asyncIterator]();
    let output = replayData(viewer);
    output = await readUntilMarker(viewerIterator, output, `${readyPrefix}${sessionId}`, 10_000);
    hostReadyAt = performance.now();
    await waitForFrame(
      env,
      launched.target,
      (frame) => frame.includes(branch ?? "") && !frame.includes("starting session..."),
      10_000,
      "Native dashboard did not replace its optimistic row with the canonical session.",
    );
    canonicalUiAt = performance.now();
    focusAt = performance.now();
    await ptyClient.write(Buffer.from(focusStrategy === "toggle" ? "\x0f" : "\x1b", "binary"));
    await waitForFrame(
      env,
      launched.target,
      (frame) => !frame.includes("[quick session]") && !frame.includes("[shell]"),
      10_000,
      "Native Quick Session row activation did not focus its pane.",
    );
    overlayDismissedAt = performance.now();
    const inputToken = `compiled-tui-input-${repetition}`;
    inputSentAt = performance.now();
    await ptyClient.write(Buffer.from(`${inputToken}\r`, "utf8"));
    output = await readUntilMarker(
      viewerIterator,
      output,
      `${acknowledgementPrefix}${sessionId}:${inputToken}`,
      10_000,
    );
    inputAcknowledgedAt = performance.now();
    await viewerIterator.return?.();
    await viewer.detach();
    viewer = undefined;

    const removalReceipt = await observer.dispatch(buildRemoveWorktreeCommand(worktree, true));
    const removal = await observer.waitForCommand(removalReceipt.commandId, { timeoutMs: 30_000 });
    if (removal.status !== "succeeded") {
      throw new Error(
        `Native Quick Session cleanup failed: ${removal.error?.code ?? removal.status}`,
      );
    }
    await waitForSnapshot(
      observer,
      (snapshot) =>
        snapshot.counts.worktrees === initialInventoryCount &&
        !snapshot.rows.some((row) => row.branch === branch)
          ? snapshot
          : undefined,
      30_000,
      "Observer did not converge to the exact post-removal inventory.",
    );
    cleanupInventoryCount = (await hostRuntime.client.list()).length;
    gitCleanupInventoryCount = await gitWorktreeCount(fixture.repositoryRoot);
    await ptyClient.write(Buffer.from("\x11", "binary"));
    uiStoppedCleanly = await waitForTmuxExit(env, sessionName, 10_000);
    await observer.stop();
    observerStoppedCleanly = await waitForPidExit(observerPid, 10_000);
    uiStderr = await readFile(uiStderrPath, "utf8").catch(() => "");
    const safetyPredicates = {
      dashboardProjectVisible: dashboardFrame.includes(projectLabel),
      commandProjectMatches: accepted.command.payload.projectId === projectId,
      commandHarnessMatches: accepted.command.payload.launchHarness === "scripted",
      worktreeProjectMatches: worktree.projectId === projectId,
      worktreeBranchMatches: worktree.branch === branch,
      worktreeUsesManagedRoot: worktree.path.startsWith(`${fixture.managedRoot}/`),
      worktreeHasRegistrationIdentity: worktree.registrationIdentity !== undefined,
      sessionHarnessMatches: canonical.session.harness.provider === "scripted",
      sessionTerminalMatches: canonical.session.terminal?.provider === STATION_HOST_PROVIDER_ID,
      hostWorktreeMatches: hostEntry.worktreePath === worktree.path,
      hostHarnessMatches: hostEntry.harnessProvider === "scripted",
      hostSessionMatches: hostEntry.sessionId === sessionId,
      readyMarkerObserved: output.includes(`${readyPrefix}${sessionId}`),
      inputAcknowledged: output.includes(`${acknowledgementPrefix}${sessionId}:${inputToken}`),
      hostInventoryEmpty: cleanupInventoryCount === 0,
      gitInventoryRestored: gitCleanupInventoryCount === initialInventoryCount,
      uiStoppedCleanly,
      observerStoppedCleanly,
      uiStderrMatches:
        uiStderr === (runFocusComparison || runSafetyAudit ? expectedUiProgress : ""),
    };
    const boundarySafe = Object.values(safetyPredicates).every(Boolean);
    const focusToInputAckMs = inputAcknowledgedAt - focusAt;
    const phaseSumMs =
      overlayDismissedAt -
      focusAt +
      (inputSentAt - overlayDismissedAt) +
      (inputAcknowledgedAt - inputSentAt);
    const phaseCoherent =
      overlayDismissedAt >= focusAt &&
      inputSentAt >= overlayDismissedAt &&
      inputAcknowledgedAt >= inputSentAt &&
      Math.abs(focusToInputAckMs - phaseSumMs) <= 10;
    const safe = boundarySafe && phaseCoherent;
    return {
      repetition,
      focusStrategy,
      safe,
      safetyPredicates,
      phaseCoherent,
      commandId,
      traceId,
      branch,
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      sessionId,
      terminalTargetId: hostEntry.terminalTargetId,
      ptyId: hostEntry.ptyId,
      ptyInstanceId: hostEntry.ptyInstanceId,
      observerPid,
      sampledReconcileReason: health.lastReconcile?.reason ?? null,
      uiPid,
      launchToDashboardMs: dashboardReadyAt - launchStartedAt,
      intentToOptimisticMs: optimisticAt - intentAt,
      intentToCommandAcceptedMs: commandAcceptedAt - intentAt,
      intentToCommandCompletedMs: commandCompletedAt - intentAt,
      intentToHostReadyMs: hostReadyAt - intentAt,
      intentToCanonicalUiMs: canonicalUiAt - intentAt,
      intentToFocusMs: focusAt - intentAt,
      focusToOverlayDismissedMs: overlayDismissedAt - focusAt,
      overlayDismissedToInputSentMs: inputSentAt - overlayDismissedAt,
      inputSentToAckMs: inputAcknowledgedAt - inputSentAt,
      focusToInputAckMs,
      phaseSumMs,
      intentToInteractiveMs: inputAcknowledgedAt - intentAt,
      launchToInteractiveMs: inputAcknowledgedAt - launchStartedAt,
      cleanupInventoryCount,
      gitCleanupInventoryCount,
      uiStoppedCleanly,
      observerStoppedCleanly,
      uiStderrEmpty: uiStderr.length === 0,
      uiStderr,
      loadAverage: { before: loadBefore, after: loadavg() },
      resourceUsage: resourceDelta(usageBefore, process.resourceUsage()),
    };
  } finally {
    await subscription?.return?.().catch(() => undefined);
    await viewer?.detach().catch(() => undefined);
    await ptyClient?.close().catch(() => undefined);
    await killTmuxSession(env, sessionName).catch(() => undefined);
    if (!observerStoppedCleanly) {
      const cleanupClient = createObserverClient({
        socketPath: fixture.observerSocketPath,
        timeoutMs: 3_000,
      });
      await cleanupClient.stop().catch(() => undefined);
    }
  }
}

async function launchNativeStation(input: {
  env: RealE2eEnvironment;
  fixture: BenchmarkFixture;
  sessionName: string;
  stderrPath: string;
}) {
  const command = [
    "exec",
    "env",
    "-u",
    "TMUX",
    "-u",
    "TMUX_PANE",
    "-u",
    "STATION_PANE",
    "-u",
    "STATION_TUI_POPUP",
    "-u",
    "STATION_TUI_PERSISTENT",
    `STATION_CONFIG_PATH=${shellQuote(input.fixture.configPath)}`,
    `STATION_OBSERVER_SOCKET_PATH=${shellQuote(input.fixture.observerSocketPath)}`,
    `STATION_HOST_SOCKET_PATH=${shellQuote(input.fixture.hostSocketPath)}`,
    `STATION_LAYOUT_PATH=${shellQuote(join(input.fixture.stateDir, "station", "layout.json"))}`,
    shellQuote(binaryPath),
    "--config",
    shellQuote(input.fixture.configPath),
    `2>>${shellQuote(input.stderrPath)}`,
  ].join(" ");
  await execFileAsync(
    tmuxCommand,
    [
      "new-session",
      "-d",
      "-s",
      input.sessionName,
      "-x",
      String(dimensions.columns),
      "-y",
      String(dimensions.rows),
      "-c",
      input.fixture.repositoryRoot,
      command,
    ],
    { timeout: 10_000 },
  );
  await execFileAsync(tmuxCommand, ["set-option", "-t", input.sessionName, "mouse", "on"], {
    timeout: 10_000,
  });
  const pane = await execFileAsync(
    tmuxCommand,
    ["display-message", "-p", "-t", input.sessionName, "#{pane_pid}\t#{pane_id}"],
    { timeout: 10_000 },
  );
  const [panePidText, target] = pane.stdout.trim().split("\t");
  const panePid = Number(panePidText);
  if (!Number.isInteger(panePid) || panePid <= 0 || target === undefined) {
    throw new Error("Compiled native TUI tmux pane did not expose process identity.");
  }
  return { panePid, target };
}

async function waitForEvent(
  iterator: AsyncIterator<StationEvent>,
  predicate: (event: StationEvent) => boolean,
  timeoutMs: number,
  message: string,
) {
  return withTimeout(
    (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error("Observer event subscription ended unexpectedly.");
        if (predicate(next.value)) return next.value;
      }
    })(),
    timeoutMs,
    message,
  );
}

async function waitForSnapshot<T>(
  client: ObserverClient,
  project: (snapshot: StationSnapshot) => T | undefined,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    const value = project(await client.getSnapshot({ includeDebug: true }));
    if (value !== undefined) return value;
    await delay(5);
  }
  throw new Error(message);
}

async function waitForHostEntry(
  client: ReturnType<typeof createStationHostClient>,
  predicate: (entry: HostListEntry) => boolean,
  timeoutMs: number,
) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    const matches = (await client.list()).filter(predicate);
    if (matches.length === 1 && matches[0] !== undefined) return matches[0];
    if (matches.length > 1) throw new Error("Multiple Host PTYs matched one Quick Session.");
    await delay(5);
  }
  throw new Error("Compiled native Quick Session did not publish its exact Host PTY.");
}

async function waitForFrame(
  env: RealE2eEnvironment,
  target: string,
  predicate: (frame: string) => boolean,
  timeoutMs: number,
  message: string,
) {
  const deadline = performance.now() + timeoutMs;
  let lastFrame = "";
  while (performance.now() <= deadline) {
    lastFrame = await captureTmuxPane({
      env,
      target,
      preserveTrailingSpaces: true,
      visibleOnly: true,
    }).catch(() => "");
    if (predicate(lastFrame)) return lastFrame;
    await delay(10);
  }
  throw new Error(`${message}\nLast frame:\n${lastFrame}`);
}

async function waitForOutput(client: AttachedTmuxPtyClient, marker: string, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    if (client.outputTail().includes(marker)) return;
    await delay(1);
  }
  throw new Error(`Compiled native TUI did not render ${JSON.stringify(marker)}.`);
}

function cellForText(frame: string, needle: string) {
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes(needle));
  const column = row < 0 ? -1 : (lines[row]?.indexOf(needle) ?? -1);
  if (row < 0 || column < 0) {
    throw new Error(`Native frame does not contain ${JSON.stringify(needle)}.`);
  }
  return { column: column + Math.floor(needle.length / 2) + 1, row: row + 1 };
}

function sgrMouse(code: number, cell: { column: number; row: number }, final: "M" | "m" = "M") {
  return Buffer.from(`\u001B[<${code};${cell.column};${cell.row}${final}`, "utf8");
}

async function writeSgrClick(client: AttachedTmuxPtyClient, cell: { column: number; row: number }) {
  await client.write(sgrMouse(0, cell));
  await client.write(sgrMouse(0, cell, "m"));
}

function replayData(attachment: HostAttachment) {
  return attachment.ack.replay.events
    .filter((event) => event.type === "data")
    .map((event) => event.data)
    .join("");
}

async function readUntilMarker(
  iterator: AsyncIterator<HostFrame>,
  initial: string,
  marker: string,
  timeoutMs: number,
) {
  let output = initial;
  const deadline = performance.now() + timeoutMs;
  while (!output.includes(marker) && performance.now() <= deadline) {
    const remaining = Math.max(1, deadline - performance.now());
    const next = await withTimeout(iterator.next(), remaining, `Timed out waiting for ${marker}.`);
    if (next.done) break;
    if (next.value.type === "data") output += next.value.data;
  }
  if (!output.includes(marker)) throw new Error(`Host output did not contain ${marker}.`);
  return output;
}

async function waitForTmuxExit(env: RealE2eEnvironment, sessionName: string, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    if (!(await tmuxSessionExists(env, sessionName))) return true;
    await delay(20);
  }
  return false;
}

async function waitForPidExit(pid: number, timeoutMs: number) {
  if (pid <= 0) return false;
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await delay(20);
  }
  return false;
}

async function waitForExit(child: ChildProcess | undefined, timeoutMs: number) {
  if (child === undefined) throw new Error("Station Host child process was not captured.");
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return withTimeout(
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    }),
    timeoutMs,
    "Station Host did not exit before timeout.",
  );
}

async function stopHostRuntime(runtime: ReturnType<typeof createHostRuntime>) {
  const live = await runtime.client.list().catch(() => []);
  for (const entry of live) {
    await runtime.client.close(entry.ptyId).catch(() => undefined);
  }
  await runtime.client.stopIfIdle(runtime.expectedBuildVersion).catch(() => undefined);
  const child = runtime.child();
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await waitForExit(child, 2_000).catch(async () => {
      child.kill("SIGKILL");
      await waitForExit(child, 2_000).catch(() => undefined);
    });
  }
  runtime.client.dispose();
}

function summarizeRuns(runs: BenchmarkRun[]) {
  return {
    launchToDashboardMs: distribution(runs.map((run) => run.launchToDashboardMs)),
    intentToOptimisticMs: distribution(runs.map((run) => run.intentToOptimisticMs)),
    intentToCommandAcceptedMs: distribution(runs.map((run) => run.intentToCommandAcceptedMs)),
    intentToCommandCompletedMs: distribution(runs.map((run) => run.intentToCommandCompletedMs)),
    intentToHostReadyMs: distribution(runs.map((run) => run.intentToHostReadyMs)),
    intentToCanonicalUiMs: distribution(runs.map((run) => run.intentToCanonicalUiMs)),
    intentToFocusMs: distribution(runs.map((run) => run.intentToFocusMs)),
    focusToOverlayDismissedMs: distribution(runs.map((run) => run.focusToOverlayDismissedMs)),
    overlayDismissedToInputSentMs: distribution(
      runs.map((run) => run.overlayDismissedToInputSentMs),
    ),
    inputSentToAckMs: distribution(runs.map((run) => run.inputSentToAckMs)),
    focusToInputAckMs: distribution(runs.map((run) => run.focusToInputAckMs)),
    intentToInteractiveMs: distribution(runs.map((run) => run.intentToInteractiveMs)),
    launchToInteractiveMs: distribution(runs.map((run) => run.launchToInteractiveMs)),
  };
}

function summarizeFocusComparison(runs: BenchmarkRun[]) {
  const escapeRuns = runs.filter((run) => run.focusStrategy === "escape");
  const toggleRuns = runs.filter((run) => run.focusStrategy === "toggle");
  const summarizeStrategy = (strategyRuns: BenchmarkRun[]) => ({
    runs: strategyRuns.length,
    focusToOverlayDismissedMs: distribution(
      strategyRuns.map((run) => run.focusToOverlayDismissedMs),
    ),
    inputSentToAckMs: distribution(strategyRuns.map((run) => run.inputSentToAckMs)),
    focusToInputAckMs: distribution(strategyRuns.map((run) => run.focusToInputAckMs)),
    intentToInteractiveMs: distribution(strategyRuns.map((run) => run.intentToInteractiveMs)),
  });
  const escapeSummary = summarizeStrategy(escapeRuns);
  const toggleSummary = summarizeStrategy(toggleRuns);
  return {
    escape: escapeSummary,
    toggle: toggleSummary,
    focusToInputAckP95ImprovementFraction: improvement(
      escapeSummary.focusToInputAckMs.p95,
      toggleSummary.focusToInputAckMs.p95,
    ),
  };
}

function emptyDistributions() {
  return summarizeRuns([]);
}

function improvement(baseline: number, candidate: number) {
  return baseline === 0 ? 0 : (baseline - candidate) / baseline;
}

async function gitWorktreeCount(root: string) {
  const result = await runCommand("git", ["worktree", "list", "--porcelain"], root);
  return result.stdout.split("\n").filter((line) => line.startsWith("worktree ")).length;
}

async function runCommand(command: string, args: string[], cwd?: string) {
  return execFileAsync(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  });
}

function requestIdFactory(repetition: number) {
  let sequence = 0;
  return () => `req_compiled_tui_${repetition}_${++sequence}`;
}

function resourceDelta(before: NodeJS.ResourceUsage, after: NodeJS.ResourceUsage) {
  return {
    userCpuMs: (after.userCPUTime - before.userCPUTime) / 1000,
    systemCpuMs: (after.systemCPUTime - before.systemCPUTime) / 1000,
    fsReads: after.fsRead - before.fsRead,
    fsWrites: after.fsWrite - before.fsWrite,
    voluntaryContextSwitches: after.voluntaryContextSwitches - before.voluntaryContextSwitches,
    involuntaryContextSwitches:
      after.involuntaryContextSwitches - before.involuntaryContextSwitches,
  };
}

function unavailableHostError(handle: Exclude<StationHostHandle, { status: "running" }>) {
  return new Error(handle.error.message);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function delay(ms: number) {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function pathExists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

function diagnosticError(error: unknown) {
  const parsed = z.object({ message: z.string().min(1) }).safeParse(error);
  return parsed.success ? parsed.data.message : "Unknown compiled native TUI benchmark failure.";
}
