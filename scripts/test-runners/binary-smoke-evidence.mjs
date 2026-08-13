import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  DiagnosticEvidenceIndexSchema,
  ErrorEnvelopeSchema,
  LogRecordSchema,
  ObserverProcessIdentitySchema,
} from "../../packages/contracts/dist/index.js";
import {
  mergeRedactionReports,
  REDACTION_POLICY_VERSION,
  redact,
} from "../../packages/observability/dist/index.js";
import { readUnixSocketHolderPids } from "../../packages/protocol/dist/index.js";
import { RuntimeLifecycleEventSchema } from "../runtime-owner.mjs";

export const BINARY_SMOKE_EVIDENCE_LIMITS = Object.freeze({
  maxTotalBytes: 1_048_576,
  maxFileBytes: 131_072,
  maxLogLines: 200,
  maxBootLines: 100,
});

const manifestMaxBytes = 65_536;
const failureMaxBytes = 32_768;
const runtimeMaxBytes = 32_768;
const lifecycleMaxBytes = 32_768;
const reservationFile = ".station-binary-smoke-run";
const bootMaxBytes = 65_536;
const diagnosticErrorsMaxBytes = 65_536;
const diagnosticErrorLines = 100;
const outputStatusSchema = z.enum(["failed", "cancelled"]);
const runIdSchema = z.string().regex(/^run_[0-9a-f-]{36}$/i);
const fileStatusSchema = z.enum([
  "captured",
  "missing",
  "malformed",
  "refused_symlink",
  "read_error",
  "budget_exhausted",
]);
const BinarySmokeExitDispositionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("code"), code: z.number().int() }).strict(),
  z.object({ type: z.literal("signal"), signal: z.string().min(1) }).strict(),
  z.object({ type: z.literal("spawn_error"), message: z.string() }).strict(),
  z.object({ type: z.literal("unknown") }).strict(),
  z.object({ type: z.literal("unavailable") }).strict(),
]);
const artifactSchema = z
  .object({
    path: z.string().min(1),
    displayVersion: z.string().min(1),
    buildIdentity: z.string().min(1),
  })
  .strict();
