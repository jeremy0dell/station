import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig, type PersistSetupConfigMutationOptions } from "@station/config";
import {
  type ExternalCommandInput,
  publicSafeErrorFromUnknown,
  runExternalCommand,
  shellQuote,
} from "@station/runtime";
import {
  performSetupOperation,
  type SetupOperation,
  type SetupOperationCommit,
  type SetupOperationExecutor,
  type SetupOperationOutcome,
  type SetupOperationPorts,
  type SetupPackageInstallationPort,
  type SetupPackageInstallerCommit,
  type SetupPackageInstallOperation,
  type SetupTmuxPopupOperation,
  type SetupWorktrunkTrackingOperation,
} from "@station/setup-core";
import { runWorktrunkHooksCommand } from "../../providerHookAdapters.js";
import { commandEnv } from "../checks/env.js";
import {
  checkSetupTmuxBinding,
  tmuxPopupBindingBlock,
  tmuxPopupBindingEndMarker,
} from "../checks/tmuxBinding.js";
import { resolveSetupHarnessInstallation } from "../harnessInstallation.js";
import { SETUP_TOOL_DEFINITIONS } from "../toolDefinitions.js";
import type { SetupApplyFileSystem, SetupCommandDeps } from "../types.js";
import { createSetupConfigAdapter } from "./config.js";
import { createHarnessTrackingAdapter } from "./harnessTracking.js";
import type { SetupFacts } from "./inspectionTypes.js";
import { createObserverActivationAdapter } from "./observerActivation.js";

export type SetupOperationAdapterOptions = {
  readonly facts?: SetupFacts | (() => SetupFacts | undefined);
  readonly deps: SetupCommandDeps | (() => SetupCommandDeps);
  /** Receives delayed Observer startup progress lines during activation. */
  readonly observerStartupProgress?: (message: string) => void;
};

/**
 * ADAPTER
 *
 * Assigns package/bootstrap, config, provider, process, filesystem, and Observer operations to their final outward implementations.
 * Tmux changes revalidate the selected key and admitted config bytes immediately before mutation.
 * Observer activation forwards startup progress to the caller-supplied callback.
 */
export function createSetupOperationAdapter(
  options: SetupOperationAdapterOptions,
): SetupOperationExecutor {
  const facts = () => (typeof options.facts === "function" ? options.facts() : options.facts);
  const deps = () => (typeof options.deps === "function" ? options.deps() : options.deps);
  const initialFacts = facts();
  const initialDeps = deps();
  let committedConfigPath: string | undefined;
  const config: SetupOperationPorts["config"] = (operation) => {
    const currentDeps = deps();
    return createSetupConfigAdapter({
      facts: requireFacts(facts()),
      ...(currentDeps.now === undefined ? {} : { now: currentDeps.now }),
      ...(currentDeps.fs === undefined ? {} : { fs: configPersistenceFileSystem(currentDeps.fs) }),
      onCommitted: (configPath) => {
        committedConfigPath = configPath;
      },
    })(operation);
  };
  const observer = createObserverActivationAdapter({
    configPath: () => committedConfigPath,
    homeDir: initialFacts?.homeDir ?? initialDeps.homeDir ?? process.env.HOME ?? "",
    ...(options.observerStartupProgress === undefined
      ? {}
      : { onStartupProgress: options.observerStartupProgress }),
    ...(initialDeps.activateObserverConfig === undefined
      ? {}
      : { activateObserverConfig: initialDeps.activateObserverConfig }),
  });

  const ports: SetupOperationPorts = {
    config,
    observer,
    harnessTracking: (operation) => {
      const currentDeps = deps();
      if (currentDeps.providerTrackingPort !== undefined) {
        return currentDeps.providerTrackingPort(operation);
      }
      return createHarnessTrackingAdapter({
        configPath: () => committedConfigPath ?? facts()?.configPath,
        homeDir: initialFacts?.homeDir ?? currentDeps.homeDir ?? process.env.HOME ?? "",
        ...(currentDeps.env === undefined ? {} : { env: currentDeps.env }),
        ...(currentDeps.providerHookIngressLauncher === undefined
          ? {}
          : { providerHookIngressLauncher: currentDeps.providerHookIngressLauncher }),
        ...(currentDeps.providerHookArtifactOwner === undefined
          ? {}
          : { providerHookArtifactOwner: currentDeps.providerHookArtifactOwner }),
      })(operation);
    },
    worktrunk: (operation) => {
      const currentDeps = deps();
      if (operation.kind === "configure-worktrunk-shell") {
        return configureWorktrunkShell(operation, requireFacts(facts()), currentDeps);
      }
      const currentFacts = requireFacts(facts());
      return (
        currentDeps.providerTrackingPort?.(operation) ??
        prepareWorktrunkTracking(
          operation,
          currentFacts,
          committedConfigPath ?? currentFacts.config.path,
          currentDeps,
        )
      );
    },
    tmux: (operation) => configureTmux(operation, requireFacts(facts()), deps()),
    packages: createPackageInstallationAdapter(facts, deps),
    launchers: (operation) => {
      const currentFacts = requireFacts(facts());
      return runExternalOperation(
        operation,
        ["bun", "run", "--cwd", currentFacts.launchers.packageRoot, "station:link"],
        { kind: "launcher-link" },
        deps(),
      );
    },
  };
  return async (operation) => {
    try {
      return await performSetupOperation(operation, ports);
    } catch (error) {
      return failedOutcome(operation, error, unexpectedOperationFallback(operation));
    }
  };
}

