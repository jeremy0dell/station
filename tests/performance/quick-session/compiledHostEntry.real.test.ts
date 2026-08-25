import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HOST_PROTOCOL_VERSION } from "@station/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type HostEntryStrategyRun,
  runHostEntryStrategy,
  summarizeHostEntryRuns,
} from "./hostEntryComparison.real.test.js";

const execFileAsync = promisify(execFile);
const runReal = process.env.STATION_REAL_COMPILED_HOST_ENTRY === "1";
const describeReal = runReal ? describe : describe.skip;
const runAssetComparison = process.env.STATION_REAL_COMPILED_HOST_ASSET === "1";
const describeAssetComparison = runAssetComparison ? describe : describe.skip;
const runMilestones = process.env.STATION_REAL_COMPILED_HOST_MILESTONES === "1";
const describeMilestones = runMilestones ? describe : describe.skip;
const runDedicatedBinary = process.env.STATION_REAL_DEDICATED_HOST_BINARY === "1";
const describeDedicatedBinary = runDedicatedBinary ? describe : describe.skip;
const runCompiledSequence = process.env.STATION_REAL_COMPILED_HOST_SEQUENCE === "1";
const describeCompiledSequence = runCompiledSequence ? describe : describe.skip;
const outputPath = resolve(
  z
    .string()
    .min(1)
    .parse(
      process.env.STATION_REAL_COMPILED_HOST_ENTRY_OUTPUT ??
        ".dev-state/performance/quick-session/compiled-host-entry.real.json",
    ),
);
const assetOutputPath = resolve(
  z
    .string()
    .min(1)
    .parse(
      process.env.STATION_REAL_COMPILED_HOST_ASSET_OUTPUT ??
        ".dev-state/performance/quick-session/compiled-host-asset-comparison.real.json",
    ),
);
const milestoneOutputPath = resolve(
  z
    .string()
    .min(1)
    .parse(
      process.env.STATION_REAL_COMPILED_HOST_MILESTONES_OUTPUT ??
        ".dev-state/performance/quick-session/compiled-host-milestones.real.json",
    ),
);
const dedicatedOutputPath = resolve(
  z
    .string()
    .min(1)
    .parse(
      process.env.STATION_REAL_DEDICATED_HOST_BINARY_OUTPUT ??
        ".dev-state/performance/quick-session/dedicated-host-binary-comparison.real.json",
    ),
);
const sequenceOutputPath = resolve(
  z
    .string()
    .min(1)
    .parse(
      process.env.STATION_REAL_COMPILED_HOST_SEQUENCE_OUTPUT ??
        ".dev-state/performance/quick-session/compiled-host-sequence.real.json",
    ),
);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const hostEntry = fileURLToPath(new URL("../../../station/src/host/hostMain.ts", import.meta.url));
const binaryPath = fileURLToPath(new URL("../../../station/dist/bin/stn", import.meta.url));
const buildIdentityPath = fileURLToPath(
  new URL("../../../packages/runtime/dist/station-build-id", import.meta.url),
);
const packageJsonPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
const bunCommand = process.env.STATION_BUN ?? "bun";
const repetitions = 5;
const strategies = ["sourceEntry", "compiledBinary"] as const;
const keepThresholds = {
  medianImprovementFraction: 0.3,
  p95ImprovementFraction: 0.3,
  candidateP95Ms: 500,
} as const;

type Strategy = (typeof strategies)[number];

let expectedBuildVersion = "";
let binaryBuildMs = 0;
let binaryBytes = 0;
let buildIdentity = "";
let binaryBuildPromise: Promise<void> | undefined;
let dedicatedRoot = "";
let dedicatedBinaryPath = "";
let dedicatedBuildMs = 0;
let dedicatedBytes = 0;

