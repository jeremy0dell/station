import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";

const outputPath = resolve(
  process.env.STATION_NATIVE_GIT_BOUND_THREE_OUTPUT ??
    ".dev-state/performance/quick-session/native-git-bound-three-comparison.real.json",
);
const burstSizes = [3, 5, 20];
const repetitions = 5;
const ordinaryLinkedWorktrees = 48;
const initialWorktrees = ordinaryLinkedWorktrees + 1;

const GitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const VerificationSchema = z.tuple([z.string().min(1), z.string().min(1)]);
const InventoryRecordSchema = z
  .object({
    path: z.string().min(1),
    head: GitObjectIdSchema,
    branch: z.string().min(1).nullable(),
  })
  .strict();

const report = {
  schemaVersion: 1,
  benchmark: "station-quick-session-native-git-bound-three-comparison",
  generatedAt: new Date().toISOString(),
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
  },
  tools: { git: (await run("git", ["--version"])).stdout.trim() },
  repositoryShape: {
    initialWorktrees,
    ordinaryLinkedWorktrees,
    comparedBounds: [4, 3],
    repetitions,
  },
  keepThresholds: {
    burst5MedianImprovementFraction: 0.1,
    burst5P95ImprovementFraction: 0.1,
    burst20MedianImprovementFraction: 0.1,
    burst20P95ImprovementFraction: 0.1,
    burst3MaximumP95RegressionFraction: 0.1,
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
  const bound4Runs = scenario.pairs.map((pair) => pair.bound4);
  const bound3Runs = scenario.pairs.map((pair) => pair.bound3);
  scenario.bound4 = summarize(bound4Runs);
  scenario.bound3 = summarize(bound3Runs);
  scenario.medianImprovementFraction = improvement(
    scenario.bound4.wallMs.median,
    scenario.bound3.wallMs.median,
  );
  scenario.p95ImprovementFraction = improvement(
    scenario.bound4.wallMs.p95,
    scenario.bound3.wallMs.p95,
  );
  scenario.allSafe = [...bound4Runs, ...bound3Runs].every((runResult) => runResult.safe);
}

const burst3 = scenarioNamed(3);
const burst5 = scenarioNamed(5);
const burst20 = scenarioNamed(20);
report.allSafe =
  report.scenarios.every((scenario) => scenario.allSafe) &&
  report.repetitions.every((repetition) => repetition.temporaryRootRemoved);
report.thresholdsPassed =
  burst3.p95ImprovementFraction >= -report.keepThresholds.burst3MaximumP95RegressionFraction &&
  burst5.medianImprovementFraction >= report.keepThresholds.burst5MedianImprovementFraction &&
  burst5.p95ImprovementFraction >= report.keepThresholds.burst5P95ImprovementFraction &&
  burst20.medianImprovementFraction >= report.keepThresholds.burst20MedianImprovementFraction &&
  burst20.p95ImprovementFraction >= report.keepThresholds.burst20P95ImprovementFraction;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`[native Git bound-three comparison] ${outputPath}\n`);
if (!report.allSafe || !report.thresholdsPassed) process.exitCode = 1;

