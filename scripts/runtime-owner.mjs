#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const SCHEMA_VERSION = 1;
const OWNER_DIRECTORY_NAME = "runtime-owners";
const OWNER_DIRECTORY_VERSION = "v1";
const TERM_GRACE_MS = 3_000;
const KILL_CONFIRM_MS = 2_000;
const STARTUP_LOCK_TIMEOUT_MS = 10_000;
const HELPER_READY_TIMEOUT_MS = 5_000;
const POLL_MS = 50;
const runtimeOwnerScriptPath = fileURLToPath(import.meta.url);

const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, "Expected an absolute path.");
const ProcessStartIdentitySchema = z.string().min(1);
const RuntimeRoleSchema = z.enum(["native-hmr", "setup-guided-e2e", "binary-smoke"]);
const UiRunIdSchema = z.string().regex(/^ui_[0-9a-f-]{36}$/i);
const CorrelationSchema = z
  .object({
    traceId: z.string().min(1),
    spanId: z.string().min(1),
    uiRunId: UiRunIdSchema.optional(),
  })
  .strict();
const SurvivorPolicySchema = z.literal("preserve-persistent-station-runtime");
const FileIdentitySchema = z
  .object({
    path: AbsolutePathSchema,
    device: z.string().min(1),
    inode: z.string().min(1),
  })
  .strict();
const ProcessIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    pgid: z.number().int().positive(),
    osStartTime: ProcessStartIdentitySchema,
    processToken: z.uuid(),
    executable: FileIdentitySchema,
    script: FileIdentitySchema,
  })
  .strict();
const RuntimePhaseSchema = z.enum([
  "registered",
  "starting",
  "running",
  "shutdown-requested",
  "cleaning",
  "cleanup-refused",
  "cleanup-failed",
  "retiring",
]);
const ShutdownReasonSchema = z.enum([
  "normal-exit",
  "startup-failure",
  "signal",
  "terminal-loss",
  "orphan-recovery",
]);
const RuntimeStateSchema = z
  .object({
    phase: RuntimePhaseSchema,
    reason: ShutdownReasonSchema.optional(),
    signal: z.enum(["SIGINT", "SIGTERM", "SIGHUP"]).optional(),
    refusalCode: z.string().min(1).optional(),
  })
  .strict();

export const DisposableRuntimeOwnerRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    generation: z.number().int().nonnegative(),
    runtimeId: z.string().regex(/^run_[0-9a-f-]{36}$/i),
    role: RuntimeRoleSchema,
    disposition: z.literal("disposable"),
    runtimeKey: z.string().regex(/^[0-9a-f]{64}$/),
    launchKey: z.string().regex(/^[0-9a-f]{64}$/),
    checkout: z
      .object({
        root: AbsolutePathSchema,
        key: z.string().regex(/^[0-9a-f]{64}$/),
        device: z.string().min(1),
        inode: z.string().min(1),
      })
      .strict(),
    recordRoot: AbsolutePathSchema,
    owner: ProcessIdentitySchema,
    processGroup: ProcessIdentitySchema.optional(),
    correlation: CorrelationSchema,
    socketRoots: z.array(AbsolutePathSchema),
    persistenceRoots: z.array(AbsolutePathSchema).min(1),
    cleanupRoots: z.array(FileIdentitySchema).optional(),
    survivorPolicy: SurvivorPolicySchema,
    state: RuntimeStateSchema,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.state.phase === "registered" && record.processGroup !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Registered records cannot name a process group.",
      });
    }
    if (record.state.phase !== "registered" && record.processGroup === undefined) {
      context.addIssue({
        code: "custom",
        message: "Process-bearing records require a process group.",
      });
    }
  });

const RuntimeLifecycleEventNameSchema = z.enum([
  "runtime.owner.registered",
  "runtime.process.started",
  "runtime.shutdown.requested",
  "runtime.cleanup.started",
  "runtime.cleanup.escalated",
  "runtime.cleanup.completed",
  "runtime.cleanup.refused",
  "runtime.cleanup.failed",
  "runtime.orphan.detected",
  "runtime.orphan.recovered",
  "runtime.owner.retired",
]);

