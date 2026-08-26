import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type LocalStateUsage,
  LocalStateUsageSchema,
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
