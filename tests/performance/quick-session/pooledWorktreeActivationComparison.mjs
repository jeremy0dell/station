import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";

const outputPath = resolve(
  process.env.STATION_POOLED_WORKTREE_BENCHMARK_OUTPUT ??
    ".dev-state/performance/quick-session/pooled-worktree-activation-comparison.real.json",
);
const repetitions = 5;
const ordinaryLinkedWorktrees = 48;
const poolSize = z
  .enum(["5", "20"])
  .transform((value) => Number(value))
  .parse(process.env.STATION_POOLED_WORKTREE_POOL_SIZE ?? "20");
const rightSizedPool = poolSize === 5;
const fallbackScheduling = z
  .enum(["interleaved", "phased"])
  .parse(process.env.STATION_POOLED_WORKTREE_FALLBACK_SCHEDULING ?? "interleaved");
const initialWorktrees = ordinaryLinkedWorktrees + poolSize + 1;
const maxConcurrent = 4;
const burstSizes = [1, 3, 5, 20];

const InventoryRecordSchema = z
  .object({
    path: z.string().min(1),
    head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
    branch: z.string().min(1).nullable(),
  })
  .strict();

const report = {
  schemaVersion: 1,
  benchmark: rightSizedPool
    ? fallbackScheduling === "phased"
      ? "station-quick-session-pooled-worktree-five-slot-phased-comparison"
      : "station-quick-session-pooled-worktree-five-slot-comparison"
    : "station-quick-session-pooled-worktree-activation-comparison",
  generatedAt: new Date().toISOString(),
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
  },
  tools: { git: (await run("git", ["--version"])).stdout.trim() },
  repositoryShape: {
    ordinaryWorktrees: ordinaryLinkedWorktrees + 1,
    poolSize,
    initialWorktrees,
    maxConcurrent,
    repetitions,
    fallbackScheduling,
  },
  keepThresholds: rightSizedPool
    ? {
        poolFillP95Ms: 150,
        singleMedianImprovementFraction: 0.25,
        singleP95ImprovementFraction: 0.25,
        burst5MedianImprovementFraction: 0.3,
        burst5P95ImprovementFraction: 0.3,
        burst20FirstFiveMedianImprovementFraction: 0.3,
        burst20FirstFiveP95ImprovementFraction: 0.3,
        burst20MaximumFinalRegressionFraction: 0.2,
      }
    : {
        singleMedianImprovementFraction: 0.25,
        singleP95ImprovementFraction: 0.25,
        burst5MedianImprovementFraction: 0.3,
        burst5P95ImprovementFraction: 0.3,
        burst20MedianImprovementFraction: 0.3,
        burst20P95ImprovementFraction: 0.3,
      },
  poolFill: undefined,
  allSafe: false,
  thresholdsPassed: false,
  scenarios: burstSizes.map((burstSize) => ({ burstSize, pairs: [] })),
  repetitions: [],
};

for (let repetition = 0; repetition < repetitions; repetition += 1) {
  report.repetitions.push(await runRepetition(repetition));
}

for (const scenario of report.scenarios) {
  const nativeRuns = scenario.pairs.map((pair) => pair.nativeCreate);
  const pooledRuns = scenario.pairs.map((pair) => pair.pooledActivation);
  scenario.nativeCreate = summarize(nativeRuns);
  scenario.pooledActivation = summarize(pooledRuns);
  scenario.medianImprovementFraction = improvement(
    scenario.nativeCreate.wallMs.median,
    scenario.pooledActivation.wallMs.median,
  );
  scenario.p95ImprovementFraction = improvement(
    scenario.nativeCreate.wallMs.p95,
    scenario.pooledActivation.wallMs.p95,
  );
  scenario.firstFiveMedianImprovementFraction = improvement(
    scenario.nativeCreate.firstFiveInteractiveMs.median,
    scenario.pooledActivation.firstFiveInteractiveMs.median,
  );
  scenario.firstFiveP95ImprovementFraction = improvement(
    scenario.nativeCreate.firstFiveInteractiveMs.p95,
    scenario.pooledActivation.firstFiveInteractiveMs.p95,
  );
  scenario.allSafe = [...nativeRuns, ...pooledRuns].every((run) => run.safe);
}

