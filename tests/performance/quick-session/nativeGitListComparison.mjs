import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";

const worktrunkCommand = process.env.STATION_WORKTRUNK_BIN ?? "wt";
const outputPath = resolve(
  process.env.STATION_NATIVE_GIT_LIST_BENCHMARK_OUTPUT ??
    ".dev-state/performance/quick-session/native-git-list-comparison.real.json",
);
const repetitions = 5;
const ordinaryLinkedWorktrees = 45;
const initialWorktrees = 49;

const WorktrunkListItemSchema = z
  .object({
    branch: z.string().min(1).nullish(),
    is_main: z.boolean().optional(),
    locked: z.boolean().optional(),
    path: z.string().min(1),
    prunable: z.boolean().optional(),
    worktree: z
      .object({
        detached: z.boolean().optional(),
        locked: z.boolean().optional(),
        prunable: z.boolean().optional(),
        state: z.string().min(1).nullish(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const WorktrunkListSchema = z.array(WorktrunkListItemSchema).min(1).max(initialWorktrees);

const report = {
  schemaVersion: 1,
  benchmark: "station-quick-session-native-git-list-comparison",
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
    ordinaryLinkedWorktrees,
    detachedWorktrees: 1,
    lockedWorktrees: 1,
    prunableWorktrees: 1,
    repetitions,
  },
  keepThresholds: {
    medianImprovementFraction: 0.8,
    p95ImprovementFraction: 0.8,
  },
  worktrunk: undefined,
  nativeGit: undefined,
  medianImprovementFraction: 0,
  p95ImprovementFraction: 0,
  allSafe: false,
  pairs: [],
};

for (let repetition = 0; repetition < repetitions; repetition += 1) {
  report.pairs.push(await runPair(repetition));
}
const worktrunkRuns = report.pairs.map((pair) => pair.worktrunk);
const nativeGitRuns = report.pairs.map((pair) => pair.nativeGit);
report.worktrunk = summarize(worktrunkRuns);
report.nativeGit = summarize(nativeGitRuns);
report.medianImprovementFraction = improvement(
  report.worktrunk.wallMs.median,
  report.nativeGit.wallMs.median,
);
report.p95ImprovementFraction = improvement(
  report.worktrunk.wallMs.p95,
  report.nativeGit.wallMs.p95,
);
report.allSafe = report.pairs.every(
  (pair) => pair.worktrunk.safe && pair.nativeGit.safe && pair.temporaryRootRemoved,
);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`[native Git list comparison] ${outputPath}\n`);

if (
  !report.allSafe ||
  report.medianImprovementFraction < report.keepThresholds.medianImprovementFraction ||
  report.p95ImprovementFraction < report.keepThresholds.p95ImprovementFraction
) {
  process.exitCode = 1;
}

async function runPair(repetition) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "station-native-git-list-"));
  const benchmarkRoot = await realpath(temporaryRoot);
  let pair;
  try {
    const root = join(benchmarkRoot, "repo");
    const shapeRoot = join(benchmarkRoot, "shape");
    const worktrunkConfigPath = join(benchmarkRoot, "worktrunk.toml");
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(shapeRoot, { recursive: true }),
      writeFile(worktrunkConfigPath, "", "utf8"),
    ]);
    const expected = await initializeRepository(root, shapeRoot);
    const order = repetition % 2 === 0 ? ["worktrunk", "nativeGit"] : ["nativeGit", "worktrunk"];
    const candidates = {};
    for (const candidate of order) {
      candidates[candidate] =
        candidate === "worktrunk"
          ? await runWorktrunkList(root, worktrunkConfigPath, expected, benchmarkRoot)
          : await runNativeGitList(root, expected, benchmarkRoot);
    }
    pair = {
      repetition,
      order,
      temporaryRootRemoved: false,
      worktrunk: candidates.worktrunk,
      nativeGit: candidates.nativeGit,
    };
  } finally {
    await rm(benchmarkRoot, { recursive: true, force: true });
    if (pair !== undefined) pair.temporaryRootRemoved = !(await pathExists(benchmarkRoot));
  }
  if (pair === undefined) throw new Error("Native Git list comparison pair did not complete.");
  return pair;
}

async function initializeRepository(root, shapeRoot) {
  await run("git", ["init", "--initial-branch=main", "--quiet"], { cwd: root });
  await run("git", ["config", "user.name", "Station Benchmark"], { cwd: root });
  await run("git", ["config", "user.email", "station-benchmark@example.invalid"], {
    cwd: root,
  });
  await run("git", ["commit", "--allow-empty", "--message=baseline", "--quiet"], { cwd: root });
  const expected = [structuralEntry(root, "main", { primary: true })];
  for (let index = 0; index < ordinaryLinkedWorktrees; index += 1) {
    const path = join(shapeRoot, `shape-${index}`);
    const branch = `shape-${index}`;
    await run("git", ["worktree", "add", "--quiet", "-b", branch, path, "main"], { cwd: root });
    expected.push(structuralEntry(path, branch));
  }

  const lockedPath = join(shapeRoot, "locked");
  await run("git", ["worktree", "add", "--quiet", "-b", "locked", lockedPath, "main"], {
    cwd: root,
  });
  await run("git", ["worktree", "lock", "--reason", "station benchmark", lockedPath], {
    cwd: root,
  });
  expected.push(structuralEntry(lockedPath, "locked", { locked: true }));

  const detachedPath = join(shapeRoot, "detached");
  await run("git", ["worktree", "add", "--quiet", "--detach", detachedPath, "main"], {
    cwd: root,
  });
  expected.push(structuralEntry(detachedPath, null, { detached: true }));

  const prunablePath = join(shapeRoot, "prunable");
  await run("git", ["worktree", "add", "--quiet", "-b", "prunable", prunablePath, "main"], {
    cwd: root,
  });
  await rm(prunablePath, { recursive: true, force: true });
  expected.push(structuralEntry(prunablePath, "prunable", { prunable: true }));
  return sortInventory(expected);
}

