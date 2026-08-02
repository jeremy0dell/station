import { spawn } from "node:child_process";
import { access, mkdir, rm, symlink } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createArmAccess, validateCommand } from "./arms.js";
import {
  assertBlindPacketHasNoArmLabels,
  assertBlindPacketHasNoPrivatePaths,
  createBlindReviewPacket,
  createRunPaths,
  type RunPaths,
  readRunState,
  writeBlindReviewPacket,
  writeJson,
  writeRunState,
  writeTrialArtifact,
} from "./artifacts.js";
import { assertCodexVersion, buildTrialPrompt, runCodexTrial } from "./codexRunner.js";
import {
  assertNoPrivateCorpusFiles,
  type IncidentPackage,
  type LoadedCorpus,
  prepareTrialEvidence,
} from "./corpus.js";
import {
  type Arm,
  type ExperimentRunState,
  ExperimentRunStateSchema,
  type NeutralArmLabel,
  type TrialAttempt,
  type TrialPlan,
  type TrialRecord,
} from "./protocol.js";

export type { ExperimentRunState, TrialPlan } from "./protocol.js";

const arms: Arm[] = ["base", "candidate", "raw"];
const neutralLabels: NeutralArmLabel[] = ["arm-a", "arm-b", "arm-c"];

export type FrozenStationExecutable = {
  path: string;
  commit: string;
};

export type CodexExecution = {
  executable: string;
  executableArgs?: string[];
  expectedVersion?: string;
  authFilePath?: string;
  timeoutMs: number;
  tokenBudget: number;
  environment?: Record<string, string>;
};

export type TrialExecutor = (input: {
  plan: TrialPlan;
  incident: IncidentPackage;
  workspaceRoot: string;
  artifactRoot: string;
  isolatedHome: string;
  stationPath?: string;
}) => Promise<{ attempt: TrialAttempt; stdoutJsonl: string }>;

export function createNeutralArmAssignments(seed: string): Record<Arm, NeutralArmLabel> {
  const labels = shuffle([...neutralLabels], seededRandom(`${seed}:labels`));
  const base = labels[0];
  const candidate = labels[1];
  const raw = labels[2];
  if (base === undefined || candidate === undefined || raw === undefined) {
    throw new Error("Unable to assign neutral arm labels.");
  }
  return { base, candidate, raw };
}

export function buildBalancedSchedule(input: {
  incidents: readonly IncidentPackage[];
  replicates: number;
  seed: string;
}): TrialPlan[] {
  if (input.replicates < 1) {
    throw new Error("At least one replicate is required.");
  }
  const assignments = createNeutralArmAssignments(input.seed);
  const random = seededRandom(`${input.seed}:schedule`);
  const schedule: TrialPlan[] = [];
  for (let replicate = 1; replicate <= input.replicates; replicate += 1) {
    const incidentOrder = shuffle([...input.incidents], random);
    for (const incident of incidentOrder) {
      const armOrder = shuffle([...arms], random);
      for (const arm of armOrder) {
        schedule.push({
          trialId: `${incident.entry.id}-r${replicate}-${assignments[arm]}`,
          incidentId: incident.entry.id,
          replicate,
          arm,
          blindArm: assignments[arm],
        });
      }
    }
  }
  return schedule;
}

