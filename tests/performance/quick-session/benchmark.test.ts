import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginQuickSessionRecording,
  type CreateQuickSessionBenchmarkFixtureOptions,
  createQuickSessionBenchmarkFixture,
  type QuickSessionSample,
  quickSessionStages,
  runQuickSession,
  runRemovalBurst,
  submitUnrelatedHarnessEvent,
  waitForMutationStarted,
  waitForProviderScanCount,
  waitForTerminalCommand,
} from "./benchmarkHarness.js";
import { type Distribution, distribution } from "./statistics.js";

type ScenarioReport = {
  name: string;
  sessionsPerRun: number;
  finalInteractiveMs: Distribution;
  allInteractiveMs: Distribution;
  throughputPerSecond: Distribution;
  stageContributionMs: Record<string, Distribution>;
  rawRuns: QuickSessionSample[][];
  scanCounts: number[];
  maxConcurrentCreates: number[];
  maxConcurrentCreatesPerProject: number[];
};

type CorrectnessReport = {
  failure: { status: string; code: string | undefined; worktreeCreated: boolean };
  cancellationAndRestart: {
    status: string;
    recoveredWorktree: boolean;
    canonicalSessionInvented: boolean;
  };
  removalBurst: { durationMs: number; removed: number };
};

type BenchmarkReport = {
  schemaVersion: 1;
  benchmark: "station-quick-session-synthetic";
  generatedAt: string;
  repositoryShape: { projects: number; worktreesPerProject: number };
  scenarios: ScenarioReport[];
  correctness: CorrectnessReport;
};

const worktreesPerProject = 49;

describe("Quick Session performance matrix", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records the complete blocking path and correctness matrix", async () => {
    vi.useFakeTimers({
      now: new Date("2026-08-24T12:00:00.000Z"),
      toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
    });
    const { scenarios, correctness } = await settleWithVirtualTime(runMatrix());
    const report: BenchmarkReport = {
      schemaVersion: 1,
      benchmark: "station-quick-session-synthetic",
      generatedAt: new Date().toISOString(),
      repositoryShape: { projects: 1, worktreesPerProject },
      scenarios,
      correctness,
    };
    vi.useRealTimers();
    await writeReport(report);

    for (const scenario of scenarios) {
      const samples = scenario.rawRuns.flat();
      expect(samples).not.toHaveLength(0);
      for (const sample of samples) assertMonotonicStages(sample);
      expect(scenario.scanCounts.every((count) => count >= 2)).toBe(true);
      expect(scenario.maxConcurrentCreatesPerProject.every((count) => count <= 4)).toBe(true);
    }
    expect(scenarioNamed(scenarios, "warm-single").scanCounts.every((count) => count === 2)).toBe(
      true,
    );
    expect(scenarioNamed(scenarios, "burst-5").scanCounts.every((count) => count <= 7)).toBe(true);
    expect(scenarioNamed(scenarios, "warm-single").finalInteractiveMs.p95).toBeLessThanOrEqual(6);
    expect(scenarioNamed(scenarios, "cold-single").finalInteractiveMs.p95).toBeLessThanOrEqual(17);
    expect(scenarioNamed(scenarios, "burst-5").finalInteractiveMs.p95).toBeLessThanOrEqual(54);
    const productionWarm = scenarioNamed(scenarios, "production-debounce-warm-single");
    const productionBurst = scenarioNamed(scenarios, "production-debounce-burst-5");
    expect(productionWarm.finalInteractiveMs.p95).toBeLessThanOrEqual(12);
    expect(productionBurst.finalInteractiveMs.p95).toBeLessThanOrEqual(28);
    expect(productionWarm.stageContributionMs.canonicalProjection?.p95).toBe(0);
    expect(productionBurst.stageContributionMs.canonicalProjection?.p95).toBe(0);
    expect(productionBurst.scanCounts.every((count) => count === 2)).toBe(true);
    expect(productionBurst.maxConcurrentCreatesPerProject.every((count) => count === 4)).toBe(true);
    const productionBurst20 = scenarioNamed(scenarios, "production-debounce-burst-20");
    expect(productionBurst.finalInteractiveMs.p95).toBeLessThanOrEqual(12);
    expect(productionBurst20.finalInteractiveMs.p95).toBeLessThanOrEqual(30);
    expect(productionBurst20.scanCounts.every((count) => count === 2)).toBe(true);
    expect(correctness.failure).toMatchObject({
      status: "failed",
      code: "SYNTHETIC_WORKTREE_CREATE_FAILED",
      worktreeCreated: false,
    });
    expect(correctness.cancellationAndRestart).toEqual({
      status: "failed",
      recoveredWorktree: true,
      canonicalSessionInvented: false,
    });
    expect(correctness.removalBurst.removed).toBe(5);
  });
});