function createPackageInstallationAdapter(
  facts: () => SetupFacts | undefined,
  deps: () => SetupCommandDeps,
): SetupPackageInstallationPort {
  return (operation) => {
    const command = packageInstallCommand(operation, facts());
    const target = packageTarget(operation);
    return runExternalOperation(operation, command, { kind: "package-installer", target }, deps());
  };
}

function packageInstallCommand(
  operation: SetupPackageInstallOperation,
  facts: SetupFacts | undefined,
): readonly string[] {
  switch (operation.kind) {
    case "install-tool":
      return ["brew", "install", SETUP_TOOL_DEFINITIONS[operation.tool].formula];
    case "install-harness": {
      const currentFacts = requireFacts(facts);
      return resolveSetupHarnessInstallation({
        harnessId: operation.harnessId,
        brewAvailable: currentFacts.brew.status === "ok",
        homeDir: currentFacts.homeDir,
        macos: currentFacts.xcode.applicable,
      }).command;
    }
    case "install-homebrew":
      return [
        "/bin/bash",
        "-c",
        [
          "set -eu",
          'installer="$(mktemp)"',
          "trap 'rm -f \"$installer\"' EXIT",
          'curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$installer"',
          '/bin/bash "$installer"',
        ].join("; "),
      ];
    case "install-xcode-command-line-tools":
      return ["xcode-select", "--install"];
    default:
      return assertNever(operation);
  }
}

function packageTarget(
  operation: SetupPackageInstallOperation,
): SetupPackageInstallerCommit["target"] {
  switch (operation.kind) {
    case "install-tool":
      return { kind: "tool", id: operation.tool };
    case "install-harness":
      return { kind: "harness", id: operation.harnessId };
    case "install-homebrew":
      return { kind: "bootstrap", id: "homebrew" };
    case "install-xcode-command-line-tools":
      return { kind: "bootstrap", id: "xcode-command-line-tools" };
    default:
      return assertNever(operation);
  }
}