const artifactLabelSchema = z.enum(["current", "alternate", "source"]);
const capturedFileSchema = z
  .object({
    path: z.string().min(1),
    source: z.string().min(1),
    status: fileStatusSchema,
    bytes: z.number().int().nonnegative().optional(),
    lines: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
const cleanupSchema = z
  .object({
    status: z.enum(["pending", "complete", "incomplete"]),
    observerExited: z.boolean(),
    hostExited: z.boolean(),
    socketRemoved: z.boolean(),
    pidfileRemoved: z.boolean(),
    hostSocketRemoved: z.boolean(),
    rootRemoved: z.boolean(),
  })
  .strict()
  .superRefine((cleanup, context) => {
    if (
      cleanup.status === "complete" &&
      ![
        cleanup.observerExited,
        cleanup.hostExited,
        cleanup.socketRemoved,
        cleanup.pidfileRemoved,
        cleanup.hostSocketRemoved,
        cleanup.rootRemoved,
      ].every(Boolean)
    ) {
      context.addIssue({
        code: "custom",
        message: "Complete binary smoke cleanup requires zero owned residue.",
      });
    }
  });
const runtimeProcessSchema = z
  .object({
    role: z.string().min(1),
    pid: z.number().int().positive(),
    pgid: z.number().int().positive().optional(),
    osStartTime: z.string().min(1).optional(),
    exists: z.boolean(),
  })
  .strict();
const runtimeSocketSchema = z
  .object({
    status: z.enum(["socket", "missing", "non_socket", "refused_symlink", "read_error"]),
    holderPids: z.array(z.number().int().positive()).optional(),
  })
  .strict();
const runtimePidfileSchema = z
  .object({
    status: z.enum(["parsed", "missing", "malformed", "refused_symlink", "read_error"]),
    pid: z.number().int().positive().optional(),
    buildIdentity: z.string().min(12).optional(),
  })
  .strict();
const lifecycleSchema = z.array(RuntimeLifecycleEventSchema);
const BinarySmokeEvidenceManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal("station-binary-smoke-failure"),
    runId: runIdSchema,
    status: outputStatusSchema,
    capturedAt: z.iso.datetime(),
    limits: z
      .object({
        maxTotalBytes: z.literal(BINARY_SMOKE_EVIDENCE_LIMITS.maxTotalBytes),
        maxFileBytes: z.literal(BINARY_SMOKE_EVIDENCE_LIMITS.maxFileBytes),
        maxLogLines: z.literal(BINARY_SMOKE_EVIDENCE_LIMITS.maxLogLines),
        maxBootLines: z.literal(BINARY_SMOKE_EVIDENCE_LIMITS.maxBootLines),
      })
      .strict(),
    rounds: z.array(
      z
        .object({
          round: z.number().int().positive(),
          elapsedMs: z.number().int().nonnegative(),
          direction: z.object({ logical: z.string().min(1), physical: z.string().min(1) }).strict(),
          failure: z
            .object({
              message: z.string(),
              command: z
                .object({ artifact: z.string().min(1), argv: z.array(z.string()) })
                .strict()
                .optional(),
              exitDisposition: BinarySmokeExitDispositionSchema,
            })
            .strict(),
          artifacts: z
            .object({
              current: artifactSchema,
              alternate: artifactSchema,
              source: artifactSchema.optional(),
              incumbent: artifactLabelSchema,
              requested: artifactLabelSchema,
            })
            .strict(),
          correlation: z
            .object({ traceIds: z.array(z.string()), diagnosticIds: z.array(z.string()) })
            .strict(),
          runtime: z
            .object({
              socket: runtimeSocketSchema,
              pidfile: runtimePidfileSchema,
              processes: z.array(runtimeProcessSchema),
              lifecycle: lifecycleSchema,
            })
            .strict(),
          files: z.array(capturedFileSchema),
          cleanup: cleanupSchema,
        })
        .strict()
        .superRefine((round, context) => {
          if (
            round.cleanup.status === "complete" &&
            round.runtime.processes.some((process) => process.exists)
          ) {
            context.addIssue({
              code: "custom",
              message: "Complete binary smoke cleanup requires every recorded process to exit.",
            });
          }
        }),
    ),
    redaction: z
      .object({
        policyVersion: z.literal(REDACTION_POLICY_VERSION),
        replacements: z.number().int().nonnegative(),
        suspiciousSecretsFound: z.number().int().nonnegative(),
      })
      .strict(),
    warnings: z.array(z.string()),
  })
  .strict();

const allowedLogAttributes = new Set([
  "attempt",
  "buildIdentity",
  "candidateBuildIdentity",
  "code",
  "diagnosticId",
  "durationMs",
  "elapsedMs",
  "healthStatus",
  "incumbentBuildIdentity",
  "incumbentPid",
  "operation",
  "pid",
  "processRole",
  "processToken",
  "requestedBuildIdentity",
  "result",
  "sequence",
  "signal",
  "stage",
  "traceId",
  "version",
]);

export { BinarySmokeEvidenceManifestSchema, BinarySmokeExitDispositionSchema };

