#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { z } from "zod";
import { locateBunRuntime, resolveAndCheckBunVersion } from "./bun-version.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const registryActionSchema = z.enum(["link", "unlink"]);
const packageManifestSchema = z
  .object({
    name: z.literal("station"),
  })
  .passthrough();
const bunfigGlobalInstallSchema = z
  .object({
    install: z
      .object({
        globalBinDir: z.string().optional(),
        globalDir: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const registryLockOwnerSchema = z
  .object({
    pid: z.number().int().positive(),
    token: z.string().min(1),
  })
  .strict();
const launcherTargets = {
  stn: join("bin", "stn"),
  "stn-ingress": join("bin", "stn-ingress"),
  "stn-tmux-popup": join("integrations", "terminal", "tmux", "bin", "stn-popup"),
};
const registryLockSuffix = ".station-link-registry.lock";
const registryLockOwnerFile = "owner.json";

/** Resolves and proves the Bun registration plus every launcher for link or unlink reporting. */
export async function assertStationLinkOwnership(root, locations, action = "unlink") {
  const parsedAction = registryActionSchema.parse(action);
  const failurePrefix =
    parsedAction === "link" ? "Station link verification failed:" : "Refusing to unlink Station:";
  const entries = await stationLinkEntries(root, locations);
  for (const entry of entries) await assertOwnedRegistrySymlink(entry, failurePrefix);
}

/** Resolves one effective Bun global-location snapshot from environment and global/local config. */
export async function resolveBunGlobalLocations(environment, { workingDirectory = repoRoot } = {}) {
  const absoluteWorkingDirectory = requireAbsoluteBase(workingDirectory, "working directory");

  let userConfigPath;
  if (environment.XDG_CONFIG_HOME === undefined) {
    if (environment.HOME !== undefined) {
      userConfigPath = join(requireAbsoluteBase(environment.HOME, "HOME"), ".bunfig.toml");
    }
  } else {
    // Bun 1.4 treats an explicitly empty XDG root differently from an unset one. Refuse
    // that ambiguous discovery state instead of proving ownership in a guessed registry.
    const xdgConfigRoot = requireAbsoluteBase(environment.XDG_CONFIG_HOME, "XDG_CONFIG_HOME");
    userConfigPath = join(xdgConfigRoot, ".bunfig.toml");
  }
  const localConfigPath = join(absoluteWorkingDirectory, "bunfig.toml");
  const [userConfig, localConfig] = await Promise.all([
    userConfigPath === undefined
      ? Promise.resolve({})
      : readConfiguredGlobalInstall(userConfigPath),
    readConfiguredGlobalInstall(localConfigPath),
  ]);
  const configured = mergeConfiguredGlobalInstall(userConfig, localConfig);

  const needsDefaultBinDir =
    environment.BUN_INSTALL_BIN === undefined &&
    (configured.globalBinDir === undefined || configured.globalBinDir.length === 0);
  const needsDefaultGlobalDir =
    environment.BUN_INSTALL_GLOBAL_DIR === undefined &&
    (configured.globalDir === undefined || configured.globalDir.length === 0);
  let installRoot;
  if (needsDefaultBinDir || needsDefaultGlobalDir) {
    if (environment.BUN_INSTALL !== undefined) {
      installRoot = resolveBunInstallRoot(environment.BUN_INSTALL);
    } else {
      let defaultInstallBase;
      if (environment.XDG_CACHE_HOME !== undefined) {
        defaultInstallBase = requireAbsoluteBase(environment.XDG_CACHE_HOME, "XDG_CACHE_HOME");
      } else if (environment.HOME !== undefined) {
        defaultInstallBase = requireAbsoluteBase(environment.HOME, "HOME");
      }
      installRoot = resolveBunInstallRoot(undefined, defaultInstallBase);
    }
  }
  const defaultGlobalBinDir = installRoot === undefined ? undefined : join(installRoot, "bin");
  const defaultGlobalDir =
    installRoot === undefined ? undefined : join(installRoot, "install", "global");
  const globalBinDir = resolveEffectiveDirectory({
    configured: configured.globalBinDir,
    defaultDirectory: defaultGlobalBinDir,
    environmentValue: environment.BUN_INSTALL_BIN,
    environmentLabel: "BUN_INSTALL_BIN",
    configLabel: "install.globalBinDir",
    workingDirectory: absoluteWorkingDirectory,
  });
  const globalDir = resolveEffectiveDirectory({
    configured: configured.globalDir,
    defaultDirectory: defaultGlobalDir,
    environmentValue: environment.BUN_INSTALL_GLOBAL_DIR,
    environmentLabel: "BUN_INSTALL_GLOBAL_DIR",
    configLabel: "install.globalDir",
    workingDirectory: absoluteWorkingDirectory,
  });
  return { globalBinDir, globalDir };
}

/** Returns canonical sorted resource locks shared even when configs use symlinked path aliases. */
export async function stationLinkRegistryLockPaths(locations) {
  const canonicalResources = await Promise.all(
    [locations.globalBinDir, locations.globalDir].map(canonicalizeRegistryResource),
  );
  const resources = [...new Set(canonicalResources)].sort();
  const resourceSet = new Set(resources);
  const lockPaths = resources.map((resource) => `${resource}${registryLockSuffix}`);
  for (const lockPath of lockPaths) {
    if (resourceSet.has(lockPath)) {
      throw new Error(
        `Station registry resource ${lockPath} collides with another resource's lock path.`,
      );
    }
  }
  return lockPaths;
}

/** Serializes Station-owned mutations; direct raw Bun registry commands are outside this lock. */
export async function withStationLinkRegistryLocks(locations, operation) {
  const leases = [];
  let outcome;
  try {
    for (const lockPath of await stationLinkRegistryLockPaths(locations)) {
      leases.push(await acquireRegistryLock(lockPath));
    }
    outcome = { succeeded: true, value: await operation() };
  } catch (error) {
    outcome = { succeeded: false, error };
  }

  const releaseErrors = [];
  for (const lease of leases.reverse()) {
    try {
      await releaseRegistryLock(lease);
    } catch (error) {
      releaseErrors.push(error);
    }
  }
  if (!outcome.succeeded) {
    if (releaseErrors.length > 0) {
      throw new AggregateError(
        [outcome.error, ...releaseErrors],
        "Station registry operation failed and one or more acquired locks could not be released.",
      );
    }
    throw outcome.error;
  }
  if (releaseErrors.length === 1) throw releaseErrors[0];
  if (releaseErrors.length > 1) {
    throw new AggregateError(
      releaseErrors,
      "Station registry operation completed but multiple acquired locks could not be released.",
    );
  }
  return outcome.value;
}

async function canonicalizeRegistryResource(resource) {
  let canonicalResource;
  try {
    canonicalResource = await realpath(resource);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    let observedStats;
    try {
      observedStats = await lstat(resource);
    } catch (inspectionCause) {
      if (
        !(
          inspectionCause instanceof Error &&
          "code" in inspectionCause &&
          inspectionCause.code === "ENOENT"
        )
      ) {
        throw inspectionCause;
      }
    }
    if (observedStats?.isSymbolicLink()) {
      try {
        canonicalResource = await realpath(resource);
      } catch (inspectionCause) {
        if (
          inspectionCause instanceof Error &&
          "code" in inspectionCause &&
          inspectionCause.code === "ENOENT"
        ) {
          throw new Error(
            `Registry resource ${resource} is a dangling symlink; refusing to choose a different lock identity.`,
          );
        }
        throw inspectionCause;
      }
    } else if (observedStats?.isDirectory()) {
      canonicalResource = await realpath(resource);
    } else if (observedStats === undefined) {
      // Materialize the actual resource before locking so case-folded aliases converge
      // on the filesystem's canonical identity rather than on caller-provided spelling.
      await mkdir(resource, { recursive: true, mode: 0o700 });
      canonicalResource = await realpath(resource);
    } else {
      throw new Error(`Registry resource ${resource} exists but cannot be resolved safely.`);
    }
  }

  if (!(await lstat(canonicalResource)).isDirectory()) {
    throw new Error(`Registry resource ${resource} must resolve to a directory.`);
  }
  return canonicalResource;
}

/** Mutates only Station's fixed registration and launchers after admitting the exact root Bun. */
export async function mutateStationLinkRegistry(action, options = {}) {
  const parsedAction = registryActionSchema.parse(action);
  const root = options.root ?? repoRoot;
  const environment = options.environment ?? process.env;
  if (Object.hasOwn(options, "bunExecutable")) {
    if (options.bunExecutable === undefined || !isAbsolute(options.bunExecutable)) {
      throw new Error("An explicitly injected Bun executable must be an absolute path.");
    }
    await locateBunRuntime(options.bunExecutable, {
      env: environment,
      cwd: root,
    });
  } else {
    await resolveAndCheckBunVersion(root, {
      env: environment,
      cwd: root,
    });
  }
  if (Object.hasOwn(options, "beforeMutation") && typeof options.beforeMutation !== "function") {
    throw new Error("An explicitly injected beforeMutation hook must be a function.");
  }
  if (Object.hasOwn(options, "afterLinkEntry") && typeof options.afterLinkEntry !== "function") {
    throw new Error("An explicitly injected afterLinkEntry hook must be a function.");
  }
  const resolvedLocations = await resolveBunGlobalLocations(environment, {
    workingDirectory: root,
  });
  const locations = await canonicalizeBunGlobalLocations(resolvedLocations);
  return withStationLinkRegistryLocks(locations, async () => {
    const entries = await stationLinkEntries(root, locations);
    if (parsedAction === "unlink") {
      for (const entry of entries) {
        await assertOwnedRegistrySymlink(entry, "Refusing to unlink Station:");
      }
    }
    await options.beforeMutation?.();

    if (parsedAction === "link") {
      await linkStationEntries(entries, options.afterLinkEntry, () =>
        assertStationLinkOwnership(root, locations, "link"),
      );
    } else {
      await unlinkStationEntries(entries);
    }
    return locations;
  });
}

async function stationLinkEntries(root, locations) {
  const resolvedRoot = await realpath(root);
  const packageName = await readPackageName(resolvedRoot);
  const registrationDestination = join(locations.globalDir, "node_modules", packageName);
  const entries = [
    {
      destination: registrationDestination,
      expectedTarget: resolvedRoot,
      label: `global registration ${packageName}`,
      linkTarget: resolvedRoot,
      sourcePath: resolvedRoot,
    },
  ];

  for (const [launcher, target] of Object.entries(launcherTargets)) {
    const sourcePath = join(resolvedRoot, target);
    let sourceStats;
    try {
      sourceStats = await lstat(sourcePath);
    } catch (cause) {
      throw new Error(
        `Station launcher source ${sourcePath} must be a regular executable file inside the checkout.`,
        { cause },
      );
    }
    if (!sourceStats.isFile() || (sourceStats.mode & 0o111) === 0) {
      throw new Error(
        `Station launcher source ${sourcePath} must be a regular executable file inside the checkout.`,
      );
    }
    const registeredSourcePath = join(await realpath(dirname(sourcePath)), basename(sourcePath));
    const expectedTarget = await realpath(registeredSourcePath);
    if (
      !isPathInside(resolvedRoot, registeredSourcePath) ||
      !isPathInside(resolvedRoot, expectedTarget)
    ) {
      throw new Error(
        `Station launcher source ${sourcePath} must stay inside checkout ${resolvedRoot}.`,
      );
    }
    const confirmedStats = await lstat(registeredSourcePath);
    if (
      !confirmedStats.isFile() ||
      (confirmedStats.mode & 0o111) === 0 ||
      confirmedStats.dev !== sourceStats.dev ||
      confirmedStats.ino !== sourceStats.ino
    ) {
      throw new Error(`Station launcher source ${sourcePath} changed while being verified.`);
    }
    entries.push({
      destination: join(locations.globalBinDir, launcher),
      expectedTarget,
      label: `global launcher ${launcher}`,
      linkTarget: registeredSourcePath,
      sourcePath: registeredSourcePath,
    });
  }
  return entries;
}

function isPathInside(root, candidate) {
  const candidateRelativePath = relative(root, candidate);
  return (
    candidateRelativePath !== ".." &&
    !candidateRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(candidateRelativePath)
  );
}

async function assertOwnedRegistrySymlink(entry, failurePrefix) {
  let stats;
  try {
    stats = await lstat(entry.destination);
  } catch (cause) {
    throw new Error(`${failurePrefix} ${entry.label} is missing or unreadable.`, { cause });
  }
  if (!stats.isSymbolicLink()) {
    throw new Error(`${failurePrefix} ${entry.label} is not a symlink.`);
  }
  if (normalize(entry.destination) === normalize(entry.sourcePath)) {
    throw new Error(`${failurePrefix} ${entry.label} destination overlaps its checkout source.`);
  }

  let observedTarget;
  try {
    observedTarget = await realpath(entry.destination);
  } catch (cause) {
    throw new Error(`${failurePrefix} ${entry.label} is missing or unreadable.`, { cause });
  }
  if (observedTarget !== entry.expectedTarget) {
    throw new Error(`${failurePrefix} ${entry.label} belongs to another checkout.`);
  }
}

async function linkStationEntries(entries, afterLinkEntry, verifyFinalState) {
  for (const directory of new Set(entries.map((entry) => dirname(entry.destination)))) {
    await mkdir(directory, { recursive: true, mode: 0o755 });
  }
  const existingEntries = [];
  for (const entry of entries) {
    if (normalize(entry.destination) === normalize(entry.sourcePath)) {
      throw new Error(`Refusing to link Station: ${entry.label} destination overlaps its source.`);
    }
    const existing = await lstatIfPresent(entry.destination);
    if (existing !== undefined && !existing.isSymbolicLink()) {
      throw new Error(`Refusing to link Station: ${entry.label} is not a symlink.`);
    }
    if (existing !== undefined) existingEntries.push(entry);
  }

  const previousLinks = [];
  const createdEntries = [];
  try {
    for (const entry of existingEntries) {
      const quarantinePath = `${entry.destination}.station-link-previous-${process.pid}-${randomUUID()}`;
      await rename(entry.destination, quarantinePath);
      previousLinks.push({ entry, quarantinePath });
      const quarantinedStats = await lstat(quarantinePath);
      if (!quarantinedStats.isSymbolicLink()) {
        throw new Error(`Refusing to link Station: ${entry.label} changed during replacement.`);
      }
    }
    for (const entry of entries) {
      await symlink(entry.linkTarget, entry.destination);
      createdEntries.push(entry);
      await afterLinkEntry?.();
    }
    for (const entry of entries) {
      await assertOwnedRegistrySymlink(entry, "Station link verification failed:");
    }
    // Re-read mutable checkout sources before deleting the prior links so every
    // fallible postcondition remains inside the rollback boundary.
    await verifyFinalState();
  } catch (cause) {
    const rollbackErrors = [];
    for (const entry of [...createdEntries].reverse()) {
      try {
        await assertCreatedLinkObject(entry);
        await rm(entry.destination);
      } catch (rollbackCause) {
        rollbackErrors.push(rollbackCause);
      }
    }
    rollbackErrors.push(...(await restoreQuarantinedEntries(previousLinks)));
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [cause, ...rollbackErrors],
        "Station link failed and its previous registry state could not be fully restored.",
      );
    }
    throw cause;
  }

  const cleanupResults = await Promise.allSettled(
    previousLinks.map(({ quarantinePath }) => rm(quarantinePath)),
  );
  const cleanupErrors = cleanupResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Station link could not remove every replaced link.");
  }
}

async function assertCreatedLinkObject(entry) {
  const stats = await lstat(entry.destination);
  if (!stats.isSymbolicLink() || (await readlink(entry.destination)) !== entry.linkTarget) {
    throw new Error(`Station link rollback found a changed ${entry.label}.`);
  }
}

async function unlinkStationEntries(entries) {
  const staged = [];
  try {
    for (const entry of [...entries].reverse()) {
      const quarantinePath = `${entry.destination}.station-unlink-${process.pid}-${randomUUID()}`;
      await rename(entry.destination, quarantinePath);
      staged.push({ entry, quarantinePath });
      const quarantinedEntry = { ...entry, destination: quarantinePath };
      await assertOwnedRegistrySymlink(quarantinedEntry, "Refusing to unlink Station:");
    }
  } catch (cause) {
    const restoreErrors = await restoreQuarantinedEntries(staged);
    if (restoreErrors.length > 0) {
      throw new AggregateError(
        [cause, ...restoreErrors],
        "Station unlink failed and one or more owned links could not be restored.",
      );
    }
    throw cause;
  }

  const removalResults = await Promise.allSettled(
    staged.map(({ quarantinePath }) => rm(quarantinePath)),
  );
  const removalErrors = removalResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (removalErrors.length > 0) {
    throw new AggregateError(removalErrors, "Station unlink could not remove every staged link.");
  }
}

async function restoreQuarantinedEntries(staged) {
  const errors = [];
  for (const stagedEntry of [...staged].reverse()) {
    try {
      await restoreQuarantinedEntry(stagedEntry);
    } catch (cause) {
      errors.push(cause);
    }
  }
  return errors;
}

async function restoreQuarantinedEntry({ entry, quarantinePath }) {
  if ((await lstatIfPresent(entry.destination)) !== undefined) {
    throw new Error(`Cannot restore ${entry.label}; its registry destination is occupied.`);
  }
  await rename(quarantinePath, entry.destination);
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

async function canonicalizeBunGlobalLocations(locations) {
  const [globalBinDir, globalDir] = await Promise.all([
    canonicalizeRegistryResource(locations.globalBinDir),
    canonicalizeRegistryResource(locations.globalDir),
  ]);
  return { globalBinDir, globalDir };
}

async function readPackageName(root) {
  const path = join(root, "package.json");
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`Cannot read Station package manifest at ${path}.`, { cause });
  }
  let document;
  try {
    document = JSON.parse(source);
  } catch (cause) {
    throw new Error(`Cannot parse Station package manifest at ${path}.`, { cause });
  }
  const result = packageManifestSchema.safeParse(document);
  if (!result.success) {
    throw new Error(`Station package manifest at ${path} must declare name "station".`, {
      cause: result.error,
    });
  }
  return result.data.name;
}

