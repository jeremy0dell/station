import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type LocalStateUsage,
  LocalStateUsageSchema,
  type LogComponent,
  type RetentionPolicy,
  RetentionPolicySchema,
} from "@station/contracts";

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxDays: 14,
  maxTotalMb: 250,
  maxFileMb: 10,
  maxFilesPerComponent: 5,
  components: {
    observerMaxMb: 100,
    cliMaxMb: 25,
    tuiMaxMb: 25,
    hookRunnerMaxMb: 25,
    providerMaxMb: 75,
  },
  sqlite: {
    eventsMaxDays: 30,
    commandsMaxDays: 60,
    errorsMaxDays: 60,
    providerObservationsMaxDays: 14,
  },
  debugBundles: {
    maxBundles: 10,
    maxDays: 30,
  },
  hookSpool: {
    deliveredDeleteImmediately: true,
    failedMaxDays: 7,
    failedMaxItems: 1000,
  },
};

export type PartialRetentionPolicy = {
  maxDays?: number | undefined;
  maxTotalMb?: number | undefined;
  maxFileMb?: number | undefined;
  maxFilesPerComponent?: number | undefined;
  components?: Partial<Record<keyof RetentionPolicy["components"], number | undefined>> | undefined;
  sqlite?: Partial<Record<keyof RetentionPolicy["sqlite"], number | undefined>> | undefined;
  debugBundles?:
    | Partial<Record<keyof RetentionPolicy["debugBundles"], number | undefined>>
    | undefined;
  hookSpool?:
    | {
        deliveredDeleteImmediately?: boolean | undefined;
        failedMaxDays?: number | undefined;
        failedMaxItems?: number | undefined;
      }
    | undefined;
};

export function mergeRetentionPolicy(input?: PartialRetentionPolicy): RetentionPolicy {
  if (input === undefined) {
    return DEFAULT_RETENTION_POLICY;
  }

  return RetentionPolicySchema.parse({
    ...DEFAULT_RETENTION_POLICY,
    ...input,
    components: {
      ...DEFAULT_RETENTION_POLICY.components,
      ...input.components,
    },
    sqlite: {
      ...DEFAULT_RETENTION_POLICY.sqlite,
      ...input.sqlite,
    },
    debugBundles: {
      ...DEFAULT_RETENTION_POLICY.debugBundles,
      ...input.debugBundles,
    },
    hookSpool: {
      ...DEFAULT_RETENTION_POLICY.hookSpool,
      ...input.hookSpool,
    },
  });
}

export type ComponentLogFileSet = {
  activePath: string;
  rotatedPaths: string[];
};

export type PruneRotatedComponentLogsResult = {
  deleted: number;
  failures: number;
};

export async function discoverComponentLogFiles(
  stateDir: string,
  component: LogComponent,
  maxRotated = 32,
): Promise<ComponentLogFileSet> {
  const logDir = join(stateDir, "logs");
  const activeName = componentFileName(component);
  const activePath = join(logDir, activeName);
  const prefix = `${activeName.slice(0, -".jsonl".length)}.`;
  let entries: Dirent[];
  try {
    entries = await readdir(logDir, { withFileTypes: true });
  } catch {
    return { activePath, rotatedPaths: [] };
  }
  const candidates = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.name.startsWith(prefix) &&
          entry.name.endsWith(".jsonl") &&
          entry.name !== activeName,
      )
      .map(async (entry) => {
        const path = join(logDir, entry.name);
        try {
          const fileStat = await lstat(path);
          return { path, mtimeMs: fileStat.mtimeMs };
        } catch {
          return { path, mtimeMs: Number.NEGATIVE_INFINITY };
        }
      }),
  );
  return {
    activePath,
    rotatedPaths: candidates
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(
        0,
        maxRotated === Number.MAX_SAFE_INTEGER ? undefined : Math.max(0, Math.min(maxRotated, 32)),
      )
      .map((candidate) => candidate.path),
  };
}