async function configureWorktrunkShell(
  operation: Extract<SetupOperation, { kind: "configure-worktrunk-shell" }>,
  facts: SetupFacts,
  deps: SetupCommandDeps,
): Promise<SetupOperationOutcome> {
  const base = [
    facts.worktrunk.resolvedPath ?? facts.worktrunk.command,
    "-y",
    "config",
    "shell",
    "install",
  ];
  const integration = facts.worktrunkShellIntegration;
  const command = integration.shell === undefined ? base : [...base, integration.shell];
  if (integration.rcPath !== undefined) {
    try {
      await (deps.fs?.access ?? access)(integration.rcPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT") {
        const recovery = [["touch", integration.rcPath], command]
          .map((part) => part.map((value) => shellQuote(value)).join(" "))
          .join(" && ");
        return {
          status: "failed",
          operationId: operation.id,
          error: {
            tag: "SetupWorktrunkShellError",
            code: "SETUP_WORKTRUNK_SHELL_RC_MISSING",
            message: `Active ${integration.shell ?? "shell"} rc file not found: ${integration.rcPath}`,
            hint: `Run: ${recovery}`,
          },
        };
      }
    }
  }
  const outcome = await runExternalOperation(operation, command, { kind: "worktrunk-shell" }, deps);
  if (outcome.status === "completed") return outcome;
  return {
    ...outcome,
    error: {
      ...outcome.error,
      hint: `Run: ${command.map((value) => shellQuote(value)).join(" ")}`,
    },
  };
}

async function prepareWorktrunkTracking(
  operation: SetupWorktrunkTrackingOperation,
  facts: SetupFacts,
  configPath: string,
  deps: SetupCommandDeps,
): Promise<SetupOperationOutcome> {
  try {
    const loaded = await loadConfig({ configPath, homeDir: facts.homeDir });
    const result = await runWorktrunkHooksCommand(["install", "--yes"], {
      config: loaded.config,
      configPath: loaded.configPath,
      ...(deps.env === undefined ? {} : { env: deps.env }),
      ...(deps.providerHookIngressLauncher === undefined
        ? {}
        : { providerHookIngressLauncher: deps.providerHookIngressLauncher }),
      ...(deps.providerHookArtifactOwner === undefined
        ? {}
        : { providerHookArtifactOwner: deps.providerHookArtifactOwner }),
    });
    if (!result.installed) throw worktrunkTrackingFallback;
    const commit =
      result.backupPath === undefined
        ? {
            kind: "provider-tracking" as const,
            provider: "worktrunk" as const,
            changed: result.changed,
          }
        : {
            kind: "provider-tracking" as const,
            provider: "worktrunk" as const,
            changed: result.changed,
            backupPaths: [result.backupPath],
          };
    return { status: "completed", operationId: operation.id, commit };
  } catch (error) {
    return failedOutcome(operation, error, worktrunkTrackingFallback);
  }
}