describeReal("real compiled Station Host entry comparison", () => {
  beforeAll(async () => {
    await prepareCurrentBinary();
  }, 310_000);

  it("compares Bun source loading with compiled self-dispatch", async () => {
    const report = {
      schemaVersion: 1,
      benchmark: "station-quick-session-compiled-host-entry-comparison",
      generatedAt: new Date().toISOString(),
      machine: {
        platform: platform(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
      },
      tools: {
        bun: (await execFileAsync(bunCommand, ["--version"])).stdout.trim(),
        hostProtocolVersion: HOST_PROTOCOL_VERSION,
        hostBuildVersion: expectedBuildVersion,
        buildIdentity,
      },
      repositoryShape: { repetitions, freshStatePerRun: true },
      binary: {
        buildMs: binaryBuildMs,
        bytes: binaryBytes,
        buildExcludedFromLaunchTiming: true,
        packagedHelperMaterializedInsideLaunchTiming: true,
      },
      keepThresholds,
      strategies: {
        sourceEntry: { runs: [] as HostEntryStrategyRun[] },
        compiledBinary: { runs: [] as HostEntryStrategyRun[] },
      },
      repetitions: [] as Array<{ repetition: number; strategyOrder: Strategy[] }>,
      medianImprovementFraction: 0,
      p95ImprovementFraction: 0,
      allSafe: false,
      thresholdsPassed: false,
      failure: null as string | null,
    };

    try {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const strategyOrder: Strategy[] =
          repetition % 2 === 0 ? [...strategies] : [...strategies].reverse();
        for (const strategy of strategyOrder) {
          const hostCommand =
            strategy === "sourceEntry"
              ? ([bunCommand, hostEntry] as const)
              : ([binaryPath, "__station-host"] as const);
          report.strategies[strategy].runs.push(
            await runHostEntryStrategy({
              strategy,
              repetition,
              hostCommand,
              expectedBuildVersion,
            }),
          );
        }
        report.repetitions.push({ repetition, strategyOrder });
      }
    } catch (error) {
      report.failure = diagnosticError(error);
    }

    const source = summarizeHostEntryRuns(report.strategies.sourceEntry.runs);
    const compiled = summarizeHostEntryRuns(report.strategies.compiledBinary.runs);
    Object.assign(report.strategies.sourceEntry, source);
    Object.assign(report.strategies.compiledBinary, compiled);
    report.medianImprovementFraction = improvement(
      source.intentToInputAckMs.median,
      compiled.intentToInputAckMs.median,
    );
    report.p95ImprovementFraction = improvement(
      source.intentToInputAckMs.p95,
      compiled.intentToInputAckMs.p95,
    );
    report.allSafe =
      report.failure === null &&
      report.repetitions.length === repetitions &&
      [...report.strategies.sourceEntry.runs, ...report.strategies.compiledBinary.runs].every(
        (run) => run.safe,
      );
    report.thresholdsPassed =
      report.medianImprovementFraction >= keepThresholds.medianImprovementFraction &&
      report.p95ImprovementFraction >= keepThresholds.p95ImprovementFraction &&
      compiled.intentToInputAckMs.p95 <= keepThresholds.candidateP95Ms;

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`[real compiled Host entry comparison] ${outputPath}\n`);

    expect(report.failure).toBeNull();
    expect(report.allSafe).toBe(true);
    expect(report.thresholdsPassed).toBe(true);
  }, 300_000);
});

