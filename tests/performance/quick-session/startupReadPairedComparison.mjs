import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";

const worktrunkCommand = process.env.STATION_WORKTRUNK_BIN ?? "wt";
const comparisonMode = z
  .enum(["structural", "hybrid", "deferred"])
  .parse(process.env.STATION_STARTUP_READ_COMPARISON_MODE ?? "structural");
const candidateStrategy = comparisonMode;
const outputPath = resolve(
  process.env.STATION_STARTUP_READ_PAIRED_BENCHMARK_OUTPUT ??
    ".dev-state/performance/quick-session/startup-read-paired-comparison.real.json",
);
const repetitions = 5;
const initialLinkedWorktrees = 48;
const initialWorktrees = initialLinkedWorktrees + 1;
const maxConcurrentCreates = 4;
const scenarios = [
  { name: "warm-single", burstSize: 1, includesStartup: false },
  { name: "cold-single", burstSize: 1, includesStartup: true },
  { name: "burst-3", burstSize: 3, includesStartup: false },
  { name: "burst-5", burstSize: 5, includesStartup: false },
  { name: "burst-20", burstSize: 20, includesStartup: false },
];

const WorktrunkListItemSchema = z
  .object({
    path: z.string().min(1),
    branch: z.string().min(1),
  })
  .passthrough();
const WorktrunkListSchema = z.array(WorktrunkListItemSchema);

const report = {
  schemaVersion: 1,
  benchmark: `station-quick-session-startup-read-${comparisonMode}-paired-comparison`,
  generatedAt: new Date().toISOString(),
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
  },
  tools: {
    worktrunk: (await run(worktrunkCommand, ["--version"])).stdout.trim(),
    git: (await run("git", ["--version"])).stdout.trim(),
  },
  repositoryShape: {
    initialWorktrees,
    lifecycleHooks: false,
    maxConcurrentCreates,
    repetitions,
  },
  comparisonMode,
  keepThresholds: {
    coldMedianImprovementFraction: comparisonMode === "deferred" ? 0.6 : 0.5,
    coldP95ImprovementFraction: comparisonMode === "deferred" ? 0.6 : 0.5,
    structuralReadP95Ms: 75,
    deferredReadP95Ms: 700,
    maximumWarmOrBurstRegressionFraction: 0.2,
  },
  structuralReadMs: undefined,
  deferredReadMs: undefined,
  allSafe: false,
  thresholdsPassed: false,
  scenarios: scenarios.map((scenario) => ({ ...scenario, pairs: [] })),
  repetitions: [],
};

for (let repetition = 0; repetition < repetitions; repetition += 1) {
  report.repetitions.push(await runRepetition(repetition));
}

for (const scenario of report.scenarios) {
  const controlRuns = scenario.pairs.map((pair) => pair.enriched);
  const candidateRuns = scenario.pairs.map((pair) => pair[candidateStrategy]);
  scenario.enriched = summarizeStrategy(controlRuns);
  scenario[candidateStrategy] = summarizeStrategy(candidateRuns);
  scenario.medianImprovementFraction = improvement(
    scenario.enriched.blockingMs.median,
    scenario[candidateStrategy].blockingMs.median,
  );
  scenario.p95ImprovementFraction = improvement(
    scenario.enriched.blockingMs.p95,
    scenario[candidateStrategy].blockingMs.p95,
  );
  scenario.p95RegressionFraction = regression(
    scenario.enriched.blockingMs.p95,
    scenario[candidateStrategy].blockingMs.p95,
  );
  scenario.allSafe = [...controlRuns, ...candidateRuns].every((run) => run.safe);
}

report.structuralReadMs = distribution(
  report.scenarios.flatMap((scenario) =>
    scenario.pairs.map((pair) => pair[candidateStrategy].structuralReadMs),
  ),
);
report.deferredReadMs = distribution(
  report.scenarios.flatMap((scenario) =>
    scenario.pairs.map((pair) => pair[candidateStrategy].deferredReadMs),
  ),
);
report.allSafe =
  report.repetitions.every((repetition) => repetition.temporaryRootRemoved) &&
  report.scenarios.every((scenario) => scenario.allSafe);
const cold = scenarioNamed("cold-single");
const warmAndBursts = report.scenarios.filter((scenario) => scenario.name !== "cold-single");
report.thresholdsPassed =
  cold.medianImprovementFraction >= report.keepThresholds.coldMedianImprovementFraction &&
  cold.p95ImprovementFraction >= report.keepThresholds.coldP95ImprovementFraction &&
  (comparisonMode === "deferred"
    ? report.deferredReadMs.p95 <= report.keepThresholds.deferredReadP95Ms
    : report.structuralReadMs.p95 <= report.keepThresholds.structuralReadP95Ms) &&
  warmAndBursts.every(
    (scenario) =>
      scenario.p95RegressionFraction <= report.keepThresholds.maximumWarmOrBurstRegressionFraction,
  );

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`[startup read paired comparison] ${outputPath}\n`);

