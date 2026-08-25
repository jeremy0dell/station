import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const comparisonMode = process.env.STATION_NATIVE_GIT_CONCURRENCY_MODE ?? "four-vs-eight";
if (comparisonMode !== "four-vs-eight" && comparisonMode !== "adaptive-overflow") {
  throw new Error(`Unsupported native Git concurrency mode: ${comparisonMode}`);
}
const adaptiveOverflow = comparisonMode === "adaptive-overflow";
const candidateName = adaptiveOverflow ? "adaptiveOverflow" : "bound8";
const outputPath = resolve(
  process.env.STATION_NATIVE_GIT_CONCURRENCY_BENCHMARK_OUTPUT ??
    (adaptiveOverflow
      ? ".dev-state/performance/quick-session/native-git-adaptive-overflow.real.json"
      : ".dev-state/performance/quick-session/native-git-concurrency.real.json"),
);
const burstSizes = [3, 5, 20];
const repetitions = 5;
const initialLinkedWorktrees = 48;
const bounds = adaptiveOverflow ? [4, "4-then-3-overflow"] : [4, 8];

const report = {
  schemaVersion: 1,
  benchmark: adaptiveOverflow
    ? "station-quick-session-native-git-adaptive-overflow"
    : "station-quick-session-native-git-concurrency",
  generatedAt: new Date().toISOString(),
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
  },
  tools: {
    git: (await run("git", ["--version"])).stdout.trim(),
  },
  repositoryShape: {
    initialWorktrees: initialLinkedWorktrees + 1,
    lifecycleHooks: false,
    bounds,
    repetitions,
  },
  keepThresholds: adaptiveOverflow
    ? {
        burst3MaximumRegressionFraction: 0.1,
        burst5MaximumRegressionFraction: 0.1,
        burst20MaximumMedianRegressionFraction: 0.1,
        burst20P95ImprovementFraction: 0.25,
      }
    : {
        burst5MedianImprovementFraction: 0.15,
        burst5P95ImprovementFraction: 0.15,
        burst20MedianImprovementFraction: 0.2,
        burst20P95ImprovementFraction: 0.2,
      },
  scenarios: [],
};

for (const [burstIndex, burstSize] of burstSizes.entries()) {
  const pairs = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    pairs.push(await runPair({ burstIndex, burstSize, repetition }));
  }
  const bound4WallMs = distribution(pairs.map((pair) => pair.bound4.wallMs));
  const candidateWallMs = distribution(pairs.map((pair) => pair[candidateName].wallMs));
  report.scenarios.push({
    burstSize,
    bound4: summarizeBound(pairs.map((pair) => pair.bound4)),
    [candidateName]: summarizeBound(pairs.map((pair) => pair[candidateName])),
    medianImprovementFraction: improvement(bound4WallMs.median, candidateWallMs.median),
    p95ImprovementFraction: improvement(bound4WallMs.p95, candidateWallMs.p95),
    allSafe: pairs.every(
      (pair) => pair.bound4.safe && pair[candidateName].safe && pair.temporaryRootRemoved,
    ),
    pairs,
  });
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`[${report.benchmark}] ${outputPath}\n`);

const burst3 = scenario(3);
const burst5 = scenario(5);
const burst20 = scenario(20);
const thresholdsPassed = adaptiveOverflow
  ? burst3.medianImprovementFraction >= -report.keepThresholds.burst3MaximumRegressionFraction &&
    burst3.p95ImprovementFraction >= -report.keepThresholds.burst3MaximumRegressionFraction &&
    burst5.medianImprovementFraction >= -report.keepThresholds.burst5MaximumRegressionFraction &&
    burst5.p95ImprovementFraction >= -report.keepThresholds.burst5MaximumRegressionFraction &&
    burst20.medianImprovementFraction >=
      -report.keepThresholds.burst20MaximumMedianRegressionFraction &&
    burst20.p95ImprovementFraction >= report.keepThresholds.burst20P95ImprovementFraction
  : burst5.medianImprovementFraction >= report.keepThresholds.burst5MedianImprovementFraction &&
    burst5.p95ImprovementFraction >= report.keepThresholds.burst5P95ImprovementFraction &&
    burst20.medianImprovementFraction >= report.keepThresholds.burst20MedianImprovementFraction &&
    burst20.p95ImprovementFraction >= report.keepThresholds.burst20P95ImprovementFraction;