export const RuntimeLifecycleEventSchema = z
  .object({
    timestamp: z.iso.datetime({ offset: true }),
    level: z.enum(["info", "warn", "error"]),
    component: z.literal("cli"),
    message: RuntimeLifecycleEventNameSchema,
    traceId: z.string().min(1),
    spanId: z.string().min(1),
    attributes: z
      .object({
        runtimeId: z.string().regex(/^run_[0-9a-f-]{36}$/i),
        role: RuntimeRoleSchema,
        disposition: z.literal("disposable"),
        runtimeKey: z.string().regex(/^[0-9a-f]{64}$/),
        checkoutKey: z.string().regex(/^[0-9a-f]{64}$/),
        socketRootsKey: z.string().regex(/^[0-9a-f]{64}$/),
        persistenceRootsKey: z.string().regex(/^[0-9a-f]{64}$/),
        survivorPolicy: SurvivorPolicySchema,
        ownerPid: z.number().int().positive(),
        ownerStartTime: ProcessStartIdentitySchema,
        uiRunId: UiRunIdSchema.optional(),
        groupLeaderPid: z.number().int().positive().optional(),
        pgid: z.number().int().positive().optional(),
        groupStartTime: ProcessStartIdentitySchema.optional(),
        reason: ShutdownReasonSchema.optional(),
        signal: z.enum(["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"]).optional(),
        durationMs: z.number().int().nonnegative().optional(),
        memberCount: z.number().int().nonnegative().optional(),
        refusalCode: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

const RuntimeOwnerLockSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    runtimeKey: z.string().regex(/^[0-9a-f]{64}$/),
    token: z.uuid(),
    ownerPid: z.number().int().positive(),
    ownerStartTime: ProcessStartIdentitySchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const LaunchStepSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()),
  })
  .strict();
const LaunchPlanSchema = z
  .object({
    cwd: AbsolutePathSchema,
    steps: z.array(LaunchStepSchema).min(1),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
const OwnedRuntimeInputSchema = z
  .object({
    role: RuntimeRoleSchema,
    checkoutRoot: AbsolutePathSchema,
    stateDir: AbsolutePathSchema,
    socketRoots: z.array(AbsolutePathSchema),
    persistenceRoots: z.array(AbsolutePathSchema).min(1),
    cleanupRoots: z.array(FileIdentitySchema).optional(),
    survivorPolicy: SurvivorPolicySchema,
    terminalKey: z.string().min(1),
    recoveryKey: z.string().min(1).optional(),
    correlation: CorrelationSchema,
    launch: LaunchPlanSchema,
  })
  .strict();
const OwnedRuntimeChildInputSchema = z
  .object({
    role: RuntimeRoleSchema,
    stateDir: AbsolutePathSchema,
    runtimeId: z.string().regex(/^run_[0-9a-f-]{36}$/i),
  })
  .strict();

export class RuntimeOwnerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "RuntimeOwnerError";
    this.code = code;
  }
}

/** Return the durable private directory used to recover disposable script runtimes. */
export function runtimeOwnerRecordDirectory(stateDir) {
  return join(resolve(stateDir), "run", OWNER_DIRECTORY_NAME, OWNER_DIRECTORY_VERSION);
}

/** Verify that the current process belongs to the exact active runtime owner record. */
export async function assertOwnedDisposableRuntimeChild(rawInput) {
  try {
    const input = OwnedRuntimeChildInputSchema.parse(rawInput);
    const record = await readValidatedRecord(
      recordPath(runtimeOwnerRecordDirectory(input.stateDir), input.runtimeId),
    );
    if (
      record.role !== input.role ||
      !["starting", "running"].includes(record.state.phase) ||
      record.processGroup === undefined
    ) {
      throw new Error("The active owner record does not match this child.");
    }
    const group = await inspectGroupIdentity(record.processGroup, record.runtimeId);
    if (
      group.kind !== "exact" ||
      !group.members.includes(process.pid) ||
      processGroupId(process.pid) !== record.processGroup.pgid
    ) {
      throw new Error("The current process is outside the recorded process group.");
    }
    return { runtimeId: record.runtimeId };
  } catch (cause) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_CHILD_UNCORROBORATED",
      "The disposable runtime child is not corroborated by an active exact owner record.",
      { cause },
    );
  }
}

/**
 * Register, launch, await, and exactly reap one disposable process group.
 * Durable registration precedes work spawn; stable recovery can carry identity-pinned cleanup
 * roots across repeated owner loss for caller-controlled deletion.
 */
