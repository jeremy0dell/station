#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const manifestName = "manifest.json";
const incompleteName = "INCOMPLETE";
const archiveVersion = 1;
const maxCommandOutput = 128 * 1024 * 1024;

export function parseSessionRescueArgs(args, deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const homeDir = deps.homeDir ?? homedir();
  const now = deps.now ?? new Date();
  const input = args.filter((arg) => arg !== "--");
  const command = input[0] === "save" || input[0] === "verify" ? input.shift() : "save";

  if (command === "verify") {
    if (input.length !== 1 || input[0]?.startsWith("--")) {
      throw new Error("Usage: session-rescue.mjs verify <archive-path>");
    }
    return { command, archivePath: resolveInputPath(input[0], cwd, homeDir) };
  }

  let configPath;
  let codexHome;
  let opencodeDb;
  let outputPath;
  let devbox = false;
  let timeoutMs = 5_000;

  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    switch (arg) {
      case "--devbox":
        devbox = true;
        break;
      case "--config":
        configPath = requiredOptionValue(input, ++index, arg);
        break;
      case "--codex-home":
        codexHome = requiredOptionValue(input, ++index, arg);
        break;
      case "--opencode-db":
        opencodeDb = requiredOptionValue(input, ++index, arg);
        break;
      case "--output":
        outputPath = requiredOptionValue(input, ++index, arg);
        break;
      case "--timeout-ms": {
        const value = Number(requiredOptionValue(input, ++index, arg));
        if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
          throw new Error("--timeout-ms must be an integer from 100 through 60000");
        }
        timeoutMs = value;
        break;
      }
      case "--help":
        return { command: "help" };
      default:
        throw new Error(`Unknown session rescue option: ${arg}`);
    }
  }

  if (devbox && (configPath !== undefined || codexHome !== undefined)) {
    throw new Error("--devbox cannot be combined with --config or --codex-home");
  }

  const timestamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return {
    command,
    configPath: resolveInputPath(
      devbox
        ? join(cwd, ".dev-state", "config.toml")
        : (configPath ?? "~/.config/station/config.toml"),
      cwd,
      homeDir,
    ),
    codexHome: resolveInputPath(
      devbox
        ? join(cwd, ".dev-state", "codex-home")
        : (codexHome ?? process.env.CODEX_HOME ?? "~/.codex"),
      cwd,
      homeDir,
    ),
    opencodeDb: resolveInputPath(
      opencodeDb ??
        join(
          process.env.XDG_DATA_HOME ?? join(homeDir, ".local", "share"),
          "opencode",
          "opencode.db",
        ),
      cwd,
      homeDir,
    ),
    outputPath: resolveInputPath(
      outputPath ?? join(homeDir, ".local", "state", "station-session-rescues", timestamp),
      cwd,
      homeDir,
    ),
    devbox,
    timeoutMs,
  };
}

export async function findCodexSessionAssets(codexHome, nativeSessionId) {
  const matches = new Set();
  await walkFiles(join(codexHome, "sessions"), (path) => {
    if (basename(path).endsWith(`-${nativeSessionId}.jsonl`)) matches.add(path);
  });
  await walkFiles(join(codexHome, "shell_snapshots"), (path) => {
    if (basename(path).startsWith(`${nativeSessionId}.`)) matches.add(path);
  });
  return matches;
}

