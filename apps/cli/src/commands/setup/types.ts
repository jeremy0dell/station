import type { ExternalCommandRunner } from "@station/runtime";
import type { CliEnv } from "../../env.js";
import type { SetupApplyFileSystem } from "./apply.js";
import type { SetupFileSystemReader } from "./checks/config.js";
import type { SetupStateDirFileSystem } from "./checks/stateDir.js";

export type SetupPromptChoice = {
  value: string;
  label: string;
};

export type SetupPromptAdapter = {
  confirm(message: string): Promise<boolean>;
  select(message: string, choices: readonly SetupPromptChoice[]): Promise<string>;
  close?(): void | Promise<void>;
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
  activateObserverConfig?: (input: { configPath: string; homeDir: string }) => Promise<void>;
  now?: () => Date;
  // Defaults to process.platform; injected by machine-state tests to drive the
  // macOS Command Line Tools check on any host.
  platform?: NodeJS.Platform;
  compiled?: boolean;
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
