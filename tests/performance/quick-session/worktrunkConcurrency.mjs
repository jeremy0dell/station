import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const worktrunkCommand = process.env.STATION_WORKTRUNK_BIN ?? "wt";
const outputPath = resolve(
  process.env.STATION_WORKTRUNK_CONCURRENCY_BENCHMARK_OUTPUT ??
    ".dev-state/performance/quick-session/worktrunk-concurrency.real.json",
);
const burstSizes = [3, 5, 20];
const repetitions = 3;

const report = {
  schemaVersion: 1,
  benchmark: "station-quick-session-worktrunk-concurrency",
  generatedAt: new Date().toISOString(),
  machine: { platform: process.platform, arch: process.arch },
  tools: {
    worktrunk: (await run(worktrunkCommand, ["--version"])).stdout.trim(),
    git: (await run("git", ["--version"])).stdout.trim(),
  },
  scenarios: [],
};

for (const hooksEnabled of [false, true]) {
  for (const mode of ["serialized", "parallel"]) {
    for (const burstSize of burstSizes) {
      const runs = [];
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        runs.push(await runBurst({ hooksEnabled, mode, burstSize, repetition }));
      }
      report.scenarios.push({
        hooksEnabled,
        mode,
        burstSize,
        wallMs: distribution(runs.map((run) => run.wallMs)),
        commandMs: distribution(runs.flatMap((run) => run.commands.map((command) => command.ms))),
        allSafe: runs.every((run) => run.safe),
        runs,
      });
    }
  }
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`[worktrunk concurrency benchmark] ${outputPath}\n`);
if (!report.scenarios.every((scenario) => scenario.allSafe)) {
  process.exitCode = 1;
}

async function runBurst({ hooksEnabled, mode, burstSize, repetition }) {
  const root = await mkdtemp(join(tmpdir(), "station-quick-session-worktrunk-"));
  try {
    await run("git", ["init", "--initial-branch=main", "--quiet"], { cwd: root });
    await run(
      "git",
      [
        "-c",
        "user.name=Station Benchmark",
        "-c",
        "user.email=station-benchmark@example.invalid",
        "commit",
        "--allow-empty",
        "--message=baseline",
        "--quiet",
      ],
      { cwd: root },
    );
    const managedRoot = join(root, "worktrees");
    await mkdir(managedRoot);
    const hookLogPath = join(root, "hook-deliveries.jsonl");
    const worktrunkConfigPath = join(root, "worktrunk.toml");
    if (hooksEnabled) {
      const recorderPath = join(root, "hook-recorder.mjs");
      await writeFile(
        recorderPath,
        [
          'import { appendFile } from "node:fs/promises";',
          "const [logPath, event, branch, worktreePath] = process.argv.slice(2);",
          'await appendFile(logPath, JSON.stringify({ event, branch, worktreePath }) + "\\n");',
          "",
        ].join("\n"),
        "utf8",
      );
      const hookCommand = (event) =>
        `node ${recorderPath} ${hookLogPath} ${event} '{{ branch }}' '{{ worktree_path }}'`;
      await writeFile(
        worktrunkConfigPath,
        [
          "[post-create]",
          `station = ${JSON.stringify(hookCommand("post-create"))}`,
          "",
          "[post-switch]",
          `station = ${JSON.stringify(hookCommand("post-switch"))}`,
          "",
        ].join("\n"),
        "utf8",
      );
    }
    const commands = Array.from({ length: burstSize }, (_, index) => {
      const branch = `probe-${mode}-${repetition}-${index}`;
      return { branch, path: join(managedRoot, branch) };
    });
    const startedAt = performance.now();
    const results = [];
    if (mode === "parallel") {
      results.push(
        ...(await Promise.all(
          commands.map((command) =>
            runWorktrunkCreate(root, command, { hooksEnabled, worktrunkConfigPath }),
          ),
        )),
      );
    } else {
      for (const command of commands) {
        results.push(
          await runWorktrunkCreate(root, command, { hooksEnabled, worktrunkConfigPath }),
        );
      }
    }
    const wallMs = performance.now() - startedAt;
    const inventory = await run("git", ["worktree", "list", "--porcelain"], { cwd: root });
    const inventoryBranches = inventory.stdout
      .split("\n")
      .filter((line) => line.startsWith("branch refs/heads/"))
      .map((line) => line.slice("branch refs/heads/".length));
    const expectedBranches = commands.map((command) => command.branch).sort();
    const observedBranches = inventoryBranches.filter((branch) => branch !== "main").sort();
    const uniquePaths = new Set(results.map((result) => result.path));
    const hookRecords = hooksEnabled ? await waitForHookRecords(hookLogPath, burstSize * 2) : [];
    const hookRecordsSafe = hooksEnabled
      ? commands.every((command) =>
          ["post-create", "post-switch"].every((event) =>
            hookRecords.some(
              (record) =>
                record.event === event &&
                record.branch === command.branch &&
                record.worktreePath === command.path,
            ),
          ),
        ) && hookRecords.length === burstSize * 2
      : hookRecords.length === 0;
    const safe =
      results.every((result) => result.code === 0 && result.parsed) &&
      uniquePaths.size === burstSize &&
      JSON.stringify(observedBranches) === JSON.stringify(expectedBranches) &&
      hookRecordsSafe;
    return {
      repetition,
      wallMs,
      safe,
      expectedBranches,
      observedBranches,
      hookRecords: hookRecords
        .map((record) => ({
          ...record,
          worktreePath: record.worktreePath.replace(root, "$TMP_REPO"),
        }))
        .sort((left, right) =>
          `${left.branch}:${left.event}`.localeCompare(`${right.branch}:${right.event}`),
        ),
      commands: results.map((result) => ({
        branch: result.branch,
        path: result.path.replace(root, "$TMP_REPO"),
        code: result.code,
        ms: result.ms,
        parsed: result.parsed,
        stderr: result.stderr.replaceAll(root, "$TMP_REPO").trim(),
      })),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runWorktrunkCreate(root, input, options) {
  const result = await run(
    worktrunkCommand,
    [
      "-C",
      root,
      "switch",
      "--create",
      input.branch,
      ...(options.hooksEnabled
        ? ["--yes", "--config", options.worktrunkConfigPath]
        : ["--no-hooks"]),
      "--no-cd",
      "--format=json",
    ],
    {
      cwd: root,
      env: { ...process.env, WORKTRUNK_WORKTREE_PATH: input.path },
      allowFailure: true,
    },
  );
  let parsed = false;
  try {
    const payload = JSON.parse(result.stdout);
    parsed = payload.branch === input.branch && payload.path === input.path;
  } catch {
    parsed = false;
  }
  return { ...input, ...result, parsed };
}

async function waitForHookRecords(logPath, expectedCount) {
  const deadline = performance.now() + 5000;
  while (performance.now() <= deadline) {
    try {
      const records = (await readFile(logPath, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      if (records.length >= expectedCount) return records;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  try {
    return (await readFile(logPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
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
      rejectPromise(
        new Error(`${command} ${args.join(" ")} failed (${result.code}): ${stderr.trim()}`),
      );
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
