import { type ChildProcess, execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { arch, cpus, loadavg, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createStationHostClient,
  HOST_PROTOCOL_VERSION,
  type HostAttachment,
  type HostFrame,
  type HostPtyAttachExpectation,
} from "@station/host";
import { ProviderRegistry, runObserverMain } from "@station/observer/internal";
import { createObserverClient, type ObserverClient } from "@station/protocol";
import {
  type ExternalCommandRunner,
  nodeExternalCommandRunner,
  stationBuildInfo,
} from "@station/runtime";
import {
  createStationHostController,
  type SpawnStationHostInput,
  type StationHostHandle,
} from "@station/terminal";
import { FakeHarnessProvider, FakeTerminalProvider } from "@station/testing";
import { WorktrunkProvider } from "@station/worktrunk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { distribution } from "./statistics.js";

const execFileAsync = promisify(execFile);
const runCrossProcessObserver =
  process.env.STATION_REAL_COMPILED_HOST_OBSERVER_CROSS_PROCESS === "1";
const runLiveObserverPhases = process.env.STATION_REAL_COMPILED_HOST_RESTART_PHASES === "1";
const runLiveObserverRestart =
  process.env.STATION_REAL_COMPILED_HOST_RESTART_LIVE === "1" ||
  runLiveObserverPhases ||
  runCrossProcessObserver;
const runObserverComposition =
  process.env.STATION_REAL_COMPILED_HOST_PREWARM_OBSERVER === "1" || runLiveObserverRestart;
const runCompiledCached =
  process.env.STATION_REAL_COMPILED_HOST_PREWARM_CACHED === "1" || runObserverComposition;
const runCompiled = process.env.STATION_REAL_COMPILED_HOST_PREWARM === "1" || runCompiledCached;
const runReal = process.env.STATION_REAL_HOST_PREWARM === "1" || runCompiled;
const describeReal = runReal ? describe : describe.skip;
const outputPath = resolve(
  z
    .string()
    .min(1)
    .parse(
      process.env.STATION_REAL_HOST_PREWARM_OUTPUT ??
        (runCompiled
          ? runObserverComposition
            ? runLiveObserverRestart
              ? runLiveObserverPhases
                ? ".dev-state/performance/quick-session/compiled-host-observer-restart-phases.real.json"
                : runCrossProcessObserver
                  ? ".dev-state/performance/quick-session/compiled-host-observer-cross-process.real.json"
                  : ".dev-state/performance/quick-session/compiled-host-observer-restart-live.real.json"
              : ".dev-state/performance/quick-session/compiled-host-prewarm-observer.real.json"
            : runCompiledCached
              ? ".dev-state/performance/quick-session/compiled-host-prewarm-cached.real.json"
              : ".dev-state/performance/quick-session/compiled-host-prewarm.real.json"
          : ".dev-state/performance/quick-session/host-prewarm-comparison.real.json"),
    ),
);
const worktrunkCommand = process.env.STATION_WORKTRUNK_BIN ?? "wt";
const bunCommand = process.env.STATION_BUN ?? "bun";
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const stationRoot = fileURLToPath(new URL("../../../station/", import.meta.url));
const hostEntry = fileURLToPath(new URL("../../../station/src/host/hostMain.ts", import.meta.url));
const binaryPath = fileURLToPath(new URL("../../../station/dist/bin/stn", import.meta.url));
const buildIdentityPath = fileURLToPath(
  new URL("../../../packages/runtime/dist/station-build-id", import.meta.url),
);
const packageJsonPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
const repetitions = runLiveObserverPhases || runCrossProcessObserver ? 10 : 5;
const ordinaryLinkedWorktrees = 48;
const expectedInventoryCount = ordinaryLinkedWorktrees + 1;
let expectedBuildVersion = !runReal || runCompiled ? "" : stationBuildInfo().version;
let expectedObserverBuildVersion = "";
let binaryBuildMs = 0;
let binaryBytes = 0;
const strategies = ["onDemand", "prewarmed"] as const;
const phaseNames = [
  "intentToEnsureStart",
  "ensureCall",
  "ensureToHealth",
  "healthToSpawn",
  "spawnToAttach",
  "attachToReady",
  "readyToInputAck",
] as const;
const keepThresholds = {
  intentToAckMedianImprovementFraction: runLiveObserverRestart ? 0.75 : runCompiled ? 0.5 : 0.6,
  intentToAckP95ImprovementFraction: runLiveObserverRestart ? 0.75 : runCompiled ? 0.5 : 0.6,
  prewarmedIntentToAckP95Ms: runCompiledCached ? 100 : runCompiled ? 300 : 100,
  prewarmedEnsureP95Ms: 25,
  startupScanMaximumRegressionFraction: 0.1,
  observerStartupMaximumRegressionFraction: 0.1,
  minimumPrewarmSettledBeforeIntentCount: runLiveObserverRestart ? 0 : runCompiled ? 4 : 0,
  minimumHostHealthyBeforeObserverCount: runLiveObserverRestart ? repetitions : 0,
} as const;

const WorktrunkPayloadSchema = z.array(z.record(z.string(), z.unknown()));
const WorktrunkInventoryRecordSchema = z
  .object({ path: z.string().min(1), branch: z.string().min(1) })
  .strict();

type Strategy = (typeof strategies)[number];
type StrategyRun = Awaited<ReturnType<typeof runStrategy>>;
let processExitSpy: ReturnType<typeof vi.spyOn> | undefined;

describeReal("real Station Host startup prewarm", () => {
  beforeAll(async () => {
    if (runObserverComposition && !runCrossProcessObserver) {
      processExitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as typeof process.exit);
    }
    await access(hostEntry);
    if (runCompiled) {
      const packageJson = z
        .object({ version: z.string().min(1) })
        .passthrough()
        .parse(JSON.parse(await readFile(packageJsonPath, "utf8")));
      expectedBuildVersion = packageJson.version;
      const buildStartedAt = performance.now();
      await execFileAsync("pnpm", ["build:binary", "--version", expectedBuildVersion], {
        cwd: repoRoot,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 300_000,
      });
      binaryBuildMs = performance.now() - buildStartedAt;
      binaryBytes = (await stat(binaryPath)).size;
      const buildIdentity = z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .parse((await readFile(buildIdentityPath, "utf8")).trim());
      expectedObserverBuildVersion = `${expectedBuildVersion}+station.${buildIdentity}`;
      return;
    }
    await execFileAsync(join(stationRoot, "scripts/link-station-packages.sh"), [], {
      cwd: stationRoot,
    });
    await execFileAsync(join(stationRoot, "scripts/repair-node-pty.sh"), [], {
      cwd: stationRoot,
    });
    await execFileAsync(bunCommand, ["run", "build:ctty-helper"], { cwd: stationRoot });
  }, 310_000);

  afterAll(() => {
    processExitSpy?.mockRestore();
  });

  it("compares on-demand Host launch with ensure concurrent to startup discovery", async () => {
    const report = {
      schemaVersion: 1,
      benchmark: runCompiled
        ? runObserverComposition
          ? runLiveObserverRestart
            ? runLiveObserverPhases
              ? "station-quick-session-compiled-host-observer-restart-phase-attribution"
              : runCrossProcessObserver
                ? "station-quick-session-compiled-host-observer-cross-process"
                : "station-quick-session-compiled-host-observer-restart-live-comparison"
            : "station-quick-session-compiled-host-prewarm-observer-comparison"
          : runCompiledCached
            ? "station-quick-session-compiled-host-prewarm-cached-comparison"
            : "station-quick-session-compiled-host-prewarm-comparison"
        : "station-quick-session-host-prewarm-comparison",
      generatedAt: new Date().toISOString(),
      machine: {
        platform: platform(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
      },
      tools: {
        bun: (await execFileAsync(bunCommand, ["--version"])).stdout.trim(),
        worktrunk: (await execFileAsync(worktrunkCommand, ["--version"])).stdout.trim(),
        hostProtocolVersion: HOST_PROTOCOL_VERSION,
        hostBuildVersion: expectedBuildVersion,
        observerBuildVersion: runCrossProcessObserver ? expectedObserverBuildVersion : null,
      },
      repositoryShape: {
        repetitions,
        worktrees: expectedInventoryCount,
        lifecycleHooks: false,
        cachedHostStateSeeded: runCompiledCached,
        actualObserverRuntime: runObserverComposition,
        liveHostPreservedAcrossObserverRestart: runLiveObserverRestart,
      },
      binary: runCompiled
        ? {
            buildMs: binaryBuildMs,
            bytes: binaryBytes,
            buildExcludedFromLaunchTiming: true,
          }
        : null,
      keepThresholds,
      strategies: {
        onDemand: { runs: [] as StrategyRun[] },
        prewarmed: { runs: [] as StrategyRun[] },
      },
      repetitions: [] as Array<{
        repetition: number;
        strategyOrder: Strategy[];
        repositoryRootRemoved: boolean;
      }>,
      medianImprovementFraction: 0,
      p95ImprovementFraction: 0,
      startupScanMedianRegressionFraction: 0,
      startupScanP95RegressionFraction: 0,
      observerStartupMedianRegressionFraction: null as number | null,
      observerStartupP95RegressionFraction: null as number | null,
      prewarmSettledBeforeIntentCount: 0,
      hostHealthyBeforeObserverCount: 0,
      phaseAttribution: null as ReturnType<typeof summarizePhaseAttribution> | null,
      allSafe: false,
      thresholdsPassed: false,
      failure: null as string | null,
    };

    try {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const repositoryRoot = await mkdtemp(join(tmpdir(), "station-host-prewarm-repo-"));
        let repositoryRootRemoved = false;
        try {
          const fixture = await createShapedRepository(repositoryRoot);
          const strategyOrder: Strategy[] =
            runLiveObserverPhases || runCrossProcessObserver
              ? ["prewarmed"]
              : repetition % 2 === 0
                ? [...strategies]
                : [...strategies].reverse();
          for (const strategy of strategyOrder) {
            report.strategies[strategy].runs.push(
              await runStrategy({ strategy, repetition, ...fixture }),
            );
          }
          report.repetitions.push({ repetition, strategyOrder, repositoryRootRemoved: false });
        } finally {
          await rm(repositoryRoot, { recursive: true, force: true });
          repositoryRootRemoved = !(await pathExists(repositoryRoot));
          const recorded = report.repetitions.find((entry) => entry.repetition === repetition);
          if (recorded !== undefined) recorded.repositoryRootRemoved = repositoryRootRemoved;
        }
      }
    } catch (error) {
      report.failure = diagnosticError(error);
    }

    const onDemand = summarize(report.strategies.onDemand.runs);
    const prewarmed = summarize(report.strategies.prewarmed.runs);
    Object.assign(report.strategies.onDemand, onDemand);
    Object.assign(report.strategies.prewarmed, prewarmed);
    report.medianImprovementFraction = improvement(
      onDemand.intentToInputAckMs.median,
      prewarmed.intentToInputAckMs.median,
    );
    report.p95ImprovementFraction = improvement(
      onDemand.intentToInputAckMs.p95,
      prewarmed.intentToInputAckMs.p95,
    );
    report.startupScanMedianRegressionFraction = regression(
      onDemand.startupScanMs.median,
      prewarmed.startupScanMs.median,
    );
    report.startupScanP95RegressionFraction = regression(
      onDemand.startupScanMs.p95,
      prewarmed.startupScanMs.p95,
    );
    if (onDemand.observerStartupMs !== null && prewarmed.observerStartupMs !== null) {
      report.observerStartupMedianRegressionFraction = regression(
        onDemand.observerStartupMs.median,
        prewarmed.observerStartupMs.median,
      );
      report.observerStartupP95RegressionFraction = regression(
        onDemand.observerStartupMs.p95,
        prewarmed.observerStartupMs.p95,
      );
    }
    report.prewarmSettledBeforeIntentCount = report.strategies.prewarmed.runs.filter(
      (run) => run.ensureSettledBeforeIntent,
    ).length;
    report.hostHealthyBeforeObserverCount = report.strategies.prewarmed.runs.filter(
      (run) => run.hostHealthyBeforeObserver,
    ).length;
    report.phaseAttribution = summarizePhaseAttribution(report.strategies.prewarmed.runs);
    report.allSafe =
      report.failure === null &&
      report.repetitions.length === repetitions &&
      report.repetitions.every((entry) => entry.repositoryRootRemoved) &&
      [...report.strategies.onDemand.runs, ...report.strategies.prewarmed.runs].every(
        (run) => run.safe,
      );
    report.thresholdsPassed = runCrossProcessObserver
      ? report.strategies.prewarmed.runs.length === repetitions &&
        report.strategies.prewarmed.runs.every((run) => run.phaseCoherent) &&
        prewarmed.intentToInputAckMs.median <= 50 &&
        prewarmed.intentToInputAckMs.p95 <= 100 &&
        report.phaseAttribution.distributions.intentToEnsureStart.p95 <= 10 &&
        prewarmed.ensureMs.p95 <= 25 &&
        prewarmed.observerStartupMs !== null &&
        prewarmed.observerStartupMs.p95 <= 1_500
      : runLiveObserverPhases
        ? report.strategies.prewarmed.runs.length === repetitions &&
          report.strategies.prewarmed.runs.every((run) => run.phaseCoherent) &&
          report.phaseAttribution.dominantP95Fraction >= 0.6 &&
          report.phaseAttribution.dominantSlowSampleCount >= 2
        : report.medianImprovementFraction >= keepThresholds.intentToAckMedianImprovementFraction &&
          report.p95ImprovementFraction >= keepThresholds.intentToAckP95ImprovementFraction &&
          prewarmed.intentToInputAckMs.p95 <= keepThresholds.prewarmedIntentToAckP95Ms &&
          (!runLiveObserverRestart ||
            prewarmed.ensureMs.p95 <= keepThresholds.prewarmedEnsureP95Ms) &&
          report.startupScanMedianRegressionFraction <=
            keepThresholds.startupScanMaximumRegressionFraction &&
          report.startupScanP95RegressionFraction <=
            keepThresholds.startupScanMaximumRegressionFraction &&
          (!runObserverComposition ||
            (report.observerStartupMedianRegressionFraction !== null &&
              report.observerStartupP95RegressionFraction !== null &&
              report.observerStartupMedianRegressionFraction <=
                keepThresholds.observerStartupMaximumRegressionFraction &&
              report.observerStartupP95RegressionFraction <=
                keepThresholds.observerStartupMaximumRegressionFraction)) &&
          report.prewarmSettledBeforeIntentCount >=
            keepThresholds.minimumPrewarmSettledBeforeIntentCount &&
          report.hostHealthyBeforeObserverCount >=
            keepThresholds.minimumHostHealthyBeforeObserverCount;

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`[real Host prewarm comparison] ${outputPath}\n`);

    expect(report.failure).toBeNull();
    expect(report.allSafe).toBe(true);
    expect(report.thresholdsPassed).toBe(true);
  }, 600_000);
});

