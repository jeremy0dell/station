#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  SessionMigrationJournalEntrySchema,
  SessionMigrationLockSchema,
  SessionMigrationSealSchema,
  SessionRecoveryCoverageSchema,
  SessionRecoveryHandleSchema,
  SessionRescueManifestSchema,
  StationSnapshotSchema,
} from "../../packages/contracts/dist/index.js";
import { isUnder, verifySessionRescueArchive } from "./session-rescue.mjs";

const maxCommandOutput = 128 * 1024 * 1024;
let activeChild;
let receivedSignal;

export function parseSessionMigrationArgs(args, deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const homeDir = deps.homeDir ?? homedir();
  const input = args.filter((arg) => arg !== "--");
  if (input.includes("--help")) return { command: "help" };

  let archivePath;
  let targetConfig;
  let targetStn = "stn";
  let sourceConfig;
  let sourceStn = "stn";
  let sourceDevboxRoot;
  let targetCodexHome;
  let targetOpenCodeDb;
  let targetClaudeProjects;
  let expectPlan;
  let apply = false;

  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    switch (arg) {
      case "--archive":
        archivePath = requiredOptionValue(input, ++index, arg);
        break;
      case "--target-config":
        targetConfig = requiredOptionValue(input, ++index, arg);
        break;
      case "--target-stn":
        targetStn = requiredOptionValue(input, ++index, arg);
        break;
      case "--source-config":
        sourceConfig = requiredOptionValue(input, ++index, arg);
        break;
      case "--source-stn":
        sourceStn = requiredOptionValue(input, ++index, arg);
        break;
      case "--source-devbox-root":
        sourceDevboxRoot = requiredOptionValue(input, ++index, arg);
        break;
      case "--target-codex-home":
        targetCodexHome = requiredOptionValue(input, ++index, arg);
        break;
      case "--target-opencode-db":
        targetOpenCodeDb = requiredOptionValue(input, ++index, arg);
        break;
      case "--target-claude-projects":
        targetClaudeProjects = requiredOptionValue(input, ++index, arg);
        break;
      case "--expect-plan":
        expectPlan = requiredOptionValue(input, ++index, arg);
        break;
      case "--yes":
        apply = true;
        break;
      default:
        throw new Error(`Unknown session migration option: ${arg}`);
    }
  }

  if (archivePath === undefined || targetConfig === undefined) {
    throw new Error("--archive and --target-config are required");
  }
  if (sourceConfig !== undefined && sourceDevboxRoot !== undefined) {
    throw new Error("Use --source-config or --source-devbox-root, not both");
  }
  if (apply && expectPlan === undefined) {
    throw new Error("--yes requires --expect-plan <digest> from a fresh read-only plan");
  }
  if (expectPlan !== undefined && !/^[0-9a-f]{64}$/u.test(expectPlan)) {
    throw new Error("--expect-plan must be a SHA-256 digest");
  }

  return {
    command: apply ? "apply" : "plan",
    archivePath: resolveInputPath(archivePath, cwd, homeDir),
    targetConfig: resolveInputPath(targetConfig, cwd, homeDir),
    targetStn,
    sourceConfig:
      sourceConfig === undefined ? undefined : resolveInputPath(sourceConfig, cwd, homeDir),
    sourceStn,
    expectPlan,
    sourceDevboxRoot:
      sourceDevboxRoot === undefined ? undefined : resolveInputPath(sourceDevboxRoot, cwd, homeDir),
    targetCodexHome: resolveInputPath(
      targetCodexHome ?? process.env.CODEX_HOME ?? "~/.codex",
      cwd,
      homeDir,
    ),
    targetOpenCodeDb: resolveInputPath(
      targetOpenCodeDb ??
        join(
          process.env.XDG_DATA_HOME ?? join(homeDir, ".local", "share"),
          "opencode",
          "opencode.db",
        ),
      cwd,
      homeDir,
    ),
    targetClaudeProjects: resolveInputPath(
      targetClaudeProjects ??
        join(process.env.CLAUDE_CONFIG_DIR ?? join(homeDir, ".claude"), "projects"),
      cwd,
      homeDir,
    ),
  };
}

export function buildSessionMigrationPlan(
  coverage,
  handles,
  snapshot,
  targetSnapshot,
  options = {},
) {
  const handlesById = new Map(handles.map((handle) => [handle.id, handle]));
  const sourceSessions = new Map(snapshot.sessions.map((session) => [session.id, session]));
  const sourceRows = new Map(snapshot.rows.map((row) => [row.id, row]));
  const targetRows = new Map(targetSnapshot.rows.map((row) => [row.id, row]));
  const targetSessionsByWorktree = new Map(
    targetSnapshot.sessions.map((session) => [session.worktreeId, session]),
  );
  const migratingProviders = new Set(coverage.map((item) => item.provider));
  const targetProviderConflict = targetSnapshot.sessions.find((session) => {
    if (!migratingProviders.has(session.harness?.provider)) return false;
    return !(
      options.allowMatchingTargetSessions &&
      coverage.some(
        (item) =>
          item.sessionId === session.id &&
          item.worktreeId === session.worktreeId &&
          item.provider === session.harness?.provider,
      )
    );
  });
  if (targetProviderConflict !== undefined) {
    throw new Error(
      `Target provider ${targetProviderConflict.harness.provider} already has an active session: ${targetProviderConflict.id}`,
    );
  }

  return coverage.map((item) => {
    if (item.exactHandleIds.length !== 1) {
      throw new Error(
        `Session ${item.sessionId} requires exactly one recovery handle; found ${item.exactHandleIds.length}`,
      );
    }
    const handle = handlesById.get(item.exactHandleIds[0]);
    if (handle === undefined)
      throw new Error(`Recovery handle ${item.exactHandleIds[0]} is missing`);
    const sourceSession = sourceSessions.get(item.sessionId);
    const sourceRow = sourceRows.get(item.worktreeId);
    const targetRow = targetRows.get(item.worktreeId);
    if (
      sourceSession === undefined ||
      sourceRow === undefined ||
      sourceSession.projectId !== item.projectId ||
      sourceSession.worktreeId !== item.worktreeId ||
      sourceRow.projectId !== item.projectId
    ) {
      throw new Error(`Session ${item.sessionId} is absent from the archived snapshot`);
    }
    if (
      targetRow === undefined ||
      targetRow.projectId !== item.projectId ||
      targetRow.path !== sourceRow.path ||
      targetRow.registrationIdentity !== sourceRow.registrationIdentity
    ) {
      throw new Error(
        `Target Station does not contain the same worktree identity: ${item.worktreeId}`,
      );
    }
    const targetSession = targetSessionsByWorktree.get(item.worktreeId);
    const alreadyResumed =
      targetSession?.id === item.sessionId &&
      targetSession.projectId === item.projectId &&
      targetSession.harness?.provider === item.provider;
    if (targetSession !== undefined && !(options.allowMatchingTargetSessions && alreadyResumed)) {
      throw new Error(`Target worktree already has a session: ${item.worktreeId}`);
    }
    if (handle.target.kind !== "native-session") {
      throw new Error(`Recovery handle ${handle.id} has no durable native session identity`);
    }
    if (
      handle.provider !== item.provider ||
      handle.projectId !== item.projectId ||
      handle.worktreeId !== item.worktreeId ||
      handle.sessionId !== item.sessionId ||
      handle.cwd === undefined ||
      !isUnder(handle.cwd, sourceRow.path)
    ) {
      throw new Error(`Recovery handle ${handle.id} does not match session ${item.sessionId}`);
    }
    return {
      sessionId: item.sessionId,
      title: sourceSession.title,
      provider: item.provider,
      projectId: item.projectId,
      worktreeId: item.worktreeId,
      worktreePath: sourceRow.path,
      alreadyResumed,
      ...(targetRow.registrationIdentity === undefined
        ? {}
        : { registrationIdentity: targetRow.registrationIdentity }),
      handle,
    };
  });
}

