import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const worktrunkCommand = process.env.STATION_WORKTRUNK_BIN ?? "wt";
const outputPath = resolve(
  process.env.STATION_NATIVE_GIT_CREATE_BENCHMARK_OUTPUT ??
    ".dev-state/performance/quick-session/native-git-create-comparison.real.json",
);
const burstSizes = [3, 5, 20];
const repetitions = 5;
const initialLinkedWorktrees = 48;
const maxConcurrent = 4;

const report = {
  schemaVersion: 1,
  benchmark: "station-quick-session-native-git-create-comparison",
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
    initialWorktrees: initialLinkedWorktrees + 1,
    lifecycleHooks: false,
    maxConcurrent,
    repetitions,
  },
  keepThresholds: {
    burst5MedianImprovementFraction: 0.4,
    burst5P95ImprovementFraction: 0.4,
    burst20MedianImprovementFraction: 0.4,
    burst20P95ImprovementFraction: 0.4,
  },
  scenarios: [],
};

for (const [burstIndex, burstSize] of burstSizes.entries()) {
  const pairs = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    pairs.push(await runPair({ burstIndex, burstSize, repetition }));
  }
  const worktrunkWallMs = distribution(pairs.map((pair) => pair.worktrunk.wallMs));
  const nativeGitWallMs = distribution(pairs.map((pair) => pair.nativeGit.wallMs));
  report.scenarios.push({
    burstSize,
    worktrunk: summarizeImplementation(pairs.map((pair) => pair.worktrunk)),
    nativeGit: summarizeImplementation(pairs.map((pair) => pair.nativeGit)),
    medianImprovementFraction: improvement(worktrunkWallMs.median, nativeGitWallMs.median),
    p95ImprovementFraction: improvement(worktrunkWallMs.p95, nativeGitWallMs.p95),
    allSafe: pairs.every((pair) => pair.worktrunk.safe && pair.nativeGit.safe),
    pairs,
  });
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`[native Git create comparison] ${outputPath}\n`);

const burst5 = scenario(5);
const burst20 = scenario(20);
const thresholdsPassed =
  burst5.medianImprovementFraction >= report.keepThresholds.burst5MedianImprovementFraction &&
  burst5.p95ImprovementFraction >= report.keepThresholds.burst5P95ImprovementFraction &&
  burst20.medianImprovementFraction >= report.keepThresholds.burst20MedianImprovementFraction &&
  burst20.p95ImprovementFraction >= report.keepThresholds.burst20P95ImprovementFraction;
if (!report.scenarios.every((candidate) => candidate.allSafe) || !thresholdsPassed) {
  process.exitCode = 1;
}

function scenario(burstSize) {
  const found = report.scenarios.find((candidate) => candidate.burstSize === burstSize);
  if (found === undefined) throw new Error(`Missing native Git comparison burst ${burstSize}.`);
  return found;
}

async function runPair({ burstIndex, burstSize, repetition }) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "station-native-git-create-"));
  const benchmarkRoot = await realpath(temporaryRoot);
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
    await initializeRepository(root, shapeRoot);
    const order =
      (burstIndex + repetition) % 2 === 0 ? ["worktrunk", "nativeGit"] : ["nativeGit", "worktrunk"];
    const implementations = {};
    for (const implementation of order) {
      const result = await runImplementation({
        implementation,
        root,
        managedRoot,
        worktrunkConfigPath,
        burstSize,
        repetition,
      });
      implementations[implementation] = result;
      await cleanupCreated(root, managedRoot, result.commands);
      result.cleanupInventoryCount = await gitWorktreeCount(root);
      result.safe &&= result.cleanupInventoryCount === initialLinkedWorktrees + 1;
    }
    return {
      repetition,
      order,
      worktrunk: implementations.worktrunk,
      nativeGit: implementations.nativeGit,
    };
  } finally {
    await rm(benchmarkRoot, { recursive: true, force: true });
  }
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

async function runImplementation({
  implementation,
  root,
  managedRoot,
  worktrunkConfigPath,
  burstSize,
  repetition,
}) {
  const commands = Array.from({ length: burstSize }, (_, index) => {
    const branch = `probe-${implementation}-${repetition}-${index}`;
    return { branch, path: join(managedRoot, branch) };
  });
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  let active = 0;
  let peakActive = 0;
  const startedAt = performance.now();
  const results = await mapBounded(commands, maxConcurrent, async (command) => {
    active += 1;
    peakActive = Math.max(peakActive, active);
    try {
      return implementation === "worktrunk"
        ? await runWorktrunkCreate(root, command, worktrunkConfigPath)
        : await runNativeGitCreate(root, command);
    } finally {
      active -= 1;
    }
  });
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
  const safe =
    results.every((result) => result.code === 0 && result.outputValid) &&
    exactRegistration &&
    inventory.length === initialLinkedWorktrees + 1 + burstSize &&
    uniqueBranches.size === inventory.length &&
    peakActive === Math.min(maxConcurrent, burstSize);
  return {
    implementation,
    wallMs,
    safe,
    exactRegistration,
    inventoryCount: inventory.length,
    cleanupInventoryCount: null,
    peakActive,
    loadAverage: { before: loadBefore, after: loadavg() },
    resourceUsage: resourceDelta(usageBefore, process.resourceUsage()),
    commands: results.map((result) => ({
      branch: result.branch,
      path: result.path.replace(dirname(root), "$TMP_REPO"),
      code: result.code,
      ms: result.ms,
      outputValid: result.outputValid,
      stderr: result.stderr.replaceAll(dirname(root), "$TMP_REPO").trim(),
    })),
  };
}

async function runWorktrunkCreate(root, input, worktrunkConfigPath) {
  const result = await run(
    worktrunkCommand,
    [
      "--config",
      worktrunkConfigPath,
      "-C",
      root,
      "switch",
      "--no-hooks",
      "--create",
      input.branch,
      "--base",
      "main",
      "--no-cd",
      "--format=json",
    ],
    {
      cwd: root,
      env: { ...process.env, WORKTRUNK_WORKTREE_PATH: input.path },
      allowFailure: true,
    },
  );
  let outputValid = false;
  try {
    const payload = JSON.parse(result.stdout);
    outputValid = payload.branch === input.branch && payload.path === input.path;
  } catch {
    outputValid = false;
  }
  return { ...input, ...result, outputValid };
}

async function runNativeGitCreate(root, input) {
  const result = await run(
    "git",
    ["-C", root, "worktree", "add", "--quiet", "-b", input.branch, input.path, "main"],
    { allowFailure: true },
  );
  return { ...input, ...result, outputValid: result.code === 0 };
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

function summarizeImplementation(runs) {
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