async function createShapedRepository(temporaryRoot: string) {
  const benchmarkRoot = await realpath(temporaryRoot);
  const root = join(benchmarkRoot, "repo");
  const shapeRoot = join(benchmarkRoot, "shape");
  const worktrunkConfigPath = join(benchmarkRoot, "worktrunk.toml");
  const stationConfigPath = join(benchmarkRoot, "station.toml");
  const terminalProvider = runCrossProcessObserver ? "noop-terminal" : "fake-terminal";
  const harnessProvider = runCrossProcessObserver ? "noop-harness" : "fake-harness";
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(shapeRoot, { recursive: true }),
    writeFile(worktrunkConfigPath, "", "utf8"),
  ]);
  await runCommand("git", ["init", "--initial-branch=main", "--quiet"], { cwd: root });
  await runCommand("git", ["config", "user.name", "Station Benchmark"], { cwd: root });
  await runCommand("git", ["config", "user.email", "station-benchmark@example.invalid"], {
    cwd: root,
  });
  await runCommand("git", ["commit", "--allow-empty", "--message=baseline", "--quiet"], {
    cwd: root,
  });
  for (let index = 0; index < ordinaryLinkedWorktrees; index += 1) {
    await runCommand(
      "git",
      [
        "worktree",
        "add",
        "--quiet",
        "-b",
        `shape-${index}`,
        join(shapeRoot, `shape-${index}`),
        "main",
      ],
      { cwd: root },
    );
  }
  await writeFile(
    stationConfigPath,
    [
      "schema_version = 1",
      "",
      "[defaults]",
      'worktree_provider = "worktrunk"',
      `terminal = ${JSON.stringify(terminalProvider)}`,
      `harness = ${JSON.stringify(harnessProvider)}`,
      'layout = "agent-shell"',
      'default_branch = "main"',
      "",
      "[worktree.worktrunk]",
      `command = ${JSON.stringify(worktrunkCommand)}`,
      `config_path = ${JSON.stringify(worktrunkConfigPath)}`,
      "use_lifecycle_hooks = false",
      'hook_mode = "disabled"',
      "",
      "[[projects]]",
      'id = "host-prewarm-project"',
      'label = "Host prewarm project"',
      `root = ${JSON.stringify(root)}`,
      'default_branch = "main"',
      "",
      "[projects.defaults]",
      `harness = ${JSON.stringify(harnessProvider)}`,
      `terminal = ${JSON.stringify(terminalProvider)}`,
      'layout = "agent-shell"',
      "",
      "[projects.worktrunk]",
      "enabled = true",
      'base = "main"',
      `managed_root = ${JSON.stringify(shapeRoot)}`,
      "include_main = true",
      "include_external = true",
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, worktrunkConfigPath, stationConfigPath };
}

