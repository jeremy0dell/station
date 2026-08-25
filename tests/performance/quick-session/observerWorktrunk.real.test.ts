import { type ChildProcess, execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, loadavg, platform, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import type {
  BuildHarnessLaunchRequest,
  CreateWorktreeRequest,
  HarnessLaunchPlan,
  ProviderDoctorCheck,
  ProviderDoctorContext,
  ProviderHealth,
  ProviderProjectConfig,
  RemoveWorktreeRequest,
  RemoveWorktreeResult,
  StationEvent,
  WorktreeCapabilities,
  WorktreeObservation,
  WorktreeProvider,
} from "@station/contracts";
import { sameObservedPath } from "@station/contracts";
import {
  createStationHostClient,
  HOST_PROTOCOL_VERSION,
  type HostAttachment,
  type HostFrame,
  type HostListEntry,
  type HostPtyAttachExpectation,
  type StationHostClient,
} from "@station/host";
import {
  createCommandQueue,
  createObserverApi,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
} from "@station/observer/internal";
import {
  type ExternalCommandInput,
  type ExternalCommandRunner,
  environmentWithoutGitLocals,
  nodeExternalCommandRunner,
} from "@station/runtime";
import {
  createStationHostController,
  type StationHostController,
  StationTerminalProvider,
} from "@station/terminal";
import { createFakeHarnessRun, FakeHarnessProvider } from "@station/testing";
import { WorktrunkProvider } from "@station/worktrunk";
import { beforeAll, describe, expect, it } from "vitest";
import type { StationLogger } from "../../../apps/observer/src/stationLogger.js";
import { createWorktreeCreateCoordinator } from "../../../apps/observer/src/worktreeCreateCoordinator.js";
import { createWorktreeMutationCoordinator } from "../../../apps/observer/src/worktreeMutationCoordinator.js";
import { createUnexpectedProjectConfigWriter } from "../../../apps/observer/test/support/projectConfigWriter.js";
import {
  beginQuickSessionRecording,
  InstrumentedManagedTerminal,
  type QuickSessionSample,
  quickSessionStages,
  waitForTerminalCommand,
} from "./benchmarkHarness.js";
import { distribution } from "./statistics.js";

const execFileAsync = promisify(execFile);
const runReal = process.env.STATION_REAL_QUICK_SESSION === "1";
const describeReal = runReal ? describe : describe.skip;
const realHostPty = process.env.STATION_REAL_QUICK_SESSION_HOST_PTY === "1";
const pairedTerminalComparison = process.env.STATION_REAL_QUICK_SESSION_PAIRED_TERMINAL === "1";
const worktrunkCommand = process.env.STATION_WORKTRUNK_BIN ?? "wt";
const scenarioFilter = process.env.STATION_REAL_QUICK_SESSION_SCENARIO;
const repetitions = 3;
const linkedShapeWorktrees = 48;
const bunCommand = process.env.STATION_BUN ?? "bun";
const stationRoot = fileURLToPath(new URL("../../../station/", import.meta.url));
const hostEntry = fileURLToPath(new URL("../../../station/src/host/hostMain.ts", import.meta.url));
const hostBuildVersion = "quick-session-observer-host-pty-benchmark";
const readyMarkerPrefix = "__STATION_E2E_READY__:";
const acknowledgementMarkerPrefix = "__STATION_E2E_ACK__:";
const performanceBudgetsMs = {
  warmSingleP95: 500,
  burst5P95: 1_500,
  burst20P95: 2_500,
  worktreeObservationP95: 100,
} as const;
const endToEndPerformanceBudgetsMs = {
  warmSingleP95: 100,
  coldSingleP95: 450,
  burst5P95: 200,
  burst20P95: 550,
  worktreeObservationP95: 100,
} as const;
const hostContentionProviderRatio = 1.25;

type TerminalBoundary = "fake" | "host";

type Recorder = ReturnType<typeof beginQuickSessionRecording>;

type RealQuickSessionSample = QuickSessionSample & {
  sessionId: string;
  worktreeId: string;
  worktreePath: string;
  directWorktreeVisibleAtCommandCompletion: boolean;
  directProjectionVisibleAtHarnessReady: boolean;
  hostPty?: {
    ptyId: string;
    ptyInstanceId: string;
    terminalTargetId: string;
    readyMarkerObserved: boolean;
    inputAcknowledged: boolean;
  };
};

type ResourceDelta = {
  userCpuMs: number;
  systemCpuMs: number;
  fsReads: number;
  fsWrites: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
};

type ExternalCommandKind =
  | "git-bare-probe"
  | "git-create-verify"
  | "git-worktree-add"
  | "worktrunk-list"
  | "worktrunk-switch"
  | "other";

type ExternalCommandProfile = {
  kind: ExternalCommandKind;
  durationMs: number;
  succeeded: boolean;
};

type ExternalCommandSummary = {
  durationMs: Record<ExternalCommandKind, ReturnType<typeof distribution>>;
  totalMs: Record<ExternalCommandKind, number>;
};

type ScenarioReport = {
  name: string;
  terminalBoundary: TerminalBoundary;
  sessionsPerRun: number;
  projectsPerRun: number;
  finalInteractiveMs: ReturnType<typeof distribution>;
  allInteractiveMs: ReturnType<typeof distribution>;
  throughputPerSecond: ReturnType<typeof distribution>;
  stageContributionMs: Record<string, ReturnType<typeof distribution>>;
  scanCounts: number[];
  maxConcurrentCreates: number[];
  maxConcurrentCreatesPerProject: number[];
  resourceUsage: ResourceDelta[];
  loadAverage: Array<{ before: number[]; after: number[] }>;
  cleanupInventoryCounts: number[][];
  scanProfiles: Array<
    Array<{
      projectId: string;
      durationMs: number;
      worktrees: number;
      activeCreatesAtStart: number;
    }>
  >;
  externalCommandProfiles: ExternalCommandProfile[][];
  externalCommandSummary: ExternalCommandSummary;
  schedulerProfiles: Array<Array<Record<string, unknown>>>;
  verificationCounts: Array<{ rows: number; sessions: number }>;
  hostRuns: BenchmarkHostReport[];
  rawRuns: RealQuickSessionSample[][];
};

type BoundaryStageSummary = {
  finalInteractiveMs: ReturnType<typeof distribution>;
  providerBlockingMs: ReturnType<typeof distribution>;
  terminalWorkMs: ReturnType<typeof distribution>;
};

type BoundaryComparison = {
  name: string;
  fake: BoundaryStageSummary;
  host: BoundaryStageSummary;
  providerBlockingP95Ratio: number;
};

type BenchmarkHostReport = {
  healthMatched: boolean;
  exactLiveInventory: boolean;
  exactLiveIdentity: boolean;
  allClosed: boolean;
  cleanupInventoryCount: number;
  stoppedCleanly: boolean;
  stderrEmpty: boolean;
  temporaryRootRemoved: boolean;
};

describeReal("real Observer Quick Session with Worktrunk", () => {
  beforeAll(async () => {
    if (!realHostPty) return;
    await access(hostEntry);
    await execFileAsync(join(stationRoot, "scripts/link-station-packages.sh"), [], {
      cwd: stationRoot,
    });
    await execFileAsync(join(stationRoot, "scripts/repair-node-pty.sh"), [], {
      cwd: stationRoot,
    });
    await execFileAsync(bunCommand, ["run", "build:ctty-helper"], { cwd: stationRoot });
  }, 60_000);

  it("records warm, cold, burst, and multi-project stage distributions", async () => {
    const benchmarkParent = process.env.STATION_TEST_MACHINE_ROOT ?? tmpdir();
    const benchmarkRoot = await mkdtemp(join(benchmarkParent, "station-observer-worktrunk-"));
    let removed = false;
    try {
      const worktrunkConfigPath = join(benchmarkRoot, "worktrunk.toml");
      await writeFile(worktrunkConfigPath, "", "utf8");
      const projects = [
        await createShapedProject(benchmarkRoot, 0),
        await createShapedProject(benchmarkRoot, 1),
      ];
      const initialInventoryCounts = await Promise.all(
        projects.map((project) => gitWorktreeCount(project.root)),
      );
      expect(initialInventoryCounts).toEqual([49, 49]);

      const scenarios: ScenarioReport[] = [];
      const scenarioInputs = [
        { name: "warm-single", sessions: 1, projects: projects.slice(0, 1) },
        { name: "cold-single", sessions: 1, projects: projects.slice(0, 1), cold: true },
        { name: "burst-3", sessions: 3, projects: projects.slice(0, 1) },
        { name: "burst-5", sessions: 5, projects: projects.slice(0, 1) },
        { name: "burst-20", sessions: 20, projects: projects.slice(0, 1) },
        { name: "multi-project-parallel", sessions: 6, projects },
      ];
      const selectedInputs = scenarioInputs.filter(
        (candidate) => scenarioFilter === undefined || candidate.name === scenarioFilter,
      );
      for (const [scenarioIndex, input] of selectedInputs.entries()) {
        const terminalBoundaries: TerminalBoundary[] = pairedTerminalComparison
          ? scenarioIndex % 2 === 0
            ? ["host", "fake"]
            : ["fake", "host"]
          : [realHostPty ? "host" : "fake"];
        for (const terminalBoundary of terminalBoundaries) {
          scenarios.push(
            await runScenario({
              ...input,
              terminalBoundary,
              worktrunkConfigPath,
              initialInventoryCounts: initialInventoryCounts.slice(0, input.projects.length),
            }),
          );
        }
      }

      const boundaryComparisons = pairedTerminalComparison
        ? buildBoundaryComparisons(
            scenarios,
            selectedInputs.map((input) => input.name),
          )
        : [];
      const hostContentionClassificationPassed =
        pairedTerminalComparison &&
        comparisonNamed(boundaryComparisons, "burst-5").providerBlockingP95Ratio >=
          hostContentionProviderRatio &&
        comparisonNamed(boundaryComparisons, "burst-20").providerBlockingP95Ratio >=
          hostContentionProviderRatio;

      const report = {
        schemaVersion: 1,
        benchmark: pairedTerminalComparison
          ? "station-quick-session-observer-worktrunk-host-pty-paired"
          : realHostPty
            ? "station-quick-session-observer-worktrunk-host-pty"
            : "station-quick-session-observer-worktrunk",
        generatedAt: new Date().toISOString(),
        machine: {
          platform: platform(),
          arch: arch(),
          cpuModel: cpus()[0]?.model ?? "unknown",
          logicalCpuCount: cpus().length,
        },
        tools: {
          worktrunk: (await runCommand(worktrunkCommand, ["--version"])).trim(),
          git: (await runCommand("git", ["--version"])).trim(),
          ...(realHostPty
            ? {
                bun: (await runCommand(bunCommand, ["--version"])).trim(),
                hostProtocolVersion: HOST_PROTOCOL_VERSION,
              }
            : {}),
        },
        repositoryShape: {
          projects: projects.length,
          worktreesPerProject: initialInventoryCounts,
          lifecycleHooks: false,
        },
        performanceBudgetsMs: realHostPty ? endToEndPerformanceBudgetsMs : performanceBudgetsMs,
        terminalBoundary: pairedTerminalComparison
          ? "counterbalanced-fake-versus-warmed-bun-host-pty"
          : realHostPty
            ? "warmed-bun-host-pty"
            : "instrumented-fake",
        hostContentionProviderRatio,
        hostContentionClassificationPassed,
        boundaryComparisons,
        scenarios,
      };
      await writeReport(report);

      for (const scenario of scenarios) {
        expect(scenario.scanCounts.every((count) => count === scenario.projectsPerRun * 2)).toBe(
          true,
        );
        expect(scenario.stageContributionMs.worktreeObservation?.p95).toBeLessThanOrEqual(
          performanceBudgetsMs.worktreeObservationP95,
        );
        expect(scenario.maxConcurrentCreatesPerProject.every((count) => count <= 4)).toBe(true);
        expect(
          scenario.scanProfiles.flat().every((profile) => profile.activeCreatesAtStart === 0),
        ).toBe(true);
        expect(scenario.externalCommandProfiles.flat().every((profile) => profile.succeeded)).toBe(
          true,
        );
        expect(scenario.externalCommandSummary.durationMs["git-worktree-add"].samples).toHaveLength(
          scenario.sessionsPerRun * repetitions,
        );
        expect(
          scenario.externalCommandSummary.durationMs["git-create-verify"].samples,
        ).toHaveLength(scenario.sessionsPerRun * repetitions);
        expect(scenario.externalCommandSummary.durationMs["worktrunk-switch"].samples).toEqual([]);
        expect(
          scenario.cleanupInventoryCounts.every((counts) => counts.every((count) => count === 49)),
        ).toBe(true);
        if (realHostPty) {
          expect(scenario.hostRuns).toHaveLength(repetitions);
          expect(
            scenario.hostRuns.every(
              (host) =>
                host.healthMatched &&
                host.exactLiveInventory &&
                host.exactLiveIdentity &&
                host.allClosed &&
                host.cleanupInventoryCount === 0 &&
                host.stoppedCleanly &&
                host.stderrEmpty &&
                host.temporaryRootRemoved,
            ),
          ).toBe(true);
        } else {
          expect(scenario.hostRuns).toEqual([]);
        }
        for (const sample of scenario.rawRuns.flat()) {
          expect(sample.commandId).toMatch(/^cmd_real_/);
          expect(sample.traceId).toMatch(/^trc_/);
          expect(isAbsolute(sample.worktreePath)).toBe(true);
          expect(sample.hostPty !== undefined).toBe(scenario.terminalBoundary === "host");
          assertMonotonicStages(sample);
        }
      }
      if (scenarioFilter === undefined && !pairedTerminalComparison) {
        const activeBudgets = realHostPty ? endToEndPerformanceBudgetsMs : performanceBudgetsMs;
        expect(scenarioNamed(scenarios, "warm-single").finalInteractiveMs.p95).toBeLessThanOrEqual(
          activeBudgets.warmSingleP95,
        );
        if (realHostPty) {
          expect(
            scenarioNamed(scenarios, "cold-single").finalInteractiveMs.p95,
          ).toBeLessThanOrEqual(endToEndPerformanceBudgetsMs.coldSingleP95);
        }
        expect(scenarioNamed(scenarios, "burst-5").finalInteractiveMs.p95).toBeLessThanOrEqual(
          activeBudgets.burst5P95,
        );
        expect(scenarioNamed(scenarios, "burst-20").finalInteractiveMs.p95).toBeLessThanOrEqual(
          activeBudgets.burst20P95,
        );
      }
      if (scenarioFilter === undefined && pairedTerminalComparison) {
        expect(hostContentionClassificationPassed).toBe(true);
      }
    } finally {
      await rm(benchmarkRoot, { recursive: true, force: true });
      removed = await access(benchmarkRoot).then(
        () => false,
        () => true,
      );
    }
    expect(removed).toBe(true);
  }, 120_000);
});

function scenarioNamed(scenarios: ScenarioReport[], name: string): ScenarioReport {
  const scenario = scenarios.find((candidate) => candidate.name === name);
  if (scenario === undefined) throw new Error(`Missing real Quick Session scenario: ${name}`);
  return scenario;
}

function buildBoundaryComparisons(
  scenarios: ScenarioReport[],
  names: string[],
): BoundaryComparison[] {
  return names.map((name) => {
    const fake = summarizeBoundaryStages(boundaryScenario(scenarios, name, "fake"));
    const host = summarizeBoundaryStages(boundaryScenario(scenarios, name, "host"));
    return {
      name,
      fake,
      host,
      providerBlockingP95Ratio: host.providerBlockingMs.p95 / fake.providerBlockingMs.p95,
    };
  });
}

function boundaryScenario(
  scenarios: ScenarioReport[],
  name: string,
  terminalBoundary: TerminalBoundary,
): ScenarioReport {
  const scenario = scenarios.find(
    (candidate) => candidate.name === name && candidate.terminalBoundary === terminalBoundary,
  );
  if (scenario === undefined) {
    throw new Error(`Missing ${terminalBoundary} boundary comparison for ${name}.`);
  }
  return scenario;
}

function summarizeBoundaryStages(scenario: ScenarioReport): BoundaryStageSummary {
  const samples = scenario.rawRuns.flat();
  return {
    finalInteractiveMs: scenario.finalInteractiveMs,
    providerBlockingMs: distribution(
      samples.map(
        (sample) =>
          sample.stageMs.queueAndPreflight +
          sample.stageMs.repositoryMutation +
          sample.stageMs.worktreeObservation,
      ),
    ),
    terminalWorkMs: distribution(
      samples.map(
        (sample) =>
          sample.stageMs.launchPreparationAndSpawn +
          sample.stageMs.harnessReadiness +
          sample.stageMs.canonicalProjection +
          sample.stageMs.optimisticAndFocus,
      ),
    ),
  };
}

function comparisonNamed(comparisons: BoundaryComparison[], name: string): BoundaryComparison {
  const comparison = comparisons.find((candidate) => candidate.name === name);
  if (comparison === undefined) throw new Error(`Missing terminal comparison scenario: ${name}`);
  return comparison;
}

async function runScenario(input: {
  name: string;
  sessions: number;
  projects: ProviderProjectConfig[];
  terminalBoundary: TerminalBoundary;
  cold?: boolean;
  worktrunkConfigPath: string;
  initialInventoryCounts: number[];
}): Promise<ScenarioReport> {
  const rawRuns: RealQuickSessionSample[][] = [];
  const scanCounts: number[] = [];
  const maxConcurrentCreates: number[] = [];
  const maxConcurrentCreatesPerProject: number[] = [];
  const resourceUsage: ResourceDelta[] = [];
  const loadAverage: Array<{ before: number[]; after: number[] }> = [];
  const cleanupInventoryCounts: number[][] = [];
  const scanProfiles: ScenarioReport["scanProfiles"] = [];
  const externalCommandProfiles: ScenarioReport["externalCommandProfiles"] = [];
  const schedulerProfiles: ScenarioReport["schedulerProfiles"] = [];
  const verificationCounts: ScenarioReport["verificationCounts"] = [];
  const hostRuns: BenchmarkHostReport[] = [];

  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const benchmarkHost = realHostPty ? await startBenchmarkHost() : undefined;
    const fixture = createRealFixture(
      input.projects,
      input.worktrunkConfigPath,
      input.terminalBoundary === "host" ? benchmarkHost?.controller : undefined,
    );
    const branches = Array.from(
      { length: input.sessions },
      (_, index) => `real-${input.name}-${repetition}-${index}`,
    );
    let recorders: Recorder[];
    const samples: RealQuickSessionSample[] = [];
    let reconcileEvents: AsyncIterator<StationEvent> | undefined;
    try {
      if (input.cold === true) {
        recorders = createRecorders(branches, input.projects);
      } else {
        await fixture.startup();
        fixture.externalCommands.reset();
        recorders = createRecorders(branches, input.projects);
      }
      const usageBefore = process.resourceUsage();
      const loadBefore = loadavg();
      if (input.cold === true) await fixture.startup();
      reconcileEvents = fixture.eventBus
        .subscribe({ type: "observer.reconciled" })
        [Symbol.asyncIterator]();
      await Promise.all(
        branches.map((branch, index) => {
          const project = input.projects[index % input.projects.length];
          const recorder = recorders[index];
          if (project === undefined || recorder === undefined) {
            throw new Error("Real Quick Session benchmark could not assign a project recorder.");
          }
          return runRealQuickSession(fixture, { branch, project, recorder }).then((sample) => {
            samples.push(sample);
          });
        }),
      );
      await waitForNextEvent(reconcileEvents, "post-launch verification reconcile");
      await waitForScanCount(fixture.worktree, input.projects.length * 2);
      verificationCounts.push(assertVerifiedSnapshot(fixture, samples));
      resourceUsage.push(resourceDelta(usageBefore, process.resourceUsage()));
      loadAverage.push({ before: loadBefore, after: loadavg() });
      rawRuns.push(samples);
      scanCounts.push(fixture.worktree.scanCount);
      maxConcurrentCreates.push(fixture.worktree.maxConcurrentCreates);
      maxConcurrentCreatesPerProject.push(fixture.worktree.maxConcurrentCreatesPerProject);
      scanProfiles.push(fixture.worktree.scanProfiles);
      externalCommandProfiles.push(fixture.externalCommands.profiles());
      schedulerProfiles.push(fixture.logger.schedulerProfiles());
    } finally {
      await reconcileEvents?.return?.();
      await fixture.close();
      if (benchmarkHost !== undefined) {
        hostRuns.push(await benchmarkHost.finish(samples, input.terminalBoundary === "host"));
      }
      await cleanupCreated(input.projects, fixture.worktree.createdObservations());
      const inventoryCounts = await Promise.all(
        input.projects.map((project) => gitWorktreeCount(project.root)),
      );
      cleanupInventoryCounts.push(inventoryCounts);
      expect(inventoryCounts).toEqual(input.initialInventoryCounts);
    }
  }

  const finalInteractive = rawRuns.map((samplesForRun) =>
    Math.max(...samplesForRun.map((sample) => sample.totalMs)),
  );
  const allSamples = rawRuns.flat();
  const stageKeys = Object.keys(allSamples[0]?.stageMs ?? {}) as Array<
    keyof QuickSessionSample["stageMs"]
  >;
  const commandProfiles = externalCommandProfiles.flat();
  return {
    name: input.name,
    terminalBoundary: input.terminalBoundary,
    sessionsPerRun: input.sessions,
    projectsPerRun: input.projects.length,
    finalInteractiveMs: distribution(finalInteractive),
    allInteractiveMs: distribution(allSamples.map((sample) => sample.totalMs)),
    throughputPerSecond: distribution(
      finalInteractive.map((durationMs) => input.sessions / (durationMs / 1000)),
    ),
    stageContributionMs: Object.fromEntries(
      stageKeys.map((key) => [key, distribution(allSamples.map((sample) => sample.stageMs[key]))]),
    ),
    scanCounts,
    maxConcurrentCreates,
    maxConcurrentCreatesPerProject,
    resourceUsage,
    loadAverage,
    cleanupInventoryCounts,
    scanProfiles,
    externalCommandProfiles,
    externalCommandSummary: summarizeExternalCommands(commandProfiles),
    schedulerProfiles,
    verificationCounts,
    hostRuns,
    rawRuns,
  };
}