async function configureTmux(
  operation: SetupTmuxPopupOperation,
  facts: SetupFacts,
  deps: SetupCommandDeps,
): Promise<SetupOperationOutcome> {
  if (facts.tmuxBinding.status === "conflict") {
    return failedOutcome(operation, tmuxConflictFallback, tmuxConflictFallback);
  }

  try {
    const fs = deps.fs ?? nodeSetupFileSystem();
    const existing = await readFileIfPresent(fs, facts.tmuxBinding.path);
    const recheckOptions: Parameters<typeof checkSetupTmuxBinding>[0] = {
      homeDir: facts.homeDir,
      fs: {
        async readFile(path) {
          if (path === facts.tmuxBinding.path && existing !== undefined) return existing;
          throw Object.assign(new Error(`Missing file: ${path}`), { code: "ENOENT" });
        },
      },
      launcherCommand: facts.tmuxBinding.launcherCommand,
      runShellCommand: facts.tmuxBinding.runShellCommand,
      tmuxCommand: facts.tmux.resolvedPath ?? facts.tmux.command,
    };
    if (deps.env !== undefined) recheckOptions.env = deps.env;
    if (deps.runner !== undefined) recheckOptions.runner = deps.runner;
    const currentBinding = await checkSetupTmuxBinding(recheckOptions);
    if (currentBinding.status === "conflict") {
      return {
        status: "failed",
        operationId: operation.id,
        error: { ...tmuxConflictFallback, message: currentBinding.message },
      };
    }
    if (currentBinding.bindingKey !== facts.tmuxBinding.bindingKey) {
      return {
        status: "failed",
        operationId: operation.id,
        error: {
          ...tmuxConflictFallback,
          message: `The tmux popup key changed from ${facts.tmuxBinding.bindingKey} to ${currentBinding.bindingKey} after setup inspection.`,
        },
      };
    }

    if (operation.scope === "live") {
      if (!currentBinding.insideTmux || currentBinding.liveStatus === "loaded") {
        return {
          status: "completed",
          operationId: operation.id,
          commit: { kind: "tmux-popup", scope: "live", changed: false },
        };
      }
      if (currentBinding.liveStatus === "unknown") {
        return {
          status: "failed",
          operationId: operation.id,
          error: {
            ...tmuxConflictFallback,
            message:
              "The current tmux server binding could not be revalidated; setup left it unchanged.",
          },
        };
      }
      return runExternalOperation(
        operation,
        [
          facts.tmux.resolvedPath ?? facts.tmux.command,
          "bind-key",
          currentBinding.bindingKey,
          "run-shell",
          "-b",
          currentBinding.runShellCommand,
        ],
        { kind: "tmux-popup", scope: "live", changed: true },
        deps,
      );
    }

    if (currentBinding.status === "ok") {
      return {
        status: "completed",
        operationId: operation.id,
        commit: { kind: "tmux-popup", scope: "persisted", changed: false },
      };
    }
    const block = tmuxPopupBindingBlock(currentBinding.launcherCommand, {
      bindingKey: currentBinding.bindingKey,
      runShellCommand: currentBinding.runShellCommand,
    });
    const content = replaceMarkedBlock(
      existing ?? "",
      currentBinding.marker,
      tmuxPopupBindingEndMarker,
      block,
    );
    if (content === existing) {
      return {
        status: "completed",
        operationId: operation.id,
        commit: { kind: "tmux-popup", scope: "persisted", changed: false },
      };
    }

    // A failed backup must leave the user-authored tmux file untouched.
    const backupPath =
      existing === undefined
        ? undefined
        : await writeTmuxBackup(fs, currentBinding.path, existing, deps.now);
    await replaceWithSetupFileSystem(fs, currentBinding.path, content, existing);
    return {
      status: "completed",
      operationId: operation.id,
      commit:
        backupPath === undefined
          ? { kind: "tmux-popup", scope: "persisted", changed: true }
          : { kind: "tmux-popup", scope: "persisted", changed: true, backupPath },
    };
  } catch (error) {
    return failedOutcome(operation, error, tmuxWriteFallback);
  }
}

async function runExternalOperation(
  operation: SetupOperation,
  command: readonly string[],
  commit: SetupOperationCommit,
  deps: Pick<SetupCommandDeps, "runner" | "env">,
): Promise<SetupOperationOutcome> {
  try {
    const [binary, ...args] = command;
    if (binary === undefined) throw externalOperationFallback;
    const input: ExternalCommandInput = {
      command: binary,
      args,
      stdio: "inherit",
      maxOutputChars: 4096,
    };
    const env = commandEnv(deps.env);
    if (env !== undefined) input.env = env;
    await runExternalCommand(input, deps.runner);
    return { status: "completed", operationId: operation.id, commit };
  } catch (error) {
    return failedOutcome(operation, error, externalOperationFallback);
  }
}

function failedOutcome(
  operation: SetupOperation,
  error: unknown,
  fallback: { tag: string; code: string; message: string; provider?: string },
): SetupOperationOutcome {
  return {
    status: "failed",
    operationId: operation.id,
    error: publicSafeErrorFromUnknown(error, fallback),
  };
}

function configPersistenceFileSystem(
  fs: SetupApplyFileSystem,
): NonNullable<PersistSetupConfigMutationOptions["fs"]> {
  return {
    readTextFile: (path) => readFileIfPresent(fs, path),
    writeBackup: (path, content) => fs.writeFile(path, content),
    replaceTextIfCurrent: async (path, expectedContent, content) => {
      const current = await readFileIfPresent(fs, path);
      if (current === content) return "unchanged";
      if (current !== expectedContent) return "stale";
      await replaceWithSetupFileSystem(fs, path, content, current);
      return "replaced";
    },
  };
}

