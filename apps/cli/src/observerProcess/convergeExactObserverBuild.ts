import * as contracts from "@station/contracts";
import type { ExactObserverOwnershipEvidence } from "@station/observer/internal";
import * as observer from "@station/observer/internal";
import * as protocol from "@station/protocol";
import * as runtime from "@station/runtime";
import { z } from "zod";
import * as lifecycle from "../observerProcess.js";
import { type ObserverPaths, resolveObserverPaths } from "../paths.js";
import { inspectExactObserverOwnerWithLocalAdapters } from "./inspectExactObserverOwner.js";
import type * as processTypes from "./types.js";

const { compareCodeUnitStrings: compare } = contracts;
const cause = lifecycle.exactObserverConvergenceError;

const BuildSchema = z
  .string()
  .refine(observer.observerBuildSelectorIsValid)
  .refine((value) => runtime.parseStationObserverBuildVersion(value).buildIdentity !== undefined);
const HandlesSchema = z
  .array(
    z.strictObject({
      sessionId: contracts.SessionIdSchema,
      selectedHandleId: z.string().min(1),
    }),
  )
  .refine((values) =>
    values
      .slice(1)
      .every(({ sessionId }, index) => compare(values[index]?.sessionId ?? "", sessionId) < 0),
  );
const RestartEvidenceSchema = z
  .strictObject({
    status: z.literal("exact"),
    health: contracts.ObserverHealthSchema.pick({
      status: true,
      pid: true,
      startedAt: true,
      version: true,
      socketPath: true,
    }).required(),
    processIdentity: contracts.ObserverProcessIdentitySchema,
    process: z.strictObject({
      pid: z.number().int().positive(),
      argv: z.array(z.string().min(1)).min(1),
      executablePath: z.string().min(1),
      startToken: z.string().min(1),
      processToken: contracts.ObserverProcessTokenSchema,
      buildVersion: BuildSchema,
      socketPath: z.string().min(1),
      startupTimeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      executableProvenance: z.enum(["exact", "installed-path-replaced"]),
    }),
    recovery: z.strictObject({ status: z.literal("assessed"), selectedHandles: HandlesSchema }),
  })
  .refine(
    ({ health, processIdentity: identity, process }) =>
      new Set([health.pid, identity.pid, process.pid]).size === 1 &&
      new Set([health.version, identity.version, process.buildVersion]).size === 1 &&
      new Set([health.socketPath, identity.socketPath, process.socketPath]).size === 1 &&
      identity.osStartTime === process.startToken &&
      identity.processToken === process.processToken,
  );
const CommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("start-if-absent"),
    targetSelector: BuildSchema,
    deadlineMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expected: z.strictObject({ status: z.literal("absent") }),
  }),
  z.strictObject({
    action: z.literal("restart-exact"),
    targetSelector: BuildSchema,
    deadlineMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expected: RestartEvidenceSchema,
  }),
]);

/** Complete current-process evidence required to authorize an exact restart. */
export type ExactObserverRestartEvidence = z.infer<typeof RestartEvidenceSchema>;
/** Current-only in-process request for exact Observer convergence. */
export type ExactObserverConvergenceCommand = z.infer<typeof CommandSchema>;

type ExactEvidence = Extract<ExactObserverOwnershipEvidence, { status: "exact" }>;
type ParseContext = { targetSelector: string; nowMs: number };
type HealthIdentity = Readonly<ExactObserverRestartEvidence["health"]>;
type SessionRequest = Readonly<{ health: HealthIdentity; deadlineMs: number }>;
type ExactObserverLifecycleSession = {
  health(): Promise<contracts.ObserverHealth>;
  getSessionRecoveryAssessment(): Promise<contracts.ObserverRecoveryAssessment>;
  stop(): Promise<contracts.ObserverStopReceipt>;
};
/**
 * DRIVEN PORT
 *
 * Keeps exact lifecycle reads and cooperative stop on one identity-pinned connection.
 */
export type ExactObserverLifecycleSessionCapability = <T>(
  request: SessionRequest,
  task: (session: ExactObserverLifecycleSession) => Promise<T>,
) => Promise<T>;
/** Application-owned evidence, startup, and pinned-session ports for exact convergence. */
export type ExactObserverConvergenceDependencies = {
  paths: ObserverPaths;
  targetSelector: string;
  inspect: (session?: ExactObserverLifecycleSession) => Promise<ExactObserverOwnershipEvidence>;
  start: () => Promise<processTypes.ObserverStatus>;
  withSession: ExactObserverLifecycleSessionCapability;
};