async function readConfiguredGlobalInstall(configPath) {
  let source;
  try {
    source = await readFile(configPath, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return {};
    throw new Error(`Cannot read Bun configuration at ${configPath}.`, { cause });
  }

  let document;
  try {
    document = parse(source);
  } catch (cause) {
    throw new Error(`Cannot parse Bun configuration at ${configPath}.`, { cause });
  }
  const result = bunfigGlobalInstallSchema.safeParse(document);
  if (!result.success) {
    throw new Error(
      `Bun configuration at ${configPath} install.globalBinDir and install.globalDir must be strings.`,
      { cause: result.error },
    );
  }
  return result.data.install ?? {};
}

function mergeConfiguredGlobalInstall(userConfig, localConfig) {
  // Bun 1.4 preserves global [install] keys absent locally, while an explicit empty
  // local path suppresses the corresponding global value and restores its default.
  return {
    globalBinDir: localConfig.globalBinDir ?? userConfig.globalBinDir,
    globalDir: localConfig.globalDir ?? userConfig.globalDir,
  };
}

function resolveBunInstallRoot(value, defaultRoot) {
  if (value === undefined) {
    if (defaultRoot === undefined) {
      throw new Error("Bun global registry defaults require BUN_INSTALL, XDG_CACHE_HOME, or HOME.");
    }
    return join(defaultRoot, ".bun");
  }
  if (value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new Error(
      "BUN_INSTALL must be an absolute filesystem path; relative and tilde-prefixed values are unsupported.",
    );
  }
  return normalize(value);
}

function resolveEffectiveDirectory({
  configured,
  defaultDirectory,
  environmentValue,
  environmentLabel,
  configLabel,
  workingDirectory,
}) {
  if (environmentValue !== undefined) {
    return resolveRelativeDirectory(environmentValue, environmentLabel, workingDirectory);
  }
  if (configured === undefined || configured.length === 0) {
    if (defaultDirectory === undefined) {
      throw new Error(`Bun global registry has no default for ${configLabel}.`);
    }
    return defaultDirectory;
  }
  return resolveRelativeDirectory(configured, configLabel, workingDirectory);
}

function requireAbsoluteBase(value, label) {
  if (value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path; found ${value || "(empty)"}.`);
  }
  return normalize(value);
}

function resolveRelativeDirectory(value, label, workingDirectory) {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must name a non-empty filesystem path.`);
  }
  // Bun 1.4 treats relative and leading-`~` registry paths literally from command cwd.
  return isAbsolute(value) ? normalize(value) : resolve(workingDirectory, value);
}