export function buildRecoveryCoverage(hostPtys, snapshot, recoveryHandles) {
  const active = new Map();
  for (const pty of hostPtys) {
    if (pty.kind !== "agent" || !pty.alive) continue;
    active.set(pty.sessionId, {
      sessionId: pty.sessionId,
      provider: pty.harnessProvider,
      projectId: pty.projectId,
      worktreeId: pty.worktreeId,
      terminalTargetId: pty.terminalTargetId,
      ptyId: pty.ptyId,
    });
  }
  for (const session of snapshot?.sessions ?? []) {
    if (session.origin !== "station" || active.has(session.id)) continue;
    active.set(session.id, {
      sessionId: session.id,
      provider: session.harness.provider,
      projectId: session.projectId,
      worktreeId: session.worktreeId,
    });
  }

  return [...active.values()]
    .map((session) => {
      const exactHandleIds = recoveryHandles
        .filter((handle) => handle.sessionId === session.sessionId)
        .map((handle) => handle.id)
        .sort();
      const candidateHandleIds = recoveryHandles
        .filter(
          (handle) =>
            !exactHandleIds.includes(handle.id) &&
            handle.provider === session.provider &&
            ((session.terminalTargetId !== undefined &&
              handle.terminalTargetId === session.terminalTargetId) ||
              (handle.projectId === session.projectId && handle.worktreeId === session.worktreeId)),
        )
        .map((handle) => handle.id)
        .sort();
      return { ...session, exactHandleIds, candidateHandleIds };
    })
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

export function assertSqliteTables(path, requiredTables) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const query = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    );
    for (const table of requiredTables) {
      if (query.get(table) === undefined) {
        throw new Error(`SQLite backup is missing required table: ${table}`);
      }
    }
  } finally {
    database.close();
  }
}

export async function writeSessionRescueManifest(root, summary) {
  const files = await archiveEntries(root);
  const manifest = {
    archiveVersion,
    createdAt: new Date().toISOString(),
    ...summary,
    files,
  };
  await writePrivateJson(join(root, `${manifestName}.tmp`), manifest);
  await rename(join(root, `${manifestName}.tmp`), join(root, manifestName));
  return manifest;
}

export async function verifySessionRescueArchive(root) {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, manifestName), "utf8"));
  } catch (error) {
    return { ok: false, errors: [`Manifest could not be read: ${errorMessage(error)}`] };
  }
  if (manifest?.archiveVersion !== archiveVersion || !Array.isArray(manifest.files)) {
    return { ok: false, errors: ["Manifest shape or archive version is invalid"] };
  }
  if (manifest.status !== "complete" && manifest.status !== "partial") {
    errors.push("Manifest status is invalid");
  }

  const expectedPaths = new Set();
  for (const entry of manifest.files) {
    if (!validManifestEntry(entry)) {
      errors.push("Manifest contains an invalid file entry");
      continue;
    }
    if (expectedPaths.has(entry.path)) {
      errors.push(`Manifest contains a duplicate path: ${entry.path}`);
      continue;
    }
    expectedPaths.add(entry.path);
    try {
      const path = safeArchivePath(root, entry.path);
      await assertNoSymlinkAncestors(root, path);
      const actual = await describeArchiveEntry(path, entry.path);
      if (actual.type !== entry.type) errors.push(`Type mismatch: ${entry.path}`);
      if (actual.sha256 !== entry.sha256) errors.push(`Hash mismatch: ${entry.path}`);
      if (entry.type === "file" && actual.size !== entry.size) {
        errors.push(`Size mismatch: ${entry.path}`);
      }
      if (entry.type === "file" && entry.path.endsWith(".sqlite")) {
        const integrity = sqliteIntegrity(path);
        if (integrity !== "ok") errors.push(`SQLite integrity failed: ${entry.path}: ${integrity}`);
      }
    } catch (error) {
      errors.push(`Missing or unreadable: ${entry.path}: ${errorMessage(error)}`);
    }
  }

  for (const entry of await archiveEntries(root)) {
    if (!expectedPaths.has(entry.path)) errors.push(`Unexpected payload: ${entry.path}`);
  }
  if (await pathExists(join(root, incompleteName))) errors.push("Archive is marked INCOMPLETE");
  return {
    ok: errors.length === 0,
    errors,
    status: manifest.status,
    fileCount: manifest.files.length,
  };
}