export async function runOwnedDisposableRuntime(rawInput) {
  assertSupportedPlatform();
  const input = OwnedRuntimeInputSchema.parse(rawInput);
  const context = await createRuntimeContext(input);
  await ensurePrivateDirectory(context.recordDirectory);
  const emitter = createLifecycleEmitter(context.logPath);
  const signals = createSignalWaiter();
  let lock;
  let record;
  let helper;
  let helperMessages;
  let started = false;
  let cleanupRoots = [];

  try {
    lock = await acquireRuntimeLock(context, signals);
    const recoveredRoots = await recoverMatchingOrphans(context, emitter);
    if (signals.signal !== undefined) {
      return interruptedResult(
        context.runtimeId,
        input.correlation.uiRunId,
        signals.signal,
        recoveredRoots,
      );
    }

    record = await createInitialRecord(context, recoveredRoots);
    cleanupRoots = record.cleanupRoots ?? [];
    await emitLifecycle(emitter, record, "runtime.owner.registered", "info");

    if (signals.signal !== undefined) {
      record = await setRecordState(record, { phase: "retiring" });
      await retireRecord(record);
      await emitLifecycle(emitter, record, "runtime.owner.retired", "info");
      return interruptedResult(
        context.runtimeId,
        input.correlation.uiRunId,
        signals.signal,
        cleanupRoots,
      );
    }

    const spawned = spawnOwnedHelper(record);
    helper = spawned.child;
    helperMessages = spawned.messages;
    const ready = await waitForHelperReady(helperMessages, helper);
    const groupIdentity = await captureHelperIdentity(helper.pid, record.runtimeId, spawned.token);
    if (ready.pid !== groupIdentity.pid || ready.pgid !== groupIdentity.pgid) {
      throw new RuntimeOwnerError(
        "RUNTIME_OWNER_HELPER_IDENTITY_CHANGED",
        "The disposable runtime helper changed identity before registration completed.",
      );
    }
    record = await setRecordState(record, { phase: "starting" }, groupIdentity);
    if (signals.signal !== undefined) {
      record = await requestRecordShutdown(
        record,
        emitter,
        signalReason(signals.signal),
        signals.signal,
      );
      const cleanup = await cleanupRecordedGroup(record, emitter);
      if (!cleanup.completed) {
        throw new RuntimeOwnerError(
          cleanup.code,
          "Interrupted runtime startup could not be cleaned.",
        );
      }
      return interruptedResult(
        context.runtimeId,
        input.correlation.uiRunId,
        signals.signal,
        cleanupRoots,
      );
    }

    // The helper remains gated until its exact group identity is durably published.
    await sendHelperLaunch(helper, input.launch);

    let outcome;
    for (;;) {
      const next = await Promise.race([
        helperMessages.next(),
        signals.promise.then((signal) => ({ kind: "owner-signal", signal })),
      ]);
      if (next.kind === "owner-signal") {
        outcome = {
          reason: signalReason(next.signal),
          signal: next.signal,
          exitCode: signalExitCode(next.signal),
        };
        break;
      }
      if (next.kind === "started") {
        if (!started) {
          started = true;
          record = await setRecordState(record, { phase: "running" });
          await emitLifecycle(emitter, record, "runtime.process.started", "info");
          await releaseRuntimeLock(lock);
          lock = undefined;
        }
        continue;
      }
      if (next.kind === "completed") {
        outcome = {
          reason: next.startupFailed ? "startup-failure" : "normal-exit",
          exitCode: next.exitCode,
          ...(next.signal === undefined ? {} : { childSignal: next.signal }),
        };
        break;
      }
      if (next.kind === "closed") {
        outcome = {
          reason: started ? "normal-exit" : "startup-failure",
          exitCode: next.exitCode ?? signalExitCode(next.signal),
          ...(next.signal === null ? {} : { childSignal: next.signal }),
        };
        break;
      }
      if (next.kind === "error") {
        throw next.error;
      }
    }

    if (lock !== undefined) {
      await releaseRuntimeLock(lock);
      lock = undefined;
    }
    const cleanupSignal = "signal" in outcome ? outcome.signal : undefined;
    record = await requestRecordShutdown(record, emitter, outcome.reason, cleanupSignal);
    const cleanup = await cleanupRecordedGroup(record, emitter);
    if (!cleanup.completed) {
      throw new RuntimeOwnerError(
        cleanup.code,
        "Disposable runtime cleanup was refused or failed.",
      );
    }
    const resultSignal = outcome.signal ?? outcome.childSignal;
    return {
      runtimeId: context.runtimeId,
      ...(input.correlation.uiRunId === undefined ? {} : { uiRunId: input.correlation.uiRunId }),
      exitCode: outcome.exitCode,
      ...(resultSignal === undefined ? {} : { signal: resultSignal }),
      ...(cleanupRoots.length === 0 ? {} : { cleanupRoots }),
    };
  } catch (cause) {
    if (
      cause instanceof RuntimeOwnerError &&
      cause.code === "RUNTIME_OWNER_INTERRUPTED" &&
      signals.signal !== undefined
    ) {
      return interruptedResult(
        context.runtimeId,
        input.correlation.uiRunId,
        signals.signal,
        cleanupRoots,
      );
    }
    if (record !== undefined && record.processGroup !== undefined) {
      try {
        record = await requestRecordShutdown(record, emitter, "startup-failure");
        await cleanupRecordedGroup(record, emitter);
      } catch {
        // The original failure remains authoritative; the strict record is retained for recovery.
      }
    } else if (record !== undefined) {
      try {
        if (helper !== undefined) await stopGatedHelper(helper);
        record = await setRecordState(record, { phase: "retiring" });
        await retireRecord(record);
        await emitLifecycle(emitter, record, "runtime.owner.retired", "info");
      } catch {
        // An uncertain record is intentionally retained for the next exact recovery attempt.
      }
    } else if (helper?.pid !== undefined) {
      await stopGatedHelper(helper);
    }
    throw cause;
  } finally {
    signals.dispose();
    if (lock !== undefined) {
      await releaseRuntimeLock(lock).catch(() => {});
    }
    helperMessages?.dispose();
  }
}

async function createRuntimeContext(input) {
  const checkoutRoot = await realpath(input.checkoutRoot);
  const checkoutStat = await stat(checkoutRoot);
  const ownerStartTime = processStartIdentity(process.pid);
  if (ownerStartTime === undefined) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_IDENTITY_UNAVAILABLE",
      "Could not establish the disposable runtime owner's OS start identity.",
    );
  }
  const ownerPgid = processGroupId(process.pid);
  if (ownerPgid === undefined) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_IDENTITY_UNAVAILABLE",
      "Could not establish the disposable runtime owner's process group.",
    );
  }
  const hash = (...values) =>
    createHash("sha256")
      .update(values.map((value) => String(value)).join("\0"))
      .digest("hex");
  const checkoutKey = hash(checkoutRoot, checkoutStat.dev, checkoutStat.ino);
  const runtimeKey = hash(
    input.role,
    checkoutKey,
    resolve(input.stateDir),
    ...(input.recoveryKey === undefined
      ? [
          ...input.socketRoots.map((path) => resolve(path)).sort(),
          ...input.persistenceRoots.map((path) => resolve(path)).sort(),
        ]
      : [input.recoveryKey]),
  );
  const cleanupRoots = [];
  for (const expected of input.cleanupRoots ?? []) {
    const actual = await fileIdentity(expected.path);
    const metadata = await lstat(expected.path);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !fileIdentityMatches(actual, expected)
    ) {
      throw new RuntimeOwnerError(
        "RUNTIME_OWNER_CLEANUP_ROOT_CHANGED",
        "A disposable runtime cleanup root changed before registration.",
      );
    }
    cleanupRoots.push(actual);
  }
  return {
    input,
    runtimeId: `run_${randomUUID()}`,
    runtimeKey,
    launchKey: hash(runtimeKey, input.terminalKey),
    checkout: {
      root: checkoutRoot,
      key: checkoutKey,
      device: String(checkoutStat.dev),
      inode: String(checkoutStat.ino),
    },
    owner: {
      pid: process.pid,
      pgid: ownerPgid,
      osStartTime: ownerStartTime,
      processToken: randomUUID(),
      executable: await fileIdentity(process.execPath),
      script: await fileIdentity(ownerScriptPath()),
    },
    recordDirectory: runtimeOwnerRecordDirectory(input.stateDir),
    logPath: join(input.stateDir, "logs", "cli.jsonl"),
    cleanupRoots,
    hash,
  };
}