async function loadMigrationInputs(options) {
  const verification = await verifySessionRescueArchive(options.archivePath);
  if (!verification.ok) {
    throw new Error(`Rescue archive verification failed: ${verification.errors.join("; ")}`);
  }
  const manifest = await parseJsonFile(
    join(options.archivePath, "manifest.json"),
    SessionRescueManifestSchema,
    "Rescue manifest",
  );
  if (manifest.status !== "complete" || manifest.critical.length > 0) {
    throw new Error("A partial rescue archive cannot authorize migration");
  }
  const handles = await parseJsonFile(
    join(options.archivePath, "observer", "recovery-handles.json"),
    SessionRecoveryHandleSchema.array(),
    "Recovery handles",
  );
  const coverage = await parseJsonFile(
    join(options.archivePath, "observer", "recovery-coverage.json"),
    SessionRecoveryCoverageSchema,
    "Recovery coverage",
  );
  const snapshot = await parseJsonFile(
    join(options.archivePath, "observer", "snapshot.json"),
    StationSnapshotSchema,
    "Observer snapshot",
  );
  const host = await import("../../packages/station-host/dist/index.js");
  const hostPtys = await parseJsonFile(
    join(options.archivePath, "host", "ptys.json"),
    host.HostListEntrySchema.array(),
    "Host PTY inventory",
  );
  const finalVerification = await verifySessionRescueArchive(options.archivePath);
  if (!finalVerification.ok) {
    throw new Error(`Rescue archive changed while loading: ${finalVerification.errors.join("; ")}`);
  }
  return {
    verification: finalVerification,
    manifest,
    handles,
    coverage,
    snapshot,
    hostPtys,
  };
}

async function planMigration(options) {
  const inputs = await loadMigrationInputs(options);
  const sourceConfig = options.sourceConfig ?? inputs.manifest.metadata.configPath;
  if (
    options.sourceDevboxRoot !== undefined &&
    resolve(join(options.sourceDevboxRoot, ".dev-state", "config.toml")) !==
      resolve(inputs.manifest.metadata.configPath)
  ) {
    throw new Error("Source devbox root does not match the runtime recorded by the archive");
  }
  if (resolve(sourceConfig) !== resolve(inputs.manifest.metadata.configPath)) {
    throw new Error("Source config must match the runtime recorded by the rescue archive");
  }
  if (resolve(sourceConfig) === resolve(options.targetConfig)) {
    throw new Error("Source and target config paths must differ");
  }

  const [sourceSnapshot, targetSnapshot, targetReadiness] = await Promise.all([
    cliJson(options.sourceStn, sourceConfig, ["snapshot", "--json", "--require-running"]),
    cliJson(options.targetStn, options.targetConfig, ["snapshot", "--json", "--require-running"]),
    recoveryReadiness(options.targetConfig),
  ]);
  const plan = buildSessionMigrationPlan(
    inputs.coverage,
    inputs.handles,
    inputs.snapshot,
    targetSnapshot,
  );
  assertArchivedRecoveryIdentity(inputs.hostPtys, plan);
  if (
    sourceSnapshot.observer.pid !== inputs.snapshot.observer.pid ||
    sourceSnapshot.observer.startedAt !== inputs.snapshot.observer.startedAt ||
    sourceSnapshot.observer.version !== inputs.snapshot.observer.version
  ) {
    throw new Error("Source Observer identity changed after rescue; create a fresh archive");
  }
  assertSourceMatchesPlan(sourceSnapshot, plan);
  const [sourceHostPtys, targetHostPtys] = await Promise.all([
    readSourceHostPtys(inputs),
    readTargetHostPtys(options.targetConfig),
  ]);
  assertHostPtyCensus(inputs.hostPtys, sourceHostPtys);
  assertNoTargetHostConflicts(targetHostPtys, plan);
  assertTargetReadiness(targetReadiness, plan);
  await preflightProviderState(options, inputs, plan);
  const digest = migrationPlanDigest({
    manifestCreatedAt: inputs.manifest.createdAt,
    sourceConfig,
    targetConfig: options.targetConfig,
    sourceObserver: sourceSnapshot.observer,
    sourceHostPtys,
    targetObserver: targetSnapshot.observer,
    targetReadiness,
    targetHostPtys: targetHostPtys.filter((pty) => pty.alive),
    plan,
  });
  return {
    inputs,
    sourceConfig,
    sourceSnapshot,
    targetSnapshot,
    targetReadiness,
    targetHostPtys,
    plan,
    digest,
  };
}