async function runWorktrunkList(root, configPath, expected, benchmarkRoot) {
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  const command = await run(
    worktrunkCommand,
    ["--config", configPath, "-C", root, "list", "--format=json"],
    { allowFailure: true },
  );
  let inventory = [];
  let parseSucceeded = false;
  try {
    const items = WorktrunkListSchema.parse(JSON.parse(command.stdout));
    inventory = sortInventory(items.map(normalizeWorktrunkItem));
    parseSucceeded = true;
  } catch {
    inventory = [];
  }
  return listResult({
    implementation: "worktrunk",
    command,
    inventory,
    expected,
    parseSucceeded,
    loadBefore,
    usageBefore,
    benchmarkRoot,
  });
}

async function runNativeGitList(root, expected, benchmarkRoot) {
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  const command = await run("git", ["-C", root, "worktree", "list", "--porcelain", "-z"], {
    allowFailure: true,
  });
  let inventory = [];
  let parseSucceeded = false;
  try {
    inventory = sortInventory(parseNativeGitPorcelain(command.stdout, root));
    parseSucceeded = true;
  } catch {
    inventory = [];
  }
  return listResult({
    implementation: "nativeGit",
    command,
    inventory,
    expected,
    parseSucceeded,
    loadBefore,
    usageBefore,
    benchmarkRoot,
  });
}

function listResult(input) {
  const exactInventory = JSON.stringify(input.inventory) === JSON.stringify(input.expected);
  const uniquePaths = new Set(input.inventory.map((entry) => entry.path)).size;
  return {
    implementation: input.implementation,
    wallMs: input.command.ms,
    safe:
      input.command.code === 0 &&
      input.parseSucceeded &&
      exactInventory &&
      input.inventory.length === initialWorktrees &&
      uniquePaths === initialWorktrees,
    parseSucceeded: input.parseSucceeded,
    exactInventory,
    inventoryCount: input.inventory.length,
    loadAverage: { before: input.loadBefore, after: loadavg() },
    resourceUsage: resourceDelta(input.usageBefore, process.resourceUsage()),
    inventory: input.inventory.map((entry) => ({
      ...entry,
      path: entry.path.replace(input.benchmarkRoot, "$TMP_ROOT"),
    })),
    code: input.command.code,
    stderr: input.command.stderr.replaceAll(input.benchmarkRoot, "$TMP_ROOT").trim(),
  };
}

function normalizeWorktrunkItem(item) {
  const state = item.worktree?.state?.toLowerCase() ?? "";
  const detached =
    item.worktree?.detached === true || item.branch === undefined || item.branch === null;
  return structuralEntry(item.path, detached ? null : item.branch, {
    detached,
    locked: item.locked === true || item.worktree?.locked === true || state === "locked",
    primary: item.is_main === true,
    prunable:
      item.prunable === true ||
      item.worktree?.prunable === true ||
      state === "prunable" ||
      state === "missing" ||
      state === "no_worktree",
  });
}

function parseNativeGitPorcelain(output, root) {
  const records = [];
  let current;
  for (const field of output.split("\0")) {
    if (field.length === 0) {
      if (current !== undefined) {
        records.push(finishNativeRecord(current, root));
        current = undefined;
      }
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current !== undefined) throw new Error("Native Git list omitted a record separator.");
      current = { path: field.slice("worktree ".length) };
      continue;
    }
    if (current === undefined) throw new Error("Native Git list field preceded its worktree path.");
    if (field.startsWith("HEAD ")) current.head = field.slice("HEAD ".length);
    else if (field.startsWith("branch refs/heads/")) {
      current.branch = field.slice("branch refs/heads/".length);
    } else if (field === "detached") current.detached = true;
    else if (field === "bare") current.bare = true;
    else if (field === "locked" || field.startsWith("locked ")) current.locked = true;
    else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = true;
    else throw new Error(`Native Git list returned an unknown field: ${field}`);
  }
  if (current !== undefined) records.push(finishNativeRecord(current, root));
  return records;
}

function finishNativeRecord(record, root) {
  if (
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    typeof record.head !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test(record.head) ||
    record.bare === true ||
    (record.detached !== true && typeof record.branch !== "string")
  ) {
    throw new Error("Native Git list returned an incomplete worktree record.");
  }
  return structuralEntry(record.path, record.detached === true ? null : record.branch, {
    detached: record.detached === true,
    locked: record.locked === true,
    primary: record.path === root,
    prunable: record.prunable === true,
  });
}

function structuralEntry(path, branch, options = {}) {
  return {
    path,
    branch,
    primary: options.primary === true,
    detached: options.detached === true,
    locked: options.locked === true,
    prunable: options.prunable === true,
  };
}

function sortInventory(inventory) {
  return [...inventory].sort((left, right) => left.path.localeCompare(right.path));
}

function summarize(runs) {
  return {
    wallMs: distribution(runs.map((run) => run.wallMs)),
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