function createRecorders(branches: string[], projects: ProviderProjectConfig[]): Recorder[] {
  return branches.map((branch, index) => {
    const project = projects[index % projects.length];
    if (project === undefined) {
      throw new Error("Real Quick Session benchmark could not assign a project recorder.");
    }
    return beginQuickSessionRecording(branch, project.id);
  });
}

async function runRealQuickSession(
  fixture: RealFixture,
  input: { branch: string; project: ProviderProjectConfig; recorder: Recorder },
): Promise<RealQuickSessionSample> {
  fixture.worktree.registerRecorder(input.branch, input.recorder);
  input.recorder.mark("commandQueued");
  try {
    const receipt = await fixture.api.dispatch({
      type: "worktree.create",
      payload: {
        projectId: input.project.id,
        branch: input.branch,
        launchHarness: "fake-harness",
      },
    });
    const command = await waitForTerminalCommand(fixture.api, receipt.commandId, 30_000);
    if (command.status !== "succeeded") {
      throw new Error(
        `Real Quick Session command ${command.id} failed: ${command.error?.code ?? command.status}`,
      );
    }
    if (receipt.traceId === undefined) {
      throw new Error(`Real Quick Session command ${receipt.commandId} has no trace id.`);
    }
    const findRow = () =>
      fixture.core
        .getSnapshot()
        .rows.find(
          (candidate) =>
            candidate.projectId === input.project.id && candidate.branch === input.branch,
        );
    const created = fixture.worktree.createdObservation(input.branch);
    const directWorktreeVisibleAtCommandCompletion = findRow() !== undefined;
    await waitForCondition(
      () => findRow() !== undefined,
      `worktree row ${input.project.id}/${input.branch}`,
    );
    const row = findRow();
    if (
      row === undefined ||
      created === undefined ||
      row.id !== created.id ||
      !sameObservedPath(row.path, created.path)
    ) {
      throw new Error(
        `Real Quick Session ${input.project.id}/${input.branch} has inconsistent create evidence: ${JSON.stringify(
          {
            row: row === undefined ? undefined : { id: row.id, path: row.path },
            created: created === undefined ? undefined : { id: created.id, path: created.path },
          },
        )}`,
      );
    }
    input.recorder.mark("usableWorktreeObserved");
    input.recorder.mark("launchRequested");
    const prepared = await fixture.api.prepareExternalLaunch({
      projectId: input.project.id,
      worktreeId: row.id,
      harness: "fake-harness",
      title: input.branch,
    });
    if (prepared.kind !== "prepared") {
      throw new Error(`Real Quick Session ${input.branch} unexpectedly reused a session.`);
    }
    input.recorder.mark("processSpawned");
    const hostPty =
      fixture.host === undefined
        ? undefined
        : await observeHostPtyReady(fixture.host.client, {
            branch: input.branch,
            projectId: input.project.id,
            worktreeId: row.id,
            worktreePath: row.path,
            sessionId: prepared.sessionId,
            terminalTargetId: prepared.terminalTargetId,
          });
    if (fixture.host === undefined) {
      fixture.harness.addRun(
        createFakeHarnessRun({
          id: `run_${prepared.sessionId}`,
          projectId: input.project.id,
          worktreeId: row.id,
          sessionId: prepared.sessionId,
          cwd: row.path,
          state: "idle",
          now: new Date().toISOString(),
        }),
      );
    }
    input.recorder.mark("harnessReady");
    const canonicalSessionVisible = () =>
      fixture.core
        .getSnapshot()
        .sessions.some(
          (session) =>
            session.id === prepared.sessionId &&
            session.projectId === input.project.id &&
            session.worktreeId === row.id,
        );
    const directProjectionVisibleAtHarnessReady = canonicalSessionVisible();
    await waitForCondition(
      canonicalSessionVisible,
      `canonical session ${input.project.id}/${input.branch}`,
    );
    input.recorder.mark("canonicalSessionVisible");
    input.recorder.mark("optimisticRemoved");
    if (hostPty === undefined) {
      await fixture.terminal.focusTarget(prepared.terminalTargetId);
    } else {
      await acknowledgeHostPtyInput(hostPty);
    }
    input.recorder.mark("focusedAndAcceptingInput");
    const sample: RealQuickSessionSample = {
      ...input.recorder.sample(),
      commandId: receipt.commandId,
      traceId: receipt.traceId,
      sessionId: prepared.sessionId,
      worktreeId: row.id,
      worktreePath: row.path,
      directWorktreeVisibleAtCommandCompletion,
      directProjectionVisibleAtHarnessReady,
    };
    if (hostPty !== undefined) {
      sample.hostPty = {
        ptyId: hostPty.entry.ptyId,
        ptyInstanceId: hostPty.entry.ptyInstanceId,
        terminalTargetId: hostPty.entry.terminalTargetId,
        readyMarkerObserved: true,
        inputAcknowledged: true,
      };
    }
    return sample;
  } finally {
    fixture.worktree.unregisterRecorder(input.branch, input.recorder);
  }
}