function scenarioNamed(scenarios: ScenarioReport[], name: string): ScenarioReport {
  const scenario = scenarios.find((candidate) => candidate.name === name);
  if (scenario === undefined) {
    throw new Error(`Missing Quick Session benchmark scenario: ${name}`);
  }
  return scenario;
}

async function runMatrix(): Promise<{
  scenarios: ScenarioReport[];
  correctness: CorrectnessReport;
}> {
  const scenarios = [
    await runScenario({ name: "warm-single", repetitions: 10, sessions: 1 }),
    await runColdSingles(8),
    await runScenario({ name: "burst-3", repetitions: 6, sessions: 3 }),
    await runScenario({ name: "burst-5", repetitions: 6, sessions: 5 }),
    await runScenario({ name: "burst-20", repetitions: 3, sessions: 20 }),
    await runScenario({
      name: "multi-project-parallel",
      repetitions: 6,
      sessions: 6,
      projects: 2,
      projectFor: (index) => `project-${index % 2}`,
    }),
    await runScenario({
      name: "unrelated-harness-events",
      repetitions: 6,
      sessions: 5,
      contend: async (fixture, repetition) => {
        await Promise.all([
          submitUnrelatedHarnessEvent(fixture, `report_${repetition}_a`),
          submitUnrelatedHarnessEvent(fixture, `report_${repetition}_b`),
        ]);
      },
    }),
    await runScenario({
      name: "production-debounce-warm-single",
      repetitions: 6,
      sessions: 1,
      reconcileDebounceMs: 100,
      interactiveReconcileDebounceMs: 25,
    }),
    await runColdSingles(6, {
      name: "production-debounce-cold-single",
      reconcileDebounceMs: 100,
      interactiveReconcileDebounceMs: 25,
    }),
    await runScenario({
      name: "production-debounce-burst-3",
      repetitions: 6,
      sessions: 3,
      reconcileDebounceMs: 100,
      interactiveReconcileDebounceMs: 25,
    }),
    await runScenario({
      name: "production-debounce-burst-5",
      repetitions: 4,
      sessions: 5,
      reconcileDebounceMs: 100,
      interactiveReconcileDebounceMs: 25,
    }),
    await runScenario({
      name: "production-debounce-burst-20",
      repetitions: 3,
      sessions: 20,
      reconcileDebounceMs: 100,
      interactiveReconcileDebounceMs: 25,
    }),
  ];
  return { scenarios, correctness: await runCorrectnessMatrix() };
}