async function acquireRegistryLock(lockPath) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, token: randomUUID() };
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
    const observedOwner = await readRegistryLockOwner(lockPath);
    if (isProcessAlive(observedOwner.pid)) {
      throw new Error(
        `Another Station link-registry operation is active at ${lockPath} (pid ${observedOwner.pid}); retry after it finishes.`,
      );
    }
    throw new Error(
      `Station link-registry lock at ${lockPath} belongs to non-running pid ${observedOwner.pid}. Inspect the lock and remove it manually only after confirming no registry operation is active.`,
    );
  }

  try {
    await writeFile(join(lockPath, registryLockOwnerFile), `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return { lockPath, owner };
  } catch (cause) {
    throw new Error(
      `Station registry lock ownership could not be published at ${lockPath}; inspect the lock before manual removal.`,
      { cause },
    );
  }
}

async function releaseRegistryLock(lease) {
  const observedOwner = await readRegistryLockOwner(lease.lockPath);
  if (observedOwner.pid !== lease.owner.pid || observedOwner.token !== lease.owner.token) {
    throw new Error(`Refusing to release a Station registry lock owned by another process.`);
  }

  const releasePath = `${lease.lockPath}.release-${lease.owner.pid}-${lease.owner.token}`;
  await rename(lease.lockPath, releasePath);
  const movedOwner = await readRegistryLockOwner(releasePath);
  if (movedOwner.pid !== lease.owner.pid || movedOwner.token !== lease.owner.token) {
    throw new Error(`Station registry lock ownership changed during release.`);
  }
  await rm(releasePath, { recursive: true });
}

async function readRegistryLockOwner(lockPath) {
  let source;
  try {
    source = await readFile(join(lockPath, registryLockOwnerFile), "utf8");
  } catch (cause) {
    throw new Error(`Cannot verify Station registry lock ownership at ${lockPath}.`, { cause });
  }
  let document;
  try {
    document = JSON.parse(source);
  } catch (cause) {
    throw new Error(`Cannot parse Station registry lock ownership at ${lockPath}.`, { cause });
  }
  const result = registryLockOwnerSchema.safeParse(document);
  if (!result.success) {
    throw new Error(`Station registry lock ownership at ${lockPath} is malformed.`, {
      cause: result.error,
    });
  }
  return result.data;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return false;
    if (cause instanceof Error && "code" in cause && cause.code === "EPERM") return true;
    throw cause;
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await mutateStationLinkRegistry(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