report.poolFill = {
  wallMs: distribution(report.repetitions.map((repetition) => repetition.poolFill.wallMs)),
  commandMs: distribution(
    report.repetitions.flatMap((repetition) => repetition.poolFill.commandMs),
  ),
  allSafe: report.repetitions.every((repetition) => repetition.poolFill.safe),
};
report.allSafe =
  report.poolFill.allSafe &&
  report.repetitions.every((repetition) => repetition.temporaryRootRemoved) &&
  report.scenarios.every((scenario) => scenario.allSafe);
const single = scenarioNamed(1);
const burst5 = scenarioNamed(5);
const burst20 = scenarioNamed(20);
report.thresholdsPassed = rightSizedPool
  ? report.poolFill.wallMs.p95 <= report.keepThresholds.poolFillP95Ms &&
    single.medianImprovementFraction >= report.keepThresholds.singleMedianImprovementFraction &&
    single.p95ImprovementFraction >= report.keepThresholds.singleP95ImprovementFraction &&
    burst5.medianImprovementFraction >= report.keepThresholds.burst5MedianImprovementFraction &&
    burst5.p95ImprovementFraction >= report.keepThresholds.burst5P95ImprovementFraction &&
    burst20.firstFiveMedianImprovementFraction >=
      report.keepThresholds.burst20FirstFiveMedianImprovementFraction &&
    burst20.firstFiveP95ImprovementFraction >=
      report.keepThresholds.burst20FirstFiveP95ImprovementFraction &&
    burst20.medianImprovementFraction >=
      -report.keepThresholds.burst20MaximumFinalRegressionFraction &&
    burst20.p95ImprovementFraction >= -report.keepThresholds.burst20MaximumFinalRegressionFraction
  : single.medianImprovementFraction >= report.keepThresholds.singleMedianImprovementFraction &&
    single.p95ImprovementFraction >= report.keepThresholds.singleP95ImprovementFraction &&
    burst5.medianImprovementFraction >= report.keepThresholds.burst5MedianImprovementFraction &&
    burst5.p95ImprovementFraction >= report.keepThresholds.burst5P95ImprovementFraction &&
    burst20.medianImprovementFraction >= report.keepThresholds.burst20MedianImprovementFraction &&
    burst20.p95ImprovementFraction >= report.keepThresholds.burst20P95ImprovementFraction;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`[pooled worktree activation comparison] ${outputPath}\n`);
if (!report.allSafe || !report.thresholdsPassed) process.exitCode = 1;