if (!report.allSafe || !report.thresholdsPassed) process.exitCode = 1;

async function runRepetition(repetition) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "station-startup-read-paired-"));
  const benchmarkRoot = await realpath(temporaryRoot);
  const repetitionReport = { repetition, temporaryRootRemoved: false };
  try {
    const root = join(benchmarkRoot, "repo");
    const shapeRoot = join(benchmarkRoot, "shape");
    const managedRoot = join(benchmarkRoot, "created");
    const worktrunkConfigPath = join(benchmarkRoot, "worktrunk.toml");
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(shapeRoot, { recursive: true }),
      mkdir(managedRoot, { recursive: true }),
      writeFile(worktrunkConfigPath, "", "utf8"),
    ]);
    const expectedInventory = await initializeRepository(root, shapeRoot);
    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      const order =
        (repetition + scenarioIndex) % 2 === 0
          ? ["enriched", candidateStrategy]
          : [candidateStrategy, "enriched"];
      const strategies = {};
      for (const strategy of order) {
        const result = await runStrategy({
          strategy,
          scenario,
          repetition,
          root,
          managedRoot,
          worktrunkConfigPath,
          expectedInventory,
        });
        strategies[strategy] = result;
        await cleanupCreated(root, result.created);
        delete result.created;
        result.cleanupInventoryCount = await gitWorktreeCount(root);
        result.safe &&= result.cleanupInventoryCount === initialWorktrees;
      }
      scenarioNamed(scenario.name).pairs.push({
        repetition,
        order,
        enriched: strategies.enriched,
        [candidateStrategy]: strategies[candidateStrategy],
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
  const expected = [{ path: root, branch: "main" }];
  for (let index = 0; index < initialLinkedWorktrees; index += 1) {
    const path = join(shapeRoot, `shape-${index}`);
    const branch = `shape-${index}`;
    await run("git", ["worktree", "add", "--quiet", "-b", branch, path, "main"], { cwd: root });
    expected.push({ path, branch });
  }
  return sortInventory(expected);
}

async function runStrategy(input) {
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  const blockingStartedAt = performance.now();
  const startupReads = [];
  let structuralReadMs = 0;
  let enrichmentReadMs = 0;
  let deferredReadMs = 0;
  if (input.strategy === "enriched") {
    const enrichmentStartedAt = performance.now();
    startupReads.push(await readEnrichedInventory(input.root, input.worktrunkConfigPath));
    enrichmentReadMs = performance.now() - enrichmentStartedAt;
  } else if (input.strategy !== "deferred") {
    const structuralStartedAt = performance.now();
    startupReads.push(await readStructuralInventory(input.root));
    structuralReadMs = performance.now() - structuralStartedAt;
    if (input.strategy === "hybrid" && !input.scenario.includesStartup) {
      const enrichmentStartedAt = performance.now();
      startupReads.push(await readEnrichedInventory(input.root, input.worktrunkConfigPath));
      enrichmentReadMs = performance.now() - enrichmentStartedAt;
    }
  }
  const mutationStartedAt = performance.now();
  const created = Array.from({ length: input.scenario.burstSize }, (_, index) => ({
    branch: `paired-${input.scenario.name}-${input.strategy}-${input.repetition}-${index}`,
    path: join(
      input.managedRoot,
      `paired-${input.scenario.name}-${input.strategy}-${input.repetition}-${index}`,
    ),
  }));
  let activeCreates = 0;
  let peakActiveCreates = 0;
  const createResults = await mapBounded(created, maxConcurrentCreates, async (create) => {
    activeCreates += 1;
    peakActiveCreates = Math.max(peakActiveCreates, activeCreates);
    try {
      return await createNativeWorktree(input.root, create);
    } finally {
      activeCreates -= 1;
    }
  });
  const finishedAt = performance.now();
  const inventory = await readNativeInventory(input.root);
  const expectedAfterCreate = sortInventory([
    ...input.expectedInventory,
    ...created.map((entry) => ({ path: entry.path, branch: entry.branch })),
  ]);
  if (input.strategy === "deferred") {
    const enrichmentStartedAt = performance.now();
    startupReads.push(
      await readEnrichedInventory(
        input.root,
        input.worktrunkConfigPath,
        expectedAfterCreate.length,
      ),
    );
    deferredReadMs = performance.now() - enrichmentStartedAt;
    enrichmentReadMs = deferredReadMs;
  }
  const expectedReadInventory =
    input.strategy === "deferred" ? expectedAfterCreate : input.expectedInventory;
  const exactStartupInventory = startupReads.every(
    (startup) => JSON.stringify(startup.inventory) === JSON.stringify(expectedReadInventory),
  );
  const exactCreatedInventory = JSON.stringify(inventory) === JSON.stringify(expectedAfterCreate);
  const safe =
    startupReads.every((startup) => startup.command.code === 0 && startup.parseSucceeded) &&
    exactStartupInventory &&
    createResults.every((result) => result.safe) &&
    exactCreatedInventory &&
    new Set(inventory.map((entry) => entry.path)).size === inventory.length &&
    new Set(inventory.map((entry) => entry.branch)).size === inventory.length &&
    peakActiveCreates === Math.min(maxConcurrentCreates, input.scenario.burstSize);
  return {
    strategy: input.strategy,
    blockingMs: input.scenario.includesStartup
      ? finishedAt - blockingStartedAt
      : finishedAt - mutationStartedAt,
    startupReadMs: mutationStartedAt - blockingStartedAt,
    structuralReadMs,
    enrichmentReadMs,
    deferredReadMs,
    mutationMs: finishedAt - mutationStartedAt,
    throughputPerSecond: input.scenario.burstSize / ((finishedAt - mutationStartedAt) / 1000),
    safe,
    parseSucceeded: startupReads.every((startup) => startup.parseSucceeded),
    exactStartupInventory,
    exactCreatedInventory,
    peakActiveCreates,
    inventoryCount: inventory.length,
    cleanupInventoryCount: null,
    loadAverage: { before: loadBefore, after: loadavg() },
    resourceUsage: resourceDelta(usageBefore, process.resourceUsage()),
    startupCommands: startupReads.map((startup) => ({
      kind: startup.kind,
      code: startup.command.code,
      ms: startup.command.ms,
      stderr: redact(startup.command.stderr, dirname(input.root)),
    })),
    createCommands: createResults.map((result) => ({
      safe: result.safe,
      bareProbeMs: result.bareProbeMs,
      addMs: result.addMs,
      verifyMs: result.verifyMs,
      code: result.code,
      stderr: redact(result.stderr, dirname(input.root)),
    })),
    created,
  };
}

async function readEnrichedInventory(root, worktrunkConfigPath, expectedLength = initialWorktrees) {
  const command = await run(
    worktrunkCommand,
    ["--config", worktrunkConfigPath, "-C", root, "list", "--format=json"],
    { allowFailure: true },
  );
  try {
    const items = WorktrunkListSchema.length(expectedLength).parse(JSON.parse(command.stdout));
    return {
      command,
      kind: "enriched",
      parseSucceeded: true,
      inventory: sortInventory(items.map((item) => ({ path: item.path, branch: item.branch }))),
    };
  } catch {
    return { command, kind: "enriched", parseSucceeded: false, inventory: [] };
  }
}

async function readStructuralInventory(root) {
  const command = await run("git", ["-C", root, "worktree", "list", "--porcelain", "-z"], {
    allowFailure: true,
  });
  try {
    return {
      command,
      kind: "structural",
      parseSucceeded: true,
      inventory: parseNativeInventory(command.stdout),
    };
  } catch {
    return { command, kind: "structural", parseSucceeded: false, inventory: [] };
  }
}

async function readNativeInventory(root) {
  const result = await run("git", ["-C", root, "worktree", "list", "--porcelain", "-z"]);
  return parseNativeInventory(result.stdout);
}

function parseNativeInventory(output) {
  const records = [];
  let current;
  for (const field of output.split("\0")) {
    if (field.length === 0) {
      if (current !== undefined) {
        records.push(finishNativeRecord(current));
        current = undefined;
      }
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current !== undefined) throw new Error("Native Git omitted a record separator.");
      current = { path: field.slice("worktree ".length) };
      continue;
    }
    if (current === undefined) throw new Error("Native Git field preceded its worktree path.");
    if (field.startsWith("HEAD ")) assignOnce(current, "head", field.slice("HEAD ".length));
    else if (field.startsWith("branch refs/heads/")) {
      assignOnce(current, "branch", field.slice("branch refs/heads/".length));
    } else if (field === "detached") assignOnce(current, "detached", true);
    else if (field === "bare") assignOnce(current, "bare", true);
    else if (field === "locked" || field.startsWith("locked ")) {
      assignOnce(current, "locked", true);
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      assignOnce(current, "prunable", true);
    } else throw new Error("Native Git returned an unknown structural field.");
  }
  if (current !== undefined) records.push(finishNativeRecord(current));
  const inventory = sortInventory(records);
  if (
    inventory.length === 0 ||
    new Set(inventory.map((entry) => entry.path)).size !== inventory.length
  ) {
    throw new Error("Native Git returned an empty or duplicate structural inventory.");
  }
  return inventory;
}