async function readFileIfPresent(
  fs: SetupApplyFileSystem,
  path: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT") return undefined;
    throw cause;
  }
}

async function writeTmuxBackup(
  fs: SetupApplyFileSystem,
  path: string,
  content: string,
  now: (() => Date) | undefined,
): Promise<string> {
  const stamp = (now ?? (() => new Date()))().toISOString().replaceAll(/[:.]/g, "-");
  const backupPath = `${path}.${stamp}.bak`;
  if (fs.writeFileExclusive !== undefined) {
    await fs.writeFileExclusive(backupPath, content);
    return backupPath;
  }
  try {
    await fs.access(backupPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") throw cause;
    await fs.writeFile(backupPath, content);
    return backupPath;
  }
  throw Object.assign(new Error(`Backup already exists: ${backupPath}`), { code: "EEXIST" });
}

async function replaceWithSetupFileSystem(
  fs: SetupApplyFileSystem,
  path: string,
  content: string,
  expectedContent: string | undefined,
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tempPath, content);
    // The exact bytes admitted by preflight must still be current after the replacement is ready.
    if ((await readFileIfPresent(fs, path)) !== expectedContent) {
      throw Object.assign(new Error(`Setup target changed before replacement: ${path}`), {
        code: "ESTALE",
      });
    }
    await fs.rename(tempPath, path);
  } catch (error) {
    await fs.rm?.(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function nodeSetupFileSystem(): SetupApplyFileSystem {
  return {
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, content) => writeFile(path, content, "utf8"),
    writeFileExclusive: async (path, content) => {
      await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    },
    rename,
    access,
    rm,
  };
}

function replaceMarkedBlock(
  existing: string,
  marker: string,
  endMarker: string,
  block: string,
): string {
  const start = existing.indexOf(marker);
  if (start === -1) return `${ensureTrailingNewline(existing)}${block}`;
  const end = existing.indexOf(endMarker, start + marker.length);
  if (end === -1) throw new Error(`Existing marker ${marker} has no closing marker.`);
  const after = existing.indexOf("\n", end + endMarker.length);
  const suffix = after === -1 ? "" : existing.slice(after + 1);
  return `${existing.slice(0, start)}${block}${suffix}`;
}

function ensureTrailingNewline(value: string): string {
  return value.length === 0 || value.endsWith("\n") ? value : `${value}\n`;
}

function requireFacts(facts: SetupFacts | undefined): SetupFacts {
  if (facts === undefined) throw new Error("This setup operation requires collected setup facts.");
  return facts;
}

function unexpectedOperationFallback(operation: SetupOperation): {
  tag: string;
  code: string;
  message: string;
  provider?: string;
} {
  if (operation.kind === "prepare-harness-tracking") {
    return {
      tag: "SetupProviderTrackingError",
      code: "SETUP_PROVIDER_TRACKING_FAILED",
      message: `Station tracking could not be prepared for ${operation.harnessId}.`,
      provider: operation.harnessId,
    };
  }
  if (operation.kind === "prepare-worktrunk-tracking") return worktrunkTrackingFallback;
  if (operation.kind === "configure-tmux-popup") return tmuxWriteFallback;
  return externalOperationFallback;
}

const externalOperationFallback = {
  tag: "SetupOperationError",
  code: "SETUP_OPERATION_FAILED",
  message: "The setup operation failed.",
};
const worktrunkTrackingFallback = {
  tag: "SetupProviderTrackingError",
  code: "SETUP_PROVIDER_TRACKING_FAILED",
  message: "Station Worktrunk tracking could not be prepared.",
  provider: "worktrunk",
};
const tmuxConflictFallback = {
  tag: "SetupTmuxError",
  code: "SETUP_TMUX_CONFLICT",
  message: "The tmux popup binding conflicts with an existing configuration.",
};
const tmuxWriteFallback = {
  tag: "SetupTmuxError",
  code: "SETUP_TMUX_WRITE_FAILED",
  message: "The tmux popup binding could not be persisted.",
};

function assertNever(value: never): never {
  throw new Error(`Unsupported setup operation value: ${String(value)}`);
}