async function createInitialRecord(context, recoveredRoots) {
  const timestamp = new Date().toISOString();
  const record = DisposableRuntimeOwnerRecordSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    generation: 0,
    runtimeId: context.runtimeId,
    role: context.input.role,
    disposition: "disposable",
    runtimeKey: context.runtimeKey,
    launchKey: context.launchKey,
    checkout: context.checkout,
    recordRoot: context.recordDirectory,
    owner: context.owner,
    correlation: context.input.correlation,
    socketRoots: context.input.socketRoots.map((path) => resolve(path)),
    persistenceRoots: context.input.persistenceRoots.map((path) => resolve(path)),
    ...(context.cleanupRoots.length === 0 && recoveredRoots.length === 0
      ? {}
      : { cleanupRoots: uniqueFileIdentities([...recoveredRoots, ...context.cleanupRoots]) }),
    survivorPolicy: context.input.survivorPolicy,
    state: { phase: "registered" },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await publishNewJson(recordPath(context.recordDirectory, record.runtimeId), record);
  return record;
}

async function setRecordState(record, state, processGroup = record.processGroup) {
  const next = DisposableRuntimeOwnerRecordSchema.parse({
    ...record,
    generation: record.generation + 1,
    ...(processGroup === undefined ? {} : { processGroup }),
    state,
    updatedAt: new Date().toISOString(),
  });
  await replaceJson(recordPathFromRecord(record), record, next);
  return next;
}

async function requestRecordShutdown(record, emitter, reason, signal) {
  const state = {
    phase: "shutdown-requested",
    reason,
    ...(signal === undefined ? {} : { signal }),
  };
  const next = await setRecordState(record, state);
  await emitLifecycle(emitter, next, "runtime.shutdown.requested", "info", {
    reason,
    ...(signal === undefined ? {} : { signal }),
  });
  return next;
}

function spawnOwnedHelper(record) {
  const token = record.processGroup?.processToken ?? randomUUID();
  const child = spawn(
    process.execPath,
    [runtimeOwnerScriptPath, "--runtime-owner-child", record.runtimeId, token],
    {
      detached: true,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    },
  );
  return { child, token, messages: createChildMessageQueue(child) };
}

async function sendHelperLaunch(helper, launch) {
  if (!helper.connected) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_HELPER_DISCONNECTED",
      "The disposable runtime helper disconnected before launch.",
    );
  }
  await new Promise((resolvePromise, reject) => {
    helper.send({ kind: "launch", launch }, (error) => {
      if (error === null) resolvePromise();
      else reject(error);
    });
  });
}

async function waitForHelperReady(messages, child) {
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ kind: "timeout" }), HELPER_READY_TIMEOUT_MS).unref();
  });
  const next = await Promise.race([messages.next(), timeout]);
  if (next.kind === "ready") return next;
  await stopGatedHelper(child);
  if (next.kind === "error") throw next.error;
  throw new RuntimeOwnerError(
    "RUNTIME_OWNER_HELPER_NOT_READY",
    "The disposable runtime helper did not become ready before its deadline.",
  );
}

async function captureHelperIdentity(pid, runtimeId, processToken) {
  if (pid === undefined) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_HELPER_NOT_READY",
      "The helper did not publish a PID.",
    );
  }
  const start = processStartIdentity(pid);
  const pgid = processGroupId(pid);
  if (start === undefined || pgid === undefined || pgid !== pid) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_HELPER_IDENTITY_UNAVAILABLE",
      "The disposable runtime helper did not establish an isolated process group.",
    );
  }
  const identity = {
    pid,
    pgid,
    osStartTime: start,
    processToken,
    executable: await fileIdentity(process.execPath),
    script: await fileIdentity(runtimeOwnerScriptPath),
  };
  const inspection = await inspectGroupIdentity(identity, runtimeId);
  if (inspection.kind !== "exact") {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_HELPER_IDENTITY_UNAVAILABLE",
      "Could not corroborate the disposable runtime helper identity.",
    );
  }
  return identity;
}

async function cleanupRecordedGroup(initialRecord, emitter) {
  const startedAt = Date.now();
  let record = initialRecord;
  try {
    record = await setRecordState(record, {
      phase: "cleaning",
      ...(record.state.reason === undefined ? {} : { reason: record.state.reason }),
      ...(record.state.signal === undefined ? {} : { signal: record.state.signal }),
    });
    await emitLifecycle(emitter, record, "runtime.cleanup.started", "info", {
      ...(record.state.reason === undefined ? {} : { reason: record.state.reason }),
      ...(record.state.signal === undefined ? {} : { signal: record.state.signal }),
    });
    const identity = await inspectGroupIdentity(record.processGroup, record.runtimeId);
    if (identity.kind === "absent") {
      return completeCleanup(record, emitter, startedAt, 0);
    }
    if (identity.kind !== "exact") {
      return refuseCleanup(record, emitter, startedAt, identity.code);
    }
    signalGroup(record.processGroup.pgid, "SIGTERM");
    let members = await waitForGroupExit(record.processGroup.pgid, TERM_GRACE_MS);
    if (members.length === 0) {
      return completeCleanup(record, emitter, startedAt, 0);
    }

    // Escalation uses fresh record and leader evidence so stale ownership can never authorize KILL.
    record = await readExactCurrentRecord(record);
    const revalidated = await inspectGroupIdentity(record.processGroup, record.runtimeId);
    if (revalidated.kind !== "exact") {
      return refuseCleanup(record, emitter, startedAt, revalidated.code);
    }
    await emitLifecycle(emitter, record, "runtime.cleanup.escalated", "warn", {
      signal: "SIGKILL",
      memberCount: members.length,
      durationMs: Date.now() - startedAt,
    });
    signalGroup(record.processGroup.pgid, "SIGKILL");
    members = await waitForGroupExit(record.processGroup.pgid, KILL_CONFIRM_MS);
    if (members.length > 0) {
      record = await setRecordState(record, {
        phase: "cleanup-failed",
        ...(record.state.reason === undefined ? {} : { reason: record.state.reason }),
        refusalCode: "group-survived-sigkill",
      });
      await emitLifecycle(emitter, record, "runtime.cleanup.failed", "error", {
        durationMs: Date.now() - startedAt,
        memberCount: members.length,
        refusalCode: "group-survived-sigkill",
      });
      return { completed: false, code: "RUNTIME_OWNER_GROUP_SURVIVED" };
    }
    return completeCleanup(record, emitter, startedAt, 0);
  } catch (cause) {
    try {
      record = await setRecordState(record, {
        phase: "cleanup-failed",
        ...(record.state.reason === undefined ? {} : { reason: record.state.reason }),
        refusalCode: "cleanup-evidence-unavailable",
      });
      await emitLifecycle(emitter, record, "runtime.cleanup.failed", "error", {
        durationMs: Date.now() - startedAt,
        refusalCode: "cleanup-evidence-unavailable",
      });
    } catch {
      // Retaining the last strict record is safer than replacing uncertain ownership evidence.
    }
    return {
      completed: false,
      code: cause instanceof RuntimeOwnerError ? cause.code : "RUNTIME_OWNER_CLEANUP_FAILED",
    };
  }
}

