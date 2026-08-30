import { realpathSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AgentStateSchema,
  HarnessEventObservationSchema,
  type ObserverApi,
  type ObserverRecoveryAssessment,
  SessionRecoveryHandleSchema,
  type StationCommand,
  type StationSnapshot,
  type WorktreeRow,
  worktreeHasLiveAgent,
} from "@station/contracts";
import type { ObserverClient } from "@station/protocol";
import { z } from "zod";
import type { RealStationConfigFixture } from "./config";
import type { RealE2eEnvironment } from "./env";
import { destroyExactTmuxSession, type ExactTmuxSessionLoss } from "./tmux";

const IngressAttemptSchema = z
  .object({
    id: z.string().uuid(),
    invokedAt: z.iso.datetime({ offset: true }),
    argv: z.array(z.string()),
    rawInput: z.string(),
    exitStatus: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();

export type IngressAttempt = z.infer<typeof IngressAttemptSchema>;

export type RealIngressWitness = {
  env: RealE2eEnvironment;
  attemptsPath: string;
  readAttempts(): Promise<IngressAttempt[]>;
};

export type ProviderSessionStartWitness = {
  provider: string;
  target: { kind: "native-session"; id: string } | { kind: "session-file"; path: string };
  cwd: string;
  attempt: IngressAttempt;
};

const ProviderObservationRowSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
    payload_json: z.string(),
    observed_at: z.string().min(1),
  })
  .strict();

const HarnessExecutionRowSchema = z
  .object({
    provider: z.string().min(1),
    session_id: z.string().min(1),
    native_session_id: z.string().min(1),
    state: AgentStateSchema,
    status_updated_at: z.string().min(1),
  })
  .strict();

const RecoveryHandleRowSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
    project_id: z.string().min(1),
    worktree_id: z.string().min(1),
    session_id: z.string().min(1).nullable(),
    target_kind: z.enum(["native-session", "session-file"]),
    target_value: z.string().min(1),
    cwd: z.string().min(1).nullable(),
    terminal_target_id: z.string().min(1).nullable(),
    harness_run_id: z.string().min(1).nullable(),
    observed_at: z.string().min(1),
    last_seen_at: z.string().min(1),
  })
  .strict();

export type RealRecoveryProjection = {
  observations: Array<{
    id: string;
    provider: string;
    observedAt: string;
    observation: z.infer<typeof HarnessEventObservationSchema>;
  }>;
  executions: Array<{
    provider: string;
    sessionId: string;
    nativeSessionId: string;
    state: z.infer<typeof AgentStateSchema>;
    statusUpdatedAt: string;
  }>;
  handles: Array<z.infer<typeof SessionRecoveryHandleSchema>>;
};

export type RecoveryAuthorityIdentity = {
  provider: string;
  projectId: string;
  worktreeId: string;
  sessionId: string;
  worktreePath: string;
};

export type RecoveryAuthority = {
  witness: ProviderSessionStartWitness;
  observation: RealRecoveryProjection["observations"][number];
  execution?: RealRecoveryProjection["executions"][number];
  handle: RealRecoveryProjection["handles"][number];
  assessment: ObserverRecoveryAssessment["sessions"][number];
};

export const RecoveryFailurePhaseSchema = z.enum([
  "no-hook-execution",
  "hook-command-failure",
  "rejected-or-spooled-ingress",
  "missing-binding",
  "missing-or-mismatched-handle",
  "post-loss-projection-failure",
]);

export type RecoveryFailurePhase = z.infer<typeof RecoveryFailurePhaseSchema>;

export class RecoveryEvidenceError extends Error {
  readonly phase: RecoveryFailurePhase;

  constructor(phase: RecoveryFailurePhase, message: string) {
    super(`${phase}: ${message}`);
    this.name = "RecoveryEvidenceError";
    this.phase = phase;
  }
}