describeAssetComparison("real compiled Station Host packaged-helper attribution", () => {
  beforeAll(async () => {
    await prepareCurrentBinary();
  }, 310_000);

  it("isolates packaged controlling-terminal helper preparation", async () => {
    const assetStrategies = ["packagedCtty", "noCtty"] as const;
    type AssetStrategy = (typeof assetStrategies)[number];
    const assetThresholds = {
      intentMedianImprovementFraction: 0.25,
      intentP95ImprovementFraction: 0.25,
      ensureMedianImprovementFraction: 0.25,
      ensureP95ImprovementFraction: 0.25,
    } as const;
    const report = {
      schemaVersion: 1,
      benchmark: "station-quick-session-compiled-host-asset-comparison",
      generatedAt: new Date().toISOString(),
      machine: {
        platform: platform(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
      },
      tools: {
        bun: (await execFileAsync(bunCommand, ["--version"])).stdout.trim(),
        hostProtocolVersion: HOST_PROTOCOL_VERSION,
        hostBuildVersion: expectedBuildVersion,
        buildIdentity,
      },
      repositoryShape: { repetitions, freshStatePerRun: true },
      binary: {
        buildMs: binaryBuildMs,
        bytes: binaryBytes,
        buildExcludedFromLaunchTiming: true,
      },
      attribution: {
        candidateOmitsControllingTerminal: true,
        productionCandidate: false,
      },
      keepThresholds: assetThresholds,
      strategies: {
        packagedCtty: { runs: [] as HostEntryStrategyRun[] },
        noCtty: { runs: [] as HostEntryStrategyRun[] },
      },
      repetitions: [] as Array<{ repetition: number; strategyOrder: AssetStrategy[] }>,
      intentMedianImprovementFraction: 0,
      intentP95ImprovementFraction: 0,
      ensureMedianImprovementFraction: 0,
      ensureP95ImprovementFraction: 0,
      allSafe: false,
      thresholdsPassed: false,
      failure: null as string | null,
    };

    try {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const strategyOrder: AssetStrategy[] =
          repetition % 2 === 0 ? [...assetStrategies] : [...assetStrategies].reverse();
        for (const strategy of strategyOrder) {
          report.strategies[strategy].runs.push(
            await runHostEntryStrategy({
              strategy,
              repetition,
              hostCommand: [binaryPath, "__station-host"],
              expectedBuildVersion,
              ptyImplementation: strategy === "packagedCtty" ? "bun" : "bun-nocctty",
            }),
          );
        }
        report.repetitions.push({ repetition, strategyOrder });
      }
    } catch (error) {
      report.failure = diagnosticError(error);
    }

    const packaged = summarizeHostEntryRuns(report.strategies.packagedCtty.runs);
    const noCtty = summarizeHostEntryRuns(report.strategies.noCtty.runs);
    Object.assign(report.strategies.packagedCtty, packaged);
    Object.assign(report.strategies.noCtty, noCtty);
    report.intentMedianImprovementFraction = improvement(
      packaged.intentToInputAckMs.median,
      noCtty.intentToInputAckMs.median,
    );
    report.intentP95ImprovementFraction = improvement(
      packaged.intentToInputAckMs.p95,
      noCtty.intentToInputAckMs.p95,
    );
    report.ensureMedianImprovementFraction = improvement(
      packaged.ensureMs.median,
      noCtty.ensureMs.median,
    );
    report.ensureP95ImprovementFraction = improvement(packaged.ensureMs.p95, noCtty.ensureMs.p95);
    report.allSafe =
      report.failure === null &&
      report.repetitions.length === repetitions &&
      [...report.strategies.packagedCtty.runs, ...report.strategies.noCtty.runs].every(
        (run) => run.safe,
      );
    report.thresholdsPassed =
      report.intentMedianImprovementFraction >= assetThresholds.intentMedianImprovementFraction &&
      report.intentP95ImprovementFraction >= assetThresholds.intentP95ImprovementFraction &&
      report.ensureMedianImprovementFraction >= assetThresholds.ensureMedianImprovementFraction &&
      report.ensureP95ImprovementFraction >= assetThresholds.ensureP95ImprovementFraction;

    await mkdir(dirname(assetOutputPath), { recursive: true });
    await writeFile(assetOutputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`[real compiled Host asset comparison] ${assetOutputPath}\n`);

    expect(report.failure).toBeNull();
    expect(report.allSafe).toBe(true);
    expect(report.thresholdsPassed).toBe(true);
  }, 300_000);
});