if (!report.scenarios.every((candidate) => candidate.allSafe) || !thresholdsPassed) {
  process.exitCode = 1;
}

function scenario(burstSize) {
  const found = report.scenarios.find((candidate) => candidate.burstSize === burstSize);
  if (found === undefined) throw new Error(`Missing native Git concurrency burst ${burstSize}.`);
  return found;
}

async function runPair({ burstIndex, burstSize, repetition }) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "station-native-git-concurrency-"));
  const benchmarkRoot = await realpath(temporaryRoot);
  let pair;
  try {
    const root = join(benchmarkRoot, "repo");
    const shapeRoot = join(benchmarkRoot, "shape");
    const managedRoot = join(benchmarkRoot, "created");
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(shapeRoot, { recursive: true }),
      mkdir(managedRoot, { recursive: true }),
    ]);
    await initializeRepository(root, shapeRoot);
    const order =
      (burstIndex + repetition) % 2 === 0 ? ["bound4", candidateName] : [candidateName, "bound4"];
    const candidates = {};
    for (const candidate of order) {
      const bound = candidate === "bound8" ? 8 : 4;
      const result = await runBound({
        candidate,
        bound,
        adaptiveOverflow: candidate === "adaptiveOverflow",
        root,
        managedRoot,
        burstSize,
        repetition,
      });
      candidates[candidate] = result;
      await cleanupCreated(root, managedRoot, result.commands);
      result.cleanupInventoryCount = await gitWorktreeCount(root);
      result.safe &&= result.cleanupInventoryCount === initialLinkedWorktrees + 1;
    }
    pair = {
      repetition,
      order,
      temporaryRootRemoved: false,
      bound4: candidates.bound4,
      [candidateName]: candidates[candidateName],
    };
  } finally {
    await rm(benchmarkRoot, { recursive: true, force: true });
    if (pair !== undefined) pair.temporaryRootRemoved = !(await pathExists(benchmarkRoot));
  }
  if (pair === undefined) throw new Error("Native Git concurrency pair did not complete.");
  return pair;
}