function finishNativeRecord(record) {
  if (
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    typeof record.head !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(record.head) ||
    record.bare === true ||
    record.detached === true ||
    typeof record.branch !== "string" ||
    record.locked === true ||
    record.prunable === true
  ) {
    throw new Error("Native Git returned an unsupported or incomplete structural record.");
  }
  return { path: record.path, branch: record.branch };
}

function assignOnce(record, field, value) {
  if (record[field] !== undefined) throw new Error("Native Git repeated a structural field.");
  record[field] = value;
}

async function createNativeWorktree(root, create) {
  const bareProbe = await run(
    "git",
    ["-C", root, "config", "--local", "--type=bool", "--get", "core.bare"],
    { allowFailure: true },
  );
  if (bareProbe.code !== 0 && bareProbe.code !== 1) {
    return createFailure(bareProbe, { bareProbeMs: bareProbe.ms, addMs: 0, verifyMs: 0 });
  }
  if (bareProbe.code === 0 && bareProbe.stdout.trim() === "true") {
    return createFailure(bareProbe, { bareProbeMs: bareProbe.ms, addMs: 0, verifyMs: 0 });
  }
  const add = await run(
    "git",
    ["-C", root, "worktree", "add", "--quiet", "-b", create.branch, create.path, "main"],
    { allowFailure: true },
  );
  if (add.code !== 0) {
    return createFailure(add, { bareProbeMs: bareProbe.ms, addMs: add.ms, verifyMs: 0 });
  }
  const verify = await run(
    "git",
    [
      "-C",
      create.path,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--abbrev-ref=strict",
      "HEAD",
    ],
    { allowFailure: true },
  );
  const [verifiedPath, verifiedBranch, ...extra] = verify.stdout.trim().split("\n");
  return {
    safe:
      verify.code === 0 &&
      verifiedPath === create.path &&
      verifiedBranch === create.branch &&
      extra.length === 0,
    code: verify.code,
    stderr: `${bareProbe.stderr}${add.stderr}${verify.stderr}`,
    bareProbeMs: bareProbe.ms,
    addMs: add.ms,
    verifyMs: verify.ms,
  };
}