async function loadResumableMigration(options, journalPath) {
  if (!(await pathExists(journalPath))) return undefined;
  const records = [];
  for (const line of (await readFile(journalPath, "utf8"))
    .split("\n")
    .filter((entry) => entry.length > 0)) {
    try {
      records.push(SessionMigrationJournalEntrySchema.parse(JSON.parse(line)));
    } catch (error) {
      throw new Error(`Migration journal is invalid: ${errorMessage(error)}`, { cause: error });
    }
  }
  const recordedDigest = records.find((entry) => entry.digest !== undefined)?.digest;
  if (recordedDigest !== options.expectPlan) {
    throw new Error("Existing migration journal does not match --expect-plan");
  }

  const inputs = await loadMigrationInputs(options);
  const sourceConfig = options.sourceConfig ?? inputs.manifest.metadata.configPath;
  if (resolve(sourceConfig) !== resolve(inputs.manifest.metadata.configPath)) {
    throw new Error("Source config must match the runtime recorded by the rescue archive");
  }
  const [targetSnapshot, targetReadiness] = await Promise.all([
    cliJson(options.targetStn, options.targetConfig, ["snapshot", "--json", "--require-running"]),
    recoveryReadiness(options.targetConfig),
  ]);
  const plan = buildSessionMigrationPlan(
    inputs.coverage,
    inputs.handles,
    inputs.snapshot,
    targetSnapshot,
    { allowMatchingTargetSessions: true },
  );
  assertArchivedRecoveryIdentity(inputs.hostPtys, plan);
  const sourceSealed = records.some(
    (entry) =>
      entry.status === "complete" &&
      ["source-sealed", "target-staged", "verified", "complete"].includes(entry.phase),
  );
  if (plan.some((item) => item.alreadyResumed) && !sourceSealed) {
    throw new Error("Target sessions appeared before the source-sealed journal phase");
  }
  assertNoTargetHostConflicts(
    await readTargetHostPtys(options.targetConfig),
    plan.filter((item) => !item.alreadyResumed),
  );
  assertTargetReadiness(targetReadiness, plan);
  return {
    inputs,
    sourceConfig,
    targetSnapshot,
    targetReadiness,
    plan,
    digest: recordedDigest,
    sourceQuiesced: records.some(
      (entry) =>
        entry.status === "complete" &&
        ["source-quiesced", "source-sealed", "target-staged", "verified", "complete"].includes(
          entry.phase,
        ),
    ),
  };
}

async function applyMigration(options) {
  process.umask(0o077);
  receivedSignal = undefined;
  const { loadConfig, resolveObserverPaths } = await import("../../packages/config/dist/index.js");
  const loadedTarget = await loadConfig(options.targetConfig);
  const targetPaths = resolveObserverPaths(loadedTarget.config);
  const migrationId = options.expectPlan.slice(0, 16);
  const migrationRoot = join(targetPaths.stateDir, "session-migrations", migrationId);
  const journalPath = join(migrationRoot, "journal.jsonl");
  const resumed = await loadResumableMigration(options, journalPath);
  const planned = resumed ?? (await planMigration(options));
  const { inputs, sourceConfig, plan, digest } = planned;
  if (options.expectPlan !== digest) {
    throw new Error(`Migration evidence changed; rerun the plan and confirm digest ${digest}`);
  }
  if (resolve(inputs.manifest.metadata.observerPaths.dbPath) === resolve(targetPaths.dbPath)) {
    throw new Error("Source and target Observer state must be different");
  }

  await mkdir(migrationRoot, { recursive: true, mode: 0o700 });
  const migrationLock = await acquireMigrationLock(migrationRoot);
  const reportPath = join(migrationRoot, "report.json");
  const sealedRoot = join(migrationRoot, "sealed-provider-state");
  const launched = [];
  let phase = "planned";
  let sourceMutationStarted = false;
  let sourceQuiesced = resumed?.sourceQuiesced === true;
  let sourceAlreadySealed = false;
  let sourceStopped = false;
  const signals = installSignalHandlers();

  try {
    sourceAlreadySealed = await pathExists(join(sealedRoot, "sealed.json"));
    if (sourceAlreadySealed) sourceQuiesced = true;
    await appendJournal(journalPath, { phase, status: "complete", digest });
    if (sourceAlreadySealed) {
      await verifySealedProviderState(sealedRoot, digest, plan);
    }
    throwIfInterrupted(signals);

    if (!sourceAlreadySealed) {
      await assertTargetUnchangedForCutover(options, planned);
      phase = "quiescing-source";
      sourceMutationStarted = true;
      await appendJournal(journalPath, { phase, status: "started" });
      await quiesceSource(options, sourceConfig, inputs, plan, signals);
      sourceQuiesced = true;
      phase = "source-quiesced";
      await appendJournal(journalPath, { phase, status: "complete" });

      phase = "sealing-provider-state";
      await appendJournal(journalPath, { phase, status: "started" });
      await rm(sealedRoot, { recursive: true, force: true });
      await sealProviderState(inputs, plan, sealedRoot, digest);
      sourceAlreadySealed = true;
      await assertSourceQuiesced(options, sourceConfig, inputs, plan);
      await runCli(options.sourceStn, sourceConfig, ["observer", "stop"]);
      sourceStopped = true;
      phase = "source-sealed";
      await appendJournal(journalPath, { phase, status: "complete", sealedRoot });
      throwIfInterrupted(signals);
    }
    if (sourceAlreadySealed && !sourceStopped) {
      await ensureSealedSourceStopped(options, sourceConfig, inputs, plan);
      sourceStopped = true;
    }

    await verifySealedProviderState(sealedRoot, digest, plan);
    phase = "staging-target";
    await appendJournal(journalPath, { phase, status: "started" });
    await stageProviderState(options, inputs, plan, sealedRoot);
    phase = "target-staged";
    await appendJournal(journalPath, { phase, status: "complete" });

    for (const item of plan) {
      throwIfInterrupted(signals);
      await assertSourceStopped(options, sourceConfig, inputs);
      if (item.alreadyResumed) {
        await dispatchCommand(options.targetStn, options.targetConfig, {
          type: "session.rename",
          payload: { sessionId: item.sessionId, title: item.title },
        });
        launched.push(item.sessionId);
        await appendJournal(journalPath, {
          phase: "target-session-resumed",
          status: "complete",
          sessionId: item.sessionId,
        });
        continue;
      }
      const targetHandle = recoveryHandleForTarget(item);
      await dispatchCommand(options.targetStn, options.targetConfig, {
        type: "session.importRecoveryHandle",
        payload: {
          projectId: item.projectId,
          worktreeId: item.worktreeId,
          expectedPath: item.worktreePath,
          ...(item.registrationIdentity === undefined
            ? {}
            : { expectedRegistrationIdentity: item.registrationIdentity }),
          handle: targetHandle,
        },
      });
      const recoveryHandleId = await importedRecoveryHandleId(options, item);
      await dispatchCommand(options.targetStn, options.targetConfig, {
        type: "session.resumeAgent",
        payload: {
          projectId: item.projectId,
          worktreeId: item.worktreeId,
          recoveryHandleId,
          terminal: { provider: "native", layout: "agent-only", focus: false },
        },
      });
      await dispatchCommand(options.targetStn, options.targetConfig, {
        type: "session.rename",
        payload: { sessionId: item.sessionId, title: item.title },
      });
      launched.push(item.sessionId);
      await appendJournal(journalPath, {
        phase: "target-session-resumed",
        status: "complete",
        sessionId: item.sessionId,
      });
    }

    await assertTargetConverged(options, plan);
    phase = "verified";
    await appendJournal(journalPath, { phase, status: "complete" });

    const report = {
      status: "complete",
      migrationId,
      archivePath: options.archivePath,
      sealedRoot,
      targetConfig: options.targetConfig,
      migratedSessions: plan.map((item) => ({
        sessionId: item.sessionId,
        title: item.title,
        provider: item.provider,
        projectId: item.projectId,
        worktreeId: item.worktreeId,
      })),
      sourceFinalized: true,
    };
    await writePrivateJson(reportPath, report);
    await appendJournal(journalPath, { phase: "complete", status: "complete" });
    return { ...report, reportPath, journalPath };
  } catch (error) {
    await appendJournal(journalPath, {
      phase,
      status: signals.interrupted === undefined ? "failed" : "interrupted",
      error: errorMessage(error),
    });
    await writePrivateJson(reportPath, {
      status: "incomplete",
      migrationId,
      archivePath: options.archivePath,
      phase,
      launchedSessions: launched,
      sourceFinalized: sourceStopped,
      error: errorMessage(error),
    });
    let authority = "Source agents remain authoritative";
    if (sourceAlreadySealed) {
      authority = `Source agents are stopped; retry from sealed evidence in ${migrationRoot}`;
    } else if (sourceQuiesced) {
      authority = `Source agents are stopped; rerun with the same digest to seal final provider state using ${journalPath}`;
    } else if (sourceMutationStarted) {
      authority = `Source sessions may be partially quiesced; rerun with the same digest using ${journalPath}`;
    }
    throw new Error(`${errorMessage(error)}. ${authority}; inspect ${reportPath}`);
  } finally {
    signals.dispose();
    await migrationLock.release().catch(() => undefined);
  }
}

