import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";

const outputPath = resolve(
  process.env.STATION_NATIVE_GIT_VERIFICATION_BENCHMARK_OUTPUT ??
    ".dev-state/performance/quick-session/native-git-verification-comparison.real.json",
);
const repetitions = 5;
const ordinaryLinkedWorktrees = 48;
const initialWorktrees = ordinaryLinkedWorktrees + 1;
const maxConcurrent = 4;
const burstSizes = [1, 3, 5, 20];

const GitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const RevParseVerificationSchema = z.tuple([z.string().min(1), z.string().min(1)]);
const InventoryRecordSchema = z
  .object({
    path: z.string().min(1),
    head: GitObjectIdSchema,
    branch: z.string().min(1).nullable(),
  })
  .strict();

const report = {
  schemaVersion: 1,
  benchmark: "station-quick-session-native-git-verification-comparison",
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
    maxConcurrent,
    repetitions,
  },
  keepThresholds: {
    filesystemVerificationP95Ms: 2,
    singleMedianImprovementFraction: 0.12,
    singleP95ImprovementFraction: 0.12,
    burst5MedianImprovementFraction: 0.1,
    burst5P95ImprovementFraction: 0.1,
    burst20MedianImprovementFraction: 0.08,
    burst20P95ImprovementFraction: 0.08,
    burst3MaximumRegressionFraction: 0,
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
  const processRuns = scenario.pairs.map((pair) => pair.processVerification);
  const filesystemRuns = scenario.pairs.map((pair) => pair.filesystemVerification);
  scenario.processVerification = summarize(processRuns);
  scenario.filesystemVerification = summarize(filesystemRuns);
  scenario.medianImprovementFraction = improvement(
    scenario.processVerification.wallMs.median,
    scenario.filesystemVerification.wallMs.median,
  );
  scenario.p95ImprovementFraction = improvement(
    scenario.processVerification.wallMs.p95,
    scenario.filesystemVerification.wallMs.p95,
  );
  scenario.allSafe = [...processRuns, ...filesystemRuns].every((run) => run.safe);
}

const single = scenarioNamed(1);
const burst3 = scenarioNamed(3);
const burst5 = scenarioNamed(5);
const burst20 = scenarioNamed(20);
report.allSafe =
  report.repetitions.every((repetition) => repetition.temporaryRootRemoved) &&
  report.scenarios.every((scenario) => scenario.allSafe);
report.thresholdsPassed =
  single.filesystemVerification.verificationMs.p95 <=
    report.keepThresholds.filesystemVerificationP95Ms &&
  single.medianImprovementFraction >= report.keepThresholds.singleMedianImprovementFraction &&
  single.p95ImprovementFraction >= report.keepThresholds.singleP95ImprovementFraction &&
  burst3.medianImprovementFraction >= -report.keepThresholds.burst3MaximumRegressionFraction &&
  burst3.p95ImprovementFraction >= -report.keepThresholds.burst3MaximumRegressionFraction &&
  burst5.medianImprovementFraction >= report.keepThresholds.burst5MedianImprovementFraction &&
  burst5.p95ImprovementFraction >= report.keepThresholds.burst5P95ImprovementFraction &&
  burst20.medianImprovementFraction >= report.keepThresholds.burst20MedianImprovementFraction &&
  burst20.p95ImprovementFraction >= report.keepThresholds.burst20P95ImprovementFraction;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`[native Git verification comparison] ${outputPath}\n`);
if (!report.allSafe || !report.thresholdsPassed) process.exitCode = 1;