export async function captureBinarySmokeEvidence(input) {
  validateEvidenceSources(input.stateDir, input.socketPath, input.smokeRoot);
  await prepareEvidenceDestination(input.evidenceDir, input.smokeRoot, input.runId);
  const capturedAt = (input.now ?? new Date()).toISOString();
  const roundName = `${String(input.round).padStart(4, "0")}-${safeName(input.direction.physical)}`;
  const roundRoot = `rounds/${roundName}`;
  await createPrivateDirectory(resolve(input.evidenceDir, "rounds"));
  await createPrivateDirectory(resolve(input.evidenceDir, roundRoot));

  const state = {
    input,
    capturedAt,
    roundRoot,
    files: [],
    redactionReports: [],
    warnings: [],
    bytesWritten: 0,
    correlations: { traceIds: new Set(), diagnosticIds: new Set() },
  };
  const failure = failureRecord(input, state);
  const runtime = await runtimeRecord(input, state);

  await writePriorityJson(
    state,
    `${roundRoot}/failure.json`,
    "runner/failure",
    failure,
    failureMaxBytes,
  );
  await writePriorityJson(
    state,
    `${roundRoot}/runtime/summary.json`,
    "runtime/socket-pidfile-process-summary",
    runtime,
    runtimeMaxBytes,
  );

  if (input.status === "failed") {
    await captureBootLog(state, roundRoot);
    await captureLog(state, roundRoot, "observer.jsonl");
    await captureLog(state, roundRoot, "cli.jsonl");
    await captureLog(state, roundRoot, "station-host.jsonl");
    await captureDiagnostics(state, roundRoot);
  }

  const redaction = mergeRedactionReports(state.redactionReports, capturedAt);
  const manifest = BinarySmokeEvidenceManifestSchema.parse({
    schemaVersion: 2,
    kind: "station-binary-smoke-failure",
    runId: runIdSchema.parse(input.runId),
    status: input.status,
    capturedAt,
    limits: BINARY_SMOKE_EVIDENCE_LIMITS,
    rounds: [
      {
        round: input.round,
        elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
        direction: input.direction,
        failure,
        artifacts: replaceSmokeRoot(input.artifacts, input.smokeRoot),
        correlation: {
          traceIds: [...state.correlations.traceIds].sort(),
          diagnosticIds: [...state.correlations.diagnosticIds].sort(),
        },
        runtime,
        files: state.files,
        cleanup: {
          status: "pending",
          observerExited: false,
          hostExited: false,
          socketRemoved: false,
          pidfileRemoved: false,
          hostSocketRemoved: false,
          rootRemoved: false,
        },
      },
    ],
    redaction: {
      policyVersion: REDACTION_POLICY_VERSION,
      replacements: redaction.replacements,
      suspiciousSecretsFound: redaction.suspiciousSecretsFound,
    },
    warnings: state.warnings,
  });
  const manifestBytes = jsonBytes(manifest);
  if (manifestBytes.length > manifestMaxBytes) {
    throw new Error(`Binary smoke evidence manifest exceeded ${manifestMaxBytes} bytes.`);
  }
  if (state.bytesWritten + manifestBytes.length > BINARY_SMOKE_EVIDENCE_LIMITS.maxTotalBytes) {
    throw new Error("Binary smoke evidence exceeded its total byte budget before manifest write.");
  }
  await atomicWrite(resolve(input.evidenceDir, "manifest.json"), manifestBytes);
  await removeMatchingReservation(input.evidenceDir, input.runId);
  return manifest;
}

function validateEvidenceSources(stateDir, socketPath, smokeRoot) {
  const root = resolve(smokeRoot);
  const state = resolve(stateDir);
  if (state === root || !state.startsWith(`${root}${sep}`)) {
    throw new Error("Binary smoke evidence state directory must be beneath the smoke root.");
  }
  const socket = resolve(socketPath);
  if (socket === root || !socket.startsWith(`${root}${sep}`)) {
    throw new Error("Binary smoke evidence socket must be beneath the smoke root.");
  }
}

export async function finalizeBinarySmokeEvidence(input) {
  const manifestPath = resolve(input.evidenceDir, "manifest.json");
  const stats = await lstat(manifestPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Binary smoke evidence manifest is not a regular file.");
  }
  const source = await readFile(manifestPath, "utf8");
  if (Buffer.byteLength(source) > manifestMaxBytes) {
    throw new Error("Binary smoke evidence manifest exceeds its read limit.");
  }
  const manifest = BinarySmokeEvidenceManifestSchema.parse(JSON.parse(source));
  const expectedRunId = runIdSchema.parse(input.expectedRunId);
  if (manifest.runId !== expectedRunId) {
    throw new Error("Binary smoke evidence belongs to a different binary smoke run.");
  }
  const [round] = manifest.rounds;
  if (round === undefined) throw new Error("Binary smoke evidence manifest has no round.");
  round.cleanup = cleanupSchema.parse(input.cleanup);
  if (input.processes !== undefined) {
    round.runtime.processes = input.processes.map((process) => runtimeProcessSchema.parse(process));
  }
  if (input.lifecycleEvents !== undefined) {
    const lifecycle = lifecycleSchema.parse(input.lifecycleEvents);
    round.runtime.lifecycle = lifecycle;
    await writeFinalLifecycle(input.evidenceDir, round, lifecycle);
  }
  manifest.warnings.push(...input.warnings.map((warning) => boundedText(warning, 1_000)));
  const bytes = jsonBytes(BinarySmokeEvidenceManifestSchema.parse(manifest));
  if (bytes.length > manifestMaxBytes) {
    throw new Error(`Binary smoke evidence manifest exceeded ${manifestMaxBytes} bytes.`);
  }
  await atomicWrite(manifestPath, bytes, true);
  await removeMatchingReservation(input.evidenceDir, expectedRunId);
}