async function runStrategy(input: {
  strategy: Strategy;
  repetition: number;
  root: string;
  worktrunkConfigPath: string;
  stationConfigPath: string;
}) {
  const hostRoot = await mkdtemp(join("/tmp", "st-hpw-"));
  let seed:
    | Awaited<ReturnType<typeof seedCompiledHost>>
    | Awaited<ReturnType<typeof seedCompiledHostWithPty>>
    | null = null;
  if (runCompiledCached && !runLiveObserverRestart) {
    try {
      seed = await seedCompiledHost(hostRoot);
    } catch (error) {
      await rm(hostRoot, { recursive: true, force: true });
      throw error;
    }
  }
  const socketPath = join(hostRoot, "host.sock");
  const client = createStationHostClient({
    socketPath,
    expectedBuildVersion,
    timeoutMs: 5_000,
  });
  let child: ChildProcess | undefined;
  let hostStderr = "";
  let spawnCount = 0;
  const controller = createStationHostController(
    {
      socketPath,
      stateDir: hostRoot,
      hostCommand: runCompiled
        ? [binaryPath, "__station-host", "--build-version", expectedBuildVersion]
        : [bunCommand, hostEntry],
      expectedBuildVersion,
      timeoutMs: 5_000,
    },
    {
      clientFactory: () => client,
      spawnHost: (spawnInput: SpawnStationHostInput) => {
        spawnCount += 1;
        child = spawn(spawnInput.argv[0], spawnInput.argv.slice(1), {
          stdio: ["ignore", "ignore", "pipe"],
          env: {
            ...process.env,
            STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE: "1",
            STATION_PTY_IMPL: "bun",
          },
        });
        child.stderr?.on("data", (data: Buffer) => {
          if (hostStderr.length < 16_384) hostStderr += data.toString("utf8");
        });
        return child;
      },
    },
  );
  let hostHealthyBeforeObserver = false;
  if (runLiveObserverRestart) {
    try {
      seed = await seedCompiledHostWithPty({
        controller,
        client,
        root: input.root,
        repetition: input.repetition,
        strategy: input.strategy,
        stopAfterWarmup: input.strategy === "onDemand",
        child: () => child,
        spawnCount: () => spawnCount,
      });
      hostHealthyBeforeObserver =
        seed.safe && "leftRunningHealthy" in seed && seed.leftRunningHealthy;
    } catch (error) {
      client.dispose();
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await waitForExit(child, 2_000).catch(() => undefined);
      }
      await rm(hostRoot, { recursive: true, force: true });
      throw error;
    }
  }
  let ensureStartedAt: number | undefined;
  let ensureSettledAt: number | undefined;
  let ensureCalls = 0;
  const ensure = () => {
    ensureCalls += 1;
    ensureStartedAt ??= performance.now();
    return controller.ensure().then((handle) => {
      ensureSettledAt = performance.now();
      return handle;
    });
  };
  let pendingEnsure: Promise<StationHostHandle> | undefined;
  const startPrewarm = () => {
    pendingEnsure ??= ensure();
    // The Observer keeps running while the shared result waits for first intent.
    void pendingEnsure.catch(() => undefined);
  };
  if (input.strategy === "prewarmed" && !runObserverComposition) startPrewarm();
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  let inventoryCount = -1;
  let scanStartedAt: number | undefined;
  let scanCompletedAt: number | undefined;
  const scanStartedAts: number[] = [];
  let scanCount = 0;
  let scanSucceeded = false;
  let intentAcceptedAt: number | undefined;
  let observerStartedAt: number | undefined;
  let observerReadyAt: number | undefined;
  let providerFactoryStartedAt: number | undefined;
  let providerFactoryCount = 0;
  let observerClient: ObserverClient | undefined;
  let observerRuntime: Promise<number> | undefined;
  let observerChild: ChildProcess | undefined;
  let observerStderr = "";
  let observerHealthMatched = false;
  let observerSnapshotMatched = false;
  let observerStoppedCleanly = false;

  if (runObserverComposition) {
    const observerSocketPath = join(hostRoot, "observer.sock");
    let requestSequence = 0;
    observerClient = createObserverClient({
      socketPath: observerSocketPath,
      expectedBuildVersion: runCrossProcessObserver
        ? expectedObserverBuildVersion
        : expectedBuildVersion,
      timeoutMs: 5_000,
      requestId: () => `req_host_prewarm_${input.repetition}_${++requestSequence}`,
    });
    if (runCrossProcessObserver) {
      observerStartedAt = performance.now();
      scanStartedAt = observerStartedAt;
      observerChild = spawn(
        binaryPath,
        [
          "__observer",
          "--config",
          input.stationConfigPath,
          "--socket",
          observerSocketPath,
          "--state-dir",
          hostRoot,
          "--startup-timeout-ms",
          "15000",
          "--build-version",
          expectedObserverBuildVersion,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      observerChild.stderr?.on("data", (data: Buffer) => {
        if (observerStderr.length < 16_384) observerStderr += data.toString("utf8");
      });
      const observerHealth = await waitForObserverHealth(observerClient, observerChild, 20_000);
      observerReadyAt = performance.now();
      scanCompletedAt = observerReadyAt;
      scanCount = 1;
      scanSucceeded = true;
      observerHealthMatched =
        observerHealth.status === "healthy" &&
        observerHealth.version === expectedObserverBuildVersion &&
        observerHealth.lastReconcile?.reason === "observer.startup";
      intentAcceptedAt = observerReadyAt;
    } else {
      let resolveReadiness: (() => void) | undefined;
      const readiness = new Promise<void>((resolvePromise) => {
        resolveReadiness = resolvePromise;
      });
      const measuredRunner: ExternalCommandRunner = async (commandInput) => {
        const measured =
          commandInput.command === worktrunkCommand && (commandInput.args ?? []).includes("list");
        if (measured) {
          scanCount += 1;
          const startedAt = performance.now();
          scanStartedAts.push(startedAt);
          scanStartedAt ??= startedAt;
        }
        try {
          const result = await nodeExternalCommandRunner(commandInput);
          if (measured) scanSucceeded = true;
          return result;
        } finally {
          if (measured) scanCompletedAt ??= performance.now();
        }
      };
      observerStartedAt = performance.now();
      observerRuntime = runObserverMain(
        [
          "--config",
          input.stationConfigPath,
          "--socket",
          observerSocketPath,
          "--state-dir",
          hostRoot,
          "--startup-timeout-ms",
          "15000",
        ],
        {
          buildVersion: expectedBuildVersion,
          providerRegistryFactory: () => {
            providerFactoryCount += 1;
            providerFactoryStartedAt = performance.now();
            if (input.strategy === "prewarmed" && !runLiveObserverRestart) startPrewarm();
            return new ProviderRegistry({
              worktree: new WorktrunkProvider({
                command: worktrunkCommand,
                configPath: input.worktrunkConfigPath,
                useLifecycleHooks: false,
                timeoutMs: 30_000,
                runner: measuredRunner,
              }),
              terminal: new FakeTerminalProvider(),
              harnesses: [new FakeHarnessProvider()],
            });
          },
          startupReadinessSink: {
            ready: () => {
              observerReadyAt ??= performance.now();
              resolveReadiness?.();
            },
          },
        },
      );
      await Promise.race([
        withTimeout(readiness, 20_000, "Observer prewarm readiness timed out."),
        observerRuntime.then((code) => {
          throw new Error(`Observer exited with code ${code} before readiness.`);
        }),
      ]);
      intentAcceptedAt = observerReadyAt;
    }
  } else {
    scanStartedAt = performance.now();
    const inventory = await scanWorktrees(input.root, input.worktrunkConfigPath);
    scanCompletedAt = performance.now();
    scanCount = 1;
    scanSucceeded = true;
    inventoryCount = inventory.length;
    intentAcceptedAt = performance.now();
  }
  let attachment: HostAttachment | undefined;
  let ptyId: string | undefined;
  let safe = false;
  let healthMatched = false;
  let exactLiveIdentity = false;
  let cleanupInventoryCount = -1;
  let stoppedCleanly = false;
  let inputAcknowledgedAt: number | undefined;
  let healthCompletedAt: number | undefined;
  let spawnCompletedAt: number | undefined;
  let attachCompletedAt: number | undefined;
  let readyObservedAt: number | undefined;
  try {
    const handle = await (pendingEnsure ?? ensure());
    if (handle.status !== "running") throw unavailableHostError(handle);
    const health = await handle.client.health();
    healthCompletedAt = performance.now();
    healthMatched =
      health.ok &&
      health.protocolVersion === HOST_PROTOCOL_VERSION &&
      health.buildVersion === expectedBuildVersion;
    const token = `${input.strategy}-${input.repetition}`;
    const readyMarker = `__STATION_PREWARM_READY_${token}__`;
    const acknowledgementPrefix = `__STATION_PREWARM_ACK_${token}__:`;
    const inputToken = `input-${token}`;
    const identity = {
      kind: "agent" as const,
      terminalTargetId: `native:host-prewarm-${token}`,
      worktreeId: `wt-host-prewarm-${token}`,
      projectId: `project-host-prewarm-${input.repetition}`,
      sessionId: `session-host-prewarm-${token}`,
      worktreePath: input.root,
      harnessProvider: "scripted",
    };
    const spawned = await handle.client.spawn({
      ...identity,
      command: "/bin/sh",
      args: [
        "-c",
        'printf "%s\\n" "$1"; IFS= read -r line || exit 31; printf "%s%s\\n" "$2" "$line"; while :; do sleep 60; done',
        "station-host-prewarm-benchmark",
        readyMarker,
        acknowledgementPrefix,
      ],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TERM: "xterm-256color",
        LC_ALL: "C",
      },
      cwd: input.root,
      cols: 80,
      rows: 24,
    });
    spawnCompletedAt = performance.now();
    ptyId = spawned.ptyId;
    const expectation: HostPtyAttachExpectation = { ...identity, ...spawned };
    attachment = await handle.client.attach(expectation, "controller");
    attachCompletedAt = performance.now();
    const iterator = attachment.frames[Symbol.asyncIterator]();
    let output = replayData(attachment);
    output = await readUntilMarker(iterator, output, readyMarker);
    readyObservedAt = performance.now();
    await attachment.write(`${inputToken}\n`);
    output = await readUntilMarker(iterator, output, `${acknowledgementPrefix}${inputToken}`);
    inputAcknowledgedAt = performance.now();
    await iterator.return?.();
    const live = await handle.client.list();
    exactLiveIdentity =
      live.length === 1 &&
      live[0]?.ptyId === spawned.ptyId &&
      live[0]?.ptyInstanceId === spawned.ptyInstanceId &&
      live[0]?.terminalTargetId === identity.terminalTargetId &&
      live[0]?.sessionId === identity.sessionId &&
      live[0]?.worktreePath === input.root;
    await attachment.detach();
    attachment = undefined;
    const closed = await handle.client.close(spawned.ptyId);
    ptyId = undefined;
    cleanupInventoryCount = (await handle.client.list()).length;
    const stop = await handle.client.stopIfIdle(expectedBuildVersion);
    if (child === undefined) throw new Error("Host ensure did not expose its child process.");
    const exit = await waitForExit(child, 5_000);
    stoppedCleanly = stop.stopping && exit.code === 0 && exit.signal === null;
    if (runObserverComposition) {
      if (observerClient === undefined) {
        throw new Error("Observer prewarm runtime was not initialized.");
      }
      const observerHealth = await observerClient.health();
      const snapshot = await observerClient.getSnapshot();
      inventoryCount = snapshot.counts.worktrees;
      observerHealthMatched =
        observerHealth.status === "healthy" &&
        observerHealth.version ===
          (runCrossProcessObserver ? expectedObserverBuildVersion : expectedBuildVersion) &&
        observerHealth.lastReconcile?.reason === "observer.startup";
      observerSnapshotMatched =
        snapshot.observer.healthy &&
        snapshot.projects.length === 1 &&
        snapshot.counts.worktrees === expectedInventoryCount;
      await observerClient.stop();
      if (runCrossProcessObserver) {
        if (observerChild === undefined) {
          throw new Error("Cross-process Observer child was not initialized.");
        }
        const observerExit = await waitForExit(observerChild, 7_000);
        observerStoppedCleanly = observerExit.code === 0 && observerExit.signal === null;
      } else {
        if (observerRuntime === undefined) {
          throw new Error("In-process Observer runtime was not initialized.");
        }
        observerStoppedCleanly =
          (await withTimeout(observerRuntime, 7_000, "Observer prewarm stop timed out.")) === 0;
      }
    }
    const discoverySafe = runCrossProcessObserver
      ? observerHealthMatched &&
        observerSnapshotMatched &&
        observerStoppedCleanly &&
        scanSucceeded &&
        observerStderr.length === 0
      : runObserverComposition
        ? observerHealthMatched &&
          observerSnapshotMatched &&
          observerStoppedCleanly &&
          providerFactoryCount === 1 &&
          scanStartedAts.filter(
            (startedAt) => observerReadyAt !== undefined && startedAt <= observerReadyAt,
          ).length === 1 &&
          scanSucceeded
        : inventoryCount === expectedInventoryCount && scanCount === 1 && scanSucceeded;
    safe =
      discoverySafe &&
      healthMatched &&
      spawnCount === (runLiveObserverRestart ? (input.strategy === "onDemand" ? 2 : 1) : 1) &&
      ensureCalls === 1 &&
      attachment === undefined &&
      exactLiveIdentity &&
      output.includes(readyMarker) &&
      output.includes(`${acknowledgementPrefix}${inputToken}`) &&
      closed.closed &&
      cleanupInventoryCount === 0 &&
      stoppedCleanly;
  } finally {
    if (!observerStoppedCleanly) {
      await observerClient?.stop().catch(() => undefined);
    }
    if (observerRuntime !== undefined && !observerStoppedCleanly) {
      await withTimeout(observerRuntime, 7_000, "Observer prewarm cleanup timed out.").catch(
        () => undefined,
      );
    }
    if (
      observerChild !== undefined &&
      observerChild.exitCode === null &&
      observerChild.signalCode === null
    ) {
      observerChild.kill("SIGTERM");
      await waitForExit(observerChild, 2_000).catch(async () => {
        observerChild?.kill("SIGKILL");
        if (observerChild !== undefined) await waitForExit(observerChild, 2_000);
      });
    }
    await attachment?.detach().catch(() => {});
    if (ptyId !== undefined) await client.close(ptyId).catch(() => {});
    client.dispose();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 2_000).catch(async () => {
        child?.kill("SIGKILL");
        if (child !== undefined) await waitForExit(child, 2_000);
      });
    }
    await rm(hostRoot, { recursive: true, force: true });
  }
  const phases = {
    intentToEnsureStart: phaseDuration(intentAcceptedAt, ensureStartedAt),
    ensureCall: phaseDuration(ensureStartedAt, ensureSettledAt),
    ensureToHealth: phaseDuration(ensureSettledAt, healthCompletedAt),
    healthToSpawn: phaseDuration(healthCompletedAt, spawnCompletedAt),
    spawnToAttach: phaseDuration(spawnCompletedAt, attachCompletedAt),
    attachToReady: phaseDuration(attachCompletedAt, readyObservedAt),
    readyToInputAck: phaseDuration(readyObservedAt, inputAcknowledgedAt),
  };
  const phaseValues = phaseNames.map((name) => phases[name]);
  const phaseSumMs = phaseValues.reduce((total, value) => total + value, 0);
  const intentToInputAckMs =
    inputAcknowledgedAt === undefined || intentAcceptedAt === undefined
      ? 0
      : inputAcknowledgedAt - intentAcceptedAt;
  const phaseCoherent =
    intentAcceptedAt !== undefined &&
    ensureSettledAt !== undefined &&
    healthCompletedAt !== undefined &&
    spawnCompletedAt !== undefined &&
    attachCompletedAt !== undefined &&
    readyObservedAt !== undefined &&
    inputAcknowledgedAt !== undefined &&
    phaseValues.every((value) => value >= 0) &&
    Math.abs(phaseSumMs - intentToInputAckMs) <= 10;
  return {
    strategy: input.strategy,
    seed,
    safe:
      safe &&
      (seed === null || seed.safe) &&
      hostStderr.length === 0 &&
      !(await pathExists(hostRoot)) &&
      ensureStartedAt !== undefined &&
      ensureSettledAt !== undefined &&
      inputAcknowledgedAt !== undefined &&
      intentAcceptedAt !== undefined &&
      scanStartedAt !== undefined &&
      scanCompletedAt !== undefined,
    inventoryCount,
    startupScanMs:
      scanStartedAt === undefined || scanCompletedAt === undefined
        ? 0
        : scanCompletedAt - scanStartedAt,
    observerStartupMs:
      observerStartedAt === undefined || observerReadyAt === undefined
        ? null
        : observerReadyAt - observerStartedAt,
    providerToReadyMs:
      providerFactoryStartedAt === undefined || observerReadyAt === undefined
        ? null
        : observerReadyAt - providerFactoryStartedAt,
    ensureMs:
      ensureStartedAt === undefined || ensureSettledAt === undefined
        ? 0
        : ensureSettledAt - ensureStartedAt,
    intentToInputAckMs,
    phases,
    phaseSumMs,
    phaseCoherent,
    ensureSettledBeforeIntent:
      ensureSettledAt !== undefined &&
      intentAcceptedAt !== undefined &&
      ensureSettledAt <= intentAcceptedAt,
    ensureSettledBeforeObserverReadiness:
      ensureSettledAt === undefined || observerReadyAt === undefined
        ? null
        : ensureSettledAt <= observerReadyAt,
    spawnCount,
    ensureCalls,
    scanCount,
    startupScanCount: runObserverComposition
      ? runCrossProcessObserver
        ? 1
        : scanStartedAts.filter(
            (startedAt) => observerReadyAt !== undefined && startedAt <= observerReadyAt,
          ).length
      : scanCount,
    scanSucceeded,
    healthMatched,
    exactLiveIdentity,
    cleanupInventoryCount,
    stoppedCleanly,
    observerHealthMatched,
    observerSnapshotMatched,
    observerStoppedCleanly,
    providerFactoryCount,
    hostHealthyBeforeObserver,
    stderrEmpty: hostStderr.length === 0,
    observerStderrEmpty: observerStderr.length === 0,
    observerProcessBoundary: runCrossProcessObserver,
    temporaryRootRemoved: !(await pathExists(hostRoot)),
    loadAverage: { before: loadBefore, after: loadavg() },
    resourceUsage: resourceDelta(usageBefore, process.resourceUsage()),
  };
}

