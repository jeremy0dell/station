import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";

const worktrunkCommand = process.env.STATION_WORKTRUNK_BIN ?? "wt";
const outputPath = resolve(
  process.env.STATION_NATIVE_GIT_REMOVE_BENCHMARK_OUTPUT ??
    ".dev-state/performance/quick-session/native-git-remove-comparison.real.json",
);
const burstSizes = [1, 3, 5, 20];
const repetitions = 5;
const linkedShapeWorktrees = 48;
const initialInventoryCount = linkedShapeWorktrees + 1;
const maxConcurrent = 4;

const GitInventoryRecordSchema = z
  .object({
    path: z.string().min(1),
    branch: z.string().min(1).nullable(),
    isPrimary: z.boolean(),
  })
  .strict();
const WorktrunkListPayloadSchema = z.array(z.record(z.string(), z.unknown()));
const WorktrunkSelectionSchema = z
  .object({
    path: z.string().min(1),
    branch: z.string().min(1),
  })
  .strict();
const GitDirPointerSchema = z.string().regex(/^gitdir: .+\n?$/u);

const report = {
  schemaVersion: 1,
  benchmark: "station-quick-session-native-git-remove-comparison",
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
    initialWorktrees: initialInventoryCount,
    lifecycleHooks: false,
    maxConcurrent,
    repetitions,
  },
  keepThresholds: {
    singleMedianImprovementFraction: 0.25,
    singleP95ImprovementFraction: 0.25,
    burst5MedianImprovementFraction: 0.4,
    burst5P95ImprovementFraction: 0.4,
    burst20MedianImprovementFraction: 0.4,
    burst20P95ImprovementFraction: 0.4,
  },
  allSafe: false,
  thresholdsPassed: false,
  scenarios: burstSizes.map((burstSize) => ({ burstSize, pairs: [] })),
  repetitions: [],
};

for (let repetition = 0; repetition < repetitions; repetition += 1) {
  report.repetitions.push(await runRepetition(repetition));
}

for (const scenario of report.scenarios) {
  const worktrunkRuns = scenario.pairs.map((pair) => pair.worktrunk);
  const nativeRuns = scenario.pairs.map((pair) => pair.nativeGit);
  scenario.worktrunk = summarize(worktrunkRuns);
  scenario.nativeGit = summarize(nativeRuns);
  scenario.medianImprovementFraction = improvement(
    scenario.worktrunk.wallMs.median,
    scenario.nativeGit.wallMs.median,
  );
  scenario.p95ImprovementFraction = improvement(
    scenario.worktrunk.wallMs.p95,
    scenario.nativeGit.wallMs.p95,
  );
  scenario.allSafe = [...worktrunkRuns, ...nativeRuns].every((runResult) => runResult.safe);
}

report.allSafe =
  report.scenarios.every((scenario) => scenario.allSafe) &&
  report.repetitions.every((repetition) => repetition.temporaryRootRemoved);
const single = scenarioNamed(1);
const burst5 = scenarioNamed(5);
const burst20 = scenarioNamed(20);
report.thresholdsPassed =
  single.medianImprovementFraction >= report.keepThresholds.singleMedianImprovementFraction &&
  single.p95ImprovementFraction >= report.keepThresholds.singleP95ImprovementFraction &&
  burst5.medianImprovementFraction >= report.keepThresholds.burst5MedianImprovementFraction &&
  burst5.p95ImprovementFraction >= report.keepThresholds.burst5P95ImprovementFraction &&
  burst20.medianImprovementFraction >= report.keepThresholds.burst20MedianImprovementFraction &&
  burst20.p95ImprovementFraction >= report.keepThresholds.burst20P95ImprovementFraction;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`[native Git remove comparison] ${outputPath}\n`);
if (!report.allSafe || !report.thresholdsPassed) process.exitCode = 1;

