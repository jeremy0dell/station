#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  INCIDENT_GRAPH,
  INCIDENT_WORKLOAD,
  writeIncidentFixture,
} from "../../tests/performance/memory/incidentFixture.mjs";
import {
  buildOwnerProbePlan,
  classifyRetention,
  OWNER_PROBES,
} from "../../tests/performance/memory/ownerProbe.mjs";
import { resolveBunRuntime } from "../bun-version.mjs";
import { runOwnedDisposableRuntime } from "../runtime-owner.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cellDriverPath = fileURLToPath(
  new URL("../../tests/performance/memory/cellDriver.mjs", import.meta.url),
);
const profiledSourcePath = fileURLToPath(
  new URL("../../tests/performance/memory/profiledSourceMain.ts", import.meta.url),
);
const binaryBuilderPath = fileURLToPath(
  new URL("../../tests/performance/memory/buildProfiledBinary.mjs", import.meta.url),
);
const REQUIRED_BUN_VERSIONS = ["1.4.0"];
const PROFILE_ROLES = ["observer", "dashboard", "native", "host"];
const ARTIFACT_MODES = ["source", "compiled"];
const GIT_LOCAL_ENVIRONMENT_KEYS = [
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
];

/** Strictly checks the reproducibility inputs without starting Station or touching runtime state. */
export async function checkMemoryProfilePrerequisites(options = {}) {
  const source = await sourceRevision();
  const runtimes = {};
  const missing = [];
  for (const version of REQUIRED_BUN_VERSIONS) {
    const executable = options.bun?.[version] ?? (await defaultBunExecutable(version));
    if (executable === undefined) {
      missing.push(`Bun ${version} (pass --bun-${version.replaceAll(".", "-")})`);
      continue;
    }
    try {
      runtimes[version] = await checkRuntime(executable, version);
    } catch (error) {
      missing.push(error instanceof Error ? error.message : String(error));
    }
  }
  const requiredFiles = [
    join(repoRoot, "packages", "runtime", "dist", "station-build-id"),
    join(repoRoot, "packages", "protocol", "dist", "index.js"),
  ];
  for (const path of requiredFiles) {
    try {
      await access(path, constants.R_OK);
    } catch {
      missing.push(`built workspace output: ${path}`);
    }
  }
  let buildIdentity;
  try {
    buildIdentity = (await readFile(requiredFiles[0], "utf8")).trim();
    if (!/^[0-9a-f]{64}$/u.test(buildIdentity)) {
      missing.push(`invalid Station build identity: ${requiredFiles[0]}`);
      buildIdentity = undefined;
    }
  } catch {
    // The missing-file diagnostic above is more useful than a second read error.
  }
  return {
    source,
    buildIdentity,
    runtimes,
    platform: process.platform,
    architecture: process.arch,
    missing,
    ready: missing.length === 0 && process.platform === "darwin" && source.clean,
  };
}

/** Returns the deterministic cell order used by the matrix without creating fixtures or processes. */
export function buildMemoryProfilePlan(options = {}) {
  const versions = options.versions ?? REQUIRED_BUN_VERSIONS;
  const modes = options.modes ?? ARTIFACT_MODES;
  const roles = options.roles ?? PROFILE_ROLES;
  assertProfileValues(versions, REQUIRED_BUN_VERSIONS, "runtime");
  assertProfileValues(modes, ARTIFACT_MODES, "artifact mode");
  assertProfileValues(roles, PROFILE_ROLES, "role");
  return versions.flatMap((version) =>
    modes.flatMap((mode) => roles.map((role) => ({ version, mode, role }))),
  );
}