async function runRepetition(repetition) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "station-pooled-worktree-"));
  const benchmarkRoot = await realpath(temporaryRoot);
  const repetitionReport = {
    repetition,
    temporaryRootRemoved: false,
    poolFill: { wallMs: 0, commandMs: [], safe: false },
  };
  try {
    const root = join(benchmarkRoot, "repo");
    const shapeRoot = join(benchmarkRoot, "shape");
    const poolRoot = join(benchmarkRoot, "pool");
    const createdRoot = join(benchmarkRoot, "created");
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(shapeRoot, { recursive: true }),
      mkdir(poolRoot, { recursive: true }),
      mkdir(createdRoot, { recursive: true }),
    ]);
    const { baseSha, ordinaryInventory } = await initializeRepository(root, shapeRoot);
    const slots = Array.from({ length: poolSize }, (_, index) => join(poolRoot, `slot-${index}`));
    repetitionReport.poolFill = await fillPool(root, slots, baseSha);
    const expectedIdleInventory = sortInventory([
      ...ordinaryInventory,
      ...slots.map((path) => ({ path, head: baseSha, branch: null })),
    ]);
    repetitionReport.poolFill.safe &&=
      JSON.stringify(await readInventory(root)) === JSON.stringify(expectedIdleInventory) &&
      (await poolSlotsAreClean(slots));

    for (const [scenarioIndex, burstSize] of burstSizes.entries()) {
      const order =
        (repetition + scenarioIndex) % 2 === 0
          ? ["nativeCreate", "pooledActivation"]
          : ["pooledActivation", "nativeCreate"];
      const strategies = {};
      for (const strategy of order) {
        const result = await runStrategy({
          strategy,
          repetition,
          burstSize,
          root,
          baseSha,
          slots,
          createdRoot,
          expectedIdleInventory,
        });
        strategies[strategy] = result;
        if (strategy === "nativeCreate") {
          await cleanupNativeCreates(root, result.cleanupTargets);
        } else {
          await cleanupPooledStrategy(root, result.cleanupTargets);
        }
        delete result.cleanupTargets;
        const resetInventory = await readInventory(root);
        result.cleanupInventoryCount = resetInventory.length;
        result.safe &&=
          JSON.stringify(resetInventory) === JSON.stringify(expectedIdleInventory) &&
          (await poolSlotsAreClean(slots));
      }
      scenarioNamed(burstSize).pairs.push({
        repetition,
        order,
        nativeCreate: strategies.nativeCreate,
        pooledActivation: strategies.pooledActivation,
      });
    }
  } finally {
    await rm(benchmarkRoot, { recursive: true, force: true });
    repetitionReport.temporaryRootRemoved = !(await pathExists(benchmarkRoot));
  }
  return repetitionReport;
}

