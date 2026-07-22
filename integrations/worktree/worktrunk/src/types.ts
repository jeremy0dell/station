import type { ExternalCommandRunner, RuntimeClock } from "@station/runtime";

export const WORKTRUNK_HOOK_NAMES = [
  "post-create",
  "post-switch",
  "pre-remove",
  "post-remove",
] as const;

export type WorktrunkHookName = (typeof WORKTRUNK_HOOK_NAMES)[number];

export type WorktrunkHookExpectation = {
  hookBin: string;
  observerSocketPath: string;
  stateDir: string;
  hookSpoolDir: string;
  autoStartFromHooks: boolean;
  stationConfigPath?: string;
};

export type WorktrunkHookPlanOptions = {
  expectation: WorktrunkHookExpectation;
  worktrunkConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export type WorktrunkHookPlan = {
  provider: "worktrunk";
  configPath: string;
  commands: Record<WorktrunkHookName, string>;
  missing: WorktrunkHookName[];
  changed: boolean;
  before: string;
  after: string;
};

export type WorktrunkHookInstallResult = WorktrunkHookPlan & {
  installed: boolean;
  backupPath?: string;
};

export type WorktrunkHookDoctorResult = {
  provider: "worktrunk";
  configPath: string;
  status: "ok" | "warn";
  installed: boolean;
  missing: WorktrunkHookName[];
  commands: Record<WorktrunkHookName, string>;
  message: string;
};

export type WorktrunkHookSetupErrorCode =
  | "WORKTRUNK_HOOK_CONFIG_UNREADABLE"
  | "WORKTRUNK_HOOK_INVALID_TOML"
  | "WORKTRUNK_HOOK_WRITE_FAILED";

export type WorktrunkProviderOptions = {
  command?: string;
  configPath?: string;
  useLifecycleHooks?: boolean;
  hookExpectation?: WorktrunkHookExpectation;
  timeoutMs?: number;
  runner?: ExternalCommandRunner;
  clock?: RuntimeClock;
  resolveRegistrationIdentity?: (worktreePath: string) => Promise<string | undefined>;
};