async function runRepetition(repetition) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "station-native-bound-three-"));
  const benchmarkRoot = await realpath(temporaryRoot);
  const repetitionReport = { repetition, temporaryRootRemoved: false };
  try {
    const root = join(benchmarkRoot, "repo");
    const shapeRoot = join(benchmarkRoot, "shape");
    const createdRoot = join(benchmarkRoot, "created");
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(shapeRoot, { recursive: true }),
      mkdir(createdRoot, { recursive: true }),
    ]);
    const fixture = await initializeRepository(root, shapeRoot);

    for (const [scenarioIndex, burstSize] of burstSizes.entries()) {
      const order =
        (repetition + scenarioIndex) % 2 === 0 ? ["bound4", "bound3"] : ["bound3", "bound4"];
      const strategies = {};
      for (const strategy of order) {
        const bound = strategy === "bound4" ? 4 : 3;
        const result = await runStrategy({
          strategy,
          bound,
          repetition,
          burstSize,
          root,
          createdRoot,
          ...fixture,
        });
        strategies[strategy] = result;
        await cleanupCreated(root, result.cleanupTargets);
        delete result.cleanupTargets;
        const resetInventory = await readInventory(root);
        result.cleanupInventoryCount = resetInventory.length;
        result.safe &&=
          JSON.stringify(resetInventory) === JSON.stringify(fixture.ordinaryInventory);
      }
      scenarioNamed(burstSize).pairs.push({
        repetition,
        order,
        bound4: strategies.bound4,
        bound3: strategies.bound3,
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
  GitObjectIdSchema.parse(baseSha);
  for (let index = 0; index < ordinaryLinkedWorktrees; index += 1) {
    await run("git", [
      "-C",
      root,
      "worktree",
      "add",
      "--quiet",
      "-b",
      `shape-${index}`,
      join(shapeRoot, `shape-${index}`),
      baseSha,
    ]);
  }
  const ordinaryInventory = await readInventory(root);
  if (ordinaryInventory.length !== initialWorktrees) {
    throw new Error(`Bound-three fixture expected ${initialWorktrees} worktrees.`);
  }
  return { baseSha, ordinaryInventory };
}

async function runStrategy(input) {
  const commands = Array.from({ length: input.burstSize }, (_, index) => ({
    branch: `bound-${input.bound}-${input.repetition}-${input.burstSize}-${index}`,
    path: join(
      input.createdRoot,
      `bound-${input.bound}-${input.repetition}-${input.burstSize}-${index}`,
    ),
  }));
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  let active = 0;
  let peakActive = 0;
  const startedAt = performance.now();
  const results = await mapBounded(commands, input.bound, async (command) => {
    active += 1;
    peakActive = Math.max(peakActive, active);
    try {
      return await createAndVerify({ ...input, ...command });
    } finally {
      active -= 1;
    }
  });
  const wallMs = performance.now() - startedAt;
  const inventory = await readInventory(input.root);
  const expectedInventory = sortInventory([
    ...input.ordinaryInventory,
    ...commands.map((command) => ({
      path: command.path,
      head: input.baseSha,
      branch: command.branch,
    })),
  ]);
  const exactInventory = JSON.stringify(inventory) === JSON.stringify(expectedInventory);
  const identities = results.map((result) => result.registrationIdentity);
  const safe =
    results.every((result) => result.safe) &&
    exactInventory &&
    new Set(commands.map((command) => command.path)).size === commands.length &&
    new Set(commands.map((command) => command.branch)).size === commands.length &&
    new Set(identities).size === identities.length &&
    peakActive === Math.min(input.bound, input.burstSize);
  return {
    strategy: input.strategy,
    bound: input.bound,
    wallMs,
    throughputPerSecond: input.burstSize / (wallMs / 1000),
    safe,
    exactInventory,
    peakActive,
    inventoryCount: inventory.length,
    cleanupInventoryCount: null,
    loadAverage: { before: loadBefore, after: loadavg() },
    resourceUsage: resourceDelta(usageBefore, process.resourceUsage()),
    commands: results.map((result) => ({
      safe: result.safe,
      bareProbeMs: result.bareProbeMs,
      mutationMs: result.mutationMs,
      verificationMs: result.verificationMs,
      registrationIdentity: result.registrationIdentity,
      stderr: redact(result.stderr, dirname(input.root)),
    })),
    cleanupTargets: commands,
  };
}

async function createAndVerify(input) {
  const bareProbe = await run(
    "git",
    ["-C", input.root, "config", "--local", "--type=bool", "--get", "core.bare"],
    { allowFailure: true },
  );
  const bareSafe =
    (bareProbe.code === 0 || bareProbe.code === 1) &&
    !(bareProbe.code === 0 && bareProbe.stdout.trim() === "true");
  if (!bareSafe) return failedCommand(bareProbe, bareProbe.ms, 0, 0);

  const mutation = await run(
    "git",
    ["-C", input.root, "worktree", "add", "--quiet", "-b", input.branch, input.path, input.baseSha],
    { allowFailure: true },
  );
  if (mutation.code !== 0) return failedCommand(mutation, bareProbe.ms, mutation.ms, 0);

  const verification = await run(
    "git",
    [
      "-C",
      input.path,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--abbrev-ref=strict",
      "HEAD",
    ],
    { allowFailure: true },
  );
  const parsed = VerificationSchema.safeParse(verification.stdout.trimEnd().split("\n"));
  const registrationIdentity = await nativeRegistrationIdentity(input.path);
  return {
    safe:
      verification.code === 0 &&
      parsed.success &&
      parsed.data[0] === input.path &&
      parsed.data[1] === input.branch &&
      registrationIdentity !== undefined,
    bareProbeMs: bareProbe.ms,
    mutationMs: mutation.ms,
    verificationMs: verification.ms,
    registrationIdentity,
    stderr: `${bareProbe.stderr}${mutation.stderr}${verification.stderr}`,
  };
}

function failedCommand(command, bareProbeMs, mutationMs, verificationMs) {
  return {
    safe: false,
    bareProbeMs,
    mutationMs,
    verificationMs,
    registrationIdentity: undefined,
    stderr: command.stderr,
  };
}

async function nativeRegistrationIdentity(worktreePath) {
  const markerPath = join(worktreePath, ".git");
  try {
    const before = await lstat(markerPath, { bigint: true });
    if (!before.isFile() || before.size > 4096n) return undefined;
    const marker = await readFile(markerPath, "utf8");
    const after = await lstat(markerPath, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.birthtimeNs !== after.birthtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      return undefined;
    }
    return `git-registration:${createHash("sha256")
      .update(
        [
          "file",
          before.dev.toString(),
          before.ino.toString(),
          before.birthtimeNs.toString(),
          before.ctimeNs.toString(),
          marker,
        ].join("\0"),
      )
      .digest("hex")}`;
  } catch {
    return undefined;
  }
}

async function cleanupCreated(root, targets) {
  for (const target of targets) {
    await run("git", ["-C", root, "worktree", "remove", "--force", target.path]);
    await run("git", ["-C", root, "branch", "--delete", "--force", "--", target.branch]);
  }
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

function scenarioNamed(burstSize) {
  const scenario = report.scenarios.find((candidate) => candidate.burstSize === burstSize);
  if (scenario === undefined) throw new Error(`Missing bound-three burst ${burstSize}.`);
  return scenario;
}

function summarize(runs) {
  return {
    wallMs: distribution(runs.map((runResult) => runResult.wallMs)),
    bareProbeMs: distribution(
      runs.flatMap((runResult) => runResult.commands.map((command) => command.bareProbeMs)),
    ),
    mutationMs: distribution(
      runs.flatMap((runResult) => runResult.commands.map((command) => command.mutationMs)),
    ),
    verificationMs: distribution(
      runs.flatMap((runResult) => runResult.commands.map((command) => command.verificationMs)),
    ),
    throughputPerSecond: distribution(runs.map((runResult) => runResult.throughputPerSecond)),
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
