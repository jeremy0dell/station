import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import { arch, cpus, loadavg, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LogRecordSchema } from "@station/contracts";
import {
  createStationHostClient,
  HOST_PROTOCOL_VERSION,
  type HostAttachment,
  type HostFrame,
  type HostPtyAttachExpectation,
} from "@station/host";
import {
  createStationHostController,
  type SpawnStationHostInput,
  type StationHostHandle,
} from "@station/terminal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { distribution } from "./statistics.js";

const execFileAsync = promisify(execFile);
const runReal = process.env.STATION_REAL_HOST_ENTRY_COMPARISON === "1";
const describeReal = runReal ? describe : describe.skip;
const outputPath = resolve(
  z
    .string()
    .min(1)
    .parse(
      process.env.STATION_REAL_HOST_ENTRY_COMPARISON_OUTPUT ??
        ".dev-state/performance/quick-session/host-entry-comparison.real.json",
    ),
);
const bunCommand = process.env.STATION_BUN ?? "bun";
const stationRoot = fileURLToPath(new URL("../../../station/", import.meta.url));
const hostEntry = fileURLToPath(new URL("../../../station/src/host/hostMain.ts", import.meta.url));
const cttyHelper = fileURLToPath(new URL("../../../station/dist/ctty-helper", import.meta.url));
const repetitions = 5;
const expectedBuildVersion = "quick-session-host-entry-benchmark";
const strategies = ["sourceEntry", "prebuiltBundle"] as const;
const keepThresholds = {
  medianImprovementFraction: 0.3,
  p95ImprovementFraction: 0.3,
  candidateP95Ms: 500,
} as const;

type Strategy = (typeof strategies)[number];
export type HostEntryStrategyRun = Awaited<ReturnType<typeof runHostEntryStrategy>>;

let bundleRoot = "";
let bundleEntry = "";
let bundleBuildMs = 0;
let bundleBytes = 0;
let bundleRuntimeExternals: string[] = [];

describeReal("real Station Host executable entry comparison", () => {
  beforeAll(async () => {
    await access(hostEntry);
    await execFileAsync(join(stationRoot, "scripts/link-station-packages.sh"), [], {
      cwd: stationRoot,
    });
    await execFileAsync(join(stationRoot, "scripts/repair-node-pty.sh"), [], {
      cwd: stationRoot,
    });
    await execFileAsync(bunCommand, ["run", "build:ctty-helper"], { cwd: stationRoot });

    bundleRoot = await realpath(await mkdtemp(join(tmpdir(), "st-hec-bundle-")));
    bundleEntry = join(bundleRoot, "station", "src", "host", "hostMain.mjs");
    // Bundling folds module-relative import.meta URLs into the entry module's
    // location, so the original three-parent helper path resolves at this root.
    const bundledCttyHelper = join(bundleRoot, "dist", "ctty-helper");
    await Promise.all([
      mkdir(dirname(bundleEntry), { recursive: true }),
      mkdir(dirname(bundledCttyHelper), { recursive: true }),
    ]);
    const buildStartedAt = performance.now();
    await execFileAsync(
      bunCommand,
      [
        "build",
        hostEntry,
        "--target=bun",
        "--format=esm",
        "--sourcemap=none",
        "--outfile",
        bundleEntry,
      ],
      { cwd: stationRoot, maxBuffer: 4 * 1024 * 1024 },
    );
    bundleBuildMs = performance.now() - buildStartedAt;
    await copyFile(cttyHelper, bundledCttyHelper);
    const [bundleSource, bundleStats] = await Promise.all([
      readFile(bundleEntry, "utf8"),
      stat(bundleEntry),
    ]);
    bundleBytes = bundleStats.size;
    bundleRuntimeExternals = findRuntimeExternals(bundleSource);
  }, 60_000);

  afterAll(async () => {
    if (bundleRoot.length > 0) await rm(bundleRoot, { recursive: true, force: true });
  });

  it("compares source loading with a prebuilt Host bundle", async () => {
    const report = {
      schemaVersion: 1,
      benchmark: "station-quick-session-host-entry-comparison",
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
      },
      repositoryShape: { repetitions },
      bundle: {
        buildMs: bundleBuildMs,
        bytes: bundleBytes,
        buildExcludedFromLaunchTiming: true,
        runtimeExternals: bundleRuntimeExternals,
        rootRemoved: false,
      },
      keepThresholds,
      strategies: {
        sourceEntry: { runs: [] as HostEntryStrategyRun[] },
        prebuiltBundle: { runs: [] as HostEntryStrategyRun[] },
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
          report.strategies[strategy].runs.push(
            await runHostEntryStrategy({
              strategy,
              repetition,
              hostCommand: [
                bunCommand,
                strategy === "sourceEntry" ? hostEntry : bundleEntry,
                "--build-version",
                expectedBuildVersion,
              ],
              expectedBuildVersion,
              redactRoots: [bundleRoot],
            }),
          );
        }
        report.repetitions.push({ repetition, strategyOrder });
      }
    } catch (error) {
      report.failure = diagnosticError(error);
    } finally {
      await rm(bundleRoot, { recursive: true, force: true });
      report.bundle.rootRemoved = !(await pathExists(bundleRoot));
    }

    const source = summarizeHostEntryRuns(report.strategies.sourceEntry.runs);
    const bundle = summarizeHostEntryRuns(report.strategies.prebuiltBundle.runs);
    Object.assign(report.strategies.sourceEntry, source);
    Object.assign(report.strategies.prebuiltBundle, bundle);
    report.medianImprovementFraction = improvement(
      source.intentToInputAckMs.median,
      bundle.intentToInputAckMs.median,
    );
    report.p95ImprovementFraction = improvement(
      source.intentToInputAckMs.p95,
      bundle.intentToInputAckMs.p95,
    );
    report.allSafe =
      report.failure === null &&
      report.bundle.runtimeExternals.length === 0 &&
      report.bundle.rootRemoved &&
      report.repetitions.length === repetitions &&
      [...report.strategies.sourceEntry.runs, ...report.strategies.prebuiltBundle.runs].every(
        (run) => run.safe,
      );
    report.thresholdsPassed =
      report.medianImprovementFraction >= keepThresholds.medianImprovementFraction &&
      report.p95ImprovementFraction >= keepThresholds.p95ImprovementFraction &&
      bundle.intentToInputAckMs.p95 <= keepThresholds.candidateP95Ms;

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`[real Host entry comparison] ${outputPath}\n`);

    expect(report.failure).toBeNull();
    expect(report.allSafe).toBe(true);
    expect(report.thresholdsPassed).toBe(true);
  }, 300_000);
});

