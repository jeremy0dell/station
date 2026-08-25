import { type ChildProcess, execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { arch, cpus, loadavg, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createStationHostClient,
  HOST_PROTOCOL_VERSION,
  type HostAttachment,
  type HostFrame,
  type HostPtyAttachExpectation,
  type StationHostClient,
} from "@station/host";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { distribution } from "./statistics.js";

const execFileAsync = promisify(execFile);
const runReal = process.env.STATION_REAL_QUICK_SESSION_PTY === "1";
const describeReal = runReal ? describe : describe.skip;
const outputPath = resolve(
  z
    .string()
    .min(1)
    .parse(
      process.env.STATION_REAL_QUICK_SESSION_PTY_OUTPUT ??
        ".dev-state/performance/quick-session/quick-session-pty.real.json",
    ),
);
const bunCommand = process.env.STATION_BUN ?? "bun";
const stationRoot = fileURLToPath(new URL("../../../station/", import.meta.url));
const hostEntry = fileURLToPath(new URL("../../../station/src/host/hostMain.ts", import.meta.url));
const repetitions = 5;
const buildVersion = "quick-session-pty-benchmark";
const implementations = ["bridge", "bun"] as const;
const scenarios = [
  { name: "cold-single", burstSize: 1, includesHostStartup: true },
  { name: "warm-single", burstSize: 1, includesHostStartup: false },
  { name: "burst-3", burstSize: 3, includesHostStartup: false },
  { name: "burst-5", burstSize: 5, includesHostStartup: false },
  { name: "burst-20", burstSize: 20, includesHostStartup: false },
] as const;
const keepThresholds = {
  bunColdHostStartToAckP95Ms: 300,
  bunWarmIntentToAckP95Ms: 30,
  bunBurst5FinalAckP95Ms: 75,
  bunBurst20FinalAckP95Ms: 250,
} as const;
const exp015KeepThresholds = {
  bunWarmIntentToAckP95Ms: 100,
  bunBurst5FinalAckP95Ms: 100,
  bunBurst20FinalAckP95Ms: 300,
} as const;

type Implementation = (typeof implementations)[number];
type Scenario = (typeof scenarios)[number];
type ScenarioRun = Awaited<ReturnType<typeof runScenario>>;

describeReal("real Station Host Quick Session PTY readiness", () => {
  beforeAll(async () => {
    await access(hostEntry);
    await execFileAsync(join(stationRoot, "scripts/link-station-packages.sh"), [], {
      cwd: stationRoot,
    });
    await execFileAsync(join(stationRoot, "scripts/repair-node-pty.sh"), [], {
      cwd: stationRoot,
    });
    await execFileAsync(bunCommand, ["run", "build:ctty-helper"], { cwd: stationRoot });
  }, 60_000);

  it("records real spawn, ready output, controller input, and acknowledgement distributions", async () => {
    const report = {
      schemaVersion: 1,
      benchmark: "station-quick-session-real-pty-readiness",
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
      },
      repositoryShape: {
        repetitions,
        implementations,
        scenarioBurstSizes: Object.fromEntries(
          scenarios.map((scenario) => [scenario.name, scenario.burstSize]),
        ),
      },
      keepThresholds,
      exp015KeepThresholds,
      implementations: Object.fromEntries(
        implementations.map((implementation) => [
          implementation,
          { scenarios: scenarios.map((scenario) => ({ ...scenario, runs: [] as ScenarioRun[] })) },
        ]),
      ) as Record<Implementation, { scenarios: Array<Scenario & { runs: ScenarioRun[] }> }>,
      repetitions: [] as Array<{
        repetition: number;
        implementationOrder: Implementation[];
        hosts: Array<Awaited<ReturnType<typeof runHostRepetition>>>;
      }>,
      allSafe: false,
      thresholdsPassed: false,
      exp015ThresholdsPassed: false,
      failure: null as string | null,
    };

    try {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const implementationOrder =
          repetition % 2 === 0 ? [...implementations] : [...implementations].reverse();
        const hosts = [];
        for (const implementation of implementationOrder) {
          const host = await runHostRepetition({ implementation, repetition });
          hosts.push(host);
          for (const run of host.scenarios) {
            const summary = report.implementations[implementation].scenarios.find(
              (scenario) => scenario.name === run.name,
            );
            if (summary === undefined) throw new Error(`Missing PTY scenario ${run.name}.`);
            summary.runs.push(run);
          }
        }
        report.repetitions.push({ repetition, implementationOrder, hosts });
      }
    } catch (error) {
      report.failure = diagnosticError(error);
    }

    for (const implementation of implementations) {
      for (const scenario of report.implementations[implementation].scenarios) {
        Object.assign(scenario, summarizeScenario(scenario.runs));
      }
    }
    report.allSafe =
      report.failure === null &&
      report.repetitions.length === repetitions &&
      report.repetitions.every((repetition) =>
        repetition.hosts.every(
          (host) =>
            host.healthMatched &&
            host.stoppedCleanly &&
            host.stderrEmpty &&
            host.temporaryRootRemoved &&
            host.scenarios.every((scenario) => scenario.safe),
        ),
      );
    if (report.failure === null) {
      const bunScenarios = report.implementations.bun.scenarios;
      const cold = summarizeScenario(scenarioNamed(bunScenarios, "cold-single").runs);
      const warm = summarizeScenario(scenarioNamed(bunScenarios, "warm-single").runs);
      const burst5 = summarizeScenario(scenarioNamed(bunScenarios, "burst-5").runs);
      const burst20 = summarizeScenario(scenarioNamed(bunScenarios, "burst-20").runs);
      report.thresholdsPassed =
        cold.finalInteractiveMs.p95 <= keepThresholds.bunColdHostStartToAckP95Ms &&
        warm.finalInteractiveMs.p95 <= keepThresholds.bunWarmIntentToAckP95Ms &&
        burst5.finalInteractiveMs.p95 <= keepThresholds.bunBurst5FinalAckP95Ms &&
        burst20.finalInteractiveMs.p95 <= keepThresholds.bunBurst20FinalAckP95Ms;
      report.exp015ThresholdsPassed =
        warm.finalInteractiveMs.p95 <= exp015KeepThresholds.bunWarmIntentToAckP95Ms &&
        burst5.finalInteractiveMs.p95 <= exp015KeepThresholds.bunBurst5FinalAckP95Ms &&
        burst20.finalInteractiveMs.p95 <= exp015KeepThresholds.bunBurst20FinalAckP95Ms;
    }

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`[real Quick Session PTY benchmark] ${outputPath}\n`);

    expect(report.failure).toBeNull();
    expect(report.allSafe).toBe(true);
    expect(report.exp015ThresholdsPassed).toBe(true);
  }, 600_000);
});