/** Executes the long matrix only when explicitly requested; every cell is owner-bound and isolated. */
export async function runMemoryProfileMatrix(rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const prerequisites = await checkMemoryProfilePrerequisites(options);
  if (prerequisites.missing.length > 0) {
    throw new Error(
      `Memory profile prerequisites failed:\n- ${prerequisites.missing.join("\n- ")}`,
    );
  }
  if (process.platform !== "darwin") {
    throw new Error("The memory profile matrix requires macOS footprint/vmmap evidence.");
  }
  if (!prerequisites.source.clean && options.allowDirty !== true) {
    throw new Error(
      "Memory profile matrix requires a clean checkout; pass --allow-dirty only for exploratory runs.",
    );
  }

  await mkdir(options.output, { recursive: true, mode: 0o700 });
  const runId = `memory_${randomUUID()}`;
  const matrixRoot = join(options.output, runId);
  await mkdir(matrixRoot, { recursive: true, mode: 0o700 });
  const artifacts = await prepareArtifacts(matrixRoot, options, prerequisites.runtimes);
  const matrixManifest = {
    schemaVersion: 1,
    runId,
    source: prerequisites.source,
    buildIdentity: prerequisites.buildIdentity,
    runtimes: prerequisites.runtimes,
    workload: INCIDENT_WORKLOAD,
    graph: INCIDENT_GRAPH,
    ownerProbes: buildOwnerProbePlan(),
    artifacts,
    timeScale: options.timeScale,
    warmupMs: options.warmupMs,
    cooldownMs: options.cooldownMs,
    stalledSubscription: options.stalledSubscription,
    clearUserTiming: options.clearUserTiming,
    roles: options.roles,
    modes: options.modes,
  };
  await writeJson(join(matrixRoot, "matrix-manifest.json"), matrixManifest);

  const cells = [];
  for (const { version, mode, role } of buildMemoryProfilePlan(options)) {
    const cell = await runCell({
      matrixRoot,
      runId,
      version,
      mode,
      role,
      options,
      bun: prerequisites.runtimes[version],
      artifact: artifacts[version],
    });
    cells.push(cell);
  }
  const result = {
    ...matrixManifest,
    finishedAt: new Date().toISOString(),
    cells,
    ownerAttribution: attributeOwners(cells),
  };
  await writeJson(join(matrixRoot, "matrix-result.json"), result);
  process.stdout.write(`${JSON.stringify({ runId, output: matrixRoot, cells: cells.length })}\n`);
  return result;
}

