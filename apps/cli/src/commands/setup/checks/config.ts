import { DEFAULT_CONFIG_PATH, loadConfigFromToml } from "@station/config";
import { pathIsSame, resolveLocalPath } from "@station/runtime";
import type { CliEnv } from "../../../env.js";
import type { SetupConfigDiagnosticFact, SetupConfigFact } from "../model.js";

export type SetupFileSystemReader = {
  readFile(path: string): Promise<string>;
};

export type CheckSetupConfigOptions = {
  configPath?: string;
  cwd?: string;
  homeDir?: string;
  gitRoot?: string;
  fs?: SetupFileSystemReader;
  env?: CliEnv;
};

export async function checkSetupConfig(
  options: CheckSetupConfigOptions = {},
): Promise<SetupConfigFact> {
  const path = setupConfigPath(options);
  const fs = options.fs ?? nodeFsReader();
  let source: string;
  try {
    source = await fs.readFile(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        status: "missing",
        path,
        message: `STATION config does not exist yet at ${path}.`,
      };
    }
    return {
      status: "invalid",
      path,
      source: "",
      message: `STATION config could not be read at ${path}.`,
    };
  }

  try {
    const loaded = await loadConfigFromToml(source, {
      configPath: path,
      homeDir: setupHomeDir(options),
    });
    const gitRoot = options.gitRoot;
    const matchedProject =
      gitRoot === undefined
        ? undefined
        : loaded.config.projects.find((project) => pathIsSame(project.root, gitRoot));
    const fact: SetupConfigFact = {
      status: "valid",
      path,
      source,
      hasProjectForRoot: matchedProject !== undefined,
      configuredHarnesses: Object.keys(loaded.config.harness ?? {}),
      configuredHookHarnesses: Object.entries(loaded.config.harness ?? {}).flatMap(
        ([id, providerConfig]) => (providerConfig?.installHooks === true ? [id] : []),
      ),
      defaults: {
        worktreeProvider: loaded.config.defaults.worktreeProvider,
        terminal: loaded.config.defaults.terminal,
        harness: loaded.config.defaults.harness,
      },
    };
    // Surface load diagnostics that loadConfigFromToml records but does not
    // throw on (broken project-local file, bad [tui]/[workspace]), so `stn
    // setup check` does not report a config with hidden problems as cleanly valid.
    const diagnostics: SetupConfigDiagnosticFact[] = loaded.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      severity: diagnostic.severity,
    }));
    if (diagnostics.length > 0) {
      fact.diagnostics = diagnostics;
    }
    if (loaded.config.worktree?.worktrunk?.useLifecycleHooks !== undefined) {
      fact.worktrunkUseLifecycleHooks = loaded.config.worktree.worktrunk.useLifecycleHooks;
    }
    if (matchedProject !== undefined) {
      fact.matchedProject = {
        id: matchedProject.id,
        worktreeProvider: loaded.config.defaults.worktreeProvider,
        worktrunkEnabled: matchedProject.worktrunk.enabled,
        terminal: matchedProject.defaults.terminal,
        harness: matchedProject.defaults.harness,
      };
    }
    return fact;
  } catch (error) {
    return {
      status: "invalid",
      path,
      source,
      message:
        error instanceof Error
          ? `STATION config is not safe to update: ${error.message}`
          : "STATION config is not safe to update.",
    };
  }
}

export function setupConfigPath(options: CheckSetupConfigOptions = {}): string {
  return resolveLocalPath(
    options.configPath ?? DEFAULT_CONFIG_PATH,
    setupHomeDir(options),
    options.cwd,
  );
}

function setupHomeDir(options: CheckSetupConfigOptions): string {
  return options.homeDir ?? options.env?.HOME ?? process.env.HOME ?? process.cwd();
}

function nodeFsReader(): SetupFileSystemReader {
  return {
    async readFile(path) {
      const { readFile } = await import("node:fs/promises");
      return readFile(path, "utf8");
    },
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