async function completeCleanup(record, emitter, startedAt, memberCount) {
  await emitLifecycle(emitter, record, "runtime.cleanup.completed", "info", {
    durationMs: Date.now() - startedAt,
    memberCount,
  });
  const retiring = await setRecordState(record, {
    phase: "retiring",
    ...(record.state.reason === undefined ? {} : { reason: record.state.reason }),
  });
  await retireRecord(retiring);
  await emitLifecycle(emitter, retiring, "runtime.owner.retired", "info");
  return { completed: true };
}

async function refuseCleanup(record, emitter, startedAt, refusalCode) {
  let refused = record;
  try {
    refused = await setRecordState(record, {
      phase: "cleanup-refused",
      ...(record.state.reason === undefined ? {} : { reason: record.state.reason }),
      refusalCode,
    });
  } catch {
    // A replaced record must not be overwritten merely to report the refusal.
  }
  await emitLifecycle(emitter, refused, "runtime.cleanup.refused", "warn", {
    durationMs: Date.now() - startedAt,
    refusalCode,
  });
  return { completed: false, code: "RUNTIME_OWNER_CLEANUP_REFUSED" };
}

async function recoverMatchingOrphans(context, emitter) {
  const entries = await listOwnerRecords(context.recordDirectory);
  const cleanupRoots = [];
  for (const entry of entries) {
    const record = await readValidatedRecord(entry);
    if (record.runtimeKey !== context.runtimeKey) continue;
    const ownerState = await inspectOwnerIdentity(record.owner);
    if (ownerState === "exact") {
      if (record.launchKey === context.launchKey) {
        throw new RuntimeOwnerError(
          "RUNTIME_OWNER_ALREADY_ACTIVE",
          "This terminal already has an active disposable native runtime owner.",
        );
      }
      continue;
    }
    if (ownerState !== "absent") {
      throw new RuntimeOwnerError(
        "RUNTIME_OWNER_OWNER_IDENTITY_AMBIGUOUS",
        "A prior runtime owner PID was reused or could not be verified.",
      );
    }
    await emitLifecycle(emitter, record, "runtime.orphan.detected", "warn");
    if (record.processGroup === undefined) {
      const retiring = await setRecordState(record, { phase: "retiring" });
      await retireRecord(retiring);
      await emitLifecycle(emitter, retiring, "runtime.owner.retired", "info");
      cleanupRoots.push(...(record.cleanupRoots ?? []));
      continue;
    }
    const requested = await requestRecordShutdown(record, emitter, "orphan-recovery");
    const cleanup = await cleanupRecordedGroup(requested, emitter);
    if (!cleanup.completed) {
      throw new RuntimeOwnerError(
        cleanup.code,
        "An exact prior disposable runtime could not be recovered.",
      );
    }
    await emitLifecycle(emitter, requested, "runtime.orphan.recovered", "info");
    cleanupRoots.push(...(record.cleanupRoots ?? []));
  }
  return uniqueFileIdentities(cleanupRoots);
}

function uniqueFileIdentities(identities) {
  return [
    ...new Map(
      identities.map((identity) => [
        `${identity.path}\0${identity.device}\0${identity.inode}`,
        identity,
      ]),
    ).values(),
  ];
}

async function inspectOwnerIdentity(identity) {
  const startState = inspectProcessStart(identity.pid, identity.osStartTime);
  if (startState !== "exact") return startState;
  if (processGroupId(identity.pid) !== identity.pgid) return "changed";
  try {
    if (!(await ownerCommandMatches(identity))) return "changed";
    if (!(await executableMatches(identity))) return "changed";
  } catch {
    return "unavailable";
  }
  return "exact";
}

async function ownerCommandMatches(identity) {
  if (process.platform === "linux") {
    const argv = await readProcessArgv(identity.pid);
    if (argv[1] === undefined) return false;
    return (await realpath(argv[1])) === identity.script.path;
  }
  const command = psField(identity.pid, "command");
  return command?.includes(identity.script.path) === true;
}