function createFailure(command, timings) {
  return {
    safe: false,
    code: command.code,
    stderr: command.stderr,
    ...timings,
  };
}

async function cleanupCreated(root, created) {
  for (const create of created) {
    await run("git", ["-C", root, "worktree", "remove", "--force", create.path]);
    await run("git", ["-C", root, "branch", "-D", create.branch]);
  }
}

async function gitWorktreeCount(root) {
  return (await readNativeInventory(root)).length;
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

function scenarioNamed(name) {
  const found = report.scenarios.find((scenario) => scenario.name === name);
  if (found === undefined) throw new Error(`Missing startup-read scenario ${name}.`);
  return found;
}

function sortInventory(inventory) {
  return [...inventory].sort((left, right) => left.path.localeCompare(right.path));
}

function summarizeStrategy(runs) {
  return {
    blockingMs: distribution(runs.map((run) => run.blockingMs)),
    startupReadMs: distribution(runs.map((run) => run.startupReadMs)),
    deferredReadMs: distribution(runs.map((run) => run.deferredReadMs)),
    mutationMs: distribution(runs.map((run) => run.mutationMs)),
    throughputPerSecond: distribution(runs.map((run) => run.throughputPerSecond)),
    allSafe: runs.every((run) => run.safe),
  };
}

function improvement(baseline, candidate) {
  return baseline === 0 ? 0 : (baseline - candidate) / baseline;
}

function regression(baseline, candidate) {
  return baseline === 0 ? 0 : (candidate - baseline) / baseline;
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
      env: options.env ?? process.env,
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
      const result = {
        code: code ?? -1,
        stdout,
        stderr,
        ms: performance.now() - startedAt,
      };
      if (result.code !== 0 && options.allowFailure !== true) {
        rejectRun(new Error(`${command} failed with ${result.code}: ${redact(stderr, tmpdir())}`));
        return;
      }
      resolveRun(result);
    });
  });
}