function validateEvidenceDestination(evidenceDir, smokeRoot) {
  if (!isAbsolute(evidenceDir)) {
    throw new Error("STATION_BINARY_SMOKE_EVIDENCE_DIR must be absolute.");
  }
  const output = resolve(evidenceDir);
  const root = resolve(smokeRoot);
  if (output === root || output.startsWith(`${root}${sep}`) || root.startsWith(`${output}${sep}`)) {
    throw new Error("STATION_BINARY_SMOKE_EVIDENCE_DIR must be outside the smoke root.");
  }
}

export async function assertNewBinarySmokeEvidenceDestination(evidenceDir, smokeRoot) {
  validateEvidenceDestination(evidenceDir, smokeRoot);
  try {
    await lstat(resolve(evidenceDir));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("STATION_BINARY_SMOKE_EVIDENCE_DIR must not exist.");
}

export async function reserveBinarySmokeEvidenceDestination(input) {
  await assertNewBinarySmokeEvidenceDestination(input.evidenceDir, input.smokeRoot);
  const runId = runIdSchema.parse(input.runId);
  await createPrivateDirectory(input.evidenceDir);
  const marker = await open(resolve(input.evidenceDir, reservationFile), "wx", 0o600);
  try {
    await marker.writeFile(`${runId}\n`, "utf8");
  } finally {
    await marker.close();
  }
}

export async function resetReservedBinarySmokeEvidenceDestination(input) {
  await assertReservedEvidenceDestination(input.evidenceDir, input.smokeRoot, input.runId);
  for (const entry of await readdir(resolve(input.evidenceDir))) {
    if (entry !== reservationFile) {
      await rm(resolve(input.evidenceDir, entry), { recursive: true });
    }
  }
}

export async function releaseBinarySmokeEvidenceReservation(input) {
  await assertReservedEvidenceDestination(input.evidenceDir, input.smokeRoot, input.runId);
  const entries = await readdir(resolve(input.evidenceDir));
  if (entries.some((entry) => entry !== reservationFile)) {
    throw new Error("Binary smoke evidence reservation contains captured data.");
  }
  await removeMatchingReservation(input.evidenceDir, input.runId);
  await rmdir(resolve(input.evidenceDir));
}

async function prepareEvidenceDestination(evidenceDir, smokeRoot, runId) {
  try {
    await assertReservedEvidenceDestination(evidenceDir, smokeRoot, runId);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await reserveBinarySmokeEvidenceDestination({ evidenceDir, smokeRoot, runId });
  }
}

async function assertReservedEvidenceDestination(evidenceDir, smokeRoot, runId) {
  validateEvidenceDestination(evidenceDir, smokeRoot);
  const output = resolve(evidenceDir);
  const stats = await lstat(output);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new Error(`Evidence path is not a private directory: ${output}`);
  }
  const markerPath = resolve(output, reservationFile);
  const markerStats = await lstat(markerPath);
  if (!markerStats.isFile() || markerStats.isSymbolicLink() || (markerStats.mode & 0o177) !== 0) {
    throw new Error("Binary smoke evidence reservation is not a private regular file.");
  }
  if ((await readFile(markerPath, "utf8")).trim() !== runIdSchema.parse(runId)) {
    throw new Error("Binary smoke evidence reservation belongs to a different run.");
  }
}