async function inspectGroupIdentity(identity, runtimeId) {
  let members;
  try {
    members = listGroupPids(identity.pgid);
  } catch {
    return { kind: "unavailable", code: "process-list-unavailable" };
  }
  if (members.length === 0) return { kind: "absent" };
  const startState = inspectProcessStart(identity.pid, identity.osStartTime);
  if (startState === "absent") return { kind: "changed", code: "group-leader-absent" };
  if (startState !== "exact") return { kind: "changed", code: "group-leader-changed" };
  if (processGroupId(identity.pid) !== identity.pgid || identity.pid !== identity.pgid) {
    return { kind: "changed", code: "process-group-changed" };
  }
  try {
    if (!(await helperCommandMatches(identity, runtimeId))) {
      return { kind: "changed", code: "helper-command-changed" };
    }
    if (!(await executableMatches(identity))) {
      return { kind: "changed", code: "helper-executable-changed" };
    }
  } catch {
    return { kind: "unavailable", code: "process-evidence-unavailable" };
  }
  return { kind: "exact", members };
}

async function helperCommandMatches(identity, runtimeId) {
  if (process.platform === "linux") {
    const argv = await readProcessArgv(identity.pid);
    if (
      argv.length !== 5 ||
      argv[1] === undefined ||
      argv[2] !== "--runtime-owner-child" ||
      argv[3] !== runtimeId ||
      argv[4] !== identity.processToken
    ) {
      return false;
    }
    return (await realpath(argv[1])) === identity.script.path;
  }
  const command = psField(identity.pid, "command");
  return (
    command?.includes(identity.script.path) === true &&
    command.includes("--runtime-owner-child") &&
    command.includes(runtimeId) &&
    command.includes(identity.processToken)
  );
}

async function readProcessArgv(pid) {
  const source = await readFile(`/proc/${pid}/cmdline`);
  return source
    .toString("utf8")
    .split("\0")
    .filter((value) => value.length > 0);
}

async function executableMatches(identity) {
  if (process.platform === "linux") {
    return fileIdentityMatches(
      await fileIdentity(`/proc/${identity.pid}/exe`),
      identity.executable,
    );
  }
  const result = spawnSync(
    "/usr/sbin/lsof",
    ["-a", "-p", String(identity.pid), "-d", "txt", "-Fn"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) throw new Error("lsof evidence unavailable");
  const paths = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
  if (paths.length === 0) throw new Error("lsof executable evidence unavailable");
  for (const path of paths) {
    try {
      if (fileIdentityMatches(await fileIdentity(path), identity.executable)) return true;
    } catch {
      // Every reported text image must remain non-authoritative unless one exactly matches.
    }
  }
  return false;
}

function fileIdentityMatches(actual, expected) {
  return (
    actual.path === expected.path &&
    actual.device === expected.device &&
    actual.inode === expected.inode
  );
}

function inspectProcessStart(pid, expected) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return "absent";
    return "unavailable";
  }
  const actual = processStartIdentity(pid);
  if (actual === undefined) return "unavailable";
  return actual === expected ? "exact" : "changed";
}

function processStartIdentity(pid) {
  if (process.platform === "linux") {
    try {
      const result = spawnSync("/bin/cat", [`/proc/${pid}/stat`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.status !== 0) return undefined;
      const close = result.stdout.lastIndexOf(")");
      const fields = result.stdout
        .slice(close + 2)
        .trim()
        .split(/\s+/u);
      const startTicks = fields[19];
      return startTicks === undefined ? undefined : `linux:${startTicks}`;
    } catch {
      return undefined;
    }
  }
  const value = psField(pid, "lstart");
  return value === undefined ? undefined : `darwin:${value}`;
}

function processGroupId(pid) {
  const value = psField(pid, "pgid");
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  return Number(value);
}

function psField(pid, field) {
  const ps = process.platform === "darwin" ? "/bin/ps" : "/bin/ps";
  const result = spawnSync(ps, ["-ww", "-p", String(pid), "-o", `${field}=`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length === 0 ? undefined : value;
}

function listGroupPids(pgid) {
  const result = spawnSync("/bin/ps", ["-ax", "-o", "pid=,pgid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) throw new Error("process list unavailable");
  const pids = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (match !== null && Number(match[2]) === pgid) pids.push(Number(match[1]));
  }
  return pids;
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw new RuntimeOwnerError(
        "RUNTIME_OWNER_SIGNAL_REFUSED",
        `Could not signal the owned process group with ${signal}.`,
        { cause: error },
      );
    }
  }
}

async function waitForGroupExit(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const members = listGroupPids(pgid);
    if (members.length === 0 || Date.now() >= deadline) return members;
    await sleep(POLL_MS);
  }
}

async function readExactCurrentRecord(expected) {
  const current = await readValidatedRecord(recordPathFromRecord(expected));
  if (
    current.runtimeId !== expected.runtimeId ||
    current.owner.processToken !== expected.owner.processToken ||
    current.generation !== expected.generation
  ) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_RECORD_REPLACED",
      "The disposable runtime owner record changed unexpectedly.",
    );
  }
  return current;
}

async function acquireRuntimeLock(context, signals) {
  const path = join(context.recordDirectory, `${context.runtimeKey}.lock`);
  const deadline = Date.now() + STARTUP_LOCK_TIMEOUT_MS;
  for (;;) {
    if (signals.signal !== undefined) {
      throw new RuntimeOwnerError(
        "RUNTIME_OWNER_INTERRUPTED",
        "Runtime ownership was interrupted before startup.",
      );
    }
    const lock = RuntimeOwnerLockSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      runtimeKey: context.runtimeKey,
      token: randomUUID(),
      ownerPid: process.pid,
      ownerStartTime: context.owner.osStartTime,
      createdAt: new Date().toISOString(),
    });
    try {
      await publishNewJson(path, lock);
      return { path, lock };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const current = await readSecureJson(path, RuntimeOwnerLockSchema);
    const ownerState = inspectProcessStart(current.ownerPid, current.ownerStartTime);
    if (ownerState === "absent") {
      const reread = await readSecureJson(path, RuntimeOwnerLockSchema);
      if (reread.token !== current.token) continue;
      await unlink(path);
      continue;
    }
    if (ownerState !== "exact") {
      throw new RuntimeOwnerError(
        "RUNTIME_OWNER_LOCK_AMBIGUOUS",
        "The disposable runtime startup lock has ambiguous owner evidence.",
      );
    }
    if (Date.now() >= deadline) {
      throw new RuntimeOwnerError(
        "RUNTIME_OWNER_LOCK_TIMEOUT",
        "Another disposable runtime startup is still in progress.",
      );
    }
    await sleep(POLL_MS);
  }
}