async function seedCompiledHostWithPty(input: {
  controller: ReturnType<typeof createStationHostController>;
  client: ReturnType<typeof createStationHostClient>;
  root: string;
  repetition: number;
  strategy: Strategy;
  stopAfterWarmup: boolean;
  child: () => ChildProcess | undefined;
  spawnCount: () => number;
}) {
  const startedAt = performance.now();
  const initialSpawnCount = input.spawnCount();
  let attachment: HostAttachment | undefined;
  let ptyId: string | undefined;
  let healthMatched = false;
  let exactLiveIdentity = false;
  let inputAcknowledged = false;
  let emptyInventory = false;
  let stoppedCleanly = false;
  let leftRunningHealthy = false;
  try {
    const handle = await input.controller.ensure();
    if (handle.status !== "running") throw unavailableHostError(handle);
    const health = await handle.client.health();
    healthMatched =
      health.ok &&
      health.protocolVersion === HOST_PROTOCOL_VERSION &&
      health.buildVersion === expectedBuildVersion;
    const token = `${input.strategy}-${input.repetition}`;
    const readyMarker = `__STATION_RESTART_WARMUP_READY_${token}__`;
    const acknowledgementPrefix = `__STATION_RESTART_WARMUP_ACK_${token}__:`;
    const inputToken = `warmup-input-${token}`;
    const identity = {
      kind: "agent" as const,
      terminalTargetId: `native:restart-warmup-${token}`,
      worktreeId: `wt-restart-warmup-${token}`,
      projectId: `project-host-prewarm-${input.repetition}`,
      sessionId: `session-restart-warmup-${token}`,
      worktreePath: input.root,
      harnessProvider: "scripted",
    };
    const spawned = await handle.client.spawn({
      ...identity,
      command: "/bin/sh",
      args: [
        "-c",
        'printf "%s\\n" "$1"; IFS= read -r line || exit 31; printf "%s%s\\n" "$2" "$line"; while :; do sleep 60; done',
        "station-host-restart-warmup",
        readyMarker,
        acknowledgementPrefix,
      ],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TERM: "xterm-256color",
        LC_ALL: "C",
      },
      cwd: input.root,
      cols: 80,
      rows: 24,
    });
    ptyId = spawned.ptyId;
    const expectation: HostPtyAttachExpectation = { ...identity, ...spawned };
    attachment = await handle.client.attach(expectation, "controller");
    const iterator = attachment.frames[Symbol.asyncIterator]();
    let output = replayData(attachment);
    output = await readUntilMarker(iterator, output, readyMarker);
    await attachment.write(`${inputToken}\n`);
    output = await readUntilMarker(iterator, output, `${acknowledgementPrefix}${inputToken}`);
    inputAcknowledged = output.includes(`${acknowledgementPrefix}${inputToken}`);
    await iterator.return?.();
    const live = await handle.client.list();
    exactLiveIdentity =
      live.length === 1 &&
      live[0]?.ptyId === spawned.ptyId &&
      live[0]?.ptyInstanceId === spawned.ptyInstanceId &&
      live[0]?.terminalTargetId === identity.terminalTargetId &&
      live[0]?.sessionId === identity.sessionId &&
      live[0]?.worktreePath === input.root;
    await attachment.detach();
    attachment = undefined;
    const closed = await handle.client.close(spawned.ptyId);
    ptyId = undefined;
    emptyInventory = closed.closed && (await handle.client.list()).length === 0;
    if (input.stopAfterWarmup) {
      const stop = await handle.client.stopIfIdle(expectedBuildVersion);
      const child = input.child();
      if (child === undefined) throw new Error("Host warmup did not expose its child process.");
      const exit = await waitForExit(child, 5_000);
      stoppedCleanly = stop.stopping && exit.code === 0 && exit.signal === null;
    } else {
      const postWarmupHealth = await handle.client.health();
      leftRunningHealthy =
        postWarmupHealth.ok &&
        postWarmupHealth.protocolVersion === HOST_PROTOCOL_VERSION &&
        postWarmupHealth.buildVersion === expectedBuildVersion;
    }
  } finally {
    await attachment?.detach().catch(() => undefined);
    if (ptyId !== undefined) await input.client.close(ptyId).catch(() => undefined);
  }
  return {
    durationMs: performance.now() - startedAt,
    safe:
      input.spawnCount() === initialSpawnCount + 1 &&
      healthMatched &&
      exactLiveIdentity &&
      inputAcknowledged &&
      emptyInventory &&
      (input.stopAfterWarmup ? stoppedCleanly : leftRunningHealthy),
    spawnCount: input.spawnCount() - initialSpawnCount,
    healthMatched,
    exactLiveIdentity,
    inputAcknowledged,
    emptyInventory,
    stoppedCleanly,
    leftRunningHealthy,
  };
}