async function runCell(input) {
  const cellId = `${input.version}-${input.mode}-${input.role}`;
  const cellRoot = join(input.matrixRoot, "cells", cellId);
  await mkdir(cellRoot, { recursive: true, mode: 0o700 });
  const fixture = await writeIncidentFixture(join(cellRoot, "fixture"));
  const schedulePath = join(fixture.root, "schedule.json");
  await writeJson(schedulePath, fixture.schedule);
  const targetSamplePath = join(cellRoot, "target-memory.jsonl");
  const observerSamplePath =
    input.role === "observer" ? undefined : join(cellRoot, "observer-memory.jsonl");
  const renderProfilePath =
    input.role === "dashboard" || input.role === "native"
      ? join(cellRoot, "render-profile.jsonl")
      : undefined;
  const target = processSpec({
    input,
    fixture,
    label: input.role,
  });
  const observer =
    input.role === "observer"
      ? undefined
      : processSpec({
          input,
          fixture,
          label: "observer",
        });
  const manifestPath = join(cellRoot, "cell-manifest.json");
  await writeJson(manifestPath, {
    schemaVersion: 1,
    cellId,
    role: input.role,
    configPath: fixture.configPath,
    socketPath: fixture.socketPath,
    stateDir: fixture.stateDir,
    schedulePath,
    evidenceDir: cellRoot,
    eventsPath: join(cellRoot, "events.jsonl"),
    targetSamplePath,
    ...(observerSamplePath === undefined ? {} : { observerSamplePath }),
    ...(renderProfilePath === undefined ? {} : { renderProfilePath }),
    clearUserTiming: input.options.clearUserTiming,
    warmupMs: input.options.warmupMs,
    cooldownMs: input.options.cooldownMs,
    timeScale: input.options.timeScale,
    target,
    ...(observer === undefined ? {} : { observer }),
    stalledSubscription: input.options.stalledSubscription,
  });

  const ownerStateDir = join(cellRoot, "owner-state");
  const ownerLogPath = join(ownerStateDir, "logs", "cli.jsonl");
  const result = await runOwnedDisposableRuntime({
    role: "memory-profile",
    checkoutRoot: repoRoot,
    stateDir: ownerStateDir,
    socketRoots: [join(fixture.root, "run")],
    persistenceRoots: [cellRoot, fixture.stateDir],
    survivorPolicy: "preserve-persistent-station-runtime",
    terminalKey: `memory-profile-${cellId}`,
    correlation: {
      traceId: `trc_${randomUUID()}`,
      spanId: `spn_${randomUUID()}`,
    },
    launch: {
      cwd: repoRoot,
      steps: [{ command: process.execPath, args: [cellDriverPath, "--manifest", manifestPath] }],
      env: { STATION_RUNTIME_OWNER_FOREGROUND: "1" },
    },
  });
  let cellResult;
  try {
    cellResult = JSON.parse(await readFile(join(cellRoot, "cell-result.json"), "utf8"));
  } catch (error) {
    throw new Error(
      `Profile cell ${cellId} did not produce cell-result.json (owner exit ${result.exitCode}).`,
      { cause: error },
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(`Profile cell ${cellId} failed with exit code ${result.exitCode}.`);
  }
  return {
    cellId,
    version: input.version,
    mode: input.mode,
    role: input.role,
    owner: result,
    cell: cellResult,
    analysis: await analyzeCell(cellResult),
    ownerLogPath,
  };
}

async function prepareArtifacts(matrixRoot, options, runtimes) {
  const artifacts = {};
  for (const version of REQUIRED_BUN_VERSIONS) {
    const root = join(matrixRoot, "artifacts", version);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const productionPath = join(root, "stn");
    const diagnosticPath = join(root, "stn-profiled");
    if (options.binary?.[version] !== undefined) {
      await access(options.binary[version], constants.X_OK);
      artifacts[version] = {
        bun: runtimes[version],
        productionPath: options.binary[version],
        diagnosticPath: options.binary[version],
        externallyProvided: true,
      };
      continue;
    }
    await buildArtifact(runtimes[version].executable, version, productionPath, "production");
    await buildArtifact(runtimes[version].executable, version, diagnosticPath, "diagnostic");
    artifacts[version] = {
      bun: runtimes[version],
      productionPath,
      diagnosticPath,
      externallyProvided: false,
    };
  }
  return artifacts;
}

async function buildArtifact(bunPath, version, output, mode) {
  await runCommand(
    bunPath,
    [binaryBuilderPath, "--output", output, "--mode", mode, "--expected-bun-version", version],
    repoRoot,
  );
}

function processSpec(input) {
  const { input: matrix, fixture, label } = input;
  const compiled = matrix.mode === "compiled";
  const binary = matrix.artifact.diagnosticPath;
  const targetName = matrix.role === "native" ? "tui" : matrix.role;
  const env = {};
  if (compiled) {
    const args =
      matrix.role === "observer"
        ? [
            "__observer",
            "--config",
            fixture.configPath,
            "--socket",
            fixture.socketPath,
            "--state-dir",
            fixture.stateDir,
          ]
        : matrix.role === "host"
          ? [
              "__station-host",
              "--socket",
              join(fixture.stateDir, "run", "station-host.sock"),
              "--state-dir",
              fixture.stateDir,
            ]
          : [matrix.role === "native" ? "__tui" : "__dashboard"];
    return {
      command: binary,
      args,
      cwd: repoRoot,
      env,
      tty: matrix.role === "native" || matrix.role === "dashboard",
      label,
    };
  }
  const args =
    matrix.role === "observer"
      ? [
          "--config",
          fixture.configPath,
          "--socket",
          fixture.socketPath,
          "--state-dir",
          fixture.stateDir,
        ]
      : matrix.role === "host"
        ? [
            "--socket",
            join(fixture.stateDir, "run", "station-host.sock"),
            "--state-dir",
            fixture.stateDir,
          ]
        : [];
  env.STATION_PROFILE_TARGET = targetName;
  return {
    command: matrix.bun.executable,
    args: [
      ...(matrix.role === "native" || matrix.role === "dashboard" ? ["--hot"] : []),
      profiledSourcePath,
      ...args,
    ],
    cwd: repoRoot,
    env,
    tty: matrix.role === "native" || matrix.role === "dashboard",
    label,
  };
}

async function analyzeCell(cell) {
  const samples = await readJsonLines(cell.targetSamplePath);
  const physicalSamples = samples
    .filter((sample) => Number.isFinite(sample.physicalFootprintBytes))
    .map((sample) => ({
      operations: sample.sequence,
      retainedBytes: sample.physicalFootprintBytes,
      elapsedMs: sample.elapsedMs ?? sample.sequence,
    }));
  const physicalFootprintPeaks = samples
    .filter((sample) => Number.isFinite(sample.physicalFootprintPeakBytes))
    .map((sample) => sample.physicalFootprintPeakBytes);
  const jscHeapSizes = samples
    .filter((sample) => Number.isFinite(sample.jsc?.heapSize))
    .map((sample) => sample.jsc.heapSize);
  const userTimingSamples = samples
    .filter((sample) => sample.userTiming !== undefined)
    .map((sample) => sample.userTiming);
  const analysis = {
    sampleCount: samples.length,
    userTiming: {
      sampleCount: userTimingSamples.length,
      maxMarks: Math.max(0, ...userTimingSamples.map((timing) => timing.marks ?? 0)),
      maxMeasures: Math.max(0, ...userTimingSamples.map((timing) => timing.measures ?? 0)),
      clearedSamples: samples.filter((sample) => sample.userTimingCleared === true).length,
    },
    physicalFootprintHighWaterBytes: Math.max(
      0,
      ...physicalSamples.map((sample) => sample.retainedBytes),
    ),
    physicalFootprintPeakHighWaterBytes: Math.max(0, ...physicalFootprintPeaks),
    jscHeapHighWaterBytes: Math.max(0, ...jscHeapSizes),
    physicalFootprintLastBytes: physicalSamples.at(-1)?.retainedBytes,
    retention:
      physicalSamples.length < 2 ? undefined : classifyRetention({ samples: physicalSamples }),
    rates: {
      ...cell.rates,
      commitsPerSecond: 0,
      rendererSamplesPerSecond: 0,
    },
  };
  if (cell.renderProfilePath !== undefined) {
    const renderRecords = await readJsonLines(cell.renderProfilePath);
    const durationSeconds = Math.max(cell.durationMs, 1) / 1_000;
    analysis.render = {
      commits: renderRecords.filter((record) => record.event === "commit").length,
      rendererSamples: renderRecords.filter((record) => record.event === "renderer-sample").length,
      userTimingSamples: renderRecords.filter((record) => record.userTiming !== undefined).length,
    };
    analysis.rates.commitsPerSecond = analysis.render.commits / durationSeconds;
    analysis.rates.rendererSamplesPerSecond = analysis.render.rendererSamples / durationSeconds;
  }
  return analysis;
}

function attributeOwners(cells) {
  return OWNER_PROBES.map((probe) => ({
    ...probe,
    status: "hypothesis",
    evidence: cells
      .filter((cell) => probeMatchesCell(probe, cell))
      .map((cell) => ({ cellId: cell.cellId, retention: cell.analysis.retention })),
  }));
}

function probeMatchesCell(probe, cell) {
  if (probe.owner === "renderer") return cell.role === "native" || cell.role === "dashboard";
  if (probe.owner === "host") return cell.role === "host";
  return cell.role === "observer" || cell.role === "dashboard" || cell.role === "native";
}

async function readJsonLines(path) {
  try {
    const source = await readFile(path, "utf8");
    return source
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function sourceRevision() {
  const head = (await runCommand("git", ["rev-parse", "HEAD"], repoRoot)).stdout.trim();
  const dirty = (
    await runCommand("git", ["status", "--porcelain", "--untracked-files=all"], repoRoot)
  ).stdout;
  return { head, clean: dirty.length === 0 };
}

async function checkRuntime(executable, expected) {
  if (!isAbsolute(executable))
    throw new Error(`Bun ${expected} executable must be absolute: ${executable}`);
  await access(executable, constants.X_OK);
  const version = (await runCommand(executable, ["--version"], repoRoot)).stdout.trim();
  if (version !== expected)
    throw new Error(`Bun ${expected} path resolved to ${version}: ${executable}`);
  return { executable, version };
}

async function defaultBunExecutable(version) {
  const configured = process.env[`STATION_BUN_${version.replaceAll(".", "_")}`];
  if (configured !== undefined) return configured;
  try {
    return (await resolveBunRuntime({ cwd: repoRoot })).executable;
  } catch {
    return undefined;
  }
}

function normalizeOptions(raw) {
  const output = raw.output ?? join(resolve(tmpdir()), "station-memory-profile");
  if (!isAbsolute(output)) throw new Error("Memory profile output must be absolute.");
  const protectedStatePath = resolve(homedir(), ".local", "state", "station");
  if (output === protectedStatePath || output.startsWith(`${protectedStatePath}/`)) {
    throw new Error(
      `Memory profile output cannot be inside the live Station state path: ${output}`,
    );
  }
  const roles = raw.roles ?? PROFILE_ROLES;
  const modes = raw.modes ?? ARTIFACT_MODES;
  assertProfileValues(roles, PROFILE_ROLES, "role");
  assertProfileValues(modes, ARTIFACT_MODES, "artifact mode");
  const timeScale = raw.timeScale ?? 1;
  if (!Number.isFinite(timeScale) || timeScale <= 0)
    throw new Error("Memory profile time scale must be positive.");
  const warmupMs = raw.warmupMs ?? 30_000;
  const cooldownMs = raw.cooldownMs ?? 30_000;
  for (const [name, value] of [
    ["warmup", warmupMs],
    ["cooldown", cooldownMs],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Memory profile ${name} duration must be a non-negative safe integer.`);
    }
  }
  return {
    output,
    roles,
    modes,
    timeScale,
    warmupMs,
    cooldownMs,
    allowDirty: raw.allowDirty === true,
    stalledSubscription: raw.stalledSubscription === true,
    clearUserTiming: raw.clearUserTiming === true,
    bun: raw.bun ?? {},
    binary: raw.binary ?? {},
  };
}

function assertProfileValues(values, allowed, label) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => !allowed.includes(value))
  ) {
    throw new Error(
      `Unsupported profile ${label}: ${Array.isArray(values) ? values.join(", ") : String(values)}`,
    );
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function runCommand(command, args, cwd) {
  return execFileAsync(command, args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    env: environmentWithoutGitLocals(),
  });
}

function environmentWithoutGitLocals(source = process.env) {
  const env = { ...source };
  for (const key of GIT_LOCAL_ENVIRONMENT_KEYS) delete env[key];
  return env;
}

function parseArgs(argv) {
  const options = { bun: {}, binary: {}, roles: PROFILE_ROLES, modes: ARTIFACT_MODES };
  let mode;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") mode = "check";
    else if (arg === "--matrix") mode = "matrix";
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--allow-dirty") options.allowDirty = true;
    else if (arg === "--time-scale") options.timeScale = Number(argv[++index]);
    else if (arg === "--warmup-ms") options.warmupMs = Number(argv[++index]);
    else if (arg === "--cooldown-ms") options.cooldownMs = Number(argv[++index]);
    else if (arg === "--roles") options.roles = argv[++index].split(",");
    else if (arg === "--modes") options.modes = argv[++index].split(",");
    else if (arg === "--stalled-subscriber") options.stalledSubscription = true;
    else if (arg === "--clear-user-timing") options.clearUserTiming = true;
    else if (arg.startsWith("--bun-")) {
      const version = arg.slice("--bun-".length).replaceAll("-", ".");
      if (!REQUIRED_BUN_VERSIONS.includes(version)) {
        throw new Error(`Unsupported Bun runtime for memory profile: ${version}`);
      }
      options.bun[version] = argv[++index];
    } else if (arg.startsWith("--binary-")) {
      const version = arg.slice("--binary-".length).replaceAll("-", ".");
      if (!REQUIRED_BUN_VERSIONS.includes(version)) {
        throw new Error(`Unsupported binary runtime for memory profile: ${version}`);
      }
      options.binary[version] = argv[++index];
    } else throw new Error(`Unsupported memory profile argument: ${arg}`);
  }
  if (mode === undefined) throw new Error(usage());
  return { mode, options };
}

function usage() {
  return "Usage: run-memory-owner-profile.mjs --check [--bun-1-4-0 <path>] | --matrix --output <absolute-dir> [--bun-1-4-0 <path>] [--roles observer,dashboard,native,host] [--modes source,compiled]";
}

if (import.meta.main) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.mode === "check") {
      process.stdout.write(
        `${JSON.stringify(await checkMemoryProfilePrerequisites(parsed.options), null, 2)}\n`,
      );
    } else {
      await runMemoryProfileMatrix(parsed.options);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