async function saveSessionRescue(options) {
  process.umask(0o077);
  const [
    { loadConfig, resolveObserverPaths, stationHostSocketPath },
    protocol,
    runtime,
    host,
    contracts,
  ] = await Promise.all([
    import("../../packages/config/dist/index.js"),
    import("../../packages/protocol/dist/index.js"),
    import("../../packages/runtime/dist/index.js"),
    import("../../packages/station-host/dist/index.js"),
    import("../../packages/contracts/dist/index.js"),
  ]);
  const loaded = await loadConfig(options.configPath);
  const observerPaths = resolveObserverPaths(loaded.config);
  const hostSocketPath = stationHostSocketPath(loaded.config);
  const buildInfo = runtime.stationBuildInfo();
  const observerBuildVersion = runtime.stationObserverBuildVersion(buildInfo);
  const protectedRoots = [observerPaths.stateDir, options.codexHome];
  if (options.devbox) protectedRoots.push(dirname(options.configPath));
  const physicalOutput = await canonicalFuturePath(options.outputPath);
  for (const protectedRoot of protectedRoots) {
    if (pathIsWithin(physicalOutput, await canonicalFuturePath(protectedRoot))) {
      throw new Error(`Archive output must be outside disposable/runtime state: ${protectedRoot}`);
    }
  }

  await mkdir(dirname(options.outputPath), { recursive: true, mode: 0o700 });
  await mkdir(options.outputPath, { mode: 0o700 });
  await writePrivateFile(
    join(options.outputPath, incompleteName),
    "Archive creation did not finish. Preserve this directory and rerun the save.\n",
  );

  const warnings = [];
  const critical = [];
  const metadata = {
    configPath: options.configPath,
    codexHome: options.codexHome,
    opencodeDb: options.opencodeDb,
    observerPaths,
    hostSocketPath,
    stationVersion: buildInfo.version,
    stationBuildIdentity: buildInfo.buildIdentity,
    observerBuildVersion,
  };

  try {
    await copyStableFile(
      options.configPath,
      join(options.outputPath, "evidence", "config.toml"),
      warnings,
    );

    const observerBackupPath = join(options.outputPath, "observer", "observer.sqlite");
    let recoveryHandles = [];
    try {
      await backupSqlite(observerPaths.dbPath, observerBackupPath);
      recoveryHandles = readRecoveryHandles(
        observerBackupPath,
        contracts.SessionRecoveryHandleSchema,
      );
      await writePrivateJson(
        join(options.outputPath, "observer", "recovery-handles.json"),
        recoveryHandles,
      );
    } catch (error) {
      critical.push(`Observer database could not be preserved: ${errorMessage(error)}`);
    }

    let snapshot;
    try {
      const unpinned = protocol.createObserverClient({
        socketPath: observerPaths.socketPath,
        timeoutMs: options.timeoutMs,
      });
      const health = await unpinned.health();
      await writePrivateJson(join(options.outputPath, "observer", "health.json"), health);
      if (
        health.version !== observerBuildVersion ||
        health.pid === undefined ||
        health.startedAt === undefined
      ) {
        critical.push(
          `Observer snapshot skipped: running build ${health.version ?? "unknown"}; this checkout is ${observerBuildVersion}. Run this script from the matching checkout/build.`,
        );
      } else {
        const pinned = protocol.createObserverClient({
          socketPath: observerPaths.socketPath,
          timeoutMs: options.timeoutMs,
          expectedObserverIdentity: {
            pid: health.pid,
            startedAt: health.startedAt,
            version: health.version,
            socketPath: observerPaths.socketPath,
          },
        });
        snapshot = await pinned.getSnapshot({ includeDebug: true });
        await writePrivateJson(join(options.outputPath, "observer", "snapshot.json"), snapshot);
      }
    } catch (error) {
      critical.push(`Observer health/snapshot could not be captured: ${errorMessage(error)}`);
    }

    let hostPtys = [];
    const hostClient = host.createStationHostClient({
      socketPath: hostSocketPath,
      timeoutMs: options.timeoutMs,
      expectedBuildVersion: buildInfo.version,
    });
    try {
      const health = await hostClient.health();
      await writePrivateJson(join(options.outputPath, "host", "health.json"), health);
      if (health.buildVersion !== buildInfo.version) {
        critical.push(
          `Host replay skipped: running build ${health.buildVersion ?? "legacy"}; this checkout is ${buildInfo.version}. Run this script from the matching checkout/build.`,
        );
      } else {
        hostPtys = await hostClient.list();
        await writePrivateJson(join(options.outputPath, "host", "ptys.json"), hostPtys);
        for (const pty of hostPtys) {
          try {
            const attachment = await hostClient.attach(pty.ptyId);
            try {
              await writePrivateJson(
                join(options.outputPath, "host", "replay", `${safeSegment(pty.ptyId)}.json`),
                attachment.ack,
              );
            } finally {
              await attachment.detach();
            }
          } catch (error) {
            critical.push(`Host replay ${pty.ptyId} could not be captured: ${errorMessage(error)}`);
          }
        }
      }
    } catch (error) {
      critical.push(`Host inventory could not be captured: ${errorMessage(error)}`);
    } finally {
      hostClient.dispose();
    }

    const recoveryCoverage = buildRecoveryCoverage(hostPtys, snapshot, recoveryHandles);
    await writePrivateJson(
      join(options.outputPath, "observer", "recovery-coverage.json"),
      recoveryCoverage,
    );
    for (const session of recoveryCoverage) {
      if (session.exactHandleIds.length === 0) {
        critical.push(
          `Active Station session ${session.sessionId} has no provider recovery handle`,
        );
      }
    }
    const activeProviders = new Set(recoveryCoverage.map((session) => session.provider));

    await preserveProviderState({
      root: options.outputPath,
      recoveryHandles,
      activeProviders,
      codexHome: options.codexHome,
      opencodeDb: options.opencodeDb,
      warnings,
      critical,
    });

    const worktreeCandidates = new Set([
      ...recoveryHandles.flatMap((handle) => (handle.cwd === undefined ? [] : [handle.cwd])),
      ...hostPtys.map((pty) => pty.worktreePath),
      ...(snapshot?.rows.map((row) => row.path) ?? []),
    ]);
    await preserveWorktrees(options.outputPath, worktreeCandidates, warnings, critical);

    const status = critical.length === 0 ? "complete" : "partial";
    await rm(join(options.outputPath, incompleteName));
    await writeSessionRescueManifest(options.outputPath, {
      status,
      warnings,
      critical,
      metadata,
    });
    const verification = await verifySessionRescueArchive(options.outputPath);
    if (!verification.ok) {
      throw new Error(`Archive verification failed: ${verification.errors.join("; ")}`);
    }
    return { status, warnings, critical, outputPath: options.outputPath, verification };
  } catch (error) {
    critical.push(errorMessage(error));
    try {
      await writePrivateFile(
        join(options.outputPath, incompleteName),
        "Archive creation or verification did not finish successfully.\n",
      );
      await writeSessionRescueManifest(options.outputPath, {
        status: "partial",
        warnings,
        critical,
        metadata,
      });
    } catch {
      // INCOMPLETE remains the authoritative signal when finalization itself fails.
    }
    throw error;
  }
}