async function initializeRepository(root, shapeRoot) {
  await run("git", ["init", "--initial-branch=main", "--quiet"], { cwd: root });
  await run("git", ["config", "user.name", "Station Benchmark"], { cwd: root });
  await run("git", ["config", "user.email", "station-benchmark@example.invalid"], {
    cwd: root,
  });
  await run("git", ["commit", "--allow-empty", "--message=baseline", "--quiet"], { cwd: root });
  const baseSha = (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  const ordinaryInventory = [{ path: root, head: baseSha, branch: "main" }];
  for (let index = 0; index < ordinaryLinkedWorktrees; index += 1) {
    const path = join(shapeRoot, `shape-${index}`);
    const branch = `shape-${index}`;
    await run("git", ["-C", root, "worktree", "add", "--quiet", "-b", branch, path, "main"]);
    ordinaryInventory.push({ path, head: baseSha, branch });
  }
  return { baseSha, ordinaryInventory: sortInventory(ordinaryInventory) };
}

async function fillPool(root, slots, baseSha) {
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  const startedAt = performance.now();
  const results = await mapBounded(slots, maxConcurrent, (path) =>
    run("git", ["-C", root, "worktree", "add", "--quiet", "--detach", path, "main"], {
      allowFailure: true,
    }),
  );
  const wallMs = performance.now() - startedAt;
  const safe =
    results.every((result) => result.code === 0) &&
    (await Promise.all(slots.map((path) => verifyDetachedSlot(path, baseSha)))).every(Boolean);
  return {
    wallMs,
    commandMs: results.map((result) => result.ms),
    safe,
    loadAverage: { before: loadBefore, after: loadavg() },
    resourceUsage: resourceDelta(usageBefore, process.resourceUsage()),
  };
}

async function runStrategy(input) {
  const commands = Array.from({ length: input.burstSize }, (_, index) => {
    const slot = input.strategy === "pooledActivation" ? input.slots[index] : undefined;
    const mechanism =
      input.strategy === "nativeCreate"
        ? "native-create"
        : slot === undefined
          ? "native-fallback"
          : "pooled-activation";
    return {
      branch: `pooled-${input.strategy}-${input.burstSize}-${input.repetition}-${index}`,
      path:
        slot ??
        join(
          input.createdRoot,
          `pooled-${input.strategy}-${input.burstSize}-${input.repetition}-${index}`,
        ),
      mechanism,
    };
  });
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  let active = 0;
  let peakActive = 0;
  const startedAt = performance.now();
  const execute = async (command) => {
    const startedAtMs = performance.now() - startedAt;
    active += 1;
    peakActive = Math.max(peakActive, active);
    try {
      const result =
        command.mechanism === "pooled-activation"
          ? await activatePooledWorktree(input.root, command)
          : await createNativeWorktree(input.root, command);
      return {
        ...result,
        mechanism: command.mechanism,
        startedAtMs,
        interactiveAtMs: performance.now() - startedAt,
      };
    } finally {
      active -= 1;
    }
  };
  const batches =
    input.strategy === "pooledActivation" && fallbackScheduling === "phased"
      ? [
          commands.filter((command) => command.mechanism === "pooled-activation"),
          commands.filter((command) => command.mechanism === "native-fallback"),
        ]
      : [commands];
  const results = [];
  for (const batch of batches) {
    results.push(...(await mapBounded(batch, maxConcurrent, execute)));
  }
  const wallMs = performance.now() - startedAt;
  const inventory = await readInventory(input.root);
  const expected = expectedStrategyInventory(input, commands);
  const exactInventory = JSON.stringify(inventory) === JSON.stringify(expected);
  const pooledActivationCount = commands.filter(
    (command) => command.mechanism === "pooled-activation",
  ).length;
  const nativeFallbackCount = commands.filter(
    (command) => command.mechanism === "native-fallback",
  ).length;
  const exactMechanismCounts =
    input.strategy === "nativeCreate"
      ? pooledActivationCount === 0 && nativeFallbackCount === 0
      : pooledActivationCount === Math.min(input.burstSize, input.slots.length) &&
        nativeFallbackCount === Math.max(0, input.burstSize - input.slots.length);
  const activationCompletedAt = Math.max(
    0,
    ...results
      .filter((result) => result.mechanism === "pooled-activation")
      .map((result) => result.interactiveAtMs),
  );
  const fallbackStartedAt = Math.min(
    Number.POSITIVE_INFINITY,
    ...results
      .filter((result) => result.mechanism === "native-fallback")
      .map((result) => result.startedAtMs),
  );
  const exactPhaseOrdering =
    fallbackScheduling !== "phased" ||
    fallbackStartedAt === Number.POSITIVE_INFINITY ||
    fallbackStartedAt >= activationCompletedAt;
  return {
    strategy: input.strategy,
    wallMs,
    throughputPerSecond: input.burstSize / (wallMs / 1000),
    safe:
      results.every((result) => result.safe) &&
      exactInventory &&
      exactMechanismCounts &&
      exactPhaseOrdering &&
      peakActive === Math.min(maxConcurrent, input.burstSize),
    exactInventory,
    exactMechanismCounts,
    exactPhaseOrdering,
    activationCompletedAt,
    fallbackStartedAt: fallbackStartedAt === Number.POSITIVE_INFINITY ? null : fallbackStartedAt,
    peakActive,
    inventoryCount: inventory.length,
    pooledActivationCount,
    nativeFallbackCount,
    firstFiveInteractiveMs: nthInteractiveMs(results, 5),
    cleanupInventoryCount: null,
    loadAverage: { before: loadBefore, after: loadavg() },
    resourceUsage: resourceDelta(usageBefore, process.resourceUsage()),
    commands: results.map((result) => ({
      safe: result.safe,
      bareProbeMs: result.bareProbeMs,
      mutationMs: result.mutationMs,
      verifyMs: result.verifyMs,
      mechanism: result.mechanism,
      startedAtMs: result.startedAtMs,
      interactiveAtMs: result.interactiveAtMs,
      code: result.code,
      stderr: redact(result.stderr, dirname(input.root)),
    })),
    cleanupTargets: commands,
  };
}

function expectedStrategyInventory(input, commands) {
  if (input.strategy === "nativeCreate") {
    return sortInventory([
      ...input.expectedIdleInventory,
      ...commands.map((command) => ({
        path: command.path,
        head: input.baseSha,
        branch: command.branch,
      })),
    ]);
  }
  const activatedByPath = new Map(
    commands
      .filter((command) => command.mechanism === "pooled-activation")
      .map((command) => [command.path, command.branch]),
  );
  const fallbackEntries = commands
    .filter((command) => command.mechanism === "native-fallback")
    .map((command) => ({
      path: command.path,
      head: input.baseSha,
      branch: command.branch,
    }));
  return sortInventory([
    ...input.expectedIdleInventory.map((entry) => ({
      ...entry,
      branch: activatedByPath.get(entry.path) ?? entry.branch,
    })),
    ...fallbackEntries,
  ]);
}

async function createNativeWorktree(root, command) {
  return guardedMutation(root, command, () =>
    run(
      "git",
      ["-C", root, "worktree", "add", "--quiet", "-b", command.branch, command.path, "main"],
      { allowFailure: true },
    ),
  );
}

async function activatePooledWorktree(root, command) {
  return guardedMutation(root, command, () =>
    run("git", ["-C", command.path, "switch", "--quiet", "--create", command.branch, "main"], {
      allowFailure: true,
    }),
  );
}

async function guardedMutation(root, command, mutate) {
  const bareProbe = await run(
    "git",
    ["-C", root, "config", "--local", "--type=bool", "--get", "core.bare"],
    { allowFailure: true },
  );
  if (
    (bareProbe.code !== 0 && bareProbe.code !== 1) ||
    (bareProbe.code === 0 && bareProbe.stdout.trim() === "true")
  ) {
    return failedMutation(bareProbe, bareProbe.ms, 0, 0);
  }
  const mutation = await mutate();
  if (mutation.code !== 0) {
    return failedMutation(mutation, bareProbe.ms, mutation.ms, 0);
  }
  const verify = await run(
    "git",
    [
      "-C",
      command.path,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--abbrev-ref=strict",
      "HEAD",
    ],
    { allowFailure: true },
  );
  const [path, branch, ...extra] = verify.stdout.trim().split("\n");
  return {
    safe:
      verify.code === 0 && path === command.path && branch === command.branch && extra.length === 0,
    code: verify.code,
    stderr: `${bareProbe.stderr}${mutation.stderr}${verify.stderr}`,
    bareProbeMs: bareProbe.ms,
    mutationMs: mutation.ms,
    verifyMs: verify.ms,
  };
}

function failedMutation(command, bareProbeMs, mutationMs, verifyMs) {
  return {
    safe: false,
    code: command.code,
    stderr: command.stderr,
    bareProbeMs,
    mutationMs,
    verifyMs,
  };
}

async function cleanupNativeCreates(root, commands) {
  for (const command of commands) {
    await run("git", ["-C", root, "worktree", "remove", "--force", command.path]);
    await run("git", ["-C", root, "branch", "-D", command.branch]);
  }
}

async function cleanupPooledStrategy(root, commands) {
  const activated = commands.filter((command) => command.mechanism === "pooled-activation");
  const fallbacks = commands.filter((command) => command.mechanism === "native-fallback");
  await resetActivatedSlots(root, activated);
  await cleanupNativeCreates(root, fallbacks);
}

async function resetActivatedSlots(root, commands) {
  for (const command of commands) {
    await run("git", ["-C", command.path, "switch", "--quiet", "--detach", "--force", "main"]);
    await run("git", ["-C", root, "branch", "-D", command.branch]);
  }
}

async function verifyDetachedSlot(path, baseSha) {
  const [head, branch, status] = await Promise.all([
    run("git", ["-C", path, "rev-parse", "HEAD"], { allowFailure: true }),
    run("git", ["-C", path, "symbolic-ref", "--quiet", "HEAD"], { allowFailure: true }),
    run("git", ["-C", path, "status", "--porcelain"], { allowFailure: true }),
  ]);
  return (
    head.code === 0 &&
    head.stdout.trim() === baseSha &&
    branch.code === 1 &&
    status.code === 0 &&
    status.stdout.length === 0
  );
}

async function poolSlotsAreClean(slots) {
  const results = await mapBounded(slots, maxConcurrent, (path) =>
    run("git", ["-C", path, "status", "--porcelain"], { allowFailure: true }),
  );
  return results.every((result) => result.code === 0 && result.stdout.length === 0);
}

async function readInventory(root) {
  const command = await run("git", ["-C", root, "worktree", "list", "--porcelain", "-z"]);
  const records = [];
  let current;
  for (const field of command.stdout.split("\0")) {
    if (field.length === 0) {
      if (current !== undefined) {
        records.push(finishInventoryRecord(current));
        current = undefined;
      }
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current !== undefined) throw new Error("Git inventory omitted a separator.");
      current = { path: field.slice("worktree ".length) };
      continue;
    }
    if (current === undefined) throw new Error("Git inventory field preceded its path.");
    if (field.startsWith("HEAD ")) assignOnce(current, "head", field.slice("HEAD ".length));
    else if (field.startsWith("branch refs/heads/")) {
      assignOnce(current, "branch", field.slice("branch refs/heads/".length));
    } else if (field === "detached") assignOnce(current, "detached", true);
    else throw new Error("Git inventory returned an unsupported field.");
  }
  if (current !== undefined) records.push(finishInventoryRecord(current));
  const inventory = sortInventory(records);
  if (
    inventory.length === 0 ||
    new Set(inventory.map((entry) => entry.path)).size !== inventory.length
  ) {
    throw new Error("Git inventory was empty or duplicated a path.");
  }
  return inventory;
}