async function removeMatchingReservation(evidenceDir, runId) {
  const markerPath = resolve(evidenceDir, reservationFile);
  try {
    if ((await readFile(markerPath, "utf8")).trim() !== runIdSchema.parse(runId)) {
      throw new Error("Binary smoke evidence reservation belongs to a different run.");
    }
    await unlink(markerPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function createPrivateDirectory(path) {
  await mkdir(path, { mode: 0o700 });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new Error(`Evidence path is not a private directory: ${path}`);
  }
}

function failureRecord(input, state) {
  const rawMessage = input.failure?.message ?? errorMessage(input.error);
  const redactedMessage = redactValue(replaceSmokeRoot(rawMessage, input.smokeRoot), state);
  collectCorrelations(redactedMessage, state.correlations);
  const result = {
    message: boundedText(redactedMessage, 16_384),
    exitDisposition: BinarySmokeExitDispositionSchema.parse(
      redactValue(input.failure?.exitDisposition ?? { type: "unavailable" }, state),
    ),
  };
  if (input.failure?.command !== undefined) {
    result.command = redactValue(replaceSmokeRoot(input.failure.command, input.smokeRoot), state);
  }
  return result;
}

async function runtimeRecord(input, state) {
  const socket = await socketSummary(input.socketPath, input.smokeRoot);
  const pidfile = await pidfileSummary(`${input.socketPath}.pid`, input.smokeRoot);
  const processes = input.knownProcesses.map(({ role, pid, pgid, osStartTime }) => ({
    role,
    pid,
    ...(pgid === undefined ? {} : { pgid }),
    ...(osStartTime === undefined ? {} : { osStartTime }),
    exists: processExists(pid),
  }));
  const lifecycle = await captureLifecycle(input, state);
  const redacted = redactValue({ socket, pidfile, processes }, state);
  return { ...redacted, lifecycle };
}

async function captureLifecycle(input, state) {
  const lifecycle = normalizeLifecycleEvents(
    input.lifecycleEvents ??
      (await readLifecycleSource(
        input.ownerEventsPath ?? resolve(input.stateDir, "logs", "cli.jsonl"),
        input.smokeRoot,
      )),
  );
  const bytes = Buffer.from(`${lifecycle.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeCaptured(
    state,
    `${state.roundRoot}/runtime/lifecycle.jsonl`,
    "runtime/owner-lifecycle.jsonl",
    bytes,
    {
      maxBytes: lifecycleMaxBytes,
      lines: lifecycle.length,
    },
  );
  return lifecycle;
}

async function readLifecycleSource(path, smokeRoot) {
  const read = await boundedSourceRead(path, smokeRoot, lifecycleMaxBytes, true);
  if (read.status !== "ready") return [];
  const parsed = parseJsonlTail(
    read.bytes.toString("utf8"),
    RuntimeLifecycleEventSchema,
    256,
    read.truncated,
  );
  return parsed.status === "malformed" ? [] : parsed.records;
}

function normalizeLifecycleEvents(events) {
  const parsed = lifecycleSchema.parse(events ?? []);
  if (parsed.length <= 256) return parsed;
  return [...parsed.slice(0, 128), ...parsed.slice(-128)];
}

async function writeFinalLifecycle(evidenceDir, round, lifecycle) {
  const roundRoot = resolve(
    evidenceDir,
    "rounds",
    `${String(round.round).padStart(4, "0")}-${safeName(round.direction.physical)}`,
  );
  const path = resolve(roundRoot, "runtime/lifecycle.jsonl");
  const bytes = Buffer.from(`${lifecycle.map((event) => JSON.stringify(event)).join("\n")}\n`);
  if (bytes.length > lifecycleMaxBytes)
    throw new Error("Binary smoke lifecycle evidence exceeded its file cap.");
  await createParentDirectories(path, evidenceDir);
  await atomicWrite(path, bytes, true);
  const file = round.files.find((entry) => entry.source === "runtime/owner-lifecycle.jsonl");
  if (file === undefined) {
    round.files.push({
      path: `rounds/${String(round.round).padStart(4, "0")}-${safeName(round.direction.physical)}/runtime/lifecycle.jsonl`,
      source: "runtime/owner-lifecycle.jsonl",
      status: "captured",
      bytes: bytes.length,
      lines: lifecycle.length,
    });
  } else {
    file.status = "captured";
    file.bytes = bytes.length;
    file.lines = lifecycle.length;
    delete file.truncated;
  }
}

async function socketSummary(path, smokeRoot) {
  const checked = await secureSource(path, smokeRoot, false);
  if (checked.status !== "ready") return { status: checked.status };
  if (!checked.stats.isSocket()) return { status: "non_socket" };
  try {
    return { status: "socket", holderPids: readUnixSocketHolderPids(path) };
  } catch {
    return { status: "socket" };
  }
}

async function pidfileSummary(path, smokeRoot) {
  const read = await boundedSourceRead(path, smokeRoot, BINARY_SMOKE_EVIDENCE_LIMITS.maxFileBytes);
  if (read.status !== "ready") return { status: read.status };
  try {
    const identity = ObserverProcessIdentitySchema.parse(JSON.parse(read.bytes.toString("utf8")));
    const buildIdentity = identity.version.match(/station\.([0-9a-f]{64})$/)?.[1];
    const summary = { status: "parsed", pid: identity.pid };
    if (buildIdentity !== undefined) summary.buildIdentity = buildIdentity.slice(0, 12);
    return summary;
  } catch {
    return { status: "malformed" };
  }
}

async function captureBootLog(state, roundRoot) {
  const source = resolve(state.input.stateDir, "logs/observer-boot.log");
  const read = await boundedSourceRead(source, state.input.smokeRoot, bootMaxBytes, true);
  const output = `${roundRoot}/observer-boot.log`;
  if (read.status !== "ready")
    return recordUnavailable(state, output, "state/logs/observer-boot.log", read.status);
  const lines = tailLines(
    read.bytes.toString("utf8"),
    BINARY_SMOKE_EVIDENCE_LIMITS.maxBootLines,
    read.truncated,
  );
  const content = redactValue(replaceSmokeRoot(lines.join("\n"), state.input.smokeRoot), state);
  collectCorrelations(content, state.correlations);
  await writeCaptured(state, output, "state/logs/observer-boot.log", Buffer.from(`${content}\n`), {
    lines: lines.length,
    truncated: read.truncated || lines.length >= BINARY_SMOKE_EVIDENCE_LIMITS.maxBootLines,
    maxBytes: bootMaxBytes,
  });
}

async function captureLog(state, roundRoot, name) {
  const sourceName = `state/logs/${name}`;
  const source = resolve(state.input.stateDir, `logs/${name}`);
  const read = await boundedSourceRead(
    source,
    state.input.smokeRoot,
    BINARY_SMOKE_EVIDENCE_LIMITS.maxFileBytes,
    true,
  );
  const output = `${roundRoot}/logs/${name}`;
  if (read.status !== "ready") return recordUnavailable(state, output, sourceName, read.status);
  const parsed = parseJsonlTail(
    read.bytes.toString("utf8"),
    LogRecordSchema,
    BINARY_SMOKE_EVIDENCE_LIMITS.maxLogLines,
    read.truncated,
  );
  if (parsed.status === "malformed")
    return recordUnavailable(state, output, sourceName, "malformed");
  const records = parsed.records.filter(relevantLogRecord).map(stripLogRecord);
  const redacted = redactValue(replaceSmokeRoot(records, state.input.smokeRoot), state);
  for (const record of redacted) collectCorrelations(record, state.correlations);
  const bytes = Buffer.from(`${redacted.map((record) => JSON.stringify(record)).join("\n")}\n`);
  await writeCaptured(state, output, sourceName, bytes, {
    lines: redacted.length,
    truncated: read.truncated || parsed.truncated,
  });
}

async function captureDiagnostics(state, roundRoot) {
  const diagnosticsRoot = resolve(state.input.stateDir, "diagnostics");
  const checked = await secureSource(diagnosticsRoot, state.input.smokeRoot, false);
  if (checked.status !== "ready" || !checked.stats.isDirectory()) return;
  let entries;
  try {
    entries = (await readdir(diagnosticsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 2);
  } catch (error) {
    state.warnings.push(`Could not enumerate diagnostic evidence: ${errorMessage(error)}`);
    return;
  }
  for (const [index, directory] of entries.entries()) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    await captureDiagnosticIndex(state, roundRoot, diagnosticsRoot, directory, suffix);
    await captureDiagnosticErrors(state, roundRoot, diagnosticsRoot, directory, suffix);
  }
}

async function captureDiagnosticIndex(state, roundRoot, diagnosticsRoot, directory, suffix) {
  const sourceName = `state/diagnostics/${directory}/diagnostic-index.json`;
  const output = `${roundRoot}/diagnostics/diagnostic-index${suffix}.json`;
  const read = await boundedSourceRead(
    resolve(diagnosticsRoot, directory, "diagnostic-index.json"),
    state.input.smokeRoot,
    BINARY_SMOKE_EVIDENCE_LIMITS.maxFileBytes,
  );
  if (read.status !== "ready") return recordUnavailable(state, output, sourceName, read.status);
  try {
    const parsed = DiagnosticEvidenceIndexSchema.parse(JSON.parse(read.bytes.toString("utf8")));
    const redacted = redactValue(replaceSmokeRoot(parsed, state.input.smokeRoot), state);
    collectCorrelations(redacted, state.correlations);
    await writeCaptured(state, output, sourceName, jsonBytes(redacted), { truncated: false });
  } catch {
    recordUnavailable(state, output, sourceName, "malformed");
  }
}

async function captureDiagnosticErrors(state, roundRoot, diagnosticsRoot, directory, suffix) {
  const sourceName = `state/diagnostics/${directory}/errors.jsonl`;
  const output = `${roundRoot}/diagnostics/errors${suffix}.jsonl`;
  const read = await boundedSourceRead(
    resolve(diagnosticsRoot, directory, "errors.jsonl"),
    state.input.smokeRoot,
    diagnosticErrorsMaxBytes,
    true,
  );
  if (read.status !== "ready") return recordUnavailable(state, output, sourceName, read.status);
  const parsed = parseJsonlTail(
    read.bytes.toString("utf8"),
    ErrorEnvelopeSchema,
    diagnosticErrorLines,
    read.truncated,
  );
  if (parsed.status === "malformed")
    return recordUnavailable(state, output, sourceName, "malformed");
  const errors = parsed.records.map(stripErrorEnvelope);
  const redacted = redactValue(replaceSmokeRoot(errors, state.input.smokeRoot), state);
  for (const error of redacted) collectCorrelations(error, state.correlations);
  const bytes = Buffer.from(`${redacted.map((error) => JSON.stringify(error)).join("\n")}\n`);
  await writeCaptured(state, output, sourceName, bytes, {
    lines: redacted.length,
    truncated: read.truncated || parsed.truncated,
    maxBytes: diagnosticErrorsMaxBytes,
  });
}

async function boundedSourceRead(path, smokeRoot, maxBytes, fromEnd = false) {
  const checked = await secureSource(path, smokeRoot, true);
  if (checked.status !== "ready") return checked;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== checked.stats.dev || opened.ino !== checked.stats.ino) {
      return { status: "read_error" };
    }
    const length = Math.min(opened.size, maxBytes);
    const bytes = Buffer.alloc(length);
    const position = fromEnd ? Math.max(0, opened.size - length) : 0;
    const result = await handle.read(bytes, 0, length, position);
    return {
      status: "ready",
      bytes: bytes.subarray(0, result.bytesRead),
      truncated: opened.size > length,
    };
  } catch {
    return { status: "read_error" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function secureSource(path, smokeRoot, requireFile) {
  const root = resolve(smokeRoot);
  const target = resolve(path);
  if (target === root || !target.startsWith(`${root}${sep}`)) return { status: "read_error" };
  const segments = relative(root, target).split(sep);
  let current = root;
  try {
    for (const [index, segment] of segments.entries()) {
      if (segment === "" || segment === "." || segment === "..") return { status: "read_error" };
      current = resolve(current, segment);
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) return { status: "refused_symlink" };
      if (index < segments.length - 1 && !stats.isDirectory()) return { status: "read_error" };
      if (index === segments.length - 1) {
        if (requireFile && !stats.isFile()) return { status: "read_error" };
        return { status: "ready", stats };
      }
    }
  } catch (error) {
    return error?.code === "ENOENT" ? { status: "missing" } : { status: "read_error" };
  }
  return { status: "read_error" };
}

async function writePriorityJson(state, output, source, value, maxBytes) {
  let bytes = jsonBytes(value);
  let truncated = false;
  if (bytes.length > maxBytes) {
    truncated = true;
    bytes = jsonBytes({
      message: boundedText(value.message ?? "Evidence exceeded its file cap.", maxBytes / 2),
    });
    state.warnings.push(`${source} was reduced to fit its ${maxBytes}-byte cap.`);
  }
  await writeCaptured(state, output, source, bytes, { truncated, maxBytes });
}

async function writeCaptured(state, output, source, bytes, metadata) {
  const { maxBytes = BINARY_SMOKE_EVIDENCE_LIMITS.maxFileBytes, ...fileMetadata } = metadata;
  if (bytes.length > maxBytes) {
    state.warnings.push(`${source} exceeded the per-file evidence cap.`);
    recordUnavailable(state, output, source, "budget_exhausted");
    return;
  }
  if (
    state.bytesWritten + bytes.length + manifestMaxBytes >
    BINARY_SMOKE_EVIDENCE_LIMITS.maxTotalBytes
  ) {
    recordUnavailable(state, output, source, "budget_exhausted");
    return;
  }
  const path = resolve(state.input.evidenceDir, output);
  await createParentDirectories(path, state.input.evidenceDir);
  await atomicWrite(path, bytes);
  state.bytesWritten += bytes.length;
  state.files.push({
    path: output,
    source,
    status: "captured",
    bytes: bytes.length,
    ...fileMetadata,
  });
}

function recordUnavailable(state, output, source, status) {
  state.files.push({ path: output, source, status: fileStatusSchema.parse(status) });
}

async function createParentDirectories(path, evidenceDir) {
  const parent = dirname(path);
  const relativeParent = relative(resolve(evidenceDir), parent);
  let current = resolve(evidenceDir);
  for (const segment of relativeParent.split(sep)) {
    if (segment.length === 0) continue;
    current = resolve(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stats = await lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Evidence output component is not a directory: ${current}`);
    }
  }
}

