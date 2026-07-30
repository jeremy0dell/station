import { writeFile } from "node:fs/promises";
import { readTextFileIfPresent, replaceTextFile } from "@station/runtime";
import { loadConfigFromToml } from "../load/index.js";
import type { SetupConfigMutationPlan } from "./mutations.js";

type SetupConfigPersistenceResult = {
  readonly status: "created" | "updated" | "unchanged";
  readonly configPath: string;
  readonly backupPath?: string;
};

type SetupConfigPersistenceFileSystem = {
  readTextFile(path: string): Promise<string | undefined>;
  writeBackup(path: string, content: string): Promise<void>;
  replaceText(path: string, content: string): Promise<void>;
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

  try {
    await fs.replaceText(plan.path, plan.content);
  } catch (cause) {
    throw setupConfigPersistenceError(
      "CONFIG_WRITE_FAILED",
      "Could not update config.toml.",
      plan.path,
      cause,
    );
  }

  const status = plan.operation === "create" ? "created" : "updated";
  return backupPath === undefined
    ? { status, configPath: plan.path }
    : { status, configPath: plan.path, backupPath };
}

function nodePersistenceFileSystem(): SetupConfigPersistenceFileSystem {
  return {
    readTextFile: readTextFileIfPresent,
    writeBackup: async (path, content) => {
      await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    },
    replaceText: async (path, content) => {
      await replaceTextFile({ path, contents: content, mode: 0o600, directoryMode: 0o700 });
    },
  };
}

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