describeMilestones("real compiled Station Host startup milestones", () => {
  beforeAll(async () => {
    await prepareCurrentBinary();
  }, 310_000);

  it("splits executable startup from post-start socket readiness", async () => {
    const attributionThresholds = {
      preStartP95Fraction: 0.75,
      postStartP95Fraction: 0.5,
    } as const;
    const report = {
      schemaVersion: 1,
      benchmark: "station-quick-session-compiled-host-milestones",
      generatedAt: new Date().toISOString(),
      machine: {
        platform: platform(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
      },
      tools: {
        bun: (await execFileAsync(bunCommand, ["--version"])).stdout.trim(),
        hostProtocolVersion: HOST_PROTOCOL_VERSION,
        hostBuildVersion: expectedBuildVersion,
        buildIdentity,
      },
      repositoryShape: { repetitions, freshStatePerRun: true },
      binary: {
        buildMs: binaryBuildMs,
        bytes: binaryBytes,
        buildExcludedFromLaunchTiming: true,
      },
      diagnosticSetup: { ptyImplementation: "bun-nocctty", productionCandidate: false },
      attributionThresholds,
      runs: [] as HostEntryStrategyRun[],
      preStartP95Fraction: 0,
      postStartP95Fraction: 0,
      attribution: "unresolved" as "pre-start" | "post-start" | "unresolved",
      predictionPassed: false,
      allSafe: false,
      thresholdsPassed: false,
      failure: null as string | null,
    };

    try {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        report.runs.push(
          await runHostEntryStrategy({
            strategy: "compiledNoCtty",
            repetition,
            hostCommand: [binaryPath, "__station-host"],
            expectedBuildVersion,
            ptyImplementation: "bun-nocctty",
          }),
        );
      }
    } catch (error) {
      report.failure = diagnosticError(error);
    }

    const summary = summarizeHostEntryRuns(report.runs);
    Object.assign(report, { summary });
    report.preStartP95Fraction = fraction(summary.hostStartFromIntentMs.p95, summary.ensureMs.p95);
    report.postStartP95Fraction = fraction(
      summary.socketReadyAfterHostStartMs.p95,
      summary.ensureMs.p95,
    );
    if (report.preStartP95Fraction >= attributionThresholds.preStartP95Fraction) {
      report.attribution = "pre-start";
    } else if (report.postStartP95Fraction >= attributionThresholds.postStartP95Fraction) {
      report.attribution = "post-start";
    }
    report.predictionPassed = report.attribution === "pre-start";
    report.allSafe =
      report.failure === null &&
      report.runs.length === repetitions &&
      report.runs.every((run) => run.safe && run.phaseClockCoherent);
    report.thresholdsPassed = report.attribution !== "unresolved";

    await mkdir(dirname(milestoneOutputPath), { recursive: true });
    await writeFile(milestoneOutputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`[real compiled Host milestones] ${milestoneOutputPath}\n`);

    expect(report.failure).toBeNull();
    expect(report.allSafe).toBe(true);
    expect(report.thresholdsPassed).toBe(true);
  }, 300_000);
});