async function runRepetition(repetition) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "station-native-verification-"));
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
        (repetition + scenarioIndex) % 2 === 0
          ? ["processVerification", "filesystemVerification"]
          : ["filesystemVerification", "processVerification"];
      const strategies = {};
      for (const strategy of order) {
        const result = await runStrategy({
          strategy,
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
        processVerification: strategies.processVerification,
        filesystemVerification: strategies.filesystemVerification,
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
  const commonDir = await realpath(join(root, ".git"));
  const worktreeAdminRoot = await realpath(join(commonDir, "worktrees"));
  const ordinaryInventory = await readInventory(root);
  if (ordinaryInventory.length !== initialWorktrees) {
    throw new Error(`Expected ${initialWorktrees} initial worktrees.`);
  }
  return { baseSha, commonDir, worktreeAdminRoot, ordinaryInventory };
}

async function runStrategy(input) {
  const commands = Array.from({ length: input.burstSize }, (_, index) => ({
    branch: `verify-${input.strategy}-${input.repetition}-${input.burstSize}-${index}`,
    path: join(
      input.createdRoot,
      `verify-${input.strategy}-${input.repetition}-${input.burstSize}-${index}`,
    ),
  }));
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  let active = 0;
  let peakActive = 0;
  const startedAt = performance.now();
  const results = await mapBounded(commands, maxConcurrent, async (command) => {
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
    peakActive === Math.min(maxConcurrent, input.burstSize);
  return {
    strategy: input.strategy,
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
      code: result.code,
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
  if (
    (bareProbe.code !== 0 && bareProbe.code !== 1) ||
    (bareProbe.code === 0 && bareProbe.stdout.trim() === "true")
  ) {
    return failedCommand(bareProbe, bareProbe.ms, 0, 0);
  }

  const mutation = await run(
    "git",
    ["-C", input.root, "worktree", "add", "--quiet", "-b", input.branch, input.path, input.baseSha],
    { allowFailure: true },
  );
  if (mutation.code !== 0) return failedCommand(mutation, bareProbe.ms, mutation.ms, 0);

  const verificationStartedAt = performance.now();
  const verification =
    input.strategy === "processVerification"
      ? await verifyWithProcess(input)
      : await verifyWithFilesystem(input);
  return {
    safe: verification.safe,
    code: verification.safe ? 0 : 1,
    stderr: `${bareProbe.stderr}${mutation.stderr}`,
    bareProbeMs: bareProbe.ms,
    mutationMs: mutation.ms,
    verificationMs: performance.now() - verificationStartedAt,
    registrationIdentity: verification.registrationIdentity,
  };
}

async function verifyWithProcess(input) {
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
  const parsed = RevParseVerificationSchema.safeParse(verification.stdout.trimEnd().split("\n"));
  const registrationIdentity = await markerRegistrationIdentity(input.path);
  return {
    safe:
      verification.code === 0 &&
      parsed.success &&
      samePath(parsed.data[0], input.path) &&
      parsed.data[1] === input.branch &&
      registrationIdentity !== undefined,
    registrationIdentity,
  };
}

async function verifyWithFilesystem(input) {
  try {
    const targetMetadata = await lstat(input.path);
    const targetRealpath = await realpath(input.path);
    if (!targetMetadata.isDirectory() || !samePath(targetRealpath, input.path)) {
      return { safe: false, registrationIdentity: undefined };
    }

    const markerPath = join(input.path, ".git");
    const markerBefore = await lstat(markerPath, { bigint: true });
    if (!markerBefore.isFile() || markerBefore.size > 4096n) {
      return { safe: false, registrationIdentity: undefined };
    }
    const marker = await readFile(markerPath, "utf8");
    const gitDirValue = strictLine(marker, "gitdir: ");
    if (gitDirValue === undefined) return { safe: false, registrationIdentity: undefined };
    const adminPath = normalize(
      isAbsolute(gitDirValue) ? gitDirValue : resolve(dirname(markerPath), gitDirValue),
    );
    const adminRealpath = await realpath(adminPath);
    const fromAdminRoot = relative(input.worktreeAdminRoot, adminRealpath);
    if (
      fromAdminRoot.length === 0 ||
      fromAdminRoot.startsWith("..") ||
      isAbsolute(fromAdminRoot) ||
      fromAdminRoot.includes("/")
    ) {
      return { safe: false, registrationIdentity: undefined };
    }
    const adminBefore = await lstat(adminRealpath, { bigint: true });
    if (!adminBefore.isDirectory()) return { safe: false, registrationIdentity: undefined };

    const [head, backlink] = await Promise.all([
      readFile(join(adminRealpath, "HEAD"), "utf8"),
      readFile(join(adminRealpath, "gitdir"), "utf8"),
    ]);
    const branchRef = strictLine(head, "ref: ");
    const backlinkPath = strictLine(backlink);
    if (
      branchRef !== `refs/heads/${input.branch}` ||
      backlinkPath === undefined ||
      !samePath(backlinkPath, markerPath)
    ) {
      return { safe: false, registrationIdentity: undefined };
    }

    const [markerAfter, adminAfter] = await Promise.all([
      lstat(markerPath, { bigint: true }),
      lstat(adminRealpath, { bigint: true }),
    ]);
    if (!sameMetadata(markerBefore, markerAfter) || !sameMetadata(adminBefore, adminAfter)) {
      return { safe: false, registrationIdentity: undefined };
    }
    return {
      safe: true,
      registrationIdentity: registrationDigest(markerBefore, marker),
    };
  } catch {
    return { safe: false, registrationIdentity: undefined };
  }
}

async function markerRegistrationIdentity(worktreePath) {
  const markerPath = join(worktreePath, ".git");
  try {
    const before = await lstat(markerPath, { bigint: true });
    if (!before.isFile() || before.size > 4096n) return undefined;
    const marker = await readFile(markerPath, "utf8");
    const after = await lstat(markerPath, { bigint: true });
    return sameMetadata(before, after) ? registrationDigest(before, marker) : undefined;
  } catch {
    return undefined;
  }
}

function registrationDigest(metadata, marker) {
  return `git-registration:${createHash("sha256")
    .update(
      [
        "file",
        metadata.dev.toString(),
        metadata.ino.toString(),
        metadata.birthtimeNs.toString(),
        metadata.ctimeNs.toString(),
        marker,
      ].join("\0"),
    )
    .digest("hex")}`;
}

function sameMetadata(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.birthtimeNs === after.birthtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function strictLine(contents, prefix = "") {
  if (!contents.endsWith("\n") || contents.slice(0, -1).includes("\n")) return undefined;
  const line = contents.slice(0, -1);
  return line.startsWith(prefix) && line.length > prefix.length
    ? line.slice(prefix.length)
    : undefined;
}

function failedCommand(command, bareProbeMs, mutationMs, verificationMs) {
  return {
    safe: false,
    code: command.code,
    stderr: command.stderr,
    bareProbeMs,
    mutationMs,
    verificationMs,
    registrationIdentity: undefined,
  };
}

async function cleanupCreated(root, commands) {
  for (const command of commands) {
    await run("git", ["-C", root, "worktree", "remove", "--force", command.path]);
    await run("git", ["-C", root, "branch", "--delete", "--force", "--", command.branch]);
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
  if (found === undefined) throw new Error(`Missing native verification burst ${burstSize}.`);
  return found;
}

function summarize(runs) {
  return {
    wallMs: distribution(runs.map((run) => run.wallMs)),
    verificationMs: distribution(
      runs.flatMap((run) => run.commands.map((command) => command.verificationMs)),
    ),
    commandMs: distribution(runs.flatMap((run) => run.commands.map(commandTotalMs))),
    throughputPerSecond: distribution(runs.map((run) => run.throughputPerSecond)),
    allSafe: runs.every((run) => run.safe),
  };
}

function commandTotalMs(command) {
  return command.bareProbeMs + command.mutationMs + command.verificationMs;
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

function samePath(left, right) {
  return canonicalPath(left) === canonicalPath(right);
}

function canonicalPath(path) {
  const normalized = normalize(path);
  return normalized.startsWith("/private/var/") || normalized.startsWith("/private/tmp/")
    ? normalized.slice("/private".length)
    : normalized;
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