async function runScenario(input: {
  name: string;
  repetitions: number;
  sessions: number;
  projects?: number;
  reconcileDebounceMs?: number;
  interactiveReconcileDebounceMs?: number;
  projectFor?: (index: number) => string;
  contend?: (
    fixture: Awaited<ReturnType<typeof createQuickSessionBenchmarkFixture>>,
    repetition: number,
  ) => Promise<void>;
}): Promise<ScenarioReport> {
  const rawRuns: QuickSessionSample[][] = [];
  const scanCounts: number[] = [];
  const maxConcurrentCreates: number[] = [];
  const maxConcurrentCreatesPerProject: number[] = [];
  for (let repetition = 0; repetition < input.repetitions; repetition += 1) {
    const fixtureOptions: CreateQuickSessionBenchmarkFixtureOptions = { worktreesPerProject };
    if (input.projects !== undefined) fixtureOptions.projects = input.projects;
    if (input.reconcileDebounceMs !== undefined) {
      fixtureOptions.reconcileDebounceMs = input.reconcileDebounceMs;
    }
    if (input.interactiveReconcileDebounceMs !== undefined) {
      fixtureOptions.interactiveReconcileDebounceMs = input.interactiveReconcileDebounceMs;
    }
    const fixture = await createQuickSessionBenchmarkFixture(fixtureOptions);
    const scansBeforeSessions = fixture.worktree.scanCount;
    try {
      const contention = input.contend?.(fixture, repetition) ?? Promise.resolve();
      const samples = await Promise.all(
        Array.from({ length: input.sessions }, (_, index) => {
          const sessionInput: Parameters<typeof runQuickSession>[1] = {
            branch: `${input.name}-${repetition}-${index}`,
          };
          const projectId = input.projectFor?.(index);
          if (projectId !== undefined) sessionInput.projectId = projectId;
          return runQuickSession(fixture, sessionInput);
        }),
      );
      await contention;
      await waitForProviderScanCount(fixture, scansBeforeSessions + (input.projects ?? 1));
      rawRuns.push(samples);
      scanCounts.push(fixture.worktree.scanCount);
      maxConcurrentCreates.push(fixture.worktree.maxConcurrentCreates);
      maxConcurrentCreatesPerProject.push(fixture.worktree.maxConcurrentCreatesPerProject);
    } finally {
      await fixture.close();
    }
  }
  return scenarioReport(
    input.name,
    input.sessions,
    rawRuns,
    scanCounts,
    maxConcurrentCreates,
    maxConcurrentCreatesPerProject,
  );
}

async function runColdSingles(
  repetitions: number,
  input: {
    name: string;
    reconcileDebounceMs?: number;
    interactiveReconcileDebounceMs?: number;
  } = { name: "cold-single" },
): Promise<ScenarioReport> {
  const rawRuns: QuickSessionSample[][] = [];
  const scanCounts: number[] = [];
  const maxConcurrentCreates: number[] = [];
  const maxConcurrentCreatesPerProject: number[] = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const branch = `cold-single-${repetition}`;
    const fixtureOptions: CreateQuickSessionBenchmarkFixtureOptions = {
      worktreesPerProject,
      startup: false,
    };
    if (input.reconcileDebounceMs !== undefined) {
      fixtureOptions.reconcileDebounceMs = input.reconcileDebounceMs;
    }
    if (input.interactiveReconcileDebounceMs !== undefined) {
      fixtureOptions.interactiveReconcileDebounceMs = input.interactiveReconcileDebounceMs;
    }
    const fixture = await createQuickSessionBenchmarkFixture(fixtureOptions);
    const recorder = beginQuickSessionRecording(branch);
    try {
      await fixture.startup();
      const scansBeforeSession = fixture.worktree.scanCount;
      rawRuns.push([await runQuickSession(fixture, { branch, recorder })]);
      await waitForProviderScanCount(fixture, scansBeforeSession + 1);
      scanCounts.push(fixture.worktree.scanCount);
      maxConcurrentCreates.push(fixture.worktree.maxConcurrentCreates);
      maxConcurrentCreatesPerProject.push(fixture.worktree.maxConcurrentCreatesPerProject);
    } finally {
      await fixture.close();
    }
  }
  return scenarioReport(
    input.name,
    1,
    rawRuns,
    scanCounts,
    maxConcurrentCreates,
    maxConcurrentCreatesPerProject,
  );
}