describeDedicatedBinary("real dedicated Station Host binary comparison", () => {
  beforeAll(async () => {
    await prepareCurrentBinary();
    dedicatedRoot = await realpath(await mkdtemp(join(tmpdir(), "st-dedicated-host-")));
    dedicatedBinaryPath = join(dedicatedRoot, "station-host");
    const buildStartedAt = performance.now();
    await execFileAsync(
      bunCommand,
      [
        "build",
        hostEntry,
        "--compile",
        "--outfile",
        dedicatedBinaryPath,
        "--define",
        `STATION_BUILD_VERSION=${JSON.stringify(expectedBuildVersion)}`,
        "--define",
        "STATION_BUILD_COMPILED=true",
        "--define",
        `STATION_BUILD_IDENTITY=${JSON.stringify(buildIdentity)}`,
      ],
      { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024, timeout: 300_000 },
    );
    dedicatedBuildMs = performance.now() - buildStartedAt;
    dedicatedBytes = (await stat(dedicatedBinaryPath)).size;
  }, 310_000);

  afterAll(async () => {
    if (dedicatedRoot.length > 0) await rm(dedicatedRoot, { recursive: true, force: true });
  });

  it("compares monolithic and Host-only compiled startup", async () => {
    const binaryStrategies = ["monolithic", "dedicated"] as const;
    type BinaryStrategy = (typeof binaryStrategies)[number];
    const binaryThresholds = {
      intentMedianImprovementFraction: 0.3,
      intentP95ImprovementFraction: 0.3,
      ensureMedianImprovementFraction: 0.3,
      ensureP95ImprovementFraction: 0.3,
      dedicatedIntentP95Ms: 500,
    } as const;
    const report = {
      schemaVersion: 1,
      benchmark: "station-quick-session-dedicated-host-binary-comparison",
      generatedAt: new Date().toISOString(),
      machine: {
        platform: platform(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
      },
      tools: {
        bun: (await execFileAsync(bunCommand, ["--version"])).stdout.trim(),
        hostProtocolVersion: HOST_PROTOCOL_VERSION,
        hostBuildVersion: expectedBuildVersion,
        buildIdentity,
      },
      repositoryShape: { repetitions, freshStatePerRun: true },
      binaries: {
        monolithic: { bytes: binaryBytes },
        dedicated: {
          buildMs: dedicatedBuildMs,
          bytes: dedicatedBytes,
          buildExcludedFromLaunchTiming: true,
          rootRemoved: false,
        },
      },
      diagnosticSetup: { ptyImplementation: "bun-nocctty", productionCandidate: false },
      keepThresholds: binaryThresholds,
      strategies: {
        monolithic: { runs: [] as HostEntryStrategyRun[] },
        dedicated: { runs: [] as HostEntryStrategyRun[] },
      },
      repetitions: [] as Array<{ repetition: number; strategyOrder: BinaryStrategy[] }>,
      intentMedianImprovementFraction: 0,
      intentP95ImprovementFraction: 0,
      ensureMedianImprovementFraction: 0,
      ensureP95ImprovementFraction: 0,
      allSafe: false,
      thresholdsPassed: false,
      failure: null as string | null,
    };

    try {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const strategyOrder: BinaryStrategy[] =
          repetition % 2 === 0 ? [...binaryStrategies] : [...binaryStrategies].reverse();
        for (const strategy of strategyOrder) {
          const hostCommand =
            strategy === "monolithic"
              ? ([binaryPath, "__station-host"] as const)
              : ([dedicatedBinaryPath] as const);
          report.strategies[strategy].runs.push(
            await runHostEntryStrategy({
              strategy,
              repetition,
              hostCommand,
              expectedBuildVersion,
              ptyImplementation: "bun-nocctty",
              redactRoots: [dedicatedRoot],
            }),
          );
        }
        report.repetitions.push({ repetition, strategyOrder });
      }
    } catch (error) {
      report.failure = diagnosticError(error);
    } finally {
      await rm(dedicatedRoot, { recursive: true, force: true });
      report.binaries.dedicated.rootRemoved = !(await pathExists(dedicatedRoot));
    }

    const monolithic = summarizeHostEntryRuns(report.strategies.monolithic.runs);
    const dedicated = summarizeHostEntryRuns(report.strategies.dedicated.runs);
    Object.assign(report.strategies.monolithic, monolithic);
    Object.assign(report.strategies.dedicated, dedicated);
    report.intentMedianImprovementFraction = improvement(
      monolithic.intentToInputAckMs.median,
      dedicated.intentToInputAckMs.median,
    );
    report.intentP95ImprovementFraction = improvement(
      monolithic.intentToInputAckMs.p95,
      dedicated.intentToInputAckMs.p95,
    );
    report.ensureMedianImprovementFraction = improvement(
      monolithic.ensureMs.median,
      dedicated.ensureMs.median,
    );
    report.ensureP95ImprovementFraction = improvement(
      monolithic.ensureMs.p95,
      dedicated.ensureMs.p95,
    );
    report.allSafe =
      report.failure === null &&
      report.binaries.dedicated.rootRemoved &&
      report.repetitions.length === repetitions &&
      [...report.strategies.monolithic.runs, ...report.strategies.dedicated.runs].every(
        (run) => run.safe && run.phaseClockCoherent,
      );
    report.thresholdsPassed =
      report.intentMedianImprovementFraction >= binaryThresholds.intentMedianImprovementFraction &&
      report.intentP95ImprovementFraction >= binaryThresholds.intentP95ImprovementFraction &&
      report.ensureMedianImprovementFraction >= binaryThresholds.ensureMedianImprovementFraction &&
      report.ensureP95ImprovementFraction >= binaryThresholds.ensureP95ImprovementFraction &&
      dedicated.intentToInputAckMs.p95 <= binaryThresholds.dedicatedIntentP95Ms &&
      dedicatedBytes < binaryBytes;

    await mkdir(dirname(dedicatedOutputPath), { recursive: true });
    await writeFile(dedicatedOutputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`[real dedicated Host binary comparison] ${dedicatedOutputPath}\n`);

    expect(report.failure).toBeNull();
    expect(report.allSafe).toBe(true);
    expect(report.thresholdsPassed).toBe(true);
  }, 300_000);
});