export type PreflightCommandResult = {
  incidentId: string;
  arm: Arm;
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export async function preflightCorpus(input: {
  corpus: LoadedCorpus;
  workspaceRoot: string;
  stationExecutables?: Record<"base" | "candidate", FrozenStationExecutable>;
}): Promise<void> {
  if (input.stationExecutables !== undefined) {
    assertFrozenStationExecutables(input.stationExecutables, input.corpus);
  }
  const evidenceByIncidentAndArm = new Map<string, string>();
  const commandResults: PreflightCommandResult[] = [];
  for (const incident of input.corpus.incidents) {
    for (const arm of arms) {
      const workspace = join(input.workspaceRoot, incident.entry.id, arm);
      const prepared = await prepareTrialEvidence({ incident, workspaceRoot: workspace });
      await assertNoPrivateCorpusFiles(prepared.root);
      const access = createArmAccess({ arm, blindArm: "arm-a", replay: incident.replay });
      for (const pattern of access.commandPatterns) {
        const check = validateCommand({
          access,
          argv: [pattern.executable, ...pattern.arguments.map(exampleArgument)],
          workspaceRoot: prepared.root,
        });
        if (check.ok === false) {
          throw new Error(`Allowed command rejected for ${incident.entry.id}: ${check.reason}`);
        }
        if (input.stationExecutables !== undefined) {
          const executable =
            arm === "raw"
              ? await resolveExecutable(check.argv[0] ?? "")
              : input.stationExecutables[arm].path;
          commandResults.push(
            await executePreflightCommand({
              incidentId: incident.entry.id,
              arm,
              executable,
              argv: check.argv,
              cwd: prepared.root,
            }),
          );
        }
      }
      const forbidden = validateCommand({
        access,
        argv: arm === "raw" ? ["stn", "debug", "logs"] : ["stn", "observer", "start"],
        workspaceRoot: prepared.root,
      });
      if (forbidden.ok) {
        throw new Error(`Forbidden command accepted for ${incident.entry.id} ${arm}.`);
      }
      evidenceByIncidentAndArm.set(`${incident.entry.id}:${arm}`, prepared.evidenceSha256);
    }
    const base = evidenceByIncidentAndArm.get(`${incident.entry.id}:base`);
    const candidate = evidenceByIncidentAndArm.get(`${incident.entry.id}:candidate`);
    if (base === undefined || candidate === undefined || base !== candidate) {
      throw new Error(`Base and candidate evidence differ for ${incident.entry.id}.`);
    }
  }
  if (input.stationExecutables !== undefined) {
    await writeJson(join(input.workspaceRoot, "preflight-command-report.json"), commandResults);
  }
}

async function executePreflightCommand(input: {
  incidentId: string;
  arm: Arm;
  executable: string;
  argv: string[];
  cwd: string;
}): Promise<PreflightCommandResult> {
  const child = spawn(input.executable, input.argv.slice(1), {
    cwd: input.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 30_000);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timeout));
  if (timedOut) {
    throw new Error(`Allowed preflight command timed out: ${input.argv.join(" ")}`);
  }
  return {
    incidentId: input.incidentId,
    arm: input.arm,
    argv: input.argv,
    exitCode,
    stdout: stdout.join("").slice(-65_536),
    stderr: stderr.join("").slice(-65_536),
  };
}