async function atomicWrite(path, bytes, replace = false) {
  if (!replace) {
    try {
      await lstat(path);
      throw new Error(`Evidence output already exists: ${path}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const temporary = resolve(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function parseJsonlTail(source, schema, maxLines, truncatedBytes) {
  const lines = source.split(/\r?\n/);
  if (truncatedBytes) lines.shift();
  const candidates = lines.filter((line) => line.trim().length > 0).slice(-maxLines);
  const records = [];
  for (const line of candidates) {
    try {
      const result = schema.safeParse(JSON.parse(line));
      if (result.success) records.push(result.data);
    } catch {
      // A malformed record is ignored only when other strict records remain useful.
    }
  }
  return records.length === 0 && candidates.length > 0
    ? { status: "malformed" }
    : { status: "captured", records, truncated: candidates.length >= maxLines };
}

function relevantLogRecord(record) {
  return (
    record.traceId !== undefined ||
    record.commandId !== undefined ||
    record.attributes?.diagnosticId !== undefined ||
    /observer|handoff|startup|health|socket|pidfile|claim|bind/i.test(record.message)
  );
}

function stripLogRecord(record) {
  const result = {
    timestamp: record.timestamp,
    level: record.level,
    component: record.component,
    message: record.message,
  };
  for (const key of ["traceId", "spanId", "commandId"]) {
    if (record[key] !== undefined) result[key] = record[key];
  }
  if (record.attributes !== undefined) {
    const attributes = Object.fromEntries(
      Object.entries(record.attributes).filter(([key]) => allowedLogAttributes.has(key)),
    );
    if (Object.keys(attributes).length > 0) result.attributes = attributes;
  }
  return result;
}

function stripErrorEnvelope(error) {
  const result = {
    id: error.id,
    tag: error.tag,
    code: error.code,
    message: error.message,
    severity: error.severity,
    redacted: error.redacted,
    createdAt: error.createdAt,
  };
  for (const key of ["commandId", "traceId", "spanId", "diagnosticId"]) {
    if (error[key] !== undefined) result[key] = error[key];
  }
  return result;
}

function tailLines(source, maxLines, truncatedBytes) {
  const lines = source.trimEnd().split(/\r?\n/);
  if (truncatedBytes) lines.shift();
  return lines.slice(-maxLines);
}

function collectCorrelations(value, correlations) {
  const source = JSON.stringify(value);
  for (const match of source.matchAll(/\btrc_[A-Za-z0-9-]+\b/g))
    correlations.traceIds.add(match[0]);
  for (const match of source.matchAll(/\bdiag_[A-Za-z0-9-]+\b/g)) {
    correlations.diagnosticIds.add(match[0]);
  }
}

function redactValue(value, state) {
  const result = redact(value, new Date(state.capturedAt));
  state.redactionReports.push(result.report);
  return result.value;
}

function replaceSmokeRoot(value, smokeRoot) {
  if (typeof value === "string") return value.replaceAll(resolve(smokeRoot), "$SMOKE_ROOT");
  if (Array.isArray(value)) return value.map((entry) => replaceSmokeRoot(entry, smokeRoot));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, replaceSmokeRoot(child, smokeRoot)]),
  );
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value, maxCharacters) {
  return value.length <= maxCharacters ? value : value.slice(value.length - maxCharacters);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function safeName(value) {
  const name = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name.length === 0 ? "unknown" : name.slice(0, 80);
}