async function seedCompiledHost(hostRoot: string) {
  const socketPath = join(hostRoot, "seed.sock");
  const client = createStationHostClient({
    socketPath,
    expectedBuildVersion,
    timeoutMs: 5_000,
  });
  let child: ChildProcess | undefined;
  let stderr = "";
  let spawnCount = 0;
  const controller = createStationHostController(
    {
      socketPath,
      stateDir: hostRoot,
      hostCommand: [binaryPath, "__station-host", "--build-version", expectedBuildVersion],
      expectedBuildVersion,
      timeoutMs: 5_000,
    },
    {
      clientFactory: () => client,
      spawnHost: (spawnInput: SpawnStationHostInput) => {
        spawnCount += 1;
        child = spawn(spawnInput.argv[0], spawnInput.argv.slice(1), {
          stdio: ["ignore", "ignore", "pipe"],
          env: {
            ...process.env,
            STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE: "1",
            STATION_PTY_IMPL: "bun",
          },
        });
        child.stderr?.on("data", (data: Buffer) => {
          if (stderr.length < 16_384) stderr += data.toString("utf8");
        });
        return child;
      },
    },
  );
  const startedAt = performance.now();
  let healthMatched = false;
  let emptyInventory = false;
  let stoppedCleanly = false;
  try {
    const handle = await controller.ensure();
    if (handle.status !== "running") throw unavailableHostError(handle);
    const health = await handle.client.health();
    healthMatched =
      health.ok &&
      health.protocolVersion === HOST_PROTOCOL_VERSION &&
      health.buildVersion === expectedBuildVersion;
    emptyInventory = (await handle.client.list()).length === 0;
    const stop = await handle.client.stopIfIdle(expectedBuildVersion);
    if (child === undefined) throw new Error("Cached-state seed did not expose its Host child.");
    const exit = await waitForExit(child, 5_000);
    stoppedCleanly = stop.stopping && exit.code === 0 && exit.signal === null;
  } finally {
    client.dispose();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 2_000).catch(async () => {
        child?.kill("SIGKILL");
        if (child !== undefined) await waitForExit(child, 2_000);
      });
    }
  }
  return {
    durationMs: performance.now() - startedAt,
    safe:
      spawnCount === 1 && healthMatched && emptyInventory && stoppedCleanly && stderr.length === 0,
    spawnCount,
    healthMatched,
    emptyInventory,
    stoppedCleanly,
    stderrEmpty: stderr.length === 0,
  };
}