type RealFixture = ReturnType<typeof createRealFixture>;

function createRealFixture(
  projects: ProviderProjectConfig[],
  worktrunkConfigPath: string,
  host?: StationHostController,
) {
  const clock = { now: () => new Date() };
  const externalCommands = new MeasuredExternalCommands();
  const worktree = new MeasuredWorktreeProvider(
    new WorktrunkProvider({
      command: worktrunkCommand,
      configPath: worktrunkConfigPath,
      useLifecycleHooks: false,
      timeoutMs: 30_000,
      runner: externalCommands.run,
    }),
  );
  const terminal =
    host === undefined ? new InstrumentedManagedTerminal() : new StationTerminalProvider({ host });
  const logger = new CollectingLogger();
  const harness =
    host === undefined
      ? new FakeHarnessProvider({
          id: "fake-harness",
          now: () => new Date().toISOString(),
        })
      : new ReadyAckHarnessProvider();
  const providers = new ProviderRegistry({
    worktree,
    terminal,
    managedTerminal: terminal,
    harnesses: [harness],
  });
  const config = realConfig(projects);
  const sqlite = openObserverSqlite({ clock });
  const ids = observerIds();
  const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
  const eventBus = createObserverEventBus();
  const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus, logger });
  const core = createObserverCore({ config, providers, persistence, clock, logger });
  const worktreeCreates = createWorktreeCreateCoordinator();
  const worktreeMutations = createWorktreeMutationCoordinator();
  registerObserverCommandHandlers({
    projectConfigWriter: createUnexpectedProjectConfigWriter(),
    queue,
    core,
    providers,
    projects,
    persistence,
    eventBus,
    clock,
    idFactory: ids,
    worktreeCreates,
    worktreeMutations,
    logger,
  });
  const metadataRefresh = {
    refresh: async () => undefined,
    shutdown: async () => undefined,
  };
  const api = createObserverApi({
    core,
    providers,
    persistence,
    persistenceHealth: persistence,
    commandQueue: queue,
    worktreeCreates,
    worktreeMutations,
    eventBus,
    diagnosticEvidenceSource: {
      collect: async () => ({
        state: { totalBytes: 0, files: 0 },
        logs: [],
        hookSpool: { pending: 0, failed: 0 },
      }),
    },
    clock,
    config,
    metadataRefresh,
    logger,
    hookReconcileDebounceMs: 100,
    interactiveReconcileDebounceMs: 25,
  });
  let started = false;
  return {
    api,
    core,
    eventBus,
    externalCommands,
    harness,
    host: host === undefined ? undefined : { client: host.client() },
    logger,
    terminal,
    worktree,
    startup: async () => {
      if (started) return;
      started = true;
      await api.reconcile("observer.startup");
      const expectedWorktrees = projects.length * (linkedShapeWorktrees + 1);
      if (core.getSnapshot().counts.worktrees !== expectedWorktrees) {
        throw new Error(
          `Real benchmark expected ${expectedWorktrees} Observer worktrees, observed ${core.getSnapshot().counts.worktrees}.`,
        );
      }
    },
    close: async () => {
      await queue.drain();
      await metadataRefresh.shutdown();
      sqlite.close();
    },
  };
}