async function runHostRepetition(input: { implementation: Implementation; repetition: number }) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), `station-pty-${input.implementation}-`));
  const root = temporaryRoot;
  const worktreeRoot = await realpath(temporaryRoot);
  const socketPath = join(root, "station-host.sock");
  const hostStartedAt = performance.now();
  const host = spawn(
    bunCommand,
    [hostEntry, "--socket", socketPath, "--state-dir", root, "--build-version", buildVersion],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE: "1",
        STATION_PTY_IMPL: input.implementation,
      },
    },
  );
  let hostStderr = "";
  host.stderr?.on("data", (data: Buffer) => {
    if (hostStderr.length < 16_384) hostStderr += data.toString("utf8");
  });
  const client = createStationHostClient({
    socketPath,
    expectedBuildVersion: buildVersion,
    timeoutMs: 5_000,
  });
  let healthMatched = false;
  let stoppedCleanly = false;
  const runs: ScenarioRun[] = [];
  let report:
    | {
        implementation: Implementation;
        repetition: number;
        hostHealthMs: number;
        healthMatched: boolean;
        stoppedCleanly: boolean;
        stderrEmpty: boolean;
        temporaryRootRemoved: boolean;
        scenarios: ScenarioRun[];
      }
    | undefined;
  try {
    const health = await waitForHealth(client);
    const healthAt = performance.now();
    healthMatched =
      health.ok &&
      health.protocolVersion === HOST_PROTOCOL_VERSION &&
      health.buildVersion === buildVersion;
    const [cold, ...warmScenarios] = scenarios;
    runs.push(
      await runScenario({
        client,
        root: worktreeRoot,
        implementation: input.implementation,
        repetition: input.repetition,
        scenario: cold,
        blockingStartedAt: hostStartedAt,
      }),
    );
    const warmOrder = input.repetition % 2 === 0 ? warmScenarios : [...warmScenarios].reverse();
    for (const scenario of warmOrder) {
      runs.push(
        await runScenario({
          client,
          root: worktreeRoot,
          implementation: input.implementation,
          repetition: input.repetition,
          scenario,
        }),
      );
    }
    const stop = await client.stopIfIdle(buildVersion);
    client.dispose();
    const exit = await waitForExit(host, 5_000);
    stoppedCleanly = stop.stopping && exit.code === 0 && exit.signal === null;
    report = {
      implementation: input.implementation,
      repetition: input.repetition,
      hostHealthMs: healthAt - hostStartedAt,
      healthMatched,
      stoppedCleanly,
      stderrEmpty: hostStderr.length === 0,
      temporaryRootRemoved: false,
      scenarios: runs,
    };
  } catch (error) {
    const diagnostic = hostStderr
      .replaceAll(root, "<temporary-root>")
      .replaceAll(worktreeRoot, "<temporary-root>")
      .trim();
    throw new Error(
      `Station Host ${input.implementation} repetition failed: ${diagnosticError(error)}; stderr: ${diagnostic.length === 0 ? "<empty>" : diagnostic}`,
      { cause: error },
    );
  } finally {
    client.dispose();
    if (host.exitCode === null && host.signalCode === null) {
      host.kill("SIGTERM");
      try {
        await waitForExit(host, 2_000);
      } catch {
        host.kill("SIGKILL");
        await waitForExit(host, 2_000);
      }
    }
    await rm(root, { recursive: true, force: true });
    if (report !== undefined) report.temporaryRootRemoved = !(await pathExists(root));
  }
  if (report === undefined) throw new Error("Station Host repetition produced no report.");
  return report;
}