async function assertTargetUnchangedForCutover(options, planned) {
  const snapshot = await cliJson(options.targetStn, options.targetConfig, [
    "snapshot",
    "--json",
    "--require-running",
  ]);
  if (
    snapshot.observer.pid !== planned.targetSnapshot.observer.pid ||
    snapshot.observer.startedAt !== planned.targetSnapshot.observer.startedAt ||
    snapshot.observer.version !== planned.targetSnapshot.observer.version
  ) {
    throw new Error("Target Observer identity changed before source cutover");
  }
  buildSessionMigrationPlan(
    planned.inputs.coverage,
    planned.inputs.handles,
    planned.inputs.snapshot,
    snapshot,
  );
  assertNoTargetHostConflicts(await readTargetHostPtys(options.targetConfig), planned.plan);
  await preflightProviderState(options, planned.inputs, planned.plan);
}

async function preflightProviderState(options, inputs, plan) {
  const providers = new Set(plan.map((item) => item.provider));
  if (
    providers.has("codex") &&
    resolve(options.targetCodexHome) !== resolve(inputs.manifest.metadata.codexHome)
  ) {
    await assertTreeCompatible(
      join(options.archivePath, "providers", "codex", "state_5.sqlite"),
      join(options.targetCodexHome, "state_5.sqlite"),
    );
    await assertTreeCompatible(
      join(options.archivePath, "providers", "codex", "sessions"),
      join(options.targetCodexHome, "sessions"),
    );
    await assertTreeCompatible(
      join(options.archivePath, "providers", "codex", "shell_snapshots"),
      join(options.targetCodexHome, "shell_snapshots"),
    );
  }
  if (
    providers.has("claude") &&
    resolve(options.targetClaudeProjects) !==
      resolve(inputs.manifest.metadata.claudeProjectsRoot ?? "")
  ) {
    await assertTreeCompatible(
      join(options.archivePath, "providers", "claude", "projects"),
      options.targetClaudeProjects,
    );
  }
  if (
    providers.has("opencode") &&
    resolve(options.targetOpenCodeDb) !== resolve(inputs.manifest.metadata.opencodeDb)
  ) {
    await assertTreeCompatible(
      join(options.archivePath, "providers", "opencode", "opencode.sqlite"),
      options.targetOpenCodeDb,
    );
  }
}

async function assertTreeCompatible(source, target) {
  if (!(await pathExists(source)) || !(await pathExists(target))) return;
  const sourceMetadata = await lstat(source);
  if (sourceMetadata.isFile()) {
    const targetMetadata = await lstat(target);
    if (!targetMetadata.isFile() || (await sha256File(source)) !== (await sha256File(target))) {
      throw new Error(`Target recovery asset conflicts with the rescue archive: ${target}`);
    }
    return;
  }
  if (!sourceMetadata.isDirectory()) {
    throw new Error(`Unsupported rescue asset type: ${source}`);
  }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const targetEntry = join(target, entry.name);
    if (await pathExists(targetEntry)) {
      await assertTreeCompatible(join(source, entry.name), targetEntry);
    }
  }
}