export async function runExperiment(input: {
  corpus: LoadedCorpus;
  artifactRoot: string;
  replicates: number;
  seed: string;
  stationExecutables: Record<"base" | "candidate", FrozenStationExecutable>;
  executor: TrialExecutor;
  maxInfrastructureAttempts?: number;
}): Promise<{ paths: RunPaths; state: ExperimentRunState }> {
  assertFrozenStationExecutables(input.stationExecutables, input.corpus);
  const paths = await createRunPaths(input.artifactRoot);
  const manifestHash = input.corpus.freeze.manifestSha256;
  const schedule = buildBalancedSchedule({
    incidents: input.corpus.incidents,
    replicates: input.replicates,
    seed: input.seed,
  });
  const storedState = await readRunState<unknown>(paths);
  const existing =
    storedState === undefined ? undefined : ExperimentRunStateSchema.parse(storedState);
  const state: ExperimentRunState = existing ?? {
    schemaVersion: 1 as const,
    corpusManifestSha256: manifestHash,
    schedule,
    records: {},
  };
  assertRunState(state, manifestHash, schedule);
  const maxInfrastructureAttempts = input.maxInfrastructureAttempts ?? 3;

  for (const plan of state.schedule) {
    const record = state.records[plan.trialId];
    if (record !== undefined && !shouldRetry(record)) {
      continue;
    }
    const incident = input.corpus.incidents.find(
      (candidate) => candidate.entry.id === plan.incidentId,
    );
    if (incident === undefined) {
      throw new Error(`Schedule references missing incident: ${plan.incidentId}`);
    }
    const mutableRecord = record ?? {
      schemaVersion: 1 as const,
      trialId: plan.trialId,
      incidentId: plan.incidentId,
      replicate: plan.replicate,
      arm: plan.arm,
      blindArm: plan.blindArm,
      evidenceSha256: "",
      attempts: [],
    };
    while (shouldRetry(mutableRecord) || mutableRecord.attempts.length === 0) {
      if (mutableRecord.attempts.length >= maxInfrastructureAttempts) {
        break;
      }
      const attemptNumber = mutableRecord.attempts.length + 1;
      const workspaceRoot = join(paths.raw, "workspaces", plan.trialId, `attempt-${attemptNumber}`);
      const prepared = await prepareTrialEvidence({ incident, workspaceRoot });
      if (mutableRecord.evidenceSha256.length === 0) {
        mutableRecord.evidenceSha256 = prepared.evidenceSha256;
      } else if (mutableRecord.evidenceSha256 !== prepared.evidenceSha256) {
        throw new Error(`Evidence changed while resuming ${plan.trialId}.`);
      }
      const stationPath = plan.arm === "raw" ? undefined : input.stationExecutables[plan.arm].path;
      const result = await input.executor({
        plan,
        incident,
        workspaceRoot: prepared.root,
        artifactRoot: join(paths.raw, "runner", plan.trialId, `attempt-${attemptNumber}`),
        isolatedHome: join(paths.raw, "homes", plan.trialId, `attempt-${attemptNumber}`),
        ...(stationPath === undefined ? {} : { stationPath }),
      });
      const attempt: TrialAttempt = { ...result.attempt, attempt: attemptNumber };
      mutableRecord.attempts.push(attempt);
      state.records[plan.trialId] = mutableRecord;
      await writeTrialArtifact({ paths, record: mutableRecord, stdoutJsonl: result.stdoutJsonl });
      await writeRunState(paths, state);
      if (!shouldRetry(mutableRecord)) {
        break;
      }
    }
  }
  assertStationEvidenceIdentity(state);
  await writeRunState(paths, state);
  return { paths, state };
}

export async function generateBlindReviewPackets(input: {
  paths: RunPaths;
  corpus: LoadedCorpus;
  state: ExperimentRunState;
}): Promise<number> {
  let count = 0;
  for (const plan of input.state.schedule) {
    const record = input.state.records[plan.trialId];
    const incident = input.corpus.incidents.find(
      (candidate) => candidate.entry.id === plan.incidentId,
    );
    if (record === undefined || incident === undefined) {
      continue;
    }
    const packet = createBlindReviewPacket({ record, symptom: incident.symptom });
    assertBlindPacketHasNoArmLabels(packet, [record.trialId, record.blindArm]);
    assertBlindPacketHasNoPrivatePaths(packet);
    await writeBlindReviewPacket(input.paths, packet);
    count += 1;
  }
  return count;
}

export function createCodexExecutor(input: CodexExecution): TrialExecutor {
  let versionCheck: Promise<void> | undefined;
  return async ({ plan, incident, workspaceRoot, artifactRoot, isolatedHome, stationPath }) => {
    await Promise.all([
      rm(artifactRoot, { recursive: true, force: true }),
      rm(isolatedHome, { recursive: true, force: true }),
    ]);
    if (input.expectedVersion !== undefined) {
      versionCheck ??= assertCodexVersion({
        executable: input.executable,
        ...(input.executableArgs === undefined ? {} : { executableArgs: input.executableArgs }),
        expectedVersion: input.expectedVersion,
      });
      await versionCheck;
    }
    const access = createArmAccess({
      arm: plan.arm,
      blindArm: plan.blindArm,
      replay: incident.replay,
    });
    const armPath = await createArmPath({
      arm: plan.arm,
      stationPath,
      commandNames: access.commandPatterns.map((pattern) => pattern.executable),
      root: join(artifactRoot, "command-bin"),
    });
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.environment ?? {})) {
      environment[key] = value;
    }
    environment.PATH = armPath;
    return runCodexTrial({
      executable: input.executable,
      ...(input.executableArgs === undefined ? {} : { executableArgs: input.executableArgs }),
      workspaceRoot,
      isolatedHome,
      artifactRoot,
      prompt: buildTrialPrompt({ symptom: incident.symptom, access }),
      arm: plan.arm,
      blindArm: plan.blindArm,
      replay: incident.replay,
      timeoutMs: input.timeoutMs,
      tokenBudget: input.tokenBudget,
      ...(input.authFilePath === undefined ? {} : { authFilePath: input.authFilePath }),
      environment,
    });
  };
}