async function runScenario(input: {
  client: StationHostClient;
  root: string;
  implementation: Implementation;
  repetition: number;
  scenario: Scenario;
  blockingStartedAt?: number;
}) {
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  const scenarioStartedAt = performance.now();
  const sessions = await Promise.all(
    Array.from({ length: input.scenario.burstSize }, (_, index) =>
      runPtySession({ ...input, index, scenarioStartedAt }),
    ),
  );
  const inventory = await input.client.list();
  const expectedPtyIds = [...sessions.map((session) => session.spawned.ptyId)].sort();
  const observedPtyIds = [...inventory.map((entry) => entry.ptyId)].sort();
  const exactLiveInventory =
    JSON.stringify(observedPtyIds) === JSON.stringify(expectedPtyIds) &&
    inventory.every((entry) => entry.alive);
  const exactLiveIdentity = sessions.every((session) =>
    inventory.some(
      (entry) =>
        entry.ptyId === session.spawned.ptyId &&
        entry.ptyInstanceId === session.spawned.ptyInstanceId &&
        entry.terminalTargetId === session.identity.terminalTargetId &&
        entry.worktreeId === session.identity.worktreeId &&
        entry.projectId === session.identity.projectId &&
        entry.sessionId === session.identity.sessionId &&
        entry.worktreePath === input.root &&
        entry.harnessProvider === "scripted",
    ),
  );
  await Promise.all(sessions.map((session) => session.attachment.detach()));
  const closeResults = await Promise.all(
    sessions.map((session) => input.client.close(session.spawned.ptyId)),
  );
  const cleanupInventory = await input.client.list();
  const finishedAt = Math.max(...sessions.map((session) => session.inputAcknowledgedAt));
  const safe =
    exactLiveInventory &&
    exactLiveIdentity &&
    closeResults.every((result) => result.closed) &&
    cleanupInventory.length === 0 &&
    sessions.every((session) => session.safe);
  return {
    name: input.scenario.name,
    burstSize: input.scenario.burstSize,
    safe,
    exactLiveInventory,
    exactLiveIdentity,
    allClosed: closeResults.every((result) => result.closed),
    cleanupInventoryCount: cleanupInventory.length,
    finalInteractiveMs: finishedAt - (input.blockingStartedAt ?? scenarioStartedAt),
    aggregateThroughputPerSecond:
      input.scenario.burstSize / ((finishedAt - scenarioStartedAt) / 1000),
    loadAverage: { before: loadBefore, after: loadavg() },
    resourceUsage: resourceDelta(usageBefore, process.resourceUsage()),
    samples: sessions.map(({ attachment: _attachment, spawned: _spawned, ...session }) => session),
  };
}