async function releaseRuntimeLock(handle) {
  const current = await readSecureJson(handle.path, RuntimeOwnerLockSchema);
  if (current.token !== handle.lock.token) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_LOCK_REPLACED",
      "The runtime startup lock was replaced.",
    );
  }
  await unlink(handle.path);
  await syncDirectory(dirname(handle.path));
}

async function listOwnerRecords(directory) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (entry.name.endsWith(".lock") || entry.name.startsWith(".tmp-")) continue;
    if (!entry.isFile() || !/^run_[0-9a-f-]{36}\.json$/iu.test(entry.name)) {
      throw new RuntimeOwnerError(
        "RUNTIME_OWNER_DIRECTORY_AMBIGUOUS",
        "The runtime owner directory contains an unrecognized entry.",
      );
    }
    paths.push(join(directory, entry.name));
  }
  return paths.sort();
}

async function readValidatedRecord(path) {
  const record = await readSecureJson(path, DisposableRuntimeOwnerRecordSchema);
  if (record.recordRoot !== dirname(path)) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_RECORD_MALFORMED",
      "A runtime owner record names a different ownership directory.",
    );
  }
  return record;
}

async function readSecureJson(path, schema) {
  const metadata = await lstat(path);
  const mode = metadata.mode & 0o777;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || mode !== 0o600) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_RECORD_INSECURE",
      "A runtime ownership file is not a private regular file.",
    );
  }
  if (typeof process.geteuid === "function" && metadata.uid !== process.geteuid()) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_RECORD_INSECURE",
      "A runtime ownership file is not owned by the current user.",
    );
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_RECORD_MALFORMED",
      "A runtime owner record is malformed.",
      { cause },
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_RECORD_MALFORMED",
      "A runtime owner record is malformed.",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

async function publishNewJson(path, value) {
  const temporary = join(dirname(path), `.tmp-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await unlink(temporary);
    await syncDirectory(dirname(path));
  } catch (cause) {
    await unlink(temporary).catch(() => {});
    throw cause;
  }
}

async function replaceJson(path, expected, next) {
  await readExactFileRecord(path, expected);
  const temporary = join(dirname(path), `.tmp-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await readExactFileRecord(path, expected);
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(dirname(path));
  } catch (cause) {
    await unlink(temporary).catch(() => {});
    throw cause;
  }
}

async function readExactFileRecord(path, expected) {
  const current = await readValidatedRecord(path);
  if (
    current.runtimeId !== expected.runtimeId ||
    current.owner.processToken !== expected.owner.processToken ||
    current.generation !== expected.generation
  ) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_RECORD_REPLACED",
      "The runtime owner record was replaced.",
    );
  }
  return current;
}

async function retireRecord(record) {
  const path = recordPathFromRecord(record);
  await readExactFileRecord(path, record);
  await unlink(path);
  await syncDirectory(dirname(path));
}

function recordPath(directory, runtimeId) {
  return join(directory, `${runtimeId}.json`);
}

function recordPathFromRecord(record) {
  return recordPath(record.recordRoot, record.runtimeId);
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_DIRECTORY_INSECURE",
      "The runtime owner directory is not a private regular directory.",
    );
  }
  if (typeof process.geteuid === "function" && metadata.uid !== process.geteuid()) {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_DIRECTORY_INSECURE",
      "The runtime owner directory is not owned by the current user.",
    );
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function ownerScriptPath() {
  const candidate = process.argv[1];
  return candidate !== undefined && isAbsolute(candidate) ? candidate : runtimeOwnerScriptPath;
}

async function fileIdentity(path) {
  const canonicalPath = await realpath(path);
  const metadata = await stat(canonicalPath);
  return {
    path: canonicalPath,
    device: String(metadata.dev),
    inode: String(metadata.ino),
  };
}

function createLifecycleEmitter(logPath) {
  let tail = Promise.resolve();
  return async (record) => {
    tail = tail
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
        await appendFile(logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      });
    return tail;
  };
}

async function emitLifecycle(emitter, record, message, level, extra = {}) {
  const processGroup = record.processGroup;
  const attributes = {
    runtimeId: record.runtimeId,
    role: record.role,
    disposition: record.disposition,
    runtimeKey: record.runtimeKey,
    checkoutKey: record.checkout.key,
    socketRootsKey: hashValues(record.socketRoots),
    persistenceRootsKey: hashValues(record.persistenceRoots),
    survivorPolicy: record.survivorPolicy,
    ownerPid: record.owner.pid,
    ownerStartTime: record.owner.osStartTime,
    ...(record.correlation.uiRunId === undefined ? {} : { uiRunId: record.correlation.uiRunId }),
    ...(processGroup === undefined
      ? {}
      : {
          groupLeaderPid: processGroup.pid,
          pgid: processGroup.pgid,
          groupStartTime: processGroup.osStartTime,
        }),
    ...extra,
  };
  const event = RuntimeLifecycleEventSchema.parse({
    timestamp: new Date().toISOString(),
    level,
    component: "cli",
    message,
    traceId: record.correlation.traceId,
    spanId: record.correlation.spanId,
    attributes,
  });
  try {
    await emitter(event);
  } catch {
    // Lifecycle evidence is best-effort and cannot replace exact process cleanup.
  }
}