async function recoveryReadiness(configPath) {
  const [{ loadConfig, resolveObserverPaths }, protocol] = await Promise.all([
    import("../../packages/config/dist/index.js"),
    import("../../packages/protocol/dist/index.js"),
  ]);
  const loaded = await loadConfig(configPath);
  const paths = resolveObserverPaths(loaded.config);
  const unpinned = protocol.createObserverClient({
    socketPath: paths.socketPath,
    timeoutMs: 5_000,
  });
  const health = await unpinned.health();
  if (health.pid === undefined || health.startedAt === undefined || health.version === undefined) {
    throw new Error("Target Observer did not publish a pinnable recovery-readiness identity");
  }
  const client = protocol.createObserverClient({
    socketPath: paths.socketPath,
    timeoutMs: 5_000,
    expectedObserverIdentity: {
      pid: health.pid,
      startedAt: health.startedAt,
      version: health.version,
      socketPath: paths.socketPath,
    },
  });
  return client.getSessionRecoveryReadiness();
}

function assertTargetReadiness(readiness, plan) {
  if (!readiness.resumeEnabled) {
    throw new Error(
      "Target Observer has session resume disabled; enable feature_flags.session_resume_agent and restart it",
    );
  }
  if (readiness.managedTerminal?.canLaunchProcessPersistently !== true) {
    throw new Error(
      "Target Observer cannot persist native launches; enable feature_flags.station_persistent_agents and restart it",
    );
  }
  const harnesses = new Map(readiness.harnesses.map((item) => [item.provider, item.canResume]));
  for (const item of plan) {
    if (harnesses.get(item.provider) !== true) {
      throw new Error(`Target harness cannot resume provider ${item.provider}`);
    }
  }
}

function assertArchivedRecoveryIdentity(hostPtys, plan) {
  for (const item of plan) {
    const hostPty = hostPtys.find(
      (pty) => pty.alive && pty.kind === "agent" && pty.sessionId === item.sessionId,
    );
    if (
      hostPty !== undefined &&
      (hostPty.worktreeId !== item.worktreeId ||
        hostPty.harnessProvider !== item.provider ||
        (item.handle.target.kind === "native-session" &&
          hostPty.nativeSessionId !== item.handle.target.id))
    ) {
      throw new Error(`Archived Host identity does not match recovery handle: ${item.sessionId}`);
    }
  }
}

function assertSourceMatchesPlan(snapshot, plan) {
  const active = snapshot.sessions.filter((session) => session.origin === "station");
  const expectedIds = new Set(plan.map((item) => item.sessionId));
  const unexpected = active.filter((session) => !expectedIds.has(session.id));
  if (unexpected.length > 0 || active.length !== plan.length) {
    throw new Error(
      `Source session census changed after rescue: ${active.map((session) => session.id).join(", ")}`,
    );
  }
  for (const item of plan) {
    const session = active.find((candidate) => candidate.id === item.sessionId);
    if (
      session === undefined ||
      session.projectId !== item.projectId ||
      session.worktreeId !== item.worktreeId ||
      session.harness.provider !== item.provider
    ) {
      throw new Error(`Source session identity changed after rescue: ${item.sessionId}`);
    }
  }
}

function migrationPlanDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function quiesceSource(options, sourceConfig, inputs, plan, signals) {
  const snapshot = await cliJson(options.sourceStn, sourceConfig, [
    "snapshot",
    "--json",
    "--require-running",
  ]);
  if (
    snapshot.observer.pid !== inputs.snapshot.observer.pid ||
    snapshot.observer.startedAt !== inputs.snapshot.observer.startedAt ||
    snapshot.observer.version !== inputs.snapshot.observer.version
  ) {
    throw new Error("Source Observer identity changed before source cutover");
  }
  const active = snapshot.sessions.filter((session) => session.origin === "station");
  const expectedIds = new Set(plan.map((item) => item.sessionId));
  const unexpected = active.filter((session) => !expectedIds.has(session.id));
  if (unexpected.length > 0) {
    throw new Error(
      `New source sessions appeared before cutover: ${unexpected.map((session) => session.id).join(", ")}`,
    );
  }
  for (const item of plan) {
    const session = active.find((candidate) => candidate.id === item.sessionId);
    if (
      session !== undefined &&
      (session.projectId !== item.projectId ||
        session.worktreeId !== item.worktreeId ||
        session.harness.provider !== item.provider)
    ) {
      throw new Error(`Source session identity changed before cutover: ${item.sessionId}`);
    }
  }
  assertHostPtySubset(inputs.hostPtys, await readSourceHostPtys(inputs));
  for (const item of plan) {
    if (!active.some((session) => session.id === item.sessionId)) continue;
    throwIfInterrupted(signals);
    await dispatchCommand(options.sourceStn, sourceConfig, {
      type: "session.close",
      payload: { sessionId: item.sessionId, mode: "all", force: false },
    });
  }
  await assertSourceQuiesced(options, sourceConfig, inputs, plan);
}

async function assertSourceQuiesced(options, sourceConfig, inputs, plan) {
  const snapshot = await cliJson(options.sourceStn, sourceConfig, [
    "snapshot",
    "--json",
    "--require-running",
  ]);
  const plannedIds = new Set(plan.map((item) => item.sessionId));
  const remaining = snapshot.sessions.filter(
    (session) => session.origin === "station" && plannedIds.has(session.id),
  );
  if (remaining.length > 0) {
    throw new Error(
      `Source sessions did not quiesce: ${remaining.map((session) => session.id).join(", ")}`,
    );
  }
  const unexpected = snapshot.sessions.filter(
    (session) => session.origin === "station" && !plannedIds.has(session.id),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `New source sessions appeared during cutover: ${unexpected.map((session) => session.id).join(", ")}`,
    );
  }
  const livePtys = (await readSourceHostPtys(inputs)).filter((pty) => pty.alive);
  if (livePtys.length > 0) {
    throw new Error(
      `Source Host still owns live PTYs: ${livePtys.map((pty) => pty.ptyId).join(", ")}`,
    );
  }
}

