import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readTextFileIfPresent } from "@station/runtime";
import { loadConfigFromToml } from "../load/index.js";
import type { SetupConfigMutationPlan } from "./mutations.js";

type SetupConfigPersistenceResult = {
  readonly status: "created" | "updated" | "unchanged";
  readonly configPath: string;
  readonly backupPath?: string;
};

type SetupConfigCommitStatus = "replaced" | "unchanged" | "stale";

type SetupConfigPersistenceFileSystem = {
  readTextFile(path: string): Promise<string | undefined>;
  writeBackup(path: string, content: string): Promise<void>;
  replaceTextIfCurrent(
    path: string,
    expectedContent: string | undefined,
    content: string,
  ): Promise<SetupConfigCommitStatus>;
};

export type PersistSetupConfigMutationOptions = {
  readonly homeDir: string;
  readonly now?: () => Date;
  readonly fs?: SetupConfigPersistenceFileSystem;
};

export async function persistSetupConfigMutation(
  plan: Exclude<SetupConfigMutationPlan, { operation: "none" | "blocked" }>,
  options: PersistSetupConfigMutationOptions,
): Promise<SetupConfigPersistenceResult> {
  await loadConfigFromToml(plan.content, {
    configPath: plan.path,
    homeDir: options.homeDir,
  });

  const fs = options.fs ?? nodePersistenceFileSystem();
  const current = await fs.readTextFile(plan.path);
  if (current === plan.content) {
    return { status: "unchanged", configPath: plan.path };
  }
  if (plan.operation === "create") {
    if (current !== undefined) {
      throw setupConfigPersistenceError(
        "SETUP_CONFIG_PRECONDITION_FAILED",
        "Station config changed after setup planning; no setup config was written.",
        plan.path,
      );
    }
  } else if (current !== plan.before) {
    throw setupConfigPersistenceError(
      "SETUP_CONFIG_PRECONDITION_FAILED",
      "Station config changed after setup planning; no setup config was written.",
      plan.path,
    );
  }

  let backupPath: string | undefined;
  if (plan.operation === "update") {
    const stamp = (options.now ?? (() => new Date()))().toISOString().replaceAll(/[:.]/g, "-");
    backupPath = `${plan.path}.${stamp}.bak`;
    try {
      await fs.writeBackup(backupPath, plan.before);
    } catch (cause) {
      throw setupConfigPersistenceError(
        "SETUP_CONFIG_BACKUP_FAILED",
        "Could not back up config.toml; the existing config was not changed.",
        backupPath,
        cause,
      );
    }
  }

  let commitStatus: SetupConfigCommitStatus;
  try {
    commitStatus = await fs.replaceTextIfCurrent(
      plan.path,
      plan.operation === "create" ? undefined : plan.before,
      plan.content,
    );
  } catch (cause) {
    throw setupConfigPersistenceError(
      "CONFIG_WRITE_FAILED",
      "Could not update config.toml.",
      plan.path,
      cause,
    );
  }
  if (commitStatus === "stale") {
    throw setupConfigPersistenceError(
      "SETUP_CONFIG_PRECONDITION_FAILED",
      "Station config changed during setup persistence; no newer config was replaced.",
      plan.path,
    );
  }

  const status = setupConfigPersistenceStatus(commitStatus, plan.operation);
  return backupPath === undefined
    ? { status, configPath: plan.path }
    : { status, configPath: plan.path, backupPath };
}

function setupConfigPersistenceStatus(
  commitStatus: SetupConfigCommitStatus,
  operation: "create" | "update",
): SetupConfigPersistenceResult["status"] {
  if (commitStatus === "unchanged") return "unchanged";
  return operation === "create" ? "created" : "updated";
}

function nodePersistenceFileSystem(): SetupConfigPersistenceFileSystem {
  return {
    readTextFile: readTextFileIfPresent,
    writeBackup: async (path, content) => {
      await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    },
    replaceTextIfCurrent: commitSetupConfigText,
  };
}

async function commitSetupConfigText(
  path: string,
  expectedContent: string | undefined,
  content: string,
): Promise<SetupConfigCommitStatus> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Serialize Station writers, then revalidate staged commits to reject edits from non-cooperating tools.
  const lock = await acquireSetupConfigLock(`${path}.station-setup.lock`);
  if (lock === undefined) return "stale";

  try {
    const targetPath = await setupConfigCommitTarget(path, expectedContent);
    if (targetPath === undefined) return "stale";
    const targetDirectory = dirname(targetPath);
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(targetDirectory, `.${basename(targetPath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);

      const current = await readTextFileIfPresent(path);
      if (current === content) return "unchanged";
      if (current !== expectedContent) return "stale";

      if (expectedContent === undefined) {
        try {
          // A hard link commits the staged create without replacing a path that appeared after planning.
          await link(temporaryPath, path);
          return "replaced";
        } catch (cause) {
          if (errorCode(cause) !== "EEXIST") throw cause;
          return (await readTextFileIfPresent(path)) === content ? "unchanged" : "stale";
        }
      }

      const revalidatedTarget = await resolvedPathIfPresent(path);
      if (revalidatedTarget !== targetPath) return "stale";
      const revalidatedContent = await readTextFileIfPresent(targetPath);
      if (revalidatedContent === content) return "unchanged";
      if (revalidatedContent !== expectedContent) return "stale";
      await rename(temporaryPath, targetPath);
      return "replaced";
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lock.path, { force: true }).catch(() => undefined);
  }
}

async function setupConfigCommitTarget(
  path: string,
  expectedContent: string | undefined,
): Promise<string | undefined> {
  if (expectedContent === undefined) return path;
  return resolvedPathIfPresent(path);
}

async function resolvedPathIfPresent(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw cause;
  }
}

async function acquireSetupConfigLock(
  path: string,
): Promise<{ close(): Promise<void>; path: string } | undefined> {
  try {
    const handle = await open(path, "wx", 0o600);
    return { close: () => handle.close(), path };
  } catch (cause) {
    if (errorCode(cause) !== "EEXIST") throw cause;
    const metadata = await stat(path).catch(() => undefined);
    if (metadata === undefined || Date.now() - metadata.mtimeMs <= setupConfigLockStaleMs) {
      return undefined;
    }
    await rm(path, { force: true });
    try {
      const handle = await open(path, "wx", 0o600);
      return { close: () => handle.close(), path };
    } catch (retryCause) {
      if (errorCode(retryCause) === "EEXIST") return undefined;
      throw retryCause;
    }
  }
}

function errorCode(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException | null | undefined)?.code;
}

const setupConfigLockStaleMs = 5 * 60 * 1_000;

function setupConfigPersistenceError(
  code: "SETUP_CONFIG_PRECONDITION_FAILED" | "SETUP_CONFIG_BACKUP_FAILED" | "CONFIG_WRITE_FAILED",
  message: string,
  hint: string,
  cause?: unknown,
): Error & { tag: "SetupConfigError"; code: string; hint: string } {
  const error = new Error(message, { cause }) as Error & {
    tag: "SetupConfigError";
    code: string;
    hint: string;
  };
  error.name = "SetupConfigError";
  error.tag = "SetupConfigError";
  error.code = code;
  error.hint = hint;
  return error;
}