async function initializeRepository(root, shapeRoot) {
  await run("git", ["init", "--initial-branch=main", "--quiet"], { cwd: root });
  await run("git", ["config", "user.name", "Station Benchmark"], { cwd: root });
  await run("git", ["config", "user.email", "station-benchmark@example.invalid"], {
    cwd: root,
  });
  await run("git", ["commit", "--allow-empty", "--message=baseline", "--quiet"], { cwd: root });
  for (let index = 0; index < initialLinkedWorktrees; index += 1) {
    await run(
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
}

async function runBound({
  candidate,
  bound,
  adaptiveOverflow: useAdaptiveOverflow,
  root,
  managedRoot,
  burstSize,
  repetition,
}) {
  const commands = Array.from({ length: burstSize }, (_, index) => {
    const branch = `probe-${candidate}-${repetition}-${index}`;
    return { branch, path: join(managedRoot, branch) };
  });
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  let active = 0;
  let peakActive = 0;
  const startedAt = performance.now();
  const task = async (command) => {
    active += 1;
    peakActive = Math.max(peakActive, active);
    try {
      return await runNativeGitCreate(root, command);
    } finally {
      active -= 1;
    }
  };
  const scheduled =
    useAdaptiveOverflow && burstSize > 5
      ? await mapAdaptiveOverflow(commands, task)
      : {
          results: await mapBounded(commands, bound, task),
          transitioned: false,
          postTransitionPeakActive: null,
        };
  const results = scheduled.results;
  const wallMs = performance.now() - startedAt;
  const inventory = parseGitWorktreePorcelain(
    (await run("git", ["worktree", "list", "--porcelain"], { cwd: root })).stdout,
  );
  const exactRegistration = commands.every((command) =>
    inventory.some(
      (entry) => entry.path === command.path && entry.branch === `refs/heads/${command.branch}`,
    ),
  );
  const uniqueBranches = new Set(inventory.map((entry) => entry.branch));
  const overflowPolicyExact =
    !useAdaptiveOverflow ||
    burstSize <= 5 ||
    (scheduled.transitioned && scheduled.postTransitionPeakActive <= 3);
  const safe =
    results.every((result) => result.code === 0) &&
    exactRegistration &&
    inventory.length === initialLinkedWorktrees + 1 + burstSize &&
    uniqueBranches.size === inventory.length &&
    peakActive === Math.min(bound, burstSize) &&
    overflowPolicyExact;
  return {
    candidate,
    bound,
    wallMs,
    safe,
    exactRegistration,
    inventoryCount: inventory.length,
    cleanupInventoryCount: null,
    peakActive,
    overflowPolicyExact,
    postTransitionPeakActive: scheduled.postTransitionPeakActive,
    loadAverage: { before: loadBefore, after: loadavg() },
    resourceUsage: resourceDelta(usageBefore, process.resourceUsage()),
    commands: results.map((result) => ({
      branch: result.branch,
      path: result.path.replace(dirname(root), "$TMP_REPO"),
      code: result.code,
      ms: result.ms,
      stderr: result.stderr.replaceAll(dirname(root), "$TMP_REPO").trim(),
    })),
  };
}

async function runNativeGitCreate(root, input) {
  const result = await run(
    "git",
    ["-C", root, "worktree", "add", "--quiet", "-b", input.branch, input.path, "main"],
    { allowFailure: true },
  );
  return { ...input, ...result };
}

async function cleanupCreated(root, managedRoot, commands) {
  for (const command of commands) {
    await run("git", [
      "-C",
      root,
      "worktree",
      "remove",
      "--force",
      join(managedRoot, command.branch),
    ]);
    await run("git", ["-C", root, "branch", "-D", command.branch]);
  }
}

async function gitWorktreeCount(root) {
  const inventory = await run("git", ["-C", root, "worktree", "list", "--porcelain"]);
  return parseGitWorktreePorcelain(inventory.stdout).length;
}

function parseGitWorktreePorcelain(output) {
  return output
    .trim()
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
      return { path, branch };
    });
}

function mapAdaptiveOverflow(values, task) {
  return new Promise((resolvePromise, rejectPromise) => {
    const results = Array(values.length);
    let nextIndex = 0;
    let active = 0;
    let transitioned = false;
    let postTransitionPeakActive = 0;
    let failed = false;

    const launch = () => {
      const capacity = transitioned ? 3 : 4;
      while (!failed && nextIndex < values.length && active < capacity) {
        const index = nextIndex;
        nextIndex += 1;
        active += 1;
        if (transitioned) {
          postTransitionPeakActive = Math.max(postTransitionPeakActive, active);
        }
        void Promise.resolve(task(values[index])).then(
          (result) => {
            results[index] = result;
            active -= 1;
            if (!transitioned) {
              transitioned = true;
              postTransitionPeakActive = active;
            }
            if (nextIndex === values.length && active === 0) {
              resolvePromise({ results, transitioned, postTransitionPeakActive });
              return;
            }
            launch();
          },
          (error) => {
            failed = true;
            rejectPromise(error);
          },
        );
      }
    };

    launch();
  });
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

function summarizeBound(runs) {
  return {
    wallMs: distribution(runs.map((run) => run.wallMs)),
    commandMs: distribution(runs.flatMap((run) => run.commands.map((command) => command.ms))),
    throughputPerSecond: distribution(runs.map((run) => run.commands.length / (run.wallMs / 1000))),
    allSafe: runs.every((run) => run.safe),
  };
}

function improvement(baseline, candidate) {
  return baseline === 0 ? 0 : (baseline - candidate) / baseline;
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

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = performance.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
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
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      const result = {
        code: code ?? -1,
        stdout,
        stderr,
        ms: performance.now() - startedAt,
      };
      if (result.code === 0 || options.allowFailure === true) {
        resolvePromise(result);
        return;
      }
      rejectPromise(new Error(`${command} failed (${result.code}): ${stderr.trim()}`));
    });
  });
}

function distribution(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples,
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted, value) {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(value * sorted.length) - 1] ?? 0;
}