async function preserveProviderState(input) {
  const providers = new Set([
    ...input.activeProviders,
    ...input.recoveryHandles.map((handle) => handle.provider),
  ]);
  if (providers.has("codex")) {
    const stateDb = join(input.codexHome, "state_5.sqlite");
    try {
      const preservedStateDb = join(input.root, "providers", "codex", "state_5.sqlite");
      await backupSqlite(stateDb, preservedStateDb);
      assertSqliteTables(preservedStateDb, ["threads"]);
      await copyProviderTree(
        join(input.codexHome, "sessions"),
        join(input.root, "providers", "codex", "sessions"),
        input.warnings,
      );
      await copyProviderTree(
        join(input.codexHome, "shell_snapshots"),
        join(input.root, "providers", "codex", "shell_snapshots"),
        input.warnings,
      );
    } catch (error) {
      input.critical.push(`Codex provider state could not be preserved: ${errorMessage(error)}`);
    }
  }

  if (providers.has("opencode")) {
    try {
      const preservedOpenCodeDb = join(input.root, "providers", "opencode", "opencode.sqlite");
      await backupSqlite(input.opencodeDb, preservedOpenCodeDb);
      assertSqliteTables(preservedOpenCodeDb, ["session"]);
    } catch (error) {
      input.critical.push(`OpenCode database could not be preserved: ${errorMessage(error)}`);
    }
  }

  const claudeRoot = join(homedir(), ".claude", "projects");
  if (providers.has("claude")) {
    try {
      await copyProviderTree(
        claudeRoot,
        join(input.root, "providers", "claude", "projects"),
        input.warnings,
        (path) => path.endsWith(".jsonl"),
      );
    } catch (error) {
      input.critical.push(`Claude provider state could not be preserved: ${errorMessage(error)}`);
    }
  }

  for (const handle of input.recoveryHandles) {
    const targetDir = join(
      input.root,
      "providers",
      safeSegment(handle.provider),
      "sessions",
      safeSegment(handle.id),
    );
    if (handle.target.kind === "session-file") {
      try {
        await copyStableFile(
          handle.target.path,
          join(targetDir, basename(handle.target.path)),
          input.warnings,
        );
      } catch (error) {
        input.critical.push(
          `Recovery file ${handle.id} could not be preserved: ${errorMessage(error)}`,
        );
      }
      continue;
    }
    if (handle.provider === "codex") {
      const assets = await findCodexSessionAssets(input.codexHome, handle.target.id);
      if (assets.size === 0) {
        input.critical.push(`No exact Codex files found for native session ${handle.target.id}`);
      }
      continue;
    }
    if (handle.provider === "opencode") {
      continue;
    }
    if (handle.provider === "claude") {
      const matches = new Set();
      await walkFiles(claudeRoot, (path) => {
        if (basename(path) === `${handle.target.id}.jsonl`) matches.add(path);
      });
      if (matches.size === 0) {
        input.critical.push(`No exact Claude file found for native session ${handle.target.id}`);
      }
      continue;
    }
    input.critical.push(
      `Provider ${handle.provider} native session ${handle.target.id} was not preserved; use the provider's matching recovery procedure.`,
    );
  }
}