export async function runHostEntryStrategy(input: {
  strategy: string;
  repetition: number;
  hostCommand: readonly [string, ...string[]];
  expectedBuildVersion: string;
  ptyImplementation?: "bun" | "bun-nocctty";
  redactRoots?: readonly string[];
}) {
  const hostRoot = await mkdtemp(join("/tmp", "st-hec-"));
  const worktreeRoot = await realpath(hostRoot);
  const socketPath = join(hostRoot, "host.sock");
  const client = createStationHostClient({
    socketPath,
    expectedBuildVersion: input.expectedBuildVersion,
    timeoutMs: 5_000,
  });
  let child: ChildProcess | undefined;
  let hostStderr = "";
  let spawnCount = 0;
  const controller = createStationHostController(
    {
      socketPath,
      stateDir: hostRoot,
      hostCommand: input.hostCommand,
      expectedBuildVersion: input.expectedBuildVersion,
      timeoutMs: 5_000,
    },
    {
      clientFactory: () => client,
      spawnHost: (spawnInput: SpawnStationHostInput) => {
        spawnCount += 1;
        child = spawn(spawnInput.argv[0], spawnInput.argv.slice(1), {
          detached: spawnInput.spawnOptions.detached,
          stdio: ["ignore", "ignore", "pipe"],
          env: {
            ...process.env,
            STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE: "1",
            STATION_PTY_IMPL: input.ptyImplementation ?? "bun",
          },
        });
        child.stderr?.on("data", (data: Buffer) => {
          if (hostStderr.length < 16_384) hostStderr += data.toString("utf8");
        });
        return child;
      },
    },
  );
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  const intentAcceptedWallMs = Date.now();
  const intentAcceptedAt = performance.now();
  let ensureSettledAt: number | undefined;
  let inputAcknowledgedAt: number | undefined;
  let attachment: HostAttachment | undefined;
  let ptyId: string | undefined;
  let healthMatched = false;
  let exactLiveIdentity = false;
  let cleanupInventoryCount = -1;
  let stoppedCleanly = false;
  let contentObserved = false;
  let closed = false;
  let hostStartFromIntentMs: number | undefined;
  let hostStartRecordCount = 0;
  try {
    const handle = await controller.ensure();
    ensureSettledAt = performance.now();
    if (handle.status !== "running") throw unavailableHostError(handle);
    const health = await handle.client.health();
    healthMatched =
      health.ok &&
      health.protocolVersion === HOST_PROTOCOL_VERSION &&
      health.buildVersion === input.expectedBuildVersion;
    const token = `${input.strategy}-${input.repetition}`;
    const readyMarker = `__STATION_HOST_ENTRY_READY_${token}__`;
    const acknowledgementPrefix = `__STATION_HOST_ENTRY_ACK_${token}__:`;
    const inputToken = `input-${token}`;
    const identity = {
      kind: "agent" as const,
      terminalTargetId: `native:host-entry-${token}`,
      worktreeId: `wt-host-entry-${token}`,
      projectId: `project-host-entry-${input.repetition}`,
      sessionId: `session-host-entry-${token}`,
      worktreePath: worktreeRoot,
      harnessProvider: "scripted",
    };
    const spawned = await handle.client.spawn({
      ...identity,
      command: "/bin/sh",
      args: [
        "-c",
        'printf "%s\\n" "$1"; IFS= read -r line || exit 31; printf "%s%s\\n" "$2" "$line"; while :; do sleep 60; done',
        "station-host-entry-benchmark",
        readyMarker,
        acknowledgementPrefix,
      ],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TERM: "xterm-256color",
        LC_ALL: "C",
      },
      cwd: worktreeRoot,
      cols: 80,
      rows: 24,
    });
    ptyId = spawned.ptyId;
    const expectation: HostPtyAttachExpectation = { ...identity, ...spawned };
    attachment = await handle.client.attach(expectation, "controller");
    const iterator = attachment.frames[Symbol.asyncIterator]();
    let output = replayData(attachment);
    output = await readUntilMarker(iterator, output, readyMarker);
    await attachment.write(`${inputToken}\n`);
    output = await readUntilMarker(iterator, output, `${acknowledgementPrefix}${inputToken}`);
    inputAcknowledgedAt = performance.now();
    contentObserved =
      output.includes(readyMarker) && output.includes(`${acknowledgementPrefix}${inputToken}`);
    await iterator.return?.();
    const live = await handle.client.list();
    exactLiveIdentity =
      live.length === 1 &&
      live[0]?.ptyId === spawned.ptyId &&
      live[0]?.ptyInstanceId === spawned.ptyInstanceId &&
      live[0]?.terminalTargetId === identity.terminalTargetId &&
      live[0]?.worktreeId === identity.worktreeId &&
      live[0]?.projectId === identity.projectId &&
      live[0]?.sessionId === identity.sessionId &&
      live[0]?.worktreePath === worktreeRoot &&
      live[0]?.harnessProvider === identity.harnessProvider;
    await attachment.detach();
    attachment = undefined;
    const closeResult = await handle.client.close(spawned.ptyId);
    closed = closeResult.closed;
    ptyId = undefined;
    cleanupInventoryCount = (await handle.client.list()).length;
    const stop = await handle.client.stopIfIdle(input.expectedBuildVersion);
    if (child === undefined) throw new Error("Host ensure did not expose its child process.");
    const exit = await waitForExit(child, 5_000);
    stoppedCleanly = stop.stopping && exit.code === 0 && exit.signal === null;
    const hostStart = await readHostStart(hostRoot, intentAcceptedWallMs);
    hostStartFromIntentMs = hostStart.fromIntentMs;
    hostStartRecordCount = hostStart.recordCount;
  } catch (error) {
    const rawDetail =
      `${diagnosticError(error)}; stderr: ${hostStderr.length === 0 ? "<empty>" : hostStderr}`.replaceAll(
        hostRoot,
        "<host-root>",
      );
    const detail = (input.redactRoots ?? []).reduce(
      (current, root) => current.replaceAll(root, "<candidate-root>"),
      rawDetail,
    );
    throw new Error(`Host entry ${input.strategy} repetition failed: ${detail}`, { cause: error });
  } finally {
    await attachment?.detach().catch(() => {});
    if (ptyId !== undefined) await client.close(ptyId).catch(() => {});
    client.dispose();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 2_000).catch(async () => {
        child?.kill("SIGKILL");
        if (child !== undefined) await waitForExit(child, 2_000);
      });
    }
    await rm(hostRoot, { recursive: true, force: true });
  }
  const temporaryRootRemoved = !(await pathExists(hostRoot));
  const ensureMs = ensureSettledAt === undefined ? 0 : ensureSettledAt - intentAcceptedAt;
  const socketReadyAfterHostStartMs =
    hostStartFromIntentMs === undefined ? 0 : ensureMs - hostStartFromIntentMs;
  const phaseClockCoherent =
    hostStartFromIntentMs !== undefined &&
    hostStartFromIntentMs >= -25 &&
    socketReadyAfterHostStartMs >= -25 &&
    Math.abs(hostStartFromIntentMs + socketReadyAfterHostStartMs - ensureMs) <= 1;
  const safe =
    ensureSettledAt !== undefined &&
    inputAcknowledgedAt !== undefined &&
    spawnCount === 1 &&
    healthMatched &&
    exactLiveIdentity &&
    contentObserved &&
    closed &&
    cleanupInventoryCount === 0 &&
    stoppedCleanly &&
    hostStderr.length === 0 &&
    temporaryRootRemoved &&
    hostStartRecordCount === 1 &&
    phaseClockCoherent;
  return {
    strategy: input.strategy,
    repetition: input.repetition,
    safe,
    intentToInputAckMs:
      inputAcknowledgedAt === undefined ? 0 : inputAcknowledgedAt - intentAcceptedAt,
    ensureMs,
    hostStartFromIntentMs: hostStartFromIntentMs ?? 0,
    socketReadyAfterHostStartMs,
    hostStartRecordCount,
    phaseClockCoherent,
    postEnsureToInputAckMs:
      ensureSettledAt === undefined || inputAcknowledgedAt === undefined
        ? 0
        : inputAcknowledgedAt - ensureSettledAt,
    spawnCount,
    healthMatched,
    exactLiveIdentity,
    contentObserved,
    closed,
    cleanupInventoryCount,
    stoppedCleanly,
    stderrEmpty: hostStderr.length === 0,
    temporaryRootRemoved,
    loadAverage: { before: loadBefore, after: loadavg() },
    resourceUsage: resourceDelta(usageBefore, process.resourceUsage()),
  };
}