async function scanWorktrees(root: string, configPath: string) {
  const result = await runCommand(
    worktrunkCommand,
    ["--config", configPath, "list", "--format=json"],
    { cwd: root },
  );
  const payload = WorktrunkPayloadSchema.parse(JSON.parse(result.stdout));
  const inventory = payload.map((item) =>
    WorktrunkInventoryRecordSchema.parse({ path: item.path, branch: item.branch }),
  );
  if (
    inventory.length !== expectedInventoryCount ||
    new Set(inventory.map((entry) => entry.path)).size !== inventory.length ||
    new Set(inventory.map((entry) => entry.branch)).size !== inventory.length
  ) {
    throw new Error("Worktrunk prewarm scan returned an inexact inventory.");
  }
  return inventory;
}

function unavailableHostError(handle: Exclude<StationHostHandle, { status: "running" }>) {
  return new Error(handle.error.message);
}

function replayData(attachment: HostAttachment): string {
  return attachment.ack.replay.events
    .filter((event) => event.type === "data")
    .map((event) => event.data)
    .join("");
}

async function readUntilMarker(
  iterator: AsyncIterator<HostFrame>,
  initial: string,
  marker: string,
) {
  let output = initial;
  while (!output.includes(marker)) {
    const next = await withTimeout(iterator.next(), 5_000, "Host prewarm PTY marker timed out.");
    if (next.done) throw new Error("Host prewarm PTY ended before its marker.");
    if (next.value.type === "data") output += next.value.data;
    if (next.value.type === "exit") throw new Error("Host prewarm PTY exited before its marker.");
  }
  return output;
}