function finishInventoryRecord(record) {
  return InventoryRecordSchema.parse({
    path: record.path,
    head: record.head,
    branch: record.detached === true ? null : record.branch,
  });
}

function assignOnce(record, field, value) {
  if (record[field] !== undefined) throw new Error("Git inventory repeated a field.");
  record[field] = value;
}

function sortInventory(inventory) {
  return [...inventory].sort((left, right) => left.path.localeCompare(right.path));
}

async function mapBounded(values, concurrency, task) {
  const results = Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function scenarioNamed(burstSize) {
  const found = report.scenarios.find((scenario) => scenario.burstSize === burstSize);
  if (found === undefined) throw new Error(`Missing pooled-worktree burst ${burstSize}.`);
  return found;
}

function summarize(runs) {
  return {
    wallMs: distribution(runs.map((run) => run.wallMs)),
    firstFiveInteractiveMs: distribution(runs.map((run) => run.firstFiveInteractiveMs)),
    commandMs: distribution(runs.flatMap((run) => run.commands.map(commandTotalMs))),
    throughputPerSecond: distribution(runs.map((run) => run.throughputPerSecond)),
    allSafe: runs.every((run) => run.safe),
  };
}

function nthInteractiveMs(results, count) {
  const completions = results
    .map((result) => result.interactiveAtMs)
    .sort((left, right) => left - right);
  return completions[Math.min(count, completions.length) - 1] ?? 0;
}

function commandTotalMs(command) {
  return command.bareProbeMs + command.mutationMs + command.verifyMs;
}

function improvement(baseline, candidate) {
  return baseline === 0 ? 0 : (baseline - candidate) / baseline;
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted,
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? 0;
}

function resourceDelta(before, after) {
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

function redact(text, temporaryParent) {
  return text.replaceAll(temporaryParent, "$TMP_ROOT").trim();
}

async function pathExists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const startedAt = performance.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: cleanEnvironment(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      const result = { code: code ?? -1, stdout, stderr, ms: performance.now() - startedAt };
      if (result.code !== 0 && options.allowFailure !== true) {
        rejectRun(new Error(`${command} failed with ${result.code}: ${redact(stderr, tmpdir())}`));
        return;
      }
      resolveRun(result);
    });
  });
}

function cleanEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  for (const name of [
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
    delete environment[name];
  }
  return environment;
}