function hashValues(values) {
  return createHash("sha256")
    .update([...values].sort().join("\0"))
    .digest("hex");
}

function createSignalWaiter() {
  let resolveSignal;
  const promise = new Promise((resolvePromise) => {
    resolveSignal = resolvePromise;
  });
  const state = {
    signal: undefined,
    promise,
    handlers: new Map(),
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      if (state.signal !== undefined) return;
      state.signal = signal;
      resolveSignal(signal);
    };
    state.handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return {
    get signal() {
      return state.signal;
    },
    promise,
    dispose() {
      for (const [signal, handler] of state.handlers) process.off(signal, handler);
    },
  };
}

function createChildMessageQueue(child) {
  const queued = [];
  const waiters = [];
  const push = (message) => {
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(message);
    else waiter(message);
  };
  const onMessage = (message) => push(message);
  const onError = (error) => push({ kind: "error", error });
  const onClose = (exitCode, signal) => push({ kind: "closed", exitCode, signal });
  child.on("message", onMessage);
  child.on("error", onError);
  child.on("close", onClose);
  return {
    next: () => {
      const message = queued.shift();
      if (message !== undefined) return Promise.resolve(message);
      return new Promise((resolvePromise) => waiters.push(resolvePromise));
    },
    dispose() {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
    },
  };
}

async function stopGatedHelper(child) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") child.kill("SIGKILL");
  }
  await new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) resolvePromise();
    else child.once("close", resolvePromise);
  });
}

function signalReason(signal) {
  return signal === "SIGHUP" ? "terminal-loss" : "signal";
}

const SIGNAL_NUMBERS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGALRM: 14,
  SIGTERM: 15,
};

function signalExitCode(signal) {
  const number = SIGNAL_NUMBERS[signal];
  return number === undefined ? 143 : 128 + number;
}

function interruptedResult(runtimeId, uiRunId, signal, cleanupRoots = []) {
  return {
    runtimeId,
    ...(uiRunId === undefined ? {} : { uiRunId }),
    exitCode: signalExitCode(signal),
    signal,
    ...(cleanupRoots.length === 0 ? {} : { cleanupRoots }),
  };
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function assertSupportedPlatform() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new RuntimeOwnerError(
      "RUNTIME_OWNER_PLATFORM_UNSUPPORTED",
      "Disposable process-group ownership requires macOS or Linux.",
    );
  }
}

async function runOwnedChild() {
  const [, , flag, runtimeId, processToken] = process.argv;
  if (
    flag !== "--runtime-owner-child" ||
    runtimeId === undefined ||
    processToken === undefined ||
    typeof process.send !== "function"
  ) {
    process.exit(2);
  }
  const pgid = processGroupId(process.pid);
  const start = processStartIdentity(process.pid);
  if (pgid !== process.pid || start === undefined) process.exit(2);

  let launched = false;
  let activeChild;
  let keepAlive;
  let shutdownSignal;
  const sendToOwner = (message) => {
    if (!process.connected) return;
    process.send?.(message, () => {});
  };
  const disconnectOwner = () => {
    if (process.connected) process.disconnect?.();
  };
  const finishSignaledShutdown = () => {
    if (shutdownSignal === undefined || activeChild !== undefined) return;
    if (keepAlive !== undefined) clearInterval(keepAlive);
    process.exitCode = signalExitCode(shutdownSignal);
    disconnectOwner();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      shutdownSignal ??= signal;
      finishSignaledShutdown();
    });
  }
  process.on("disconnect", () => {
    if (!launched) process.exit(1);
  });
  sendToOwner({ kind: "ready", pid: process.pid, pgid, osStartTime: start });

  process.on("message", async (message) => {
    if (launched || message?.kind !== "launch") return;
    launched = true;
    const parsed = z
      .object({
        kind: z.literal("launch"),
        launch: LaunchPlanSchema,
      })
      .strict()
      .safeParse(message);
    if (!parsed.success) {
      sendToOwner({ kind: "completed", exitCode: 1, startupFailed: true });
      return;
    }

    // Keep the registered leader alive so TERM-resistant descendants can be revalidated before KILL.
    keepAlive = setInterval(() => undefined, 60_000);
    const env = {
      ...process.env,
      ...(parsed.data.launch.env ?? {}),
      STATION_RUNTIME_OWNER_ID: runtimeId,
    };
    for (const [index, step] of parsed.data.launch.steps.entries()) {
      if (shutdownSignal !== undefined) {
        finishSignaledShutdown();
        return;
      }
      const isFinal = index === parsed.data.launch.steps.length - 1;
      try {
        activeChild = spawn(step.command, step.args, {
          cwd: parsed.data.launch.cwd,
          env,
          stdio: "inherit",
        });
      } catch {
        sendToOwner({ kind: "completed", exitCode: 1, startupFailed: true });
        return;
      }
      const child = activeChild;
      const result = await new Promise((resolvePromise) => {
        child.once("spawn", () => {
          if (isFinal) sendToOwner({ kind: "started", pid: child.pid });
        });
        child.once("error", () => resolvePromise({ exitCode: 1, startupFailed: true }));
        child.once("close", (exitCode, signal) =>
          resolvePromise({
            exitCode: exitCode ?? signalExitCode(signal),
            ...(signal === null ? {} : { signal }),
            startupFailed: !isFinal,
          }),
        );
      });
      activeChild = undefined;
      if (shutdownSignal !== undefined) {
        finishSignaledShutdown();
        return;
      }
      if (result.exitCode !== 0 || isFinal) {
        sendToOwner({ kind: "completed", ...result });
        process.exitCode = result.exitCode;
        return;
      }
    }
  });
}

if (process.argv[2] === "--runtime-owner-child") {
  await runOwnedChild();
}