function phaseDuration(startedAt: number | undefined, completedAt: number | undefined) {
  return startedAt === undefined || completedAt === undefined ? 0 : completedAt - startedAt;
}

function summarizePhaseAttribution(runs: StrategyRun[]) {
  const distributions = Object.fromEntries(
    phaseNames.map((name) => [name, distribution(runs.map((run) => run.phases[name]))]),
  ) as Record<(typeof phaseNames)[number], ReturnType<typeof distribution>>;
  const dominantPhase = phaseNames.reduce((dominant, candidate) =>
    distributions[candidate].p95 > distributions[dominant].p95 ? candidate : dominant,
  );
  const totalP95 = distribution(runs.map((run) => run.intentToInputAckMs)).p95;
  const dominantP95Fraction = totalP95 === 0 ? 0 : distributions[dominantPhase].p95 / totalP95;
  const dominantSlowSampleCount = runs.filter(
    (run) =>
      run.intentToInputAckMs > 100 && run.phases[dominantPhase] / run.intentToInputAckMs >= 0.5,
  ).length;
  return {
    distributions,
    dominantPhase,
    totalP95,
    dominantP95Fraction,
    dominantSlowSampleCount,
    coherentRunCount: runs.filter((run) => run.phaseCoherent).length,
  };
}

function summarize(runs: StrategyRun[]) {
  const seedSamples = runs.flatMap((run) => (run.seed === null ? [] : [run.seed.durationMs]));
  const observerStartupSamples = runs.flatMap((run) =>
    run.observerStartupMs === null ? [] : [run.observerStartupMs],
  );
  const providerToReadySamples = runs.flatMap((run) =>
    run.providerToReadyMs === null ? [] : [run.providerToReadyMs],
  );
  return {
    intentToInputAckMs: distribution(runs.map((run) => run.intentToInputAckMs)),
    startupScanMs: distribution(runs.map((run) => run.startupScanMs)),
    ensureMs: distribution(runs.map((run) => run.ensureMs)),
    observerStartupMs:
      observerStartupSamples.length === 0 ? null : distribution(observerStartupSamples),
    providerToReadyMs:
      providerToReadySamples.length === 0 ? null : distribution(providerToReadySamples),
    seedMs: seedSamples.length === 0 ? null : distribution(seedSamples),
    allSeedsSafe: runs.every((run) => run.seed === null || run.seed.safe),
    allSafe: runs.every((run) => run.safe),
  };
}

function improvement(baseline: number, candidate: number) {
  return baseline === 0 ? 0 : (baseline - candidate) / baseline;
}

function regression(baseline: number, candidate: number) {
  return baseline === 0 ? 0 : (candidate - baseline) / baseline;
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

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return withTimeout(
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    }),
    timeoutMs,
    "Station Host prewarm exit timed out.",
  );
}

async function waitForObserverHealth(
  client: ObserverClient,
  child: ChildProcess,
  timeoutMs: number,
) {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  while (performance.now() <= deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Observer child exited before health (${child.exitCode ?? child.signalCode ?? "unknown"}).`,
      );
    }
    try {
      const health = await client.health();
      if (health.status === "healthy" && health.lastReconcile?.reason === "observer.startup") {
        return health;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Compiled Observer did not publish healthy startup before timeout.", {
    cause: lastError,
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

async function pathExists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

function diagnosticError(error: unknown) {
  const parsed = z.object({ message: z.string().min(1) }).safeParse(error);
  return parsed.success ? parsed.data.message : "Unknown Host prewarm benchmark failure.";
}