/** Strictly parses and clones a current command before convergence performs any async work. */
export function parseExactObserverConvergenceCommand(input: unknown, context: ParseContext) {
  const parsed = CommandSchema.safeParse(input);
  if (!parsed.success) throw cause("COMMAND_INVALID");
  if (parsed.data.targetSelector !== context.targetSelector) throw cause("COMMAND_INVALID");
  if (parsed.data.deadlineMs <= context.nowMs) throw cause("DEADLINE_EXCEEDED");
  return parsed.data;
}

/**
 * USE CASE
 *
 * Converges exact absence or one revalidated owner and requires an independent final proof.
 */
export async function convergeExactObserverBuild(
  input: unknown,
  deps: ExactObserverConvergenceDependencies,
): Promise<processTypes.ExactObserverBuildStatus> {
  let command: ExactObserverConvergenceCommand | undefined;
  try {
    command = parseExactObserverConvergenceCommand(input, {
      targetSelector: deps.targetSelector,
      nowMs: Date.now(),
    });
    return await converge(command, deps);
  } catch (error) {
    if (command?.deadlineMs !== undefined && command.deadlineMs <= Date.now())
      return fail(deps, "inspection", "unknown", cause("DEADLINE_EXCEEDED"));
    return fail(deps, "inspection", "unknown", error);
  }
}

/**
 * COMPOSITION ROOT
 *
 * Preserves standalone exact reuse while wiring local adapters into exact convergence.
 */
export async function ensureExactObserverBuild(
  options: processTypes.ObserverProcessOptions = {},
  processDeps: processTypes.ObserverProcessDeps = {},
): Promise<processTypes.ExactObserverBuildStatus> {
  const paths = options.paths ?? resolveObserverPaths(options.config);
  const targetSelector = processDeps.buildVersion ?? runtime.stationObserverBuildVersion();
  const deadlineMs = Date.now() + (options.timeoutMs ?? 10_000);
  const exactOptions = { ...options, paths, startupDeadlineMs: deadlineMs };
  const deps: ExactObserverConvergenceDependencies = {
    paths,
    targetSelector,
    inspect: (session) => inspectExactObserverOwnerWithLocalAdapters(exactOptions, {}, session),
    start: () => lifecycle.startObserverPreservingIncumbent(exactOptions, processDeps),
    withSession: ({ health, deadlineMs }, task) =>
      protocol.withExactObserverLifecycleSession(
        { socketPath: paths.socketPath, expectedObserverIdentity: health, deadlineMs },
        task,
      ),
  };
  let initial: ExactObserverOwnershipEvidence;
  try {
    initial = await beforeDeadline(deadlineMs, deps.inspect);
  } catch (error) {
    const failure = deadlineMs <= Date.now() ? cause("DEADLINE_EXCEEDED") : error;
    return fail(deps, "inspection", "unknown", failure);
  }
  if (initial.status === "exact" && initial.health.version === targetSelector)
    return success(deps, initial, "reused");
  const start: ExactObserverConvergenceCommand = {
    action: "start-if-absent",
    targetSelector,
    deadlineMs,
    expected: { status: "absent" },
  };
  if (initial.status === "blocked" && initial.reason === "stale-socket")
    return converge(start, deps, true);
  if (initial.status === "absent") return convergeExactObserverBuild(start, deps);
  if (initial.status === "blocked")
    return fail(deps, "inspection", "unknown", inspectionFailure(initial));
  if (initial.recovery.status === "unknown")
    return fail(deps, "inspection", "unknown", initial.recovery.error);
  return convergeExactObserverBuild(
    { action: "restart-exact", targetSelector, deadlineMs, expected: project(initial) },
    deps,
  );
}