async function readHostStart(hostRoot: string, intentAcceptedWallMs: number) {
  const source = await readFile(join(hostRoot, "logs", "station-host.jsonl"), "utf8");
  const records = source
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => LogRecordSchema.parse(JSON.parse(line)))
    .filter((record) => record.component === "station-host" && record.message === "host.start");
  const record = records[0];
  if (record === undefined || records.length !== 1) {
    throw new Error(`Expected one host.start record; observed ${records.length}.`);
  }
  return {
    fromIntentMs: Date.parse(record.timestamp) - intentAcceptedWallMs,
    recordCount: records.length,
  };
}

export function summarizeHostEntryRuns(runs: HostEntryStrategyRun[]) {
  return {
    intentToInputAckMs: distribution(runs.map((run) => run.intentToInputAckMs)),
    ensureMs: distribution(runs.map((run) => run.ensureMs)),
    hostStartFromIntentMs: distribution(runs.map((run) => run.hostStartFromIntentMs)),
    socketReadyAfterHostStartMs: distribution(runs.map((run) => run.socketReadyAfterHostStartMs)),
    postEnsureToInputAckMs: distribution(runs.map((run) => run.postEnsureToInputAckMs)),
    allSafe: runs.every((run) => run.safe),
  };
}

function findRuntimeExternals(bundleSource: string) {
  const builtin = new Set(builtinModules.map((specifier) => specifier.replace(/^node:/, "")));
  const specifiers = [...bundleSource.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
  return [...new Set(specifiers)]
    .filter((specifier) => specifier !== undefined)
    .filter((specifier) => !builtin.has(specifier.replace(/^node:/, "")))
    .filter((specifier) => specifier !== "bun")
    .sort();
}

function unavailableHostError(handle: Exclude<StationHostHandle, { status: "running" }>) {
  return new Error(handle.error.message);
}

function replayData(attachment: HostAttachment): string {
  return attachment.ack.replay.events
    .filter((event) => event.type === "data")
    .map((event) => event.data)
    .join("");
}

async function readUntilMarker(
  iterator: AsyncIterator<HostFrame>,
  initial: string,
  marker: string,
) {
  let output = initial;
  while (!output.includes(marker)) {
    const next = await withTimeout(iterator.next(), 5_000, "Host entry PTY marker timed out.");
    if (next.done) throw new Error("Host entry PTY ended before its marker.");
    if (next.value.type === "data") output += next.value.data;
    if (next.value.type === "exit") throw new Error("Host entry PTY exited before its marker.");
  }
  return output;
}

function improvement(baseline: number, candidate: number) {
  return baseline === 0 ? 0 : (baseline - candidate) / baseline;
}

function resourceDelta(before: NodeJS.ResourceUsage, after: NodeJS.ResourceUsage) {
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

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return withTimeout(
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    }),
    timeoutMs,
    "Station Host entry process exit timed out.",
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function pathExists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

function diagnosticError(error: unknown) {
  const parsed = z.object({ message: z.string().min(1) }).safeParse(error);
  return parsed.success ? parsed.data.message : "Unknown Host entry benchmark failure.";
}