class ReadyAckHarnessProvider extends FakeHarnessProvider {
  constructor() {
    super({ id: "fake-harness", now: () => new Date().toISOString() });
  }

  override async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    const base = await super.buildLaunch(request);
    return {
      ...base,
      command: "/bin/sh",
      args: [
        "-c",
        'printf "%s%s\\n" "$1" "$STATION_SESSION_ID"; IFS= read -r line || exit 31; printf "%s%s:%s\\n" "$2" "$STATION_SESSION_ID" "$line"; while :; do sleep 60; done',
        "station-observer-host-pty-benchmark",
        readyMarkerPrefix,
        acknowledgementMarkerPrefix,
      ],
      env: {
        ...base.env,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TERM: "xterm-256color",
        LC_ALL: "C",
      },
    };
  }
}

type PendingHostPty = {
  client: StationHostClient;
  entry: HostListEntry;
  attachment: HostAttachment;
  iterator: AsyncIterator<HostFrame>;
  output: string;
  acknowledgementMarker: string;
  inputToken: string;
};

async function observeHostPtyReady(
  client: StationHostClient,
  input: {
    branch: string;
    projectId: string;
    worktreeId: string;
    worktreePath: string;
    sessionId: string;
    terminalTargetId: string;
  },
): Promise<PendingHostPty> {
  const entry = await waitForHostEntry(client, input);
  const expectation: HostPtyAttachExpectation = {
    kind: "agent",
    ptyId: entry.ptyId,
    ptyInstanceId: entry.ptyInstanceId,
    terminalTargetId: input.terminalTargetId,
    worktreeId: input.worktreeId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    worktreePath: input.worktreePath,
    harnessProvider: "fake-harness",
  };
  const attachment = await client.attach(expectation, "controller");
  const iterator = attachment.frames[Symbol.asyncIterator]();
  const readyMarker = `${readyMarkerPrefix}${input.sessionId}`;
  let output = replayHostData(attachment);
  try {
    output = await readUntilHostMarker(iterator, output, readyMarker);
  } catch (error) {
    await iterator.return?.();
    await attachment.detach();
    throw error;
  }
  return {
    client,
    entry,
    attachment,
    iterator,
    output,
    acknowledgementMarker: `${acknowledgementMarkerPrefix}${input.sessionId}:`,
    inputToken: `input-${input.branch}`,
  };
}