async function converge(
  command: ExactObserverConvergenceCommand,
  deps: ExactObserverConvergenceDependencies,
  staleStart = false,
) {
  const failed: Parameters<typeof lifecycle.exactBuildActivationFailure>[1] = {
    phase: "verification",
    incumbentDisposition: command.action === "restart-exact" ? "stopped" : "none",
    error: cause("TARGET_MISMATCH"),
  };
  let start = staleStart;
  const expected = command.action === "restart-exact" ? command.expected : undefined;

  if (command.action === "start-if-absent" && !staleStart) {
    const current = await beforeDeadline(command.deadlineMs, deps.inspect);
    if (current.status === "absent") start = true;
    else if (current.status === "exact") {
      if (current.recovery.status === "unknown")
        return fail(deps, "inspection", "unknown", current.recovery.error);
      if (current.health.version !== command.targetSelector)
        return fail(deps, "inspection", "preserved", cause("EVIDENCE_DRIFT"));
      failed.incumbentDisposition = "unknown";
    } else return fail(deps, "inspection", "unknown", inspectionFailure(current));
  }

  if (command.action === "restart-exact") {
    const evidenceDrift = cause("EVIDENCE_DRIFT");
    try {
      const request = { health: { ...command.expected.health }, deadlineMs: command.deadlineMs };
      await deps.withSession(request, async (session) => {
        const current = await beforeDeadline(command.deadlineMs, () => deps.inspect(session));
        if (!matches(current, command.expected)) throw evidenceDrift;
        await session.stop();
      });
      start = true;
    } catch (error) {
      failed.phase = "stop";
      failed.incumbentDisposition = "unknown";
      const refusal = error === evidenceDrift ? evidenceDrift : cause("STOP_UNCERTAIN");
      failed.error = command.deadlineMs <= Date.now() ? cause("DEADLINE_EXCEEDED") : refusal;
    }
  }

  if (start) {
    try {
      const result = await beforeDeadline(command.deadlineMs, deps.start);
      if (result.status !== "running") {
        Object.assign(failed, result, {
          phase: "start",
          error: result.error ?? cause("TARGET_MISMATCH"),
        });
      }
    } catch (error) {
      failed.phase = "start";
      failed.error = command.deadlineMs <= Date.now() ? cause("DEADLINE_EXCEEDED") : error;
    }
  }

  try {
    const final = await beforeDeadline(command.deadlineMs, deps.inspect);
    if (
      final.status === "exact" &&
      final.health.version === command.targetSelector &&
      !samePhysicalGeneration(final, expected)
    )
      return success(deps, final, command.action === "restart-exact" ? "replaced" : "started");
    if (final.status === "blocked") failed.error = inspectionFailure(final);
  } catch (error) {
    failed.error = command.deadlineMs <= Date.now() ? cause("DEADLINE_EXCEEDED") : error;
  }
  return lifecycle.exactBuildActivationFailure(deps.paths, failed);
}

function matches(value: ExactObserverOwnershipEvidence, expected: ExactObserverRestartEvidence) {
  if (value.status !== "exact" || value.recovery.status !== "assessed") return false;
  return (
    value.health.status === expected.health.status &&
    value.health.pid === expected.health.pid &&
    value.health.startedAt === expected.health.startedAt &&
    value.health.version === expected.health.version &&
    value.health.socketPath === expected.health.socketPath &&
    observer.observerProcessIdentitiesMatch(value.processIdentity, expected.processIdentity) &&
    observer.observerProcessEntriesMatch(value.process, expected.process) &&
    value.process.executableProvenance === expected.process.executableProvenance &&
    JSON.stringify(selectedHandles(value)) === JSON.stringify(expected.recovery.selectedHandles)
  );
}

const samePhysicalGeneration = (value: ExactEvidence, expected?: ExactObserverRestartEvidence) =>
  expected !== undefined &&
  observer.observerProcessIdentitiesMatch(value.processIdentity, expected.processIdentity);

function project(value: ExactEvidence): ExactObserverRestartEvidence {
  const { status, pid, startedAt, version, socketPath } = value.health;
  return {
    status: "exact",
    health: { status, pid, startedAt, version, socketPath },
    processIdentity: value.processIdentity,
    process: value.process,
    recovery: { status: "assessed", selectedHandles: selectedHandles(value) },
  };
}

function selectedHandles(value: ExactEvidence) {
  if (value.recovery.status !== "assessed") return [];
  const handles = value.recovery.assessment.sessions.flatMap(({ sessionId, handleResolution }) =>
    handleResolution.kind === "selected"
      ? [{ sessionId, selectedHandleId: handleResolution.selectedHandleId }]
      : [],
  );
  return handles.sort((left, right) => compare(left.sessionId, right.sessionId));
}

const success = (
  deps: ExactObserverConvergenceDependencies,
  value: ExactEvidence,
  lifecycle: "reused" | "started" | "replaced",
) => ({ status: "running" as const, paths: deps.paths, health: value.health, lifecycle });

function fail(
  deps: ExactObserverConvergenceDependencies,
  phase: processTypes.ExactObserverActivationPhase,
  incumbentDisposition: processTypes.ExactObserverIncumbentDisposition,
  error: unknown,
) {
  return lifecycle.exactBuildActivationFailure(deps.paths, { phase, incumbentDisposition, error });
}

function inspectionFailure(value: Extract<ExactObserverOwnershipEvidence, { status: "blocked" }>) {
  return value.error ?? cause(`INSPECTION_${value.reason.replaceAll("-", "_").toUpperCase()}`);
}

async function beforeDeadline<T>(deadlineMs: number, task: () => Promise<T>): Promise<T> {
  if (deadlineMs <= Date.now()) throw cause("DEADLINE_EXCEEDED");
  const result = await task();
  if (deadlineMs <= Date.now()) throw cause("DEADLINE_EXCEEDED");
  return result;
}