async function copyProviderTree(sourceRoot, targetRoot, warnings, include = () => true) {
  await walkFiles(sourceRoot, async (source) => {
    if (!include(source)) return;
    const relativePath = relative(sourceRoot, source);
    await copyStableFile(source, safeChildPath(targetRoot, relativePath), warnings);
  });
}

async function preserveWorktrees(archiveRoot, candidates, warnings, critical) {
  const roots = new Set();
  const physicalArchive = await canonicalFuturePath(archiveRoot);
  for (const candidate of candidates) {
    try {
      const { stdout } = await runGit(candidate, ["rev-parse", "--show-toplevel"]);
      roots.add(stdout.trim());
    } catch (error) {
      warnings.push(`Worktree path ${candidate} could not be resolved: ${errorMessage(error)}`);
    }
  }

  let index = 0;
  for (const root of roots) {
    const target = join(
      archiveRoot,
      "worktrees",
      `${String(index).padStart(2, "0")}-${safeSegment(basename(root))}`,
    );
    index += 1;
    if (pathIsWithin(physicalArchive, await canonicalFuturePath(root))) {
      critical.push(`Worktree capture skipped because the archive is inside it: ${root}`);
      continue;
    }
    try {
      const before = await gitText(root, [
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=all",
      ]);
      await writePrivateFile(join(target, "root.txt"), `${root}\n`);
      await writePrivateFile(join(target, "status-before.txt"), before);
      await writePrivateFile(join(target, "head.txt"), await gitText(root, ["rev-parse", "HEAD"]));
      await writePrivateFile(
        join(target, "diff-head.patch"),
        await gitText(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"]),
      );
      await writePrivateFile(
        join(target, "diff-cached.patch"),
        await gitText(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--cached"]),
      );
      await copyUntrackedFiles(root, join(target, "untracked"));

      const uniqueCount = Number(
        (await gitText(root, ["rev-list", "--count", "HEAD", "--not", "--remotes"])).trim(),
      );
      if (uniqueCount > 0) {
        await mkdir(target, { recursive: true, mode: 0o700 });
        await runGit(root, [
          "bundle",
          "create",
          join(target, "unpublished-commits.bundle"),
          "HEAD",
          "--not",
          "--remotes",
        ]);
        await chmod(join(target, "unpublished-commits.bundle"), 0o600);
      }

      const after = await gitText(root, [
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=all",
      ]);
      await writePrivateFile(join(target, "status-after.txt"), after);
      if (before !== after) warnings.push(`Worktree changed during capture: ${root}`);
    } catch (error) {
      warnings.push(`Worktree ${root} could not be fully preserved: ${errorMessage(error)}`);
    }
  }
}

async function copyUntrackedFiles(root, targetRoot) {
  const { stdout } = await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], {
    encoding: "buffer",
  });
  for (const raw of stdout
    .subarray(0, Math.max(0, stdout.length - 1))
    .toString("utf8")
    .split("\0")) {
    if (raw.length === 0) continue;
    const source = safeChildPath(root, raw);
    const target = safeChildPath(targetRoot, raw);
    const sourceStat = await lstat(source);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (sourceStat.isSymbolicLink()) {
      await symlink(await readlink(source), target);
    } else if (sourceStat.isFile()) {
      await copyFile(source, target);
      await chmod(target, 0o600);
    }
  }
}

