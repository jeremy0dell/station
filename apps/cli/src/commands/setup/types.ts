import type {
  CliSetupHarnessId,
  HarnessHooksStatus,
  ObserverLifecycleFailure,
  ProviderHookArtifactOwner,
} from "@station/contracts";
import type { ExternalCommandRunner } from "@station/runtime";
import type { SetupOperation, SetupOperationOutcome } from "@station/setup-core";
import type { CliEnv } from "../../env.js";
import type { SetupFileSystemReader } from "./checks/config.js";
import type { SetupStateDirFileSystem } from "./checks/stateDir.js";

export type SetupApplyFileSystem = {
  readonly mkdir: (...arguments_: [string, { recursive: true }]) => Promise<void>;
  readonly readFile: (...arguments_: [string]) => Promise<string>;
  readonly writeFile: (...arguments_: [string, string]) => Promise<void>;
  readonly writeFileExclusive?: (...arguments_: [string, string]) => Promise<void>;
  readonly rename: (...arguments_: [string, string]) => Promise<void>;
  readonly access: (...arguments_: [string]) => Promise<void>;
  readonly rm?: (...arguments_: [string, { force: true }]) => Promise<void>;
};

export type SetupPromptChoice = {
  value: string;
  label: string;
  hint?: string;
};

export type SetupPromptAnswer<T> =
  | { readonly kind: "answered"; readonly value: T }
  | { readonly kind: "cancelled" };

export type SetupConfirmRequest = {
  readonly message: string;
};

export type SetupSelectOneRequest = {
  readonly message: string;
  readonly choices: readonly SetupPromptChoice[];
  readonly initialValue?: string;
};

export type SetupSelectManyRequest = {
  readonly message: string;
  readonly choices: readonly SetupPromptChoice[];
  readonly initialValues?: readonly string[];
};

export type SetupPromptAdapter = {
  readonly isInteractiveTerminal: () => boolean;
  readonly intro: (title: string) => void;
  readonly outro: (message: string) => void;
  readonly cancel: (message: string) => void;
  readonly confirm: (request: SetupConfirmRequest) => Promise<SetupPromptAnswer<boolean>>;
  readonly selectOne: (request: SetupSelectOneRequest) => Promise<SetupPromptAnswer<string>>;
  readonly selectMany: (
    request: SetupSelectManyRequest,
  ) => Promise<SetupPromptAnswer<readonly string[]>>;
  readonly note: (message: string, title?: string) => void;
  readonly logStep: (message: string) => void;
  readonly logSuccess: (message: string) => void;
  readonly logWarn: (message: string) => void;
  readonly logError: (message: string) => void;
  readonly logInfo: (message: string) => void;
};

export type SetupCommandDeps = {
  runner?: ExternalCommandRunner;
  prompt?: SetupPromptAdapter;
  fs?: SetupFileSystemReader & SetupApplyFileSystem;
  access?: (path: string) => Promise<void>;
  writeStdout?: (chunk: string) => void | Promise<void>;
  env?: CliEnv;
  cwd?: string;
  homeDir?: string;
  activateObserverConfig?: (input: {
    configPath: string;
    homeDir: string;
    onStartupProgress?: (message: string) => void;
  }) => Promise<ObserverLifecycleFailure | undefined>;
  now?: () => Date;
  nodeVersion?: string;
  // Defaults to process.platform; injected by machine-state tests to drive the
  // macOS Command Line Tools check on any host.
  platform?: NodeJS.Platform;
  compiled?: boolean;
  providerHookIngressLauncher?: string;
  providerHookArtifactOwner?: ProviderHookArtifactOwner;
  providerTrackingPort?: (
    operation: Extract<
      SetupOperation,
      { kind: "prepare-harness-tracking" | "prepare-worktrunk-tracking" }
    >,
  ) => Promise<SetupOperationOutcome>;
  /**
   * Inspects Station-owned tracking artifacts without contacting the Observer.
   * An absent result is valid only for a harness with no external tracking artifact.
   */
  probeHarnessHooksStatus?: (
    harnessId: CliSetupHarnessId,
    configPath: string,
  ) => Promise<HarnessHooksStatus | undefined>;
  tmuxPopupOwnerRoot?: string;
  stateDirExecute?: (path: string) => Promise<void>;
  stateDirFs?: SetupStateDirFileSystem;
};

export type SetupCommandOptions = {
  configPath?: string;
  env?: CliEnv;
  renderHelp?: (path: readonly string[]) => string;
};

export type SetupCommandResult = {
  code: number;
  output?: unknown;
};