export async function pruneRotatedComponentLogs(options: {
  stateDir: string;
  component: LogComponent;
  policy: RetentionPolicy;
  now?: Date;
}): Promise<PruneRotatedComponentLogsResult> {
  const now = options.now ?? new Date();
  const files = await discoverComponentLogFiles(
    options.stateDir,
    options.component,
    Number.MAX_SAFE_INTEGER,
  );
  const candidates = (
    await Promise.all(
      files.rotatedPaths.map(async (path) => {
        let handle: Awaited<ReturnType<typeof open>>;
        try {
          handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        } catch {
          return { path, failure: true as const };
        }
        try {
          const fileStat = await handle.stat();
          if (!fileStat.isFile()) return { path, failure: true as const };
          await handle.chmod(0o600);
          return { path, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
        } catch {
          return { path, failure: true as const };
        } finally {
          await handle.close().catch(() => undefined);
        }
      }),
    )
  ).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
  let failures = candidates.filter((candidate) => "failure" in candidate).length;
  const regular = candidates
    .filter(
      (candidate): candidate is Extract<typeof candidate, { size: number }> =>
        !("failure" in candidate),
    )
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  const graceCutoff = now.getTime() - 60_000;
  const ageCutoff = now.getTime() - options.policy.maxDays * 24 * 60 * 60 * 1000;
  const componentLimit = componentLimitBytes(options.component, options.policy);
  let activeBytes = 0;
  let activeFiles = 0;
  try {
    const activeStat = await lstat(files.activePath);
    if (activeStat.isFile() && !activeStat.isSymbolicLink()) {
      activeBytes = activeStat.size;
      activeFiles = 1;
    }
  } catch {
    // An absent active file contributes no bytes; append durability was already established.
  }
  let retainedBytes = activeBytes + regular.reduce((sum, candidate) => sum + candidate.size, 0);
  let retainedCount = activeFiles + regular.length;
  let deleted = 0;

  for (const candidate of regular) {
    const overAge = candidate.mtimeMs < ageCutoff;
    const overCount = retainedCount > options.policy.maxFilesPerComponent;
    const overBytes = retainedBytes > componentLimit;
    if (candidate.mtimeMs > graceCutoff || (!overAge && !overCount && !overBytes)) {
      continue;
    }
    try {
      await unlink(candidate.path);
      deleted += 1;
      retainedCount -= 1;
      retainedBytes -= candidate.size;
    } catch {
      failures += 1;
    }
  }

  return { deleted, failures };
}

export async function scanLocalStateUsage(
  stateDir: string,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): Promise<LocalStateUsage> {
  const entries = await Promise.all([
    usageEntry(
      "logs",
      join(stateDir, "logs"),
      mb(
        policy.components.observerMaxMb +
          policy.components.cliMaxMb +
          policy.components.tuiMaxMb +
          policy.components.hookRunnerMaxMb +
          policy.components.providerMaxMb,
      ),
    ),
    usageEntry("database", join(stateDir, "observer.sqlite")),
    usageEntry("debug_bundles", join(stateDir, "diagnostics"), mb(policy.maxTotalMb)),
    usageEntry("hook_spool", join(stateDir, "spool", "hooks")),
  ]);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const limitBytes = mb(policy.maxTotalMb);

  return LocalStateUsageSchema.parse({
    stateDir,
    totalBytes,
    limitBytes,
    overLimit: totalBytes > limitBytes,
    entries: entries.map((entry) => ({
      ...entry,
      overLimit: entry.limitBytes === undefined ? false : entry.sizeBytes > entry.limitBytes,
    })),
  });
}

async function usageEntry(
  kind: LocalStateUsage["entries"][number]["kind"],
  path: string,
  limitBytes?: number,
): Promise<LocalStateUsage["entries"][number]> {
  const { sizeBytes, fileCount } = await pathUsage(path);
  return {
    kind,
    path,
    sizeBytes,
    fileCount,
    ...(limitBytes === undefined ? {} : { limitBytes }),
  };
}

async function pathUsage(path: string): Promise<{ sizeBytes: number; fileCount: number }> {
  let pathStat: Awaited<ReturnType<typeof stat>>;
  try {
    pathStat = await stat(path);
  } catch {
    return { sizeBytes: 0, fileCount: 0 };
  }

  if (!pathStat.isDirectory()) {
    return { sizeBytes: pathStat.size, fileCount: 1 };
  }

  const children = await directoryChildren(path);
  const childStats = await Promise.all(children.map(pathUsage));
  return childStats.reduce(
    (acc, child) => ({
      sizeBytes: acc.sizeBytes + child.sizeBytes,
      fileCount: acc.fileCount + child.fileCount,
    }),
    { sizeBytes: 0, fileCount: 0 },
  );
}

async function directoryChildren(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

function mb(value: number): number {
  return value * 1024 * 1024;
}

function componentFileName(component: LogComponent): string {
  return component === "hook" ? "hooks.jsonl" : `${component}.jsonl`;
}

function componentLimitBytes(component: LogComponent, policy: RetentionPolicy): number {
  const componentMb =
    component === "observer"
      ? policy.components.observerMaxMb
      : component === "cli"
        ? policy.components.cliMaxMb
        : component === "tui"
          ? policy.components.tuiMaxMb
          : component === "hook"
            ? policy.components.hookRunnerMaxMb
            : policy.components.providerMaxMb;
  return mb(componentMb);
}