async function runPtySession(input: {
  client: StationHostClient;
  root: string;
  implementation: Implementation;
  repetition: number;
  scenario: Scenario;
  scenarioStartedAt: number;
  index: number;
}) {
  const token = `${input.implementation}-${input.repetition}-${input.scenario.name}-${input.index}`;
  const readyMarker = `__STATION_READY_${token}__`;
  const acknowledgementPrefix = `__STATION_ACK_${token}__:`;
  const inputToken = `input-${token}`;
  const intentAcceptedAt = performance.now();
  const identity = {
    kind: "agent" as const,
    terminalTargetId: `native:${token}`,
    worktreeId: `wt-${token}`,
    projectId: `project-${input.implementation}-${input.repetition}`,
    sessionId: `session-${token}`,
    worktreePath: input.root,
    harnessProvider: "scripted",
  };
  const spawned = await input.client.spawn({
    ...identity,
    command: "/bin/sh",
    args: [
      "-c",
      'printf "%s\\n" "$1"; IFS= read -r line || exit 31; printf "%s%s\\n" "$2" "$line"; while :; do sleep 60; done',
      "station-pty-benchmark",
      readyMarker,
      acknowledgementPrefix,
    ],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TERM: "xterm-256color",
      LC_ALL: "C",
    },
    cwd: input.root,
    cols: 80,
    rows: 24,
  });
  const processSpawnedAt = performance.now();
  const expectation: HostPtyAttachExpectation = { ...identity, ...spawned };
  const attachment = await input.client.attach(expectation, "controller");
  const attachedAt = performance.now();
  const iterator = attachment.frames[Symbol.asyncIterator]();
  let output = replayData(attachment);
  output = await readUntilMarker(iterator, output, readyMarker);
  const readyAt = performance.now();
  await attachment.write(`${inputToken}\n`);
  const inputSubmittedAt = performance.now();
  output = await readUntilMarker(iterator, output, `${acknowledgementPrefix}${inputToken}`);
  const inputAcknowledgedAt = performance.now();
  await iterator.return?.();
  const timestampsMs = {
    intentAccepted: intentAcceptedAt - input.scenarioStartedAt,
    processSpawned: processSpawnedAt - input.scenarioStartedAt,
    attached: attachedAt - input.scenarioStartedAt,
    ready: readyAt - input.scenarioStartedAt,
    inputSubmitted: inputSubmittedAt - input.scenarioStartedAt,
    inputAcknowledged: inputAcknowledgedAt - input.scenarioStartedAt,
  };
  const monotonic = Object.values(timestampsMs).every(
    (timestamp, index, values) => index === 0 || timestamp >= (values[index - 1] ?? 0),
  );
  return {
    token,
    identity,
    spawned,
    attachment,
    inputAcknowledgedAt,
    safe:
      monotonic &&
      attachment.ack.role === "controller" &&
      attachment.controlState.role === "controller" &&
      output.includes(readyMarker) &&
      output.includes(`${acknowledgementPrefix}${inputToken}`),
    timestampsMs,
    intentToSpawnMs: processSpawnedAt - intentAcceptedAt,
    spawnToReadyMs: readyAt - processSpawnedAt,
    readyToInputAckMs: inputAcknowledgedAt - readyAt,
    intentToInputAckMs: inputAcknowledgedAt - intentAcceptedAt,
  };
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
): Promise<string> {
  let output = initial;
  while (!output.includes(marker)) {
    const next = await withTimeout(
      iterator.next(),
      5_000,
      `PTY marker ${marker} timed out; bounded output: ${JSON.stringify(output.slice(-512))}.`,
    );
    if (next.done) throw new Error(`PTY frame stream ended before marker ${marker}.`);
    if (next.value.type === "data") output += next.value.data;
    if (next.value.type === "exit") {
      throw new Error(`PTY exited before marker ${marker}.`);
    }
  }
  return output;
}

async function waitForHealth(client: StationHostClient) {
  const deadline = performance.now() + 5_000;
  let lastError: unknown;
  while (performance.now() <= deadline) {
    try {
      return await client.health();
    } catch (error) {
      lastError = error;
      await wait(5);
    }
  }
  throw new Error("Station Host did not become healthy.", { cause: lastError });
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return withTimeout(
    new Promise((resolvePromise) => {
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    }),
    timeoutMs,
    "Station Host exit timed out.",
  );
}

function summarizeScenario(runs: ScenarioRun[]) {
  const samples = runs.flatMap((run) => run.samples);
  return {
    finalInteractiveMs: distribution(runs.map((run) => run.finalInteractiveMs)),
    aggregateThroughputPerSecond: distribution(runs.map((run) => run.aggregateThroughputPerSecond)),
    intentToSpawnMs: distribution(samples.map((sample) => sample.intentToSpawnMs)),
    spawnToReadyMs: distribution(samples.map((sample) => sample.spawnToReadyMs)),
    readyToInputAckMs: distribution(samples.map((sample) => sample.readyToInputAckMs)),
    intentToInputAckMs: distribution(samples.map((sample) => sample.intentToInputAckMs)),
    allSafe: runs.every((run) => run.safe),
  };
}

function scenarioNamed(
  scenarioSummaries: Array<Scenario & { runs: ScenarioRun[] }>,
  name: Scenario["name"],
) {
  const found = scenarioSummaries.find((scenario) => scenario.name === name);
  if (found === undefined) throw new Error(`Missing summarized PTY scenario ${name}.`);
  return found;
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

function diagnosticError(error: unknown): string {
  const parsed = z.object({ message: z.string().min(1) }).safeParse(error);
  return parsed.success ? parsed.data.message : "Unknown PTY benchmark failure.";
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