async function readSourceHostPtys(inputs) {
  const host = await import("../../packages/station-host/dist/index.js");
  const client = host.createStationHostClient({
    socketPath: inputs.manifest.metadata.hostSocketPath,
    timeoutMs: 5_000,
    expectedBuildVersion: inputs.manifest.metadata.stationVersion,
  });
  try {
    await client.health();
    return await client.list();
  } finally {
    client.dispose();
  }
}

function assertHostPtySubset(archived, live) {
  const archivedById = new Map(archived.filter((pty) => pty.alive).map((pty) => [pty.ptyId, pty]));
  const changed = live
    .filter((pty) => pty.alive)
    .some((pty) => {
      const expected = archivedById.get(pty.ptyId);
      return (
        expected === undefined ||
        expected.sessionId !== pty.sessionId ||
        expected.worktreeId !== pty.worktreeId ||
        expected.nativeSessionId !== pty.nativeSessionId
      );
    });
  if (changed) {
    throw new Error("Source Host acquired or replaced a PTY after rescue");
  }
}

function assertHostPtyCensus(archived, live) {
  const archivedAlive = archived.filter((pty) => pty.alive);
  const liveAlive = live.filter((pty) => pty.alive);
  if (
    archivedAlive.length !== liveAlive.length ||
    archivedAlive.some((pty) => {
      const current = liveAlive.find((candidate) => candidate.ptyId === pty.ptyId);
      return (
        current === undefined ||
        current.sessionId !== pty.sessionId ||
        current.worktreeId !== pty.worktreeId ||
        current.nativeSessionId !== pty.nativeSessionId
      );
    })
  ) {
    throw new Error("Source Host PTY census changed after rescue; create a fresh archive");
  }
}

async function sealProviderState(inputs, plan, sealedRoot, digest) {
  const [codex, claude, opencode] = await Promise.all([
    import("../../integrations/harness/codex/dist/index.js"),
    import("../../integrations/harness/claude/dist/index.js"),
    import("../../integrations/harness/opencode/dist/index.js"),
  ]);
  const claudeProjects = inputs.manifest.metadata.claudeProjectsRoot;
  const locators = new Map([
    ["codex", codex.createCodexRecoveryArtifactLocator(inputs.manifest.metadata.codexHome)],
    ...(claudeProjects === undefined
      ? []
      : [["claude", claude.createClaudeRecoveryArtifactLocator(claudeProjects)]]),
    [
      "opencode",
      opencode.createOpenCodeRecoveryArtifactLocator(inputs.manifest.metadata.opencodeDb),
    ],
  ]);
  let codexStateSealed = false;
  let openCodeSealed = false;
  for (const item of plan) {
    const locator = locators.get(item.provider);
    if (locator === undefined) {
      throw new Error(`Provider ${item.provider} has no recovery artifact adapter`);
    }
    const assets = await locator.locate(item.handle);
    if (assets.length === 0) {
      throw new Error(`No final recovery assets found for ${item.sessionId}`);
    }
    if (item.provider === "opencode") {
      if (!openCodeSealed) {
        await backupSqlite(assets[0], join(sealedRoot, "providers", "opencode", "opencode.sqlite"));
        openCodeSealed = true;
      }
      continue;
    }
    for (const asset of assets) {
      const target = sealedArtifactTarget(inputs, item, asset, sealedRoot);
      if (
        item.provider === "codex" &&
        resolve(asset) === resolve(join(inputs.manifest.metadata.codexHome, "state_5.sqlite"))
      ) {
        if (!codexStateSealed) {
          await backupSqlite(asset, target);
          codexStateSealed = true;
        }
        continue;
      }
      await copyVerifiedFile(asset, target);
    }
  }
  const seal = SessionMigrationSealSchema.parse({
    sealedAt: new Date().toISOString(),
    digest,
    sessions: plan.map((item) => item.sessionId),
    files: await collectSealedFiles(sealedRoot),
  });
  await writePrivateJson(join(sealedRoot, "sealed.json"), seal);
}

async function verifySealedProviderState(sealedRoot, digest, plan) {
  let seal;
  try {
    seal = SessionMigrationSealSchema.parse(
      JSON.parse(await readFile(join(sealedRoot, "sealed.json"), "utf8")),
    );
  } catch (error) {
    throw new Error(`Sealed provider state is invalid: ${errorMessage(error)}`, { cause: error });
  }
  const expectedSessions = plan.map((item) => item.sessionId);
  if (
    seal.digest !== digest ||
    JSON.stringify(seal.sessions) !== JSON.stringify(expectedSessions)
  ) {
    throw new Error("Sealed provider state does not match the confirmed migration plan");
  }
  const files = await collectSealedFiles(sealedRoot);
  if (JSON.stringify(files) !== JSON.stringify(seal.files)) {
    throw new Error("Sealed provider state changed after source quiescence");
  }
}

