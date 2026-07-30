#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { verifySessionRescueArchive } from "./session-rescue.mjs";

const execFile = promisify(execFileCallback);
const maxCommandOutput = 128 * 1024 * 1024;

const ObserverPathsSchema = z
  .object({
    stateDir: z.string().min(1),
    socketPath: z.string().min(1),
    dbPath: z.string().min(1),
    logDir: z.string().min(1),
    diagnosticsDir: z.string().min(1),
    hookSpoolDir: z.string().min(1),
  })
  .strict();

const RescueMetadataSchema = z
  .object({
    configPath: z.string().min(1),
    codexHome: z.string().min(1),
    opencodeDb: z.string().min(1),
    observerPaths: ObserverPathsSchema,
    hostSocketPath: z.string().min(1),
    stationVersion: z.string().min(1),
    stationBuildIdentity: z.string().min(1),
    observerBuildVersion: z.string().min(1),
  })
  .strict();

const ManifestFileSchema = z.discriminatedUnion("type", [
  z
    .object({
      path: z.string().min(1),
      type: z.literal("file"),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .strict(),
  z
    .object({
      path: z.string().min(1),
      type: z.literal("symlink"),
      target: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .strict(),
]);

const RescueManifestSchema = z
  .object({
    archiveVersion: z.literal(1),
    createdAt: z.string().min(1),
    status: z.enum(["complete", "partial"]),
    warnings: z.array(z.string()),
    critical: z.array(z.string()),
    metadata: RescueMetadataSchema,
    files: z.array(ManifestFileSchema),
  })
  .strict();

const RecoveryCoverageSchema = z.array(
  z
    .object({
      sessionId: z.string().min(1),
      provider: z.string().min(1),
      projectId: z.string().min(1),
      worktreeId: z.string().min(1),
      terminalTargetId: z.string().min(1).optional(),
      ptyId: z.string().min(1).optional(),
      exactHandleIds: z.array(z.string().min(1)),
      candidateHandleIds: z.array(z.string().min(1)),
    })
    .strict(),
);

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

  return {
    command: apply ? "apply" : "plan",
    archivePath: resolveInputPath(archivePath, cwd, homeDir),
    targetConfig: resolveInputPath(targetConfig, cwd, homeDir),
    targetStn,
    sourceConfig:
      sourceConfig === undefined ? undefined : resolveInputPath(sourceConfig, cwd, homeDir),
    sourceStn,
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

export function buildSessionMigrationPlan(coverage, handles, snapshot, targetSnapshot) {
  const handlesById = new Map(handles.map((handle) => [handle.id, handle]));
  const sourceSessions = new Map(snapshot.sessions.map((session) => [session.id, session]));
  const sourceRows = new Map(snapshot.rows.map((row) => [row.id, row]));
  const targetRows = new Map(targetSnapshot.rows.map((row) => [row.id, row]));
  const targetSessionsByWorktree = new Map(
    targetSnapshot.sessions.map((session) => [session.worktreeId, session]),
  );

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
    if (sourceSession === undefined || sourceRow === undefined) {
      throw new Error(`Session ${item.sessionId} is absent from the archived snapshot`);
    }
    if (targetRow === undefined || targetRow.path !== sourceRow.path) {
      throw new Error(
        `Target Station does not contain the same worktree identity: ${item.worktreeId}`,
      );
    }
    if (targetSessionsByWorktree.has(item.worktreeId)) {
      throw new Error(`Target worktree already has a session: ${item.worktreeId}`);
    }
    if (handle.provider !== item.provider || handle.worktreeId !== item.worktreeId) {
      throw new Error(`Recovery handle ${handle.id} does not match session ${item.sessionId}`);
    }
    return {
      sessionId: item.sessionId,
      title: sourceSession.title,
      provider: item.provider,
      projectId: item.projectId,
      worktreeId: item.worktreeId,
      worktreePath: sourceRow.path,
      handle,
    };
  });
}

export function enableSessionResumeFeature(configText) {
  const lines = configText.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() === "[feature_flags]");
  if (headerIndex === -1) {
    const separator = configText.endsWith("\n") ? "" : "\n";
    return `${configText}${separator}\n[feature_flags]\nsession_resume_agent = true\n`;
  }
  let end = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  const keyIndex = lines.findIndex(
    (line, index) =>
      index > headerIndex && index < end && /^\s*session_resume_agent\s*=/u.test(line),
  );
  if (keyIndex === -1) lines.splice(end, 0, "session_resume_agent = true");
  else lines[keyIndex] = "session_resume_agent = true";
  return lines.join("\n");
}

async function loadMigrationInputs(options) {
  const verification = await verifySessionRescueArchive(options.archivePath);
  if (!verification.ok) {
    throw new Error(`Rescue archive verification failed: ${verification.errors.join("; ")}`);
  }
  const manifest = await parseJsonFile(
    join(options.archivePath, "manifest.json"),
    RescueManifestSchema,
    "Rescue manifest",
  );
  if (manifest.status !== "complete" || manifest.critical.length > 0) {
    throw new Error("A partial rescue archive cannot authorize migration");
  }
  const contracts = await import("../../packages/contracts/dist/index.js");
  const handles = await parseJsonFile(
    join(options.archivePath, "observer", "recovery-handles.json"),
    z.array(contracts.SessionRecoveryHandleSchema),
    "Recovery handles",
  );
  const coverage = await parseJsonFile(
    join(options.archivePath, "observer", "recovery-coverage.json"),
    RecoveryCoverageSchema,
    "Recovery coverage",
  );
  const snapshot = await parseJsonFile(
    join(options.archivePath, "observer", "snapshot.json"),
    contracts.StationSnapshotSchema,
    "Observer snapshot",
  );
  return { verification, manifest, handles, coverage, snapshot };
}

async function planMigration(options) {
  const inputs = await loadMigrationInputs(options);
  const targetSnapshot = await cliJson(options.targetStn, options.targetConfig, [
    "snapshot",
    "--json",
  ]);
  const plan = buildSessionMigrationPlan(
    inputs.coverage,
    inputs.handles,
    inputs.snapshot,
    targetSnapshot,
  );
  return { inputs, targetSnapshot, plan };
}

async function applyMigration(options) {
  process.umask(0o077);
  const { loadConfig, resolveObserverPaths } = await import("../../packages/config/dist/index.js");
  const { inputs, plan } = await planMigration(options);
  const loadedTarget = await loadConfig(options.targetConfig);
  const targetPaths = resolveObserverPaths(loadedTarget.config);
  if (resolve(inputs.manifest.metadata.observerPaths.dbPath) === resolve(targetPaths.dbPath)) {
    throw new Error("Source and target Observer state must be different");
  }

  const migrationId = createHash("sha256")
    .update(`${inputs.manifest.createdAt}\0${options.targetConfig}`)
    .digest("hex")
    .slice(0, 16);
  const migrationRoot = join(targetPaths.stateDir, "session-migrations", migrationId);
  await mkdir(migrationRoot, { recursive: true, mode: 0o700 });
  const reportPath = join(migrationRoot, "report.json");
  const originalConfig = await readFile(options.targetConfig, "utf8");
  const configBackup = join(migrationRoot, "target-config.before.toml");
  await writePrivateFile(configBackup, originalConfig);
  const targetDbBackup = join(migrationRoot, "observer.before.sqlite");
  let targetConfigChanged = false;
  let targetStopped = false;
  let targetStarted = false;
  const launched = [];

  try {
    await stageProviderState(options, inputs, plan, migrationRoot);
    const enabledConfig = enableSessionResumeFeature(originalConfig);
    if (enabledConfig !== originalConfig) {
      await atomicReplace(options.targetConfig, enabledConfig);
      targetConfigChanged = true;
    }

    await runCli(options.targetStn, options.targetConfig, ["observer", "stop"]);
    targetStopped = true;
    await backupSqlite(targetPaths.dbPath, targetDbBackup);
    const importedHandles = importRecoveryHandles(targetPaths.dbPath, plan, migrationRoot);

    await runCli(options.targetStn, options.targetConfig, ["observer", "start"]);
    targetStarted = true;
    await waitForSnapshot(options.targetStn, options.targetConfig);

    for (const item of plan) {
      const recoveryHandleId = importedHandles.get(item.handle.id);
      if (recoveryHandleId === undefined)
        throw new Error(`Handle import missing: ${item.handle.id}`);
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
    }

    await assertTargetConverged(options, plan);
    await finalizeSource(options, inputs, plan);

    const report = {
      status: "complete",
      migrationId,
      archivePath: options.archivePath,
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
    return { ...report, reportPath };
  } catch (error) {
    await writePrivateJson(reportPath, {
      status: "incomplete",
      migrationId,
      archivePath: options.archivePath,
      launchedSessions: launched,
      sourceFinalized: false,
      error: errorMessage(error),
    });
    throw new Error(
      `${errorMessage(error)}. Source finalization did not complete; preserve both runtimes and inspect ${reportPath}`,
    );
  } finally {
    if (targetConfigChanged) {
      await atomicReplace(options.targetConfig, originalConfig).catch(() => undefined);
      if (targetStarted || targetStopped) {
        await runCli(options.targetStn, options.targetConfig, ["observer", "restart"], {
          allowFailure: true,
        }).catch(() => undefined);
      }
    }
  }
}

async function stageProviderState(options, inputs, plan, migrationRoot) {
  const providers = new Set(plan.map((item) => item.provider));
  if (providers.has("codex")) {
    await copyTree(
      join(options.archivePath, "providers", "codex", "sessions"),
      join(options.targetCodexHome, "sessions"),
    );
    await copyTree(
      join(options.archivePath, "providers", "codex", "shell_snapshots"),
      join(options.targetCodexHome, "shell_snapshots"),
    );
  }
  if (providers.has("claude")) {
    await copyTree(
      join(options.archivePath, "providers", "claude", "projects"),
      options.targetClaudeProjects,
    );
  }
  if (providers.has("opencode")) {
    const archived = join(options.archivePath, "providers", "opencode", "opencode.sqlite");
    const target = options.targetOpenCodeDb;
    const missingIds = plan
      .filter(
        (item) => item.provider === "opencode" && item.handle.target.kind === "native-session",
      )
      .map((item) => item.handle.target.id)
      .filter((id) => !sqliteRowExists(target, "session", id));
    if (missingIds.length > 0 && !(await pathExists(target))) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await cp(archived, target, { force: false });
    } else if (missingIds.length > 0) {
      throw new Error(
        `Target OpenCode database is missing rescued sessions and cannot be merged safely: ${missingIds.join(", ")}`,
      );
    }
  }
  for (const item of plan) {
    if (item.handle.target.kind !== "session-file") continue;
    const sourceDir = join(
      options.archivePath,
      "providers",
      safeSegment(item.provider),
      "sessions",
      safeSegment(item.handle.id),
    );
    const targetDir = join(migrationRoot, "session-files", safeSegment(item.handle.id));
    await copyTree(sourceDir, targetDir);
  }
  void inputs;
}

export function importRecoveryHandles(databasePath, plan, migrationRoot) {
  const database = new DatabaseSync(databasePath);
  const imported = new Map();
  try {
    database.exec("BEGIN IMMEDIATE");
    const byTarget = database.prepare(
      "SELECT * FROM session_recovery_handles WHERE provider = ? AND target_kind = ? AND target_value = ?",
    );
    const insert = database.prepare(`
      INSERT INTO session_recovery_handles
        (id, provider, project_id, worktree_id, session_id, target_kind, target_value,
         cwd, terminal_target_id, harness_run_id, observed_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of plan) {
      const handle = item.handle;
      let targetValue;
      if (handle.target.kind === "session-file") {
        targetValue = join(
          migrationRoot,
          "session-files",
          safeSegment(handle.id),
          basename(handle.target.path),
        );
      } else {
        targetValue = handle.target.id;
      }
      const existing = byTarget.get(handle.provider, handle.target.kind, targetValue);
      if (existing !== undefined) {
        if (
          existing.project_id !== item.projectId ||
          existing.worktree_id !== item.worktreeId ||
          existing.session_id !== item.sessionId
        ) {
          throw new Error(`Target recovery identity conflicts with ${handle.id}`);
        }
        imported.set(handle.id, existing.id);
        continue;
      }
      insert.run(
        handle.id,
        handle.provider,
        item.projectId,
        item.worktreeId,
        item.sessionId,
        handle.target.kind,
        targetValue,
        item.worktreePath,
        handle.terminalTargetId ?? null,
        handle.harnessRunId ?? null,
        handle.observedAt,
        handle.lastSeenAt,
      );
      imported.set(handle.id, handle.id);
    }
    database.exec("COMMIT");
    return imported;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    database.close();
  }
}

async function assertTargetConverged(options, plan) {
  const snapshot = await waitForSnapshot(options.targetStn, options.targetConfig);
  for (const item of plan) {
    const session = snapshot.sessions.find((candidate) => candidate.id === item.sessionId);
    if (
      session === undefined ||
      session.worktreeId !== item.worktreeId ||
      session.harness.provider !== item.provider ||
      (session.terminal?.state !== "open" && session.terminal?.state !== "detached")
    ) {
      throw new Error(`Target session did not converge with a live terminal: ${item.sessionId}`);
    }
  }
}

async function finalizeSource(options, inputs, plan) {
  if (options.sourceDevboxRoot !== undefined) {
    await run("pnpm", ["--dir", options.sourceDevboxRoot, "station:devbox", "stop"]);
    return;
  }
  const sourceConfig = options.sourceConfig ?? inputs.manifest.metadata.configPath;
  if (resolve(sourceConfig) === resolve(options.targetConfig)) {
    throw new Error("Source and target config paths must differ");
  }
  for (const item of plan) {
    await dispatchCommand(options.sourceStn, sourceConfig, {
      type: "session.close",
      payload: { sessionId: item.sessionId, mode: "all", force: true },
    });
  }
}

async function waitForSnapshot(stn, configPath) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const snapshot = await cliJson(stn, configPath, ["snapshot", "--json"]);
      if (snapshot.rows.length > 0) return snapshot;
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
  if (options.input === undefined) {
    return execFile(command, args, {
      encoding: "utf8",
      env: options.env ?? process.env,
      maxBuffer: maxCommandOutput,
    });
  }
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const collect = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxCommandOutput) {
        child.kill("SIGTERM");
        rejectRun(new Error(`${command} output exceeded the migration limit`));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
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

async function copyTree(source, target) {
  if (!(await pathExists(source))) return;
  await mkdir(target, { recursive: true, mode: 0o700 });
  await cp(source, target, { recursive: true, force: false, errorOnExist: false });
}

function sqliteRowExists(path, table, id) {
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id) !== undefined;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

async function atomicReplace(path, content) {
  const temporary = `${path}.session-migration-${process.pid}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
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

function safeSegment(value) {
  const sanitized = value.replaceAll(/[^0-9A-Za-z._-]/gu, "_");
  return sanitized.length > 0 ? sanitized : "session";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printHelp() {
  process.stdout.write(`Usage:
  pnpm station:sessions:migrate -- --archive <path> --target-config <config.toml> [options]
  pnpm station:sessions:migrate -- --archive <path> --target-config <config.toml> [options] --yes

Without --yes, validates the complete rescue archive and prints a non-mutating migration plan.
With --yes, stages provider state, imports exact recovery handles while the target Observer is
stopped, resumes and verifies every target session, then closes the source sessions. Use
--source-devbox-root for an isolated devbox source; otherwise the archived source config is used.
The source is never finalized until every target session has a live terminal.\n`);
}

async function main() {
  const options = parseSessionMigrationArgs(process.argv.slice(2));
  if (options.command === "help") {
    printHelp();
    return;
  }
  if (options.command === "plan") {
    const { plan } = await planMigration(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "planned",
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
    process.exitCode = 1;
  });
}