export async function createRealIngressWitness(input: {
  env: RealE2eEnvironment;
  rootPath: string;
}): Promise<RealIngressWitness> {
  const attemptsPath = join(input.rootPath, "ingress-witness");
  const wrapperPath = join(attemptsPath, "stn-ingress-witness.mjs");
  const observerWrapperPath = join(attemptsPath, "observer-with-ingress-witness.mjs");
  const stationWrapperPath = join(attemptsPath, "stn-with-ingress-witness.mjs");
  await mkdir(attemptsPath, { recursive: true, mode: 0o700 });
  await chmod(attemptsPath, 0o700);
  await writeFile(wrapperPath, ingressWitnessSource(input.env.stationIngressBin, attemptsPath), {
    encoding: "utf8",
    mode: 0o700,
  });
  await chmod(wrapperPath, 0o700);
  await writeFile(observerWrapperPath, observerWitnessSource(input.env.repoRoot, wrapperPath), {
    encoding: "utf8",
    mode: 0o700,
  });
  await chmod(observerWrapperPath, 0o700);
  await writeFile(
    stationWrapperPath,
    stationWitnessSource(input.env.repoRoot, wrapperPath, observerWrapperPath),
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(stationWrapperPath, 0o700);

  return {
    env: { ...input.env, stationBin: stationWrapperPath, stationIngressBin: wrapperPath },
    attemptsPath,
    readAttempts: async () => {
      const entries = (await readdir(attemptsPath))
        .filter((entry) => entry.endsWith(".json"))
        .sort();
      return Promise.all(
        entries.map(async (entry) =>
          IngressAttemptSchema.parse(JSON.parse(await readFile(join(attemptsPath, entry), "utf8"))),
        ),
      );
    },
  };
}

export function readRealRecoveryProjection(stateDir: string): RealRecoveryProjection {
  const database = new DatabaseSync(join(stateDir, "observer.sqlite"), { readOnly: true });
  try {
    const observations = database
      .prepare(
        `SELECT id, provider, payload_json, observed_at
         FROM provider_observations
         WHERE entity_kind = 'harness_event'
         ORDER BY observed_at, id`,
      )
      .all()
      .map((unknownRow) => {
        const row = ProviderObservationRowSchema.parse(unknownRow);
        const observation = HarnessEventObservationSchema.parse(JSON.parse(row.payload_json));
        if (observation.provider !== row.provider) {
          throw new Error(
            `Harness observation ${row.id} provider ${observation.provider} disagrees with row ${row.provider}.`,
          );
        }
        return {
          id: row.id,
          provider: row.provider,
          observedAt: row.observed_at,
          observation,
        };
      });
    const executions = database
      .prepare(
        `SELECT provider, session_id, native_session_id, state, status_updated_at
         FROM session_harness_executions
         ORDER BY provider, session_id`,
      )
      .all()
      .map((unknownRow) => {
        const row = HarnessExecutionRowSchema.parse(unknownRow);
        return {
          provider: row.provider,
          sessionId: row.session_id,
          nativeSessionId: row.native_session_id,
          state: row.state,
          statusUpdatedAt: row.status_updated_at,
        };
      });
    const handles = database
      .prepare(
        `SELECT id, provider, project_id, worktree_id, session_id, target_kind, target_value,
                cwd, terminal_target_id, harness_run_id, observed_at, last_seen_at
         FROM session_recovery_handles
         ORDER BY last_seen_at DESC, id`,
      )
      .all()
      .map((unknownRow) => recoveryHandleFromRow(RecoveryHandleRowSchema.parse(unknownRow)));
    return { observations, executions, handles };
  } finally {
    database.close();
  }
}

export function recoveryAuthorityFromEvidence(input: {
  identity: RecoveryAuthorityIdentity;
  witness: ProviderSessionStartWitness;
  projection: RealRecoveryProjection;
  assessment: ObserverRecoveryAssessment;
}): RecoveryAuthority | undefined {
  const { identity, witness, projection } = input;
  if (
    witness.provider !== identity.provider ||
    !pathsReferToSameLocation(witness.cwd, identity.worktreePath) ||
    witness.attempt.exitStatus !== 0
  ) {
    return undefined;
  }
  const observation = projection.observations.find(
    ({ provider, observation: candidate }) =>
      provider === identity.provider &&
      candidate.eventType === "SessionStart" &&
      candidate.projectId === identity.projectId &&
      candidate.worktreeId === identity.worktreeId &&
      candidate.sessionId === identity.sessionId &&
      candidate.cwd !== undefined &&
      pathsReferToSameLocation(candidate.cwd, identity.worktreePath) &&
      targetMatchesObservation(witness.target, candidate),
  );
  if (observation === undefined) return undefined;

  const execution = projection.executions.find(
    (candidate) =>
      candidate.provider === identity.provider && candidate.sessionId === identity.sessionId,
  );
  if (witness.target.kind === "native-session") {
    if (execution?.nativeSessionId !== witness.target.id) return undefined;
  } else if (execution !== undefined) {
    return undefined;
  }

  const handle = projection.handles.find(
    (candidate) =>
      candidate.provider === identity.provider &&
      candidate.projectId === identity.projectId &&
      candidate.worktreeId === identity.worktreeId &&
      candidate.sessionId === identity.sessionId &&
      candidate.cwd !== undefined &&
      pathsReferToSameLocation(candidate.cwd, identity.worktreePath) &&
      targetsEqual(candidate.target, witness.target),
  );
  if (handle === undefined) return undefined;

  const assessment = input.assessment.sessions.find(
    (candidate) =>
      candidate.sessionId === identity.sessionId &&
      candidate.projectId === identity.projectId &&
      candidate.worktreeId === identity.worktreeId &&
      candidate.harnessProvider === identity.provider,
  );
  if (
    assessment?.disposition !== "recoverable" ||
    assessment.handleResolution.kind !== "selected" ||
    assessment.handleResolution.selectedHandleId !== handle.id
  ) {
    return undefined;
  }
  const authority: RecoveryAuthority = { witness, observation, handle, assessment };
  if (execution !== undefined) authority.execution = execution;
  return authority;
}

export function classifyRecoveryFailure(input: {
  attempts: readonly IngressAttempt[];
  witness?: ProviderSessionStartWitness;
  identity: RecoveryAuthorityIdentity;
  projection?: RealRecoveryProjection;
  postLoss?: boolean;
}): RecoveryFailurePhase {
  if (input.postLoss === true) return "post-loss-projection-failure";
  if (input.attempts.length === 0) return "no-hook-execution";
  if (input.witness === undefined || input.witness.attempt.exitStatus !== 0) {
    return "hook-command-failure";
  }
  const projection = input.projection;
  const admitted = projection?.observations.some(
    ({ provider, observation }) =>
      provider === input.identity.provider &&
      observation.projectId === input.identity.projectId &&
      observation.worktreeId === input.identity.worktreeId &&
      observation.sessionId === input.identity.sessionId &&
      targetMatchesObservation(input.witness?.target, observation),
  );
  if (admitted !== true) return "rejected-or-spooled-ingress";
  if (input.witness.target.kind === "native-session") {
    const bound = projection?.executions.some(
      (execution) =>
        execution.provider === input.identity.provider &&
        execution.sessionId === input.identity.sessionId &&
        execution.nativeSessionId === input.witness?.target.id,
    );
    if (bound !== true) return "missing-binding";
  } else if (
    projection?.executions.some(
      (execution) =>
        execution.provider === input.identity.provider &&
        execution.sessionId === input.identity.sessionId,
    ) === true
  ) {
    return "missing-binding";
  }
  return "missing-or-mismatched-handle";
}

export async function waitForRecoveryAuthority(input: {
  client: Pick<ObserverApi, "getSessionRecoveryAssessment">;
  stateDir: string;
  ingress: Pick<RealIngressWitness, "readAttempts">;
  readWitness: () => Promise<ProviderSessionStartWitness | undefined>;
  identity: RecoveryAuthorityIdentity;
  timeoutMs?: number;
}): Promise<RecoveryAuthority> {
  const deadline = Date.now() + (input.timeoutMs ?? 90_000);
  let attempts: IngressAttempt[] = [];
  let witness: ProviderSessionStartWitness | undefined;
  let projection: RealRecoveryProjection | undefined;
  while (Date.now() <= deadline) {
    attempts = await input.ingress.readAttempts();
    witness = await input.readWitness();
    try {
      projection = readRealRecoveryProjection(input.stateDir);
      if (witness !== undefined) {
        const assessment = await input.client.getSessionRecoveryAssessment();
        const authority = recoveryAuthorityFromEvidence({
          identity: input.identity,
          witness,
          projection,
          assessment,
        });
        if (authority !== undefined) return authority;
      }
    } catch {
      // Observer startup and SQLite schema creation can briefly lag the first raw hook witness.
    }
    await delay(500);
  }
  const phase = classifyRecoveryFailure({
    attempts,
    identity: input.identity,
    ...(witness === undefined ? {} : { witness }),
    ...(projection === undefined ? {} : { projection }),
  });
  throw new RecoveryEvidenceError(
    phase,
    `timed out proving ${input.identity.provider} recovery authority for ${input.identity.sessionId}`,
  );
}

export async function proveDormantRecovery(input: {
  client: Pick<ObserverApi, "getSnapshot" | "getSessionRecoveryAssessment" | "reconcile">;
  config: RealStationConfigFixture;
  ingress: Pick<RealIngressWitness, "readAttempts">;
  readWitness: () => Promise<ProviderSessionStartWitness | undefined>;
  identity: RecoveryAuthorityIdentity;
  timeoutMs?: number;
}): Promise<{ authority: RecoveryAuthority; loss: ExactTmuxSessionLoss; row: WorktreeRow }> {
  const authority = await waitForRecoveryAuthority({
    client: input.client,
    stateDir: input.config.stateDir,
    ingress: input.ingress,
    readWitness: input.readWitness,
    identity: input.identity,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  const loss = await destroyExactTmuxSession(input.config.tmuxEndpoint, input.config.tmuxSession);
  const deadline = Date.now() + (input.timeoutMs ?? 90_000);
  while (Date.now() <= deadline) {
    const snapshot = await input.client.getSnapshot({ includeDebug: true });
    const row = snapshot.rows.find(
      (candidate) =>
        candidate.projectId === input.identity.projectId &&
        candidate.id === input.identity.worktreeId,
    );
    const assessment = await input.client.getSessionRecoveryAssessment();
    const session = assessment.sessions.find(
      (candidate) => candidate.sessionId === input.identity.sessionId,
    );
    if (
      row !== undefined &&
      !worktreeHasLiveAgent(row) &&
      !hasLiveTerminal(row) &&
      row.recovery?.kind === "agent-resume" &&
      row.recovery.handleId === authority.handle.id &&
      row.recovery.provider === input.identity.provider &&
      row.recovery.sessionId === input.identity.sessionId &&
      session?.lifecycle === "open" &&
      session.disposition === "recoverable" &&
      session.handleResolution.kind === "selected" &&
      session.handleResolution.selectedHandleId === authority.handle.id
    ) {
      return { authority, loss, row };
    }
    await input.client.reconcile("real-recovery-post-terminal-loss").catch(() => undefined);
    await delay(500);
  }
  throw new RecoveryEvidenceError(
    "post-loss-projection-failure",
    `Station session ${input.identity.sessionId} did not become exactly dormant after ${loss.lostAt}`,
  );
}

export async function launchProvenDormantRecovery(input: {
  client: ObserverClient;
  config: RealStationConfigFixture;
  ingress: Pick<RealIngressWitness, "readAttempts">;
  provider: string;
  branch: string;
  initialPrompt: string;
  afterTerminalAttached: (row: WorktreeRow) => Promise<void>;
  readWitness: (row: WorktreeRow) => Promise<ProviderSessionStartWitness | undefined>;
  timeoutMs?: number;
}): Promise<{
  commandId: string;
  identity: RecoveryAuthorityIdentity;
  authority: RecoveryAuthority;
  loss: ExactTmuxSessionLoss;
  row: WorktreeRow;
}> {
  const command: StationCommand = {
    type: "session.create",
    payload: {
      projectId: input.config.projectId,
      branch: input.branch,
      harness: { provider: input.provider, mode: "interactive" },
      terminal: { provider: "tmux", layout: "agent-build-shell" },
      placement: { intent: "detached" },
      initialPrompt: input.initialPrompt,
    },
  };
  const receipt = await input.client.dispatch(command);
  const commandRecord = await input.client.waitForCommand(receipt.commandId, {
    timeoutMs: input.timeoutMs ?? 180_000,
  });
  if (commandRecord.status !== "succeeded") {
    throw new Error(
      `session.create ${receipt.commandId} failed: ${commandRecord.error?.code ?? commandRecord.status}`,
    );
  }
  const attachedRow = await waitForExactRow(
    input.client,
    input.config.projectId,
    input.branch,
    (row) =>
      row.terminal?.hasPrimaryAgentEndpoint === true &&
      row.terminal.focusable === true &&
      row.agent?.harness === input.provider &&
      row.agent.sessionId !== undefined,
    input.timeoutMs ?? 90_000,
    `created ${input.provider} session did not expose an exact terminal attachment`,
  );
  await input.afterTerminalAttached(attachedRow);
  const attachedSessionId = attachedRow.agent?.sessionId;
  if (attachedSessionId === undefined) {
    throw new Error(`created ${input.provider} row has no Station session identity`);
  }
  const completedRow = await waitForExactRow(
    input.client,
    input.config.projectId,
    input.branch,
    (row) =>
      row.agent?.harness === input.provider &&
      row.agent.sessionId === attachedSessionId &&
      row.agent.state === "idle",
    input.timeoutMs ?? 180_000,
    `created ${input.provider} session did not complete its bounded sentinel turn`,
  );
  const sessionId = completedRow.agent?.sessionId;
  if (sessionId === undefined) {
    throw new Error(`created ${input.provider} row has no Station session identity`);
  }
  const identity: RecoveryAuthorityIdentity = {
    provider: input.provider,
    projectId: completedRow.projectId,
    worktreeId: completedRow.id,
    sessionId,
    worktreePath: completedRow.path,
  };
  const dormant = await proveDormantRecovery({
    client: input.client,
    config: input.config,
    ingress: input.ingress,
    readWitness: () => input.readWitness(completedRow),
    identity,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  return { commandId: receipt.commandId, identity, ...dormant };
}

export async function waitForResumedRecovery(input: {
  client: Pick<ObserverApi, "getSnapshot" | "reconcile">;
  stateDir: string;
  identity: RecoveryAuthorityIdentity;
  original: ProviderSessionStartWitness;
  readPostResumeWitness: () => Promise<ProviderSessionStartWitness | undefined>;
  timeoutMs?: number;
}): Promise<{ witness: ProviderSessionStartWitness; snapshot: StationSnapshot; row: WorktreeRow }> {
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  while (Date.now() <= deadline) {
    const witness = await input.readPostResumeWitness();
    const snapshot = await input.client.getSnapshot({ includeDebug: true });
    const row = snapshot.rows.find(
      (candidate) =>
        candidate.projectId === input.identity.projectId &&
        candidate.id === input.identity.worktreeId,
    );
    let projection: RealRecoveryProjection | undefined;
    try {
      projection = readRealRecoveryProjection(input.stateDir);
    } catch {
      // The Observer can be between its report receipt and SQLite visibility.
    }
    const admittedPostResume =
      witness === undefined
        ? undefined
        : projection?.observations.find(
            ({ provider, observedAt, observation }) =>
              provider === input.identity.provider &&
              observedAt >= witness.attempt.invokedAt &&
              observation.eventType === "SessionStart" &&
              observation.projectId === input.identity.projectId &&
              observation.worktreeId === input.identity.worktreeId &&
              observation.sessionId === input.identity.sessionId &&
              observation.cwd !== undefined &&
              pathsReferToSameLocation(observation.cwd, input.identity.worktreePath) &&
              targetMatchesObservation(witness.target, observation),
          );
    const executionAgrees =
      witness?.target.kind === "native-session"
        ? projection?.executions.some(
            (execution) =>
              execution.provider === input.identity.provider &&
              execution.sessionId === input.identity.sessionId &&
              execution.nativeSessionId === witness.target.id,
          ) === true
        : projection?.executions.some(
            (execution) =>
              execution.provider === input.identity.provider &&
              execution.sessionId === input.identity.sessionId,
          ) !== true;
    if (
      witness !== undefined &&
      witness.provider === input.identity.provider &&
      pathsReferToSameLocation(witness.cwd, input.identity.worktreePath) &&
      targetsEqual(witness.target, input.original.target) &&
      admittedPostResume !== undefined &&
      executionAgrees &&
      row?.agent?.sessionId === input.identity.sessionId &&
      worktreeHasLiveAgent(row) &&
      row.recovery === undefined
    ) {
      return { witness, snapshot, row };
    }
    await input.client.reconcile("real-recovery-post-resume").catch(() => undefined);
    await delay(500);
  }
  throw new RecoveryEvidenceError(
    "post-loss-projection-failure",
    `resumed ${input.identity.provider} identity did not return live for ${input.identity.sessionId}`,
  );
}

function recoveryHandleFromRow(row: z.infer<typeof RecoveryHandleRowSchema>) {
  const handle: Record<string, unknown> = {
    id: row.id,
    provider: row.provider,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    target:
      row.target_kind === "native-session"
        ? { kind: "native-session", id: row.target_value }
        : { kind: "session-file", path: row.target_value },
    observedAt: row.observed_at,
    lastSeenAt: row.last_seen_at,
  };
  if (row.session_id !== null) handle.sessionId = row.session_id;
  if (row.cwd !== null) handle.cwd = row.cwd;
  if (row.terminal_target_id !== null) handle.terminalTargetId = row.terminal_target_id;
  if (row.harness_run_id !== null) handle.harnessRunId = row.harness_run_id;
  return SessionRecoveryHandleSchema.parse(handle);
}

function targetMatchesObservation(
  target: ProviderSessionStartWitness["target"] | undefined,
  observation: z.infer<typeof HarnessEventObservationSchema>,
): boolean {
  if (target === undefined) return false;
  return target.kind === "native-session"
    ? observation.nativeSessionId === target.id && observation.nativeSessionFile === undefined
    : observation.nativeSessionFile === target.path && observation.nativeSessionId === undefined;
}

function targetsEqual(
  left: ProviderSessionStartWitness["target"],
  right: ProviderSessionStartWitness["target"],
): boolean {
  return left.kind === "native-session"
    ? right.kind === "native-session" && left.id === right.id
    : right.kind === "session-file" && left.path === right.path;
}

export function pathsReferToSameLocation(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function hasLiveTerminal(row: WorktreeRow): boolean {
  return (
    row.terminal?.hasPrimaryAgentEndpoint === true ||
    row.terminal?.focusable === true ||
    row.terminal?.state === "open"
  );
}

async function waitForExactRow(
  client: Pick<ObserverApi, "getSnapshot" | "reconcile">,
  projectId: string,
  branch: string,
  predicate: (row: WorktreeRow) => boolean,
  timeoutMs: number,
  message: string,
): Promise<WorktreeRow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const snapshot = await client.getSnapshot({ includeDebug: true });
    const row = snapshot.rows.find(
      (candidate) => candidate.projectId === projectId && candidate.branch === branch,
    );
    if (row !== undefined && predicate(row)) return row;
    await client.reconcile("real-recovery-row-poll").catch(() => undefined);
    await delay(500);
  }
  throw new Error(`${message}: ${projectId}/${branch}`);
}

function observerWitnessSource(repoRoot: string, ingressWrapperPath: string): string {
  const observerMainPath = join(repoRoot, "apps", "cli", "dist", "observerMain.js");
  return `#!/usr/bin/env node
import { runCliObserverMain, runCliObserverProcess } from ${JSON.stringify(observerMainPath)};

const code = await runCliObserverProcess((startupReadinessSink) =>
  runCliObserverMain(process.argv.slice(2), {
    providerHookIngressLauncher: ${JSON.stringify(ingressWrapperPath)},
    startupReadinessSink,
  }),
);
process.exitCode = code;
`;
}

function stationWitnessSource(
  repoRoot: string,
  ingressWrapperPath: string,
  observerWrapperPath: string,
): string {
  const cliMainPath = join(repoRoot, "apps", "cli", "dist", "main.js");
  const observerSpawnPath = join(repoRoot, "apps", "cli", "dist", "observerProcess", "spawn.js");
  return `#!/usr/bin/env node
import { runCliMain } from ${JSON.stringify(cliMainPath)};
import { defaultSpawnObserver } from ${JSON.stringify(observerSpawnPath)};

await runCliMain(process.argv.slice(2), {
  providerHookIngressLauncher: ${JSON.stringify(ingressWrapperPath)},
  observerDeps: {
    spawnObserver: (input) => defaultSpawnObserver({
      ...input,
      observerCommand: [process.execPath, ${JSON.stringify(observerWrapperPath)}],
    }),
  },
});
`;
}

function ingressWitnessSource(ingressPath: string, attemptsPath: string): string {
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const id = randomUUID();
const invokedAt = new Date().toISOString();
const argv = process.argv.slice(2);
const rawInput = readFileSync(0, "utf8");
const result = spawnSync(${JSON.stringify(ingressPath)}, argv, {
  encoding: "utf8",
  env: process.env,
  input: rawInput,
  maxBuffer: 4 * 1024 * 1024,
});
const stdout = result.stdout ?? "";
const stderr = result.stderr ?? (result.error?.message ?? "");
const record = {
  id,
  invokedAt,
  argv,
  rawInput,
  exitStatus: result.status,
  signal: result.signal,
  stdout,
  stderr,
};
writeFileSync(join(${JSON.stringify(attemptsPath)}, \`\${invokedAt}-\${id}.json\`), JSON.stringify(record) + "\\n", { mode: 0o600 });
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exit(result.status ?? 1);
`;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