async function backupSqlite(sourcePath, targetPath) {
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, targetPath);
  } finally {
    source.close();
  }
  const preserved = new DatabaseSync(targetPath);
  try {
    preserved.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    preserved.exec("PRAGMA journal_mode=DELETE");
  } finally {
    preserved.close();
  }
  await rm(`${targetPath}-shm`, { force: true });
  await rm(`${targetPath}-wal`, { force: true });
  await chmod(targetPath, 0o600);
}

function readRecoveryHandles(path, schema) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("session_recovery_handles");
    if (table === undefined) return [];
    return database
      .prepare("SELECT * FROM session_recovery_handles ORDER BY last_seen_at DESC, id")
      .all()
      .map((row) =>
        schema.parse({
          id: row.id,
          provider: row.provider,
          projectId: row.project_id,
          worktreeId: row.worktree_id,
          ...(row.session_id === null ? {} : { sessionId: row.session_id }),
          target:
            row.target_kind === "native-session"
              ? { kind: "native-session", id: row.target_value }
              : { kind: "session-file", path: row.target_value },
          ...(row.cwd === null ? {} : { cwd: row.cwd }),
          ...(row.terminal_target_id === null ? {} : { terminalTargetId: row.terminal_target_id }),
          ...(row.harness_run_id === null ? {} : { harnessRunId: row.harness_run_id }),
          observedAt: row.observed_at,
          lastSeenAt: row.last_seen_at,
        }),
      );
  } finally {
    database.close();
  }
}

async function copyStableFile(source, target, warnings) {
  const before = await stat(source);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target);
  await chmod(target, 0o600);
  const after = await stat(source);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    warnings.push(`Source changed during capture: ${source}`);
  }
}

async function walkFiles(root, visit) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(path, visit);
    else if (entry.isFile()) await visit(path);
  }
}