async function acknowledgeHostPtyInput(pending: PendingHostPty): Promise<void> {
  try {
    await pending.attachment.write(`${pending.inputToken}\n`);
    await readUntilHostMarker(
      pending.iterator,
      pending.output,
      `${pending.acknowledgementMarker}${pending.inputToken}`,
    );
  } finally {
    await pending.iterator.return?.();
    await pending.attachment.detach();
  }
}

async function waitForHostEntry(
  client: StationHostClient,
  expected: {
    projectId: string;
    worktreeId: string;
    worktreePath: string;
    sessionId: string;
    terminalTargetId: string;
  },
): Promise<HostListEntry> {
  const deadline = performance.now() + 5_000;
  while (performance.now() <= deadline) {
    const entry = (await client.list()).find(
      (candidate) =>
        candidate.kind === "agent" &&
        candidate.alive &&
        candidate.terminalTargetId === expected.terminalTargetId &&
        candidate.projectId === expected.projectId &&
        candidate.worktreeId === expected.worktreeId &&
        candidate.worktreePath === expected.worktreePath &&
        candidate.sessionId === expected.sessionId &&
        candidate.harnessProvider === "fake-harness",
    );
    if (entry !== undefined) return entry;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for exact Host identity ${expected.terminalTargetId}.`);
}

function replayHostData(attachment: HostAttachment): string {
  return attachment.ack.replay.events
    .filter((event) => event.type === "data")
    .map((event) => event.data)
    .join("");
}

async function readUntilHostMarker(
  iterator: AsyncIterator<HostFrame>,
  initial: string,
  marker: string,
): Promise<string> {
  let output = initial;
  while (!output.includes(marker)) {
    const next = await withHostTimeout(
      iterator.next(),
      5_000,
      `Host PTY marker timed out; bounded output: ${JSON.stringify(output.slice(-512))}.`,
    );
    if (next.done) throw new Error("Host PTY frame stream ended before its marker.");
    if (next.value.type === "data") output += next.value.data;
    if (next.value.type === "exit") throw new Error("Host PTY exited before its marker.");
  }
  return output;
}

async function startBenchmarkHost(): Promise<{
  controller: StationHostController;
  finish(
    samples: RealQuickSessionSample[],
    expectsSessionPtys: boolean,
  ): Promise<BenchmarkHostReport>;
}> {
  const root = await mkdtemp(join(tmpdir(), "station-observer-host-pty-"));
  const socketPath = join(root, "station-host.sock");
  const child = spawn(
    bunCommand,
    [hostEntry, "--socket", socketPath, "--state-dir", root, "--build-version", hostBuildVersion],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE: "1",
        STATION_PTY_IMPL: "bun",
      },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    if (stderr.length < 16_384) stderr += data.toString("utf8");
  });
  const client = createStationHostClient({
    socketPath,
    expectedBuildVersion: hostBuildVersion,
    timeoutMs: 5_000,
  });
  let healthMatched = false;
  try {
    const health = await waitForHostHealth(client);
    healthMatched =
      health.ok &&
      health.protocolVersion === HOST_PROTOCOL_VERSION &&
      health.buildVersion === hostBuildVersion;
    await warmBenchmarkHost(client, root);
  } catch (error) {
    client.dispose();
    await terminateHostProcess(child);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const controller = createStationHostController(
    {
      socketPath,
      stateDir: root,
      hostCommand: [bunCommand, hostEntry],
      expectedBuildVersion: hostBuildVersion,
      timeoutMs: 5_000,
    },
    { clientFactory: () => client },
  );
  let finished = false;
  return {
    controller,
    finish: async (samples, expectsSessionPtys) => {
      if (finished) throw new Error("Benchmark Host was already finished.");
      finished = true;
      let exactLiveInventory = false;
      let exactLiveIdentity = false;
      let allClosed = false;
      let cleanupInventoryCount = -1;
      let stoppedCleanly = false;
      try {
        const live = await client.list();
        const expected = samples.flatMap((sample) =>
          sample.hostPty === undefined ? [] : [{ sample, hostPty: sample.hostPty }],
        );
        exactLiveInventory =
          expected.length === (expectsSessionPtys ? samples.length : 0) &&
          live.length === expected.length &&
          JSON.stringify(live.map((entry) => entry.ptyId).sort()) ===
            JSON.stringify(expected.map(({ hostPty }) => hostPty.ptyId).sort());
        exactLiveIdentity = expected.every(({ sample, hostPty }) =>
          live.some(
            (entry) =>
              entry.kind === "agent" &&
              entry.alive &&
              entry.ptyId === hostPty.ptyId &&
              entry.ptyInstanceId === hostPty.ptyInstanceId &&
              entry.terminalTargetId === hostPty.terminalTargetId &&
              entry.projectId === sample.projectId &&
              entry.worktreeId === sample.worktreeId &&
              entry.sessionId === sample.sessionId &&
              entry.worktreePath === sample.worktreePath &&
              entry.harnessProvider === "fake-harness" &&
              hostPty.readyMarkerObserved &&
              hostPty.inputAcknowledged,
          ),
        );
        const closeResults = await Promise.all(live.map((entry) => client.close(entry.ptyId)));
        allClosed =
          closeResults.length === expected.length && closeResults.every((result) => result.closed);
        const cleanupInventory = await client.list();
        cleanupInventoryCount = cleanupInventory.length;
        const stop = await client.stopIfIdle(hostBuildVersion);
        client.dispose();
        const exit = await waitForHostExit(child, 5_000);
        stoppedCleanly = stop.stopping && exit.code === 0 && exit.signal === null;
      } finally {
        client.dispose();
        await terminateHostProcess(child);
        await rm(root, { recursive: true, force: true });
      }
      return {
        healthMatched,
        exactLiveInventory,
        exactLiveIdentity,
        allClosed,
        cleanupInventoryCount,
        stoppedCleanly,
        stderrEmpty: stderr.length === 0,
        temporaryRootRemoved: !(await pathExists(root)),
      };
    },
  };
}

async function warmBenchmarkHost(client: StationHostClient, root: string): Promise<void> {
  const identity = {
    kind: "agent" as const,
    terminalTargetId: "native:benchmark-warmup",
    worktreeId: "benchmark-warmup-worktree",
    projectId: "benchmark-warmup-project",
    sessionId: "benchmark-warmup-session",
    worktreePath: root,
    harnessProvider: "fake-harness",
  };
  const marker = "__STATION_E2E_WARMUP_READY__";
  const spawned = await client.spawn({
    ...identity,
    command: "/bin/sh",
    args: [
      "-c",
      'printf "%s\\n" "$1"; while :; do sleep 60; done',
      "station-observer-host-pty-warmup",
      marker,
    ],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TERM: "xterm-256color",
      LC_ALL: "C",
    },
    cwd: root,
    cols: 80,
    rows: 24,
  });
  const attachment = await client.attach({ ...identity, ...spawned }, "controller");
  const iterator = attachment.frames[Symbol.asyncIterator]();
  try {
    await readUntilHostMarker(iterator, replayHostData(attachment), marker);
  } finally {
    await iterator.return?.();
    await attachment.detach();
  }
  const closed = await client.close(spawned.ptyId);
  if (!closed.closed || (await client.list()).length !== 0) {
    throw new Error("Benchmark Host warmup did not restore an empty inventory.");
  }
}

async function waitForHostHealth(client: StationHostClient) {
  const deadline = performance.now() + 5_000;
  let lastError: unknown;
  while (performance.now() <= deadline) {
    try {
      return await client.health();
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
  throw new Error("Benchmark Station Host did not become healthy.", { cause: lastError });
}

async function terminateHostProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForHostExit(child, 2_000);
  } catch {
    child.kill("SIGKILL");
    await waitForHostExit(child, 2_000);
  }
}

function waitForHostExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return withHostTimeout(
    new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    }),
    timeoutMs,
    "Benchmark Station Host exit timed out.",
  );
}

function withHostTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

class MeasuredExternalCommands {
  readonly #profiles: ExternalCommandProfile[] = [];

  readonly run: ExternalCommandRunner = async (input) => {
    const startedAt = performance.now();
    let succeeded = false;
    try {
      const result = await nodeExternalCommandRunner(input);
      succeeded = true;
      return result;
    } finally {
      this.#profiles.push({
        kind: classifyExternalCommand(input),
        durationMs: performance.now() - startedAt,
        succeeded,
      });
    }
  };

  profiles(): ExternalCommandProfile[] {
    return this.#profiles.map((profile) => ({ ...profile }));
  }

  reset(): void {
    this.#profiles.length = 0;
  }
}

function classifyExternalCommand(input: ExternalCommandInput): ExternalCommandKind {
  const args = input.args ?? [];
  if (input.command === "git" && args.includes("core.bare")) return "git-bare-probe";
  if (input.command === "git" && args.includes("worktree") && args.includes("add")) {
    return "git-worktree-add";
  }
  if (input.command === "git" && args.includes("rev-parse") && args.includes("--show-toplevel")) {
    return "git-create-verify";
  }
  if (input.command === worktrunkCommand && args.includes("list")) return "worktrunk-list";
  if (input.command === worktrunkCommand && args.includes("switch")) return "worktrunk-switch";
  return "other";
}

function summarizeExternalCommands(profiles: ExternalCommandProfile[]): ExternalCommandSummary {
  const durations = (kind: ExternalCommandKind) =>
    profiles.filter((profile) => profile.kind === kind).map((profile) => profile.durationMs);
  const gitBareProbe = durations("git-bare-probe");
  const gitCreateVerify = durations("git-create-verify");
  const gitWorktreeAdd = durations("git-worktree-add");
  const worktrunkList = durations("worktrunk-list");
  const worktrunkSwitch = durations("worktrunk-switch");
  const other = durations("other");
  return {
    durationMs: {
      "git-bare-probe": distribution(gitBareProbe),
      "git-create-verify": distribution(gitCreateVerify),
      "git-worktree-add": distribution(gitWorktreeAdd),
      "worktrunk-list": distribution(worktrunkList),
      "worktrunk-switch": distribution(worktrunkSwitch),
      other: distribution(other),
    },
    totalMs: {
      "git-bare-probe": sum(gitBareProbe),
      "git-create-verify": sum(gitCreateVerify),
      "git-worktree-add": sum(gitWorktreeAdd),
      "worktrunk-list": sum(worktrunkList),
      "worktrunk-switch": sum(worktrunkSwitch),
      other: sum(other),
    },
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

class MeasuredWorktreeProvider implements WorktreeProvider {
  readonly id;
  readonly #delegate: WorktrunkProvider;
  readonly #recorders = new Map<string, Recorder>();
  readonly #created = new Map<string, WorktreeObservation>();
  readonly #activeByProject = new Map<string, number>();
  readonly #maxByProject = new Map<string, number>();
  scanCount = 0;
  activeCreateCount = 0;
  maxConcurrentCreates = 0;
  readonly scanProfiles: Array<{
    projectId: string;
    durationMs: number;
    worktrees: number;
    activeCreatesAtStart: number;
  }> = [];

  constructor(delegate: WorktrunkProvider) {
    this.#delegate = delegate;
    this.id = delegate.id;
  }

  get maxConcurrentCreatesPerProject(): number {
    return Math.max(0, ...this.#maxByProject.values());
  }

  registerRecorder(branch: string, recorder: Recorder): void {
    this.#recorders.set(branch, recorder);
  }

  unregisterRecorder(branch: string, recorder: Recorder): void {
    if (this.#recorders.get(branch) === recorder) this.#recorders.delete(branch);
  }

  createdObservation(branch: string): WorktreeObservation | undefined {
    return this.#created.get(branch);
  }

  createdObservations(): WorktreeObservation[] {
    return [...this.#created.values()];
  }

  capabilities(): WorktreeCapabilities {
    return this.#delegate.capabilities();
  }

  health(): Promise<ProviderHealth> {
    return this.#delegate.health();
  }

  doctorChecks(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]> {
    return context === undefined
      ? this.#delegate.doctorChecks()
      : this.#delegate.doctorChecks(context);
  }

  async listWorktrees(project: ProviderProjectConfig): Promise<WorktreeObservation[]> {
    this.scanCount += 1;
    const activeCreatesAtStart = this.activeCreateCount;
    const startedAt = performance.now();
    const worktrees = await this.#delegate.listWorktrees(project);
    this.scanProfiles.push({
      projectId: project.id,
      durationMs: performance.now() - startedAt,
      worktrees: worktrees.length,
      activeCreatesAtStart,
    });
    return worktrees;
  }

  async createWorktree(request: CreateWorktreeRequest): Promise<WorktreeObservation> {
    this.activeCreateCount += 1;
    this.maxConcurrentCreates = Math.max(this.maxConcurrentCreates, this.activeCreateCount);
    const activeForProject = (this.#activeByProject.get(request.project.id) ?? 0) + 1;
    this.#activeByProject.set(request.project.id, activeForProject);
    this.#maxByProject.set(
      request.project.id,
      Math.max(this.#maxByProject.get(request.project.id) ?? 0, activeForProject),
    );
    const recorder = this.#recorders.get(request.branch);
    recorder?.mark("mutationStarted");
    try {
      const observation = await this.#delegate.createWorktree(request);
      this.#created.set(request.branch, observation);
      recorder?.mark("mutationCompleted");
      return observation;
    } finally {
      this.activeCreateCount -= 1;
      this.#activeByProject.set(
        request.project.id,
        (this.#activeByProject.get(request.project.id) ?? 1) - 1,
      );
    }
  }

  removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult> {
    return this.#delegate.removeWorktree(request);
  }
}

class CollectingLogger implements StationLogger {
  readonly #entries: Array<{ message: string; attributes: Record<string, unknown> }> = [];

  info(message: string, attributes: Record<string, unknown> = {}): Promise<void> {
    this.#entries.push({ message, attributes });
    return Promise.resolve();
  }

  warn(message: string, attributes: Record<string, unknown> = {}): Promise<void> {
    this.#entries.push({ message, attributes });
    return Promise.resolve();
  }

  error(message: string, attributes: Record<string, unknown> = {}): Promise<void> {
    this.#entries.push({ message, attributes });
    return Promise.resolve();
  }

  schedulerProfiles(): Array<Record<string, unknown>> {
    return this.#entries
      .filter((entry) => entry.message === "Reconcile scheduler profile.")
      .map((entry) => entry.attributes);
  }
}

async function createShapedProject(
  benchmarkRoot: string,
  projectIndex: number,
): Promise<ProviderProjectConfig> {
  const root = join(benchmarkRoot, `repo-${projectIndex}`);
  const managedRoot = join(benchmarkRoot, `worktrees-${projectIndex}`);
  await mkdir(root, { recursive: true });
  await mkdir(managedRoot, { recursive: true });
  await runGit(root, ["init", "--initial-branch=main", "--quiet"]);
  await runGit(root, ["config", "user.name", "Station Benchmark"]);
  await runGit(root, ["config", "user.email", "station-benchmark@example.invalid"]);
  await runGit(root, ["commit", "--allow-empty", "--message=baseline", "--quiet"]);
  for (let index = 0; index < linkedShapeWorktrees; index += 1) {
    await runGit(root, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      `shape-${projectIndex}-${index}`,
      join(managedRoot, `shape-${index}`),
      "main",
    ]);
  }
  return {
    id: `real-project-${projectIndex}`,
    label: `Real project ${projectIndex}`,
    root,
    defaultBranch: "main",
    defaults: {
      harness: "fake-harness",
      terminal: "native",
      layout: "agent-shell",
    },
    worktrunk: {
      enabled: true,
      base: "main",
      managedRoot,
      includeMain: true,
      includeExternal: true,
    },
  };
}

function realConfig(projects: ProviderProjectConfig[]): StationConfig {
  return {
    schemaVersion: 1,
    workspace: DEFAULT_WORKSPACE_CONFIG,
    defaults: {
      worktreeProvider: "worktrunk",
      terminal: "native",
      harness: "fake-harness",
      layout: "agent-shell",
      defaultBranch: "main",
    },
    projects,
  };
}

async function cleanupCreated(
  projects: ProviderProjectConfig[],
  worktrees: WorktreeObservation[],
): Promise<void> {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  for (const worktree of worktrees) {
    const project = projectsById.get(worktree.projectId);
    if (project === undefined) continue;
    await runGit(project.root, ["worktree", "remove", "--force", worktree.path]);
    await runGit(project.root, ["branch", "-D", worktree.branch]);
  }
}

async function gitWorktreeCount(root: string): Promise<number> {
  const output = await runGit(root, ["worktree", "list", "--porcelain"]);
  return output.split("\n").filter((line) => line.startsWith("worktree ")).length;
}

async function waitForScanCount(
  provider: MeasuredWorktreeProvider,
  expected: number,
): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (performance.now() <= deadline) {
    if (provider.scanCount >= expected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for ${expected} real Worktrunk scans.`);
}