async function runRepetition(repetition) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "station-native-git-remove-"));
  const benchmarkRoot = await realpath(temporaryRoot);
  const repetitionReport = { repetition, temporaryRootRemoved: false };
  try {
    const root = join(benchmarkRoot, "repo");
    const shapeRoot = join(benchmarkRoot, "shape");
    const removalRoot = join(benchmarkRoot, "remove");
    const worktrunkConfigPath = join(benchmarkRoot, "worktrunk.toml");
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(shapeRoot, { recursive: true }),
      mkdir(removalRoot, { recursive: true }),
      writeFile(worktrunkConfigPath, "", "utf8"),
    ]);
    await initializeRepository(root, shapeRoot);
    const initialInventory = await readGitInventory(root);
    if (initialInventory.length !== initialInventoryCount) {
      throw new Error(`Removal fixture expected ${initialInventoryCount} worktrees.`);
    }
    const project = benchmarkProject(root, removalRoot);

    for (const [scenarioIndex, burstSize] of burstSizes.entries()) {
      const order =
        (repetition + scenarioIndex) % 2 === 0
          ? ["worktrunk", "nativeGit"]
          : ["nativeGit", "worktrunk"];
      const strategies = {};
      for (const strategy of order) {
        const targets = await createRemovalTargets({
          root,
          removalRoot,
          strategy,
          burstSize,
          repetition,
        });
        const result = await runRemovalStrategy({
          strategy,
          project,
          worktrunkConfigPath,
          targets,
        });
        strategies[strategy] = result;
        await cleanupRemainingTargets(root, targets);
        const cleanupInventory = await readGitInventory(root);
        result.cleanupInventoryCount = cleanupInventory.length;
        result.safe &&=
          cleanupInventory.length === initialInventoryCount &&
          (await branchesAbsent(root, targets));
      }
      scenarioNamed(burstSize).pairs.push({
        repetition,
        order,
        worktrunk: strategies.worktrunk,
        nativeGit: strategies.nativeGit,
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
  await run("git", ["commit", "--allow-empty", "--message=baseline", "--quiet"], {
    cwd: root,
  });
  for (let index = 0; index < linkedShapeWorktrees; index += 1) {
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

function benchmarkProject(root, removalRoot) {
  return {
    id: "remove-project",
    label: "Removal benchmark",
    root,
    defaultBranch: "main",
    defaults: {
      harness: "scripted",
      terminal: "native",
      layout: "agent-shell",
    },
    worktrunk: {
      enabled: true,
      base: "main",
      managedRoot: removalRoot,
      includeMain: true,
      includeExternal: true,
    },
  };
}

async function createRemovalTargets(input) {
  const commands = Array.from({ length: input.burstSize }, (_, index) => ({
    branch: `remove-${input.strategy}-${input.burstSize}-${input.repetition}-${index}`,
    path: join(
      input.removalRoot,
      `remove-${input.strategy}-${input.burstSize}-${input.repetition}-${index}`,
    ),
  }));
  const results = await mapBounded(commands, maxConcurrent, (command) =>
    run("git", [
      "-C",
      input.root,
      "worktree",
      "add",
      "--quiet",
      "-b",
      command.branch,
      command.path,
      "main",
    ]),
  );
  if (results.some((result) => result.code !== 0)) {
    throw new Error("Removal benchmark could not create its target burst.");
  }
  const inventory = await readGitInventory(input.root);
  const targets = [];
  for (const command of commands) {
    const observation = inventory.find(
      (entry) => entry.path === command.path && entry.branch === command.branch,
    );
    if (observation === undefined || observation.isPrimary) {
      throw new Error(`Removal target ${command.branch} was not registered exactly.`);
    }
    targets.push({
      ...command,
      registrationIdentity: await registrationIdentity(command.path, input.root),
    });
  }
  if (inventory.length !== initialInventoryCount + input.burstSize) {
    throw new Error("Removal target inventory did not have the expected shape.");
  }
  return targets;
}

async function runRemovalStrategy(input) {
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  let active = 0;
  let peakActive = 0;
  const startedAt = performance.now();
  const results = await mapBounded(input.targets, maxConcurrent, async (target) => {
    active += 1;
    peakActive = Math.max(peakActive, active);
    try {
      return input.strategy === "worktrunk"
        ? await removeWithWorktrunk(input, target)
        : await removeWithNativeGit(input, target);
    } finally {
      active -= 1;
    }
  });
  const wallMs = performance.now() - startedAt;
  const inventory = await readGitInventory(input.project.root);
  const exactAbsence = input.targets.every(
    (target) => !inventory.some((entry) => entry.path === target.path),
  );
  const deletedBranches = await branchesAbsent(input.project.root, input.targets);
  return {
    strategy: input.strategy,
    wallMs,
    safe:
      results.every((result) => result.safe) &&
      exactAbsence &&
      deletedBranches &&
      inventory.length === initialInventoryCount &&
      peakActive === Math.min(maxConcurrent, input.targets.length),
    exactAbsence,
    deletedBranches,
    peakActive,
    inventoryCount: inventory.length,
    cleanupInventoryCount: null,
    loadAverage: { before: loadBefore, after: loadavg() },
    resourceUsage: resourceDelta(usageBefore, process.resourceUsage()),
    commands: results,
  };
}

async function removeWithWorktrunk(input, target) {
  const startedAt = performance.now();
  const bare = await bareProbe(input.project.root);
  if (!bare.safe) return removalFailure("worktrunk", startedAt, bare.stderr);
  const listed = await run(
    worktrunkCommand,
    ["--config", input.worktrunkConfigPath, "list", "--format=json"],
    { cwd: input.project.root, allowFailure: true },
  );
  if (listed.code !== 0) return removalFailure("worktrunk", startedAt, listed.stderr);
  const observations = parseWorktrunkSelections(listed.stdout);
  const selected = observations.filter(
    (observation) => observation.path === target.path && observation.branch === target.branch,
  );
  if (
    selected.length !== 1 ||
    (await registrationIdentity(target.path, input.project.root)) !== target.registrationIdentity
  ) {
    return removalFailure("worktrunk", startedAt, "Worktrunk identity revalidation failed.");
  }
  const removed = await run(
    worktrunkCommand,
    [
      "--config",
      input.worktrunkConfigPath,
      "-C",
      target.path,
      "remove",
      "--no-hooks",
      "--force",
      "--force-delete",
      "--format=json",
    ],
    { allowFailure: true },
  );
  return {
    strategy: "worktrunk",
    safe: removed.code === 0,
    ms: performance.now() - startedAt,
    stderr: redact(`${bare.stderr}${listed.stderr}${removed.stderr}`, dirname(input.project.root)),
  };
}

function parseWorktrunkSelections(stdout) {
  const payload = WorktrunkListPayloadSchema.parse(JSON.parse(stdout));
  return payload.map((item) =>
    WorktrunkSelectionSchema.parse({
      path: item.path,
      branch: item.branch,
    }),
  );
}

async function removeWithNativeGit(input, target) {
  const startedAt = performance.now();
  const bare = await bareProbe(input.project.root);
  if (!bare.safe) return removalFailure("nativeGit", startedAt, bare.stderr);
  const inventory = await readGitInventory(input.project.root);
  const matches = inventory.filter(
    (entry) => entry.path === target.path && entry.branch === target.branch && !entry.isPrimary,
  );
  if (
    matches.length !== 1 ||
    (await registrationIdentity(target.path, input.project.root)) !== target.registrationIdentity
  ) {
    return removalFailure("nativeGit", startedAt, "Native identity revalidation failed.");
  }
  const removed = await run(
    "git",
    ["-C", input.project.root, "worktree", "remove", "--force", target.path],
    { allowFailure: true },
  );
  if (removed.code !== 0) {
    return removalFailure("nativeGit", startedAt, removed.stderr);
  }
  const deleted = await run("git", ["-C", input.project.root, "branch", "-D", target.branch], {
    allowFailure: true,
  });
  return {
    strategy: "nativeGit",
    safe: deleted.code === 0,
    ms: performance.now() - startedAt,
    stderr: redact(`${bare.stderr}${removed.stderr}${deleted.stderr}`, dirname(input.project.root)),
  };
}

async function bareProbe(root) {
  const result = await run(
    "git",
    ["-C", root, "config", "--local", "--type=bool", "--get", "core.bare"],
    { allowFailure: true },
  );
  return {
    safe:
      (result.code === 0 || result.code === 1) &&
      !(result.code === 0 && result.stdout.trim() === "true"),
    stderr: result.stderr,
  };
}

function removalFailure(strategy, startedAt, stderr) {
  return {
    strategy,
    safe: false,
    ms: performance.now() - startedAt,
    stderr: redact(stderr, tmpdir()),
  };
}

async function registrationIdentity(worktreePath, repositoryRoot) {
  const marker = GitDirPointerSchema.parse(await readFile(join(worktreePath, ".git"), "utf8"));
  const pointer = marker.trim().slice("gitdir: ".length);
  const administrativePath = await realpath(
    isAbsolute(pointer) ? pointer : resolve(worktreePath, pointer),
  );
  const worktreesRoot = await realpath(join(repositoryRoot, ".git", "worktrees"));
  const child = relative(worktreesRoot, administrativePath);
  if (child.length === 0 || child.startsWith("..") || child.includes("/")) {
    throw new Error("Removal target registration was outside the repository worktree registry.");
  }
  return administrativePath;
}

async function readGitInventory(root) {
  const result = await run("git", ["-C", root, "worktree", "list", "--porcelain", "-z"]);
  const records = [];
  let current;
  for (const field of result.stdout.split("\0")) {
    if (field.length === 0) {
      if (current !== undefined) {
        records.push(finishGitRecord(current, root));
        current = undefined;
      }
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current !== undefined) throw new Error("Git inventory omitted a record separator.");
      current = { path: field.slice("worktree ".length) };
      continue;
    }
    if (current === undefined) throw new Error("Git inventory field preceded its path.");
    if (field.startsWith("HEAD ")) assignOnce(current, "head", field.slice("HEAD ".length));
    else if (field.startsWith("branch refs/heads/")) {
      assignOnce(current, "branch", field.slice("branch refs/heads/".length));
    } else if (field === "detached") assignOnce(current, "detached", true);
    else if (field === "bare") assignOnce(current, "bare", true);
    else if (field.startsWith("locked")) assignOnce(current, "locked", true);
    else if (field.startsWith("prunable")) assignOnce(current, "prunable", true);
    else throw new Error("Git inventory returned an unsupported structural field.");
  }
  if (current !== undefined) records.push(finishGitRecord(current, root));
  const sorted = records.sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(sorted.map((entry) => entry.path)).size !== sorted.length) {
    throw new Error("Git inventory duplicated a path.");
  }
  return sorted;
}

function finishGitRecord(record, root) {
  return GitInventoryRecordSchema.parse({
    path: record.path,
    branch: record.detached === true ? null : record.branch,
    isPrimary: record.path === root,
  });
}

function assignOnce(record, field, value) {
  if (record[field] !== undefined) throw new Error("Git inventory repeated a field.");
  record[field] = value;
}

async function branchesAbsent(root, targets) {
  const checks = await Promise.all(
    targets.map((target) =>
      run("git", ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${target.branch}`], {
        allowFailure: true,
      }),
    ),
  );
  return checks.every((check) => check.code === 1);
}

async function cleanupRemainingTargets(root, targets) {
  const inventory = await readGitInventory(root);
  for (const target of targets) {
    if (inventory.some((entry) => entry.path === target.path)) {
      await run("git", ["-C", root, "worktree", "remove", "--force", target.path]);
    }
    const branch = await run(
      "git",
      ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${target.branch}`],
      { allowFailure: true },
    );
    if (branch.code === 0) await run("git", ["-C", root, "branch", "-D", target.branch]);
  }
}

function scenarioNamed(burstSize) {
  const scenario = report.scenarios.find((candidate) => candidate.burstSize === burstSize);
  if (scenario === undefined) throw new Error(`Missing removal burst ${burstSize}.`);
  return scenario;
}

function summarize(runs) {
  return {
    wallMs: distribution(runs.map((runResult) => runResult.wallMs)),
    commandMs: distribution(
      runs.flatMap((runResult) => runResult.commands.map((command) => command.ms)),
    ),
    throughputPerSecond: distribution(
      runs.map((runResult) => runResult.commands.length / (runResult.wallMs / 1000)),
    ),
    allSafe: runs.every((runResult) => runResult.safe),
  };
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
      const result = {
        code: code ?? -1,
        stdout,
        stderr,
        ms: performance.now() - startedAt,
      };
      if (result.code === 0 || options.allowFailure === true) {
        resolveRun(result);
        return;
      }
      rejectRun(new Error(`${command} failed (${result.code}): ${stderr.trim()}`));
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