async function archiveEntries(root) {
  const entries = [];
  await walkArchive(root, root, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function walkArchive(root, directory, entries) {
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (
      directory === root &&
      [manifestName, `${manifestName}.tmp`, incompleteName].includes(child.name)
    ) {
      continue;
    }
    const path = join(directory, child.name);
    const relativePath = relative(root, path).split(sep).join("/");
    if (child.isDirectory()) await walkArchive(root, path, entries);
    else if (child.isFile() || child.isSymbolicLink()) {
      entries.push(await describeArchiveEntry(path, relativePath));
    }
  }
}

async function describeArchiveEntry(path, relativePath) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    const target = await readlink(path);
    return { path: relativePath, type: "symlink", target, sha256: sha256(target) };
  }
  if (!metadata.isFile()) throw new Error(`Unsupported archive entry: ${relativePath}`);
  return { path: relativePath, type: "file", size: metadata.size, sha256: await hashFile(path) };
}

function sqliteIntegrity(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA integrity_check").get();
    return row?.integrity_check;
  } finally {
    database.close();
  }
}

function validManifestEntry(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    typeof entry.path === "string" &&
    entry.path.length > 0 &&
    (entry.type === "file" || entry.type === "symlink") &&
    typeof entry.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(entry.sha256) &&
    (entry.type !== "file" || (Number.isSafeInteger(entry.size) && entry.size >= 0)) &&
    (entry.type !== "symlink" || typeof entry.target === "string")
  );
}

function safeArchivePath(root, relativePath) {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    throw new Error(`Unsafe archive path: ${relativePath}`);
  }
  return safeChildPath(root, relativePath);
}

function safeChildPath(root, child) {
  const path = resolve(root, child);
  const fromRoot = relative(resolve(root), path);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`Path escapes root ${root}: ${child}`);
  }
  return path;
}

function pathIsWithin(path, root) {
  const fromRoot = relative(resolve(root), resolve(path));
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

async function canonicalFuturePath(path) {
  const suffix = [];
  let candidate = resolve(path);
  for (;;) {
    try {
      return resolve(await realpath(candidate), ...suffix.reverse());
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      suffix.push(basename(candidate));
      candidate = parent;
    }
  }
}

async function assertNoSymlinkAncestors(root, path) {
  const relativePath = relative(resolve(root), path);
  let current = resolve(root);
  for (const part of relativePath.split(sep).slice(0, -1)) {
    current = join(current, part);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Archive path has a symlink ancestor: ${current}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Archive path has a non-directory ancestor: ${current}`);
    }
  }
}

async function writePrivateJson(path, value) {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePrivateFile(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function gitText(root, args) {
  const { stdout } = await runGit(root, args);
  return stdout;
}

function runGit(root, args, options = {}) {
  return run("git", ["-C", root, ...args], {
    ...options,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function run(command, args, options = {}) {
  return execFile(command, args, {
    encoding: options.encoding ?? "utf8",
    env: options.env ?? process.env,
    maxBuffer: maxCommandOutput,
  });
}

function requiredOptionValue(args, index, option) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function resolveInputPath(input, cwd, homeDir) {
  const expanded =
    input === "~" ? homeDir : input.startsWith("~/") ? join(homeDir, input.slice(2)) : input;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function safeSegment(value) {
  const sanitized = value.replaceAll(/[^0-9A-Za-z._-]/gu, "_");
  return sanitized.length > 0 ? sanitized : sha256(value).slice(0, 16);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function nodeErrorCode(error) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printHelp() {
  console.log(`Usage:
  pnpm station:sessions:save -- --devbox [--output <path>]
  pnpm station:sessions:save -- --config <config.toml> [--codex-home <path>] [--output <path>]
  pnpm station:sessions:verify -- <archive-path>

The save is read-only with respect to Station, provider sessions, and worktrees. It never stops,
closes, resumes, writes to, resizes, or unlinks a live runtime. Archives contain sensitive session
output and provider state and are created with owner-only permissions.`);
}

async function main() {
  const options = parseSessionRescueArgs(process.argv.slice(2));
  if (options.command === "help") {
    printHelp();
    return;
  }
  if (options.command === "verify") {
    const result = await verifySessionRescueArchive(options.archivePath);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const result = await saveSessionRescue(options);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "complete") process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