async function collectSealedFiles(root, current = root) {
  const files = [];
  if (!(await pathExists(current))) return files;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (path === join(root, "sealed.json")) continue;
    if (entry.isDirectory()) {
      files.push(...(await collectSealedFiles(root, path)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported sealed recovery asset type: ${path}`);
    }
    const metadata = await stat(path);
    files.push({
      path: relative(root, path),
      type: "file",
      size: metadata.size,
      sha256: await sha256File(path),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function sealedArtifactTarget(inputs, item, asset, sealedRoot) {
  if (item.provider === "codex") {
    if (!isUnder(asset, inputs.manifest.metadata.codexHome)) {
      throw new Error(`Codex recovery asset escaped its provider root: ${asset}`);
    }
    return join(
      sealedRoot,
      "providers",
      "codex",
      relative(inputs.manifest.metadata.codexHome, asset),
    );
  }
  if (item.provider === "claude") {
    const claudeProjects = inputs.manifest.metadata.claudeProjectsRoot;
    if (claudeProjects === undefined) {
      throw new Error("Rescue archive does not record the source Claude projects directory");
    }
    if (!isUnder(asset, claudeProjects)) {
      throw new Error(`Claude recovery asset escaped its provider root: ${asset}`);
    }
    return join(sealedRoot, "providers", "claude", "projects", relative(claudeProjects, asset));
  }
  throw new Error(`Unsupported recovery artifact provider: ${item.provider}`);
}

async function ensureSealedSourceStopped(options, sourceConfig, inputs, plan) {
  const status = await cliJson(options.sourceStn, sourceConfig, ["observer", "status", "--json"]);
  if (status.status === "running") {
    await assertSourceQuiesced(options, sourceConfig, inputs, plan);
    await runCli(options.sourceStn, sourceConfig, ["observer", "stop"]);
  }
  await assertSourceStopped(options, sourceConfig, inputs);
}

async function assertSourceStopped(options, sourceConfig, inputs) {
  const status = await cliJson(options.sourceStn, sourceConfig, ["observer", "status", "--json"]);
  if (status.status === "running") {
    throw new Error("Source Observer restarted during target cutover");
  }
  const livePtys = (await readSourceHostPtys(inputs)).filter((pty) => pty.alive);
  if (livePtys.length > 0) {
    throw new Error("Source Host acquired a PTY during target cutover");
  }
}

function recoveryHandleForTarget(item) {
  return {
    ...item.handle,
    projectId: item.projectId,
    worktreeId: item.worktreeId,
    sessionId: item.sessionId,
    cwd: item.worktreePath,
  };
}

async function importedRecoveryHandleId(options, item) {
  const snapshot = await cliJson(options.targetStn, options.targetConfig, [
    "snapshot",
    "--json",
    "--require-running",
  ]);
  const row = snapshot.rows.find((candidate) => candidate.id === item.worktreeId);
  if (
    row?.recovery?.provider !== item.provider ||
    row.recovery.targetKind !== item.handle.target.kind
  ) {
    throw new Error(`Imported recovery handle is not visible for ${item.sessionId}`);
  }
  return row.recovery.handleId;
}

async function acquireMigrationLock(migrationRoot) {
  const path = join(migrationRoot, "apply.lock");
  const token = randomUUID();
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        const lock = SessionMigrationLockSchema.parse({
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        });
        await handle.writeFile(`${JSON.stringify(lock)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          try {
            const current = SessionMigrationLockSchema.parse(
              JSON.parse(await readFile(path, "utf8")),
            );
            if (current.token === token) await rm(path);
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let current;
      try {
        current = SessionMigrationLockSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (parseError) {
        throw new Error(`Migration lock is invalid: ${errorMessage(parseError)}`, {
          cause: parseError,
        });
      }
      if (processIsAlive(current.pid)) {
        throw new Error(`Migration apply is already running as process ${current.pid}`);
      }
      try {
        await rm(path);
      } catch (removeError) {
        if (removeError?.code !== "ENOENT") throw removeError;
      }
    }
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function appendJournal(path, entry) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const record = SessionMigrationJournalEntrySchema.parse({
    at: new Date().toISOString(),
    ...entry,
  });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

function installSignalHandlers() {
  const state = { interrupted: undefined, dispose: undefined };
  const interrupt = (signal) => {
    state.interrupted ??= signal;
    receivedSignal ??= signal;
    activeChild?.kill("SIGTERM");
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, interrupt);
  state.dispose = () => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, interrupt);
  };
  return state;
}

function throwIfInterrupted(signals) {
  if (signals.interrupted !== undefined) {
    throw new Error(`Migration interrupted by ${signals.interrupted}`);
  }
}

async function stageProviderState(options, inputs, plan, sealedRoot) {
  const providers = new Set(plan.map((item) => item.provider));
  if (providers.has("codex")) {
    const targetStateDatabase = join(options.targetCodexHome, "state_5.sqlite");
    const sourceStateDatabase = join(inputs.manifest.metadata.codexHome, "state_5.sqlite");
    if (resolve(targetStateDatabase) !== resolve(sourceStateDatabase)) {
      await copyVerifiedFile(
        join(sealedRoot, "providers", "codex", "state_5.sqlite"),
        targetStateDatabase,
      );
    }
    await copyTree(
      join(sealedRoot, "providers", "codex", "sessions"),
      join(options.targetCodexHome, "sessions"),
    );
    await copyTree(
      join(sealedRoot, "providers", "codex", "shell_snapshots"),
      join(options.targetCodexHome, "shell_snapshots"),
    );
  }
  if (providers.has("claude")) {
    await copyTree(
      join(sealedRoot, "providers", "claude", "projects"),
      options.targetClaudeProjects,
    );
  }
  if (
    providers.has("opencode") &&
    resolve(options.targetOpenCodeDb) !== resolve(inputs.manifest.metadata.opencodeDb)
  ) {
    await copyVerifiedFile(
      join(sealedRoot, "providers", "opencode", "opencode.sqlite"),
      options.targetOpenCodeDb,
    );
  }
}

async function assertTargetConverged(options, plan) {
  const snapshot = await waitForSnapshot(options.targetStn, options.targetConfig);
  const hostPtys = await readTargetHostPtys(options.targetConfig);
  for (const item of plan) {
    const session = snapshot.sessions.find((candidate) => candidate.id === item.sessionId);
    const hostPty = hostPtys.find(
      (pty) =>
        pty.alive &&
        pty.kind === "agent" &&
        pty.sessionId === item.sessionId &&
        pty.worktreeId === item.worktreeId &&
        pty.harnessProvider === item.provider,
    );
    const nativeIdentityMatches =
      item.handle.target.kind !== "native-session" ||
      hostPty?.nativeSessionId === item.handle.target.id;
    if (
      session === undefined ||
      session.worktreeId !== item.worktreeId ||
      session.harness.provider !== item.provider ||
      (session.terminal?.state !== "open" && session.terminal?.state !== "detached") ||
      hostPty === undefined ||
      !nativeIdentityMatches
    ) {
      throw new Error(`Target session did not converge with its exact Host PTY: ${item.sessionId}`);
    }
  }
}

function assertNoTargetHostConflicts(hostPtys, plan) {
  const sessionIds = new Set(plan.map((item) => item.sessionId));
  const worktreeIds = new Set(plan.map((item) => item.worktreeId));
  const nativeIds = new Set(
    plan
      .filter((item) => item.handle.target.kind === "native-session")
      .map((item) => item.handle.target.id),
  );
  const conflicts = hostPtys.filter(
    (pty) =>
      pty.alive &&
      (sessionIds.has(pty.sessionId) ||
        worktreeIds.has(pty.worktreeId) ||
        nativeIds.has(pty.nativeSessionId)),
  );
  if (conflicts.length > 0) {
    throw new Error(
      `Target Host already owns planned recovery identities: ${conflicts.map((pty) => pty.ptyId).join(", ")}`,
    );
  }
}

async function readTargetHostPtys(configPath) {
  const [{ loadConfig, stationHostSocketPath }, host, runtime] = await Promise.all([
    import("../../packages/config/dist/index.js"),
    import("../../packages/station-host/dist/index.js"),
    import("../../packages/runtime/dist/index.js"),
  ]);
  const loaded = await loadConfig(configPath);
  const socketPath = stationHostSocketPath(loaded.config);
  if (!(await pathExists(socketPath))) return [];
  const client = host.createStationHostClient({
    socketPath,
    timeoutMs: 5_000,
    expectedBuildVersion: runtime.stationBuildInfo().version,
  });
  try {
    await client.health();
    return await client.list();
  } finally {
    client.dispose();
  }
}

async function waitForSnapshot(stn, configPath) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const snapshot = await cliJson(stn, configPath, ["snapshot", "--json", "--require-running"]);
      if (Array.isArray(snapshot.rows)) return snapshot;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`Target Observer did not converge: ${errorMessage(lastError)}`);
}

async function parseJsonFile(path, schema, label) {
  try {
    const text = await readFile(path, "utf8");
    return schema.parse(JSON.parse(text));
  } catch (error) {
    throw new Error(`${label} is invalid: ${errorMessage(error)}`, { cause: error });
  }
}

async function dispatchCommand(stn, configPath, command) {
  await runCli(
    stn,
    configPath,
    ["command", "dispatch", "--stdin", "--wait", "--timeout-ms", "60000"],
    {
      input: `${JSON.stringify(command)}\n`,
    },
  );
}

async function cliJson(stn, configPath, args) {
  const { stdout } = await runCli(stn, configPath, args);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Station CLI returned invalid JSON: ${errorMessage(error)}`, { cause: error });
  }
}

async function runCli(stn, configPath, args, options = {}) {
  try {
    return await run(stn, ["--config", configPath, ...args], options);
  } catch (error) {
    if (options.allowFailure) return { stdout: "", stderr: errorMessage(error) };
    throw error;
  }
}

async function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChild = child;
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      rejectRun(error);
    };
    const collect = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxCommandOutput) {
        child.kill("SIGTERM");
        rejectOnce(new Error(`${command} output exceeded the migration limit`));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", rejectOnce);
    child.once("close", (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      if (settled) return;
      settled = true;
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolveRun(output);
      else {
        rejectRun(
          new Error(
            `${command} exited ${code ?? signal ?? "unknown"}: ${output.stderr || output.stdout}`,
          ),
        );
      }
    });
    child.stdin.end(options.input);
  });
}

async function backupSqlite(sourcePath, targetPath) {
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, targetPath);
  } finally {
    source.close();
  }
}

async function copyTree(source, target, onlyBasename) {
  if (!(await pathExists(source))) return;
  const sourceMetadata = await lstat(source);
  if (sourceMetadata.isSymbolicLink()) {
    throw new Error(`Recovery state cannot contain a symlink: ${source}`);
  }
  if (sourceMetadata.isFile()) {
    if (onlyBasename === undefined || basename(source) === onlyBasename) {
      await copyVerifiedFile(source, target);
    }
    return;
  }
  if (!sourceMetadata.isDirectory()) {
    throw new Error(`Unsupported recovery asset type: ${source}`);
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (onlyBasename !== undefined && entry.name !== onlyBasename) continue;
    await copyTree(join(source, entry.name), join(target, entry.name));
  }
}

async function copyVerifiedFile(source, target) {
  const before = await stat(source);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (await pathExists(target)) {
    const [sourceHash, targetHash] = await Promise.all([sha256File(source), sha256File(target)]);
    if (sourceHash !== targetHash) {
      throw new Error(`Target recovery asset conflicts with sealed state: ${target}`);
    }
  } else {
    await copyFile(source, target);
    await chmod(target, 0o600);
  }
  const after = await stat(source);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`Recovery asset changed during sealing: ${source}`);
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", resolveHash);
    stream.once("error", rejectHash);
  });
  return hash.digest("hex");
}

async function writePrivateJson(path, value) {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePrivateFile(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode: 0o600 });
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function requiredOptionValue(args, index, option) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function resolveInputPath(input, cwd, homeDir) {
  let expanded = input;
  if (input === "~") expanded = homeDir;
  else if (input.startsWith("~/")) expanded = join(homeDir, input.slice(2));
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printHelp() {
  process.stdout.write(`Usage:
  pnpm station:sessions:migrate -- --archive <path> --target-config <config.toml> [options]
  pnpm station:sessions:migrate -- --archive <path> --target-config <config.toml> [options] --yes --expect-plan <sha256>

Without --yes, validates the complete rescue archive and prints a read-only migration plan and
digest. Apply revalidates that digest, closes the exact source sessions without force, seals final
provider state, stops the source Observer, then imports and resumes target sessions. Source and
target agents never run concurrently; a failure after sealing is retried from the migration report.\n`);
}

async function main() {
  const options = parseSessionMigrationArgs(process.argv.slice(2));
  if (options.command === "help") {
    printHelp();
    return;
  }
  if (options.command === "plan") {
    const { plan, digest } = await planMigration(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "planned",
          digest,
          applyWith: `--yes --expect-plan ${digest}`,
          sourceFinalized: false,
          sessions: plan.map((item) => ({
            sessionId: item.sessionId,
            title: item.title,
            provider: item.provider,
            projectId: item.projectId,
            worktreeId: item.worktreeId,
            worktreePath: item.worktreePath,
            recoveryHandleId: item.handle.id,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(await applyMigration(options), null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = receivedSignal === undefined ? 1 : 130;
  });
}