function waitForNextEvent(
  iterator: AsyncIterator<StationEvent>,
  description: string,
): Promise<StationEvent> {
  return new Promise<StationEvent>((resolveEvent, rejectEvent) => {
    const timer = setTimeout(
      () => rejectEvent(new Error(`Timed out waiting for ${description}.`)),
      30_000,
    );
    timer.unref?.();
    void iterator.next().then(
      (result) => {
        clearTimeout(timer);
        if (result.done === true || result.value === undefined) {
          rejectEvent(new Error(`Event stream ended while waiting for ${description}.`));
          return;
        }
        resolveEvent(result.value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectEvent(error);
      },
    );
  });
}

function assertVerifiedSnapshot(
  fixture: RealFixture,
  samples: RealQuickSessionSample[],
): { rows: number; sessions: number } {
  const snapshot = fixture.core.getSnapshot();
  for (const sample of samples) {
    const row = snapshot.rows.find(
      (candidate) => candidate.projectId === sample.projectId && candidate.branch === sample.branch,
    );
    if (row === undefined || !sameObservedPath(row.path, sample.worktreePath)) {
      throw new Error(`Verification lost worktree ${sample.projectId}/${sample.branch}.`);
    }
    if (
      !snapshot.sessions.some(
        (session) =>
          session.id === sample.sessionId &&
          session.projectId === sample.projectId &&
          session.worktreeId === row.id,
      )
    ) {
      throw new Error(`Verification lost session ${sample.projectId}/${sample.branch}.`);
    }
  }
  return { rows: snapshot.rows.length, sessions: snapshot.sessions.length };
}

async function waitForCondition(predicate: () => boolean, description: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (performance.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function assertMonotonicStages(sample: RealQuickSessionSample): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const stage of quickSessionStages) {
    const timestamp = sample.timestampsMs[stage];
    expect(timestamp, `${sample.branch}:${stage}`).toBeGreaterThanOrEqual(previous);
    previous = timestamp;
  }
}

function resourceDelta(before: NodeJS.ResourceUsage, after: NodeJS.ResourceUsage): ResourceDelta {
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

function observerIds() {
  let command = 0;
  let event = 0;
  let error = 0;
  let observation = 0;
  let breadcrumb = 0;
  let session = 0;
  let group = 0;
  return {
    commandId: () => `cmd_real_${++command}`,
    eventId: () => `evt_real_${++event}`,
    errorId: () => `err_real_${++error}`,
    observationId: () => `obs_real_${++observation}`,
    breadcrumbId: () => `crumb_real_${++breadcrumb}`,
    sessionId: () => `ses_real_${++session}`,
    sessionGroupId: () => `grp_real_${++group}`,
  };
}

async function writeReport(report: object): Promise<void> {
  const configured = process.env.STATION_REAL_QUICK_SESSION_BENCHMARK_OUTPUT;
  if (configured === undefined || configured.length === 0) return;
  const outputPath = resolve(configured);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`[real Observer Quick Session benchmark] ${outputPath}\n`);
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  return runCommand("git", args, cwd);
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    env: environmentWithoutGitLocals(),
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}