describeCompiledSequence("real compiled Station Host launch sequence", () => {
  beforeAll(async () => {
    await prepareCurrentBinary();
  }, 310_000);

  it("separates first-execution warmup from steady cold Hosts", async () => {
    const sequenceRepetitions = 20;
    const sequenceThresholds = {
      steadyIntentP95Ms: 300,
      steadyEnsureP95Ms: 300,
      earlySlowSampleFraction: 0.8,
      slowSampleMs: 500,
    } as const;
    const report = {
      schemaVersion: 1,
      benchmark: "station-quick-session-compiled-host-sequence",
      generatedAt: new Date().toISOString(),
      machine: {
        platform: platform(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
      },
      tools: {
        bun: (await execFileAsync(bunCommand, ["--version"])).stdout.trim(),
        hostProtocolVersion: HOST_PROTOCOL_VERSION,
        hostBuildVersion: expectedBuildVersion,
        buildIdentity,
      },
      repositoryShape: { repetitions: sequenceRepetitions, freshStatePerRun: true },
      binary: {
        buildMs: binaryBuildMs,
        bytes: binaryBytes,
        buildExcludedFromLaunchTiming: true,
      },
      diagnosticSetup: { ptyImplementation: "bun-nocctty", productionCandidate: false },
      keepThresholds: sequenceThresholds,
      runs: [] as HostEntryStrategyRun[],
      slowSamplePositions: [] as number[],
      earlySlowSampleFraction: 0,
      predictionPassed: false,
      allSafe: false,
      thresholdsPassed: false,
      failure: null as string | null,
    };

    try {
      for (let position = 0; position < sequenceRepetitions; position += 1) {
        report.runs.push(
          await runHostEntryStrategy({
            strategy: "compiledSequence",
            repetition: position,
            hostCommand: [binaryPath, "__station-host"],
            expectedBuildVersion,
            ptyImplementation: "bun-nocctty",
          }),
        );
      }
    } catch (error) {
      report.failure = diagnosticError(error);
    }

    const full = summarizeHostEntryRuns(report.runs);
    const steady = summarizeHostEntryRuns(report.runs.slice(1));
    Object.assign(report, { full, steady });
    report.slowSamplePositions = report.runs.flatMap((run, position) =>
      run.ensureMs > sequenceThresholds.slowSampleMs ? [position + 1] : [],
    );
    const earlySlowCount = report.slowSamplePositions.filter((position) => position <= 2).length;
    report.earlySlowSampleFraction =
      report.slowSamplePositions.length === 0
        ? 1
        : earlySlowCount / report.slowSamplePositions.length;
    report.predictionPassed =
      report.slowSamplePositions.length === 1 && report.slowSamplePositions[0] === 1;
    report.allSafe =
      report.failure === null &&
      report.runs.length === sequenceRepetitions &&
      report.runs.every((run) => run.safe && run.phaseClockCoherent);
    report.thresholdsPassed =
      steady.intentToInputAckMs.p95 <= sequenceThresholds.steadyIntentP95Ms &&
      steady.ensureMs.p95 <= sequenceThresholds.steadyEnsureP95Ms &&
      report.earlySlowSampleFraction >= sequenceThresholds.earlySlowSampleFraction;

    await mkdir(dirname(sequenceOutputPath), { recursive: true });
    await writeFile(sequenceOutputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`[real compiled Host sequence] ${sequenceOutputPath}\n`);

    expect(report.failure).toBeNull();
    expect(report.allSafe).toBe(true);
    expect(report.thresholdsPassed).toBe(true);
  }, 300_000);
});

async function prepareCurrentBinary() {
  binaryBuildPromise ??= (async () => {
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
    const [binaryStats, identity] = await Promise.all([
      stat(binaryPath),
      readFile(buildIdentityPath, "utf8"),
    ]);
    binaryBytes = binaryStats.size;
    buildIdentity = z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .parse(identity.trim());
    await access(hostEntry);
  })();
  await binaryBuildPromise;
}

async function pathExists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

function improvement(baseline: number, candidate: number) {
  return baseline === 0 ? 0 : (baseline - candidate) / baseline;
}

function fraction(part: number, whole: number) {
  return whole === 0 ? 0 : part / whole;
}

function diagnosticError(error: unknown) {
  const parsed = z.object({ message: z.string().min(1) }).safeParse(error);
  return parsed.success ? parsed.data.message : "Unknown compiled Host benchmark failure.";
}