function assertFrozenStationExecutables(
  executables: Record<"base" | "candidate", FrozenStationExecutable>,
  corpus: LoadedCorpus,
): void {
  if (
    executables.base.commit !== corpus.manifest.baseCommit ||
    executables.candidate.commit !== corpus.manifest.candidateCommit
  ) {
    throw new Error("Station executable commits do not match the sealed corpus freeze.");
  }
}

function shouldRetry(record: TrialRecord): boolean {
  const lastAttempt = record.attempts.at(-1);
  return (
    lastAttempt !== undefined &&
    lastAttempt.status === "infrastructure-retryable" &&
    !lastAttempt.modelStarted
  );
}

async function createArmPath(input: {
  arm: Arm;
  stationPath: string | undefined;
  commandNames: string[];
  root: string;
}): Promise<string> {
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  if (input.arm !== "raw") {
    if (input.stationPath === undefined) {
      throw new Error(`Missing frozen Station executable for ${input.arm}.`);
    }
    await access(input.stationPath);
    await symlink(input.stationPath, join(input.root, "stn"));
    return input.root;
  }

  for (const commandName of new Set(input.commandNames)) {
    const executable = await resolveExecutable(commandName);
    await symlink(executable, join(input.root, commandName));
  }
  return input.root;
}

async function resolveExecutable(commandName: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = join(directory, commandName);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue until the exact allowlisted executable is found.
    }
  }
  throw new Error(`Required raw-evidence executable is unavailable: ${commandName}`);
}

function assertRunState(
  state: ExperimentRunState,
  manifestHash: string,
  expectedSchedule: TrialPlan[],
): void {
  if (state.schemaVersion !== 1 || state.corpusManifestSha256 !== manifestHash) {
    throw new Error("Run state does not match the sealed corpus.");
  }
  if (JSON.stringify(state.schedule) !== JSON.stringify(expectedSchedule)) {
    throw new Error("Run state schedule does not match the seeded balanced schedule.");
  }
}

function assertStationEvidenceIdentity(state: ExperimentRunState): void {
  const byIncidentAndReplicate = new Map<string, Partial<Record<Arm, string>>>();
  for (const record of Object.values(state.records)) {
    const key = `${record.incidentId}:${record.replicate}`;
    const hashes = byIncidentAndReplicate.get(key) ?? {};
    hashes[record.arm] = record.evidenceSha256;
    byIncidentAndReplicate.set(key, hashes);
  }
  for (const [key, hashes] of byIncidentAndReplicate) {
    if (hashes.base !== hashes.candidate) {
      throw new Error(`Base and candidate evidence identity check failed for ${key}.`);
    }
  }
}

function exampleArgument(argument: string): string {
  switch (argument) {
    case "{id}":
    case "{traceId}":
    case "{commandId}":
    case "{diagnosticId}":
      return "incident-123";
    case "{query}":
      return "failure";
    case "{path}":
      return "state";
    case "{sql}":
      return "SELECT 1";
    case "{number}":
      return "20";
    default:
      return argument;
  }
}

function shuffle<T>(values: T[], random: () => number): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    const current = values[index];
    values[index] = values[target] as T;
    values[target] = current as T;
  }
  return values;
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