async function runCorrectnessMatrix(): Promise<CorrectnessReport> {
  const failureFixture = await createQuickSessionBenchmarkFixture({
    worktreesPerProject,
    failBranches: new Set(["expected-failure"]),
  });
  let failure: CorrectnessReport["failure"];
  try {
    const receipt = await failureFixture.api.dispatch({
      type: "worktree.create",
      payload: {
        projectId: "project-0",
        branch: "expected-failure",
        launchHarness: "fake-harness",
      },
    });
    const record = await waitForTerminalCommand(failureFixture.api, receipt.commandId);
    failure = {
      status: record.status,
      code: record.error?.code,
      worktreeCreated: failureFixture.worktree
        .snapshot()
        .worktrees.some((worktree) => worktree.branch === "expected-failure"),
    };
  } finally {
    await failureFixture.close();
  }

  const cancellationFixture = await createQuickSessionBenchmarkFixture({
    worktreesPerProject,
    costs: { mutationMs: 30 },
  });
  let cancellationAndRestart: CorrectnessReport["cancellationAndRestart"];
  try {
    const receipt = await cancellationFixture.api.dispatch({
      type: "worktree.create",
      payload: {
        projectId: "project-0",
        branch: "cancelled-during-create",
        launchHarness: "fake-harness",
      },
    });
    await waitForMutationStarted(cancellationFixture, "cancelled-during-create");
    await cancellationFixture.queue.shutdown();
    const record = await cancellationFixture.api.getCommand(receipt.commandId);
    await cancellationFixture.api.reconcile("observer.startup");
    const snapshot = cancellationFixture.core.getSnapshot();
    const recovered = snapshot.rows.find((row) => row.branch === "cancelled-during-create");
    cancellationAndRestart = {
      status: record.status,
      recoveredWorktree: recovered !== undefined,
      canonicalSessionInvented:
        recovered !== undefined &&
        snapshot.sessions.some((session) => session.worktreeId === recovered.id),
    };
  } finally {
    await cancellationFixture.close();
  }

  const removalFixture = await createQuickSessionBenchmarkFixture({ worktreesPerProject });
  let removalBurst: CorrectnessReport["removalBurst"];
  try {
    removalBurst = await runRemovalBurst(removalFixture, 5);
  } finally {
    await removalFixture.close();
  }
  return { failure, cancellationAndRestart, removalBurst };
}

function scenarioReport(
  name: string,
  sessionsPerRun: number,
  rawRuns: QuickSessionSample[][],
  scanCounts: number[],
  maxConcurrentCreates: number[],
  maxConcurrentCreatesPerProject: number[],
): ScenarioReport {
  const finalInteractive = rawRuns.map((samples) =>
    Math.max(...samples.map((sample) => sample.totalMs)),
  );
  const allSamples = rawRuns.flat();
  const throughput = finalInteractive.map((durationMs) =>
    durationMs === 0 ? 0 : sessionsPerRun / (durationMs / 1000),
  );
  const stageKeys = Object.keys(allSamples[0]?.stageMs ?? {}) as Array<
    keyof QuickSessionSample["stageMs"]
  >;
  return {
    name,
    sessionsPerRun,
    finalInteractiveMs: distribution(finalInteractive),
    allInteractiveMs: distribution(allSamples.map((sample) => sample.totalMs)),
    throughputPerSecond: distribution(throughput),
    stageContributionMs: Object.fromEntries(
      stageKeys.map((key) => [key, distribution(allSamples.map((sample) => sample.stageMs[key]))]),
    ),
    rawRuns,
    scanCounts,
    maxConcurrentCreates,
    maxConcurrentCreatesPerProject,
  };
}

function assertMonotonicStages(sample: QuickSessionSample): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const stage of quickSessionStages) {
    const timestamp = sample.timestampsMs[stage];
    expect(timestamp, `${sample.branch}:${stage}`).toBeGreaterThanOrEqual(previous);
    previous = timestamp;
  }
}

async function writeReport(report: BenchmarkReport): Promise<void> {
  const configured = process.env.STATION_QUICK_SESSION_BENCHMARK_OUTPUT;
  if (configured === undefined || configured.length === 0) return;
  const outputPath = resolve(configured);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`[quick-session benchmark] ${outputPath}\n`);
}

async function settleWithVirtualTime<T>(promise: Promise<T>): Promise<T> {
  let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  void promise.then(
    (value) => {
      result = { ok: true, value };
    },
    (error: unknown) => {
      result = { ok: false, error };
    },
  );
  for (let step = 0; result === undefined && step < 100_000; step += 1) {
    await Promise.resolve();
    if (vi.getTimerCount() > 0) {
      await vi.advanceTimersToNextTimerAsync();
    } else {
      await vi.advanceTimersByTimeAsync(0);
    }
  }
  if (result === undefined) throw new Error("Virtual Quick Session benchmark did not settle.");
  if (!result.ok) throw result.error;
  return result.value;
}
