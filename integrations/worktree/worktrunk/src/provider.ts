import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type {
  CreateWorktreeRequest,
  DiagnosticDetail,
  ExternalCommandDiagnosticDetail,
  GetWorktreeRequest,
  ProviderDoctorCheck,
  ProviderDoctorContext,
  ProviderHealth,
  ProviderId,
  ProviderProjectConfig,
  RawWorktreeEvent,
  RemoveWorktreeRequest,
  RemoveWorktreeResult,
  WorktreeCapabilities,
  WorktreeEventContext,
  WorktreeObservation,
  WorktreeProvider,
} from "@station/contracts";
import { ExternalCommandDiagnosticDetailSchema } from "@station/contracts";
import {
  type ExternalCommandRunner,
  type RuntimeClock,
  runExternalCommand,
  runRuntimeBoundaryWithRetryAndTimeout,
  safeErrorFromUnknown,
  stableName,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { missingWorktrunkAutomationFlagSupport, worktrunkAutomationMode } from "./automation.js";
import {
  type CheckWorktrunkDependencyOptions,
  checkWorktrunkDependency,
  type WorktrunkDependencyStatus,
  worktrunkInstallHint,
} from "./dependency.js";
import {
  ProviderUnavailableError,
  providerErrorFromUnknown,
  WorktrunkProviderError,
  type WorktrunkProviderErrorCode,
} from "./errors.js";
import { doctorWorktrunkHooks } from "./hooks.js";
import { applyRecoveryBreadcrumbMetadata } from "./metadata.js";
import { parseWorktrunkListJson, parseWorktrunkListPayload } from "./parse.js";

export type WorktrunkProviderOptions = {
  command?: string;
  configPath?: string;
  useLifecycleHooks?: boolean;
  timeoutMs?: number;
  runner?: ExternalCommandRunner;
  clock?: RuntimeClock;
};

const defaultCapabilities: WorktreeCapabilities = {
  canCreate: true,
  canRemove: true,
  canList: true,
  canEmitLifecycleEvents: true,
  canExposeDirtyState: true,
  canSeedWorkingTree: true,
};

export class WorktrunkProvider implements WorktreeProvider {
  readonly id: ProviderId = "worktrunk";

  readonly #command: string;
  readonly #configPath: string | undefined;
  readonly #useLifecycleHooks: boolean | undefined;
  readonly #timeoutMs: number;
  readonly #runner: ExternalCommandRunner | undefined;
  readonly #clock: RuntimeClock;
  readonly #observations = new Map<string, WorktreeObservation>();

  constructor(options: WorktrunkProviderOptions = {}) {
    this.#command = options.command ?? process.env.STATION_WORKTRUNK_BIN ?? "wt";
    this.#configPath = options.configPath;
    this.#useLifecycleHooks = options.useLifecycleHooks;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#runner = options.runner;
    this.#clock = options.clock ?? systemClock;
  }

  capabilities(): WorktreeCapabilities {
    return defaultCapabilities;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = toIsoTimestamp(this.#clock.now());
    const dependencyOptions: CheckWorktrunkDependencyOptions = {
      command: this.#command,
      timeoutMs: this.#timeoutMs,
    };
    if (this.#runner !== undefined) dependencyOptions.runner = this.#runner;
    const dependency = await checkWorktrunkDependency(dependencyOptions);
    if (dependency.status === "available") {
      return {
        providerId: this.id,
        providerType: "worktree",
        status: "healthy",
        lastCheckedAt: checkedAt,
        capabilities: this.capabilities(),
        diagnostics: dependencyDiagnostics(dependency),
      };
    }

    return {
      providerId: this.id,
      providerType: "worktree",
      status: "unavailable",
      lastCheckedAt: checkedAt,
      lastError: dependency.error,
      capabilities: this.capabilities(),
      diagnostics: dependencyDiagnostics(dependency),
    };
  }

  async doctorChecks(context: ProviderDoctorContext = {}): Promise<ProviderDoctorCheck[]> {
    const checks: ProviderDoctorCheck[] = [await this.#automationCapabilityCheck()];
    try {
      const result = await doctorWorktrunkHooks({
        ...(this.#configPath === undefined ? {} : { worktrunkConfigPath: this.#configPath }),
        ...(context.stationConfigPath === undefined
          ? {}
          : { stationConfigPath: context.stationConfigPath }),
        enabled: this.#useLifecycleHooks !== false,
      });
      const check: ProviderDoctorCheck = {
        name: "worktrunk-hooks",
        status: result.status,
        message: `${result.message} Config: ${result.configPath}.`,
      };
      if (result.status !== "ok") {
        check.error = {
          tag: "WorktrunkHookSetupError",
          code: "WORKTRUNK_HOOKS_MISSING",
          message: result.message,
          provider: this.id,
        };
      }
      checks.push(check);
      return checks;
    } catch (cause) {
      const error = safeErrorFromUnknown(cause, {
        tag: "WorktrunkHookSetupError",
        code: "WORKTRUNK_HOOK_DIAGNOSTIC_FAILED",
        message: "Worktrunk hook diagnostics failed.",
        provider: this.id,
      });
      checks.push({
        name: "worktrunk-hooks",
        status: "error",
        message: error.message,
        error,
      });
      return checks;
    }
  }

  async ingestEvent(
    _event: RawWorktreeEvent,
    _context: WorktreeEventContext,
  ): Promise<WorktreeObservation[]> {
    return [];
  }

  async listWorktrees(project: ProviderProjectConfig): Promise<WorktreeObservation[]> {
    if (!project.worktrunk.enabled) {
      return [];
    }

    const output = await this.#run(
      this.#args(["list", "--format=json"]),
      project.root,
      {
        code: "WORKTRUNK_COMMAND_FAILED",
        message: "Worktrunk failed to list worktrees.",
      },
      { retries: 1 },
    );
    const observations = parseWorktrunkListJson(output.stdout, {
      project,
      providerId: this.id,
      observedAt: toIsoTimestamp(this.#clock.now()),
    });
    const managedObservations = observations.filter((observation) =>
      isManagedWorktreeObservation(project, observation),
    );
    const withBreadcrumbs = await Promise.all(
      managedObservations.map((observation) =>
        applyRecoveryBreadcrumbMetadata(observation, project),
      ),
    );
    for (const observation of withBreadcrumbs) {
      this.#observations.set(observation.id, observation);
    }
    return withBreadcrumbs;
  }

  async createWorktree(request: CreateWorktreeRequest): Promise<WorktreeObservation> {
    const base = request.base ?? request.project.worktrunk.base;
    const output = await this.#run(
      this.#args([
        "switch",
        ...this.#automationHookArgs(),
        "--create",
        request.branch,
        ...(base === undefined ? [] : ["--base", base]),
        "--no-cd",
        "--format=json",
      ]),
      request.project.root,
      {
        code: "WORKTRUNK_COMMAND_FAILED",
        message: "Worktrunk failed to create a worktree.",
      },
      {},
      worktreePathEnv(request.project, request.branch, request.path),
    );

    const observations = parseCommandObservation(output.stdout, {
      project: request.project,
      providerId: this.id,
      observedAt: toIsoTimestamp(this.#clock.now()),
    }).filter((observation) => isManagedWorktreeObservation(request.project, observation));
    const found =
      observations.find((observation) => observation.branch === request.branch) ??
      observations.find((observation) => observation.path === request.path) ??
      (await this.listWorktrees(request.project)).find(
        (observation) => observation.branch === request.branch,
      );
    if (found === undefined) {
      throw new WorktrunkProviderError(
        "WORKTRUNK_INVALID_OUTPUT",
        "Worktrunk create did not return or list the created worktree.",
      );
    }
    // Cache before seeding so the cleanup path can resolve the worktree if seeding fails.
    this.#observations.set(found.id, found);
    if (request.seedFrom !== undefined) {
      try {
        await this.#seedWorkingTree(request.seedFrom.path, found.path);
      } catch (seedError) {
        // Seeding failed after the worktree was created. Remove it so callers never
        // inherit a half-seeded worktree; best-effort, then rethrow the seed cause.
        await this.removeWorktree({ worktreeId: found.id, force: true }).catch(() => {});
        this.#observations.delete(found.id);
        throw seedError;
      }
      // Re-list so the seeded dirty state is observed before we return; listWorktrees
      // refreshes the observation cache, so the caller sees the post-seed status.
      const refreshed = (await this.listWorktrees(request.project)).find(
        (observation) => observation.id === found.id,
      );
      if (refreshed !== undefined) {
        return refreshed;
      }
    }
    return found;
  }

  async #seedWorkingTree(srcPath: string, tgtPath: string): Promise<void> {
    const indexDir = await mkdtemp(join(tmpdir(), "wt-seed-index-"));
    // Snapshot the source's full working tree via a throwaway index, so `add -A` never
    // writes the source's real index. Collapses the staged/unstaged split — everything
    // lands staged in the target, which is fine for a fork.
    const env = { GIT_INDEX_FILE: join(indexDir, "index") };
    try {
      await this.#runSeedCommand("git", ["-C", srcPath, "read-tree", "HEAD"], { env });
      await this.#runSeedCommand("git", ["-C", srcPath, "add", "-A"], { env });
      const written = await this.#runSeedCommand("git", ["-C", srcPath, "write-tree"], { env });
      const tree = written.stdout.trim();
      // Materialize the snapshot in the target (incl. deletions); a clean source yields
      // HEAD's tree, so this is a no-op.
      await this.#runSeedCommand("git", ["-C", tgtPath, "read-tree", "-m", "-u", tree]);
    } finally {
      await rm(indexDir, { recursive: true, force: true });
    }
  }

  async #runSeedCommand(
    command: string,
    args: string[],
    options?: { env?: Record<string, string> },
  ) {
    try {
      return await runExternalCommand(
        {
          command,
          args,
          timeoutMs: this.#timeoutMs,
          ...(options?.env === undefined ? {} : { env: options.env }),
        },
        this.#runner,
      );
    } catch (cause) {
      throw new WorktrunkProviderError(
        "WORKTRUNK_SEED_FAILED",
        "Worktrunk created the worktree but failed to seed its working tree from the source.",
        { cause },
      );
    }
  }

  async removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult> {
    const observation = this.#observations.get(request.worktreeId);
    if (observation === undefined) {
      throw new WorktrunkProviderError(
        "WORKTRUNK_WORKTREE_NOT_FOUND",
        "Worktrunk remove requires a previously observed worktree.",
        { hint: "Run listWorktrees before removeWorktree so the provider can resolve the target." },
      );
    }

    await this.#run(
      this.#args([
        "remove",
        ...this.#automationHookArgs(),
        removeTarget(observation),
        ...(request.force === true ? ["--force"] : []),
        ...(request.force === true ? ["--force-delete"] : []),
        "--foreground",
        "--format=json",
      ]),
      observation.path,
      {
        code: "WORKTRUNK_COMMAND_FAILED",
        message: "Worktrunk failed to remove a worktree.",
      },
    );
    this.#observations.delete(request.worktreeId);
    return {
      worktreeId: request.worktreeId,
      removed: true,
    };
  }

  async getWorktree(request: GetWorktreeRequest): Promise<WorktreeObservation | null> {
    if (request.worktreeId !== undefined) {
      return this.#observations.get(request.worktreeId) ?? null;
    }
    if (request.path !== undefined) {
      return (
        [...this.#observations.values()].find((observation) => observation.path === request.path) ??
        null
      );
    }
    return null;
  }

  #args(args: string[]): string[] {
    return this.#configPath === undefined ? args : ["--config", this.#configPath, ...args];
  }

  #automationHookArgs(): string[] {
    if (this.#useLifecycleHooks === false) {
      return ["--no-hooks"];
    }
    if (this.#useLifecycleHooks === true) {
      return ["--yes"];
    }
    return [];
  }

  async #automationCapabilityCheck(): Promise<ProviderDoctorCheck> {
    const mode = worktrunkAutomationMode(this.#useLifecycleHooks);
    if (mode.flag === undefined) {
      return {
        name: "worktrunk-automation",
        status: "ok",
        message:
          "Worktrunk automation uses default hook prompt behavior; no extra mutation flags are configured.",
      };
    }

    let missing: string[];
    try {
      missing = await missingWorktrunkAutomationFlagSupport({
        command: this.#command,
        flag: mode.flag,
        timeoutMs: this.#timeoutMs,
        runner: this.#runner,
      });
    } catch (cause) {
      const fallback = safeErrorFromUnknown(cause, {
        tag: "WorktrunkAutomationDiagnosticError",
        code: "WORKTRUNK_AUTOMATION_DIAGNOSTIC_FAILED",
        message: "Worktrunk automation capability diagnostics failed.",
        provider: this.id,
      });
      const missingBinary = isMissingBinary(cause);
      const error = {
        tag: missingBinary ? "ProviderUnavailableError" : "WorktrunkAutomationDiagnosticError",
        code: missingBinary ? "WORKTRUNK_UNAVAILABLE" : fallback.code,
        message: missingBinary ? "Worktrunk is not available." : fallback.message,
        provider: this.id,
        ...(missingBinary ? { hint: worktrunkInstallHint(this.#command) } : {}),
      };
      return {
        name: "worktrunk-automation",
        status: missingBinary ? "warn" : "error",
        message: error.message,
        error,
      };
    }

    if (missing.length === 0) {
      return {
        name: "worktrunk-automation",
        status: "ok",
        message: `${mode.message} The installed wt supports ${mode.flag} for switch and remove.`,
      };
    }

    const error = {
      tag: "WorktrunkAutomationDiagnosticError",
      code: "WORKTRUNK_AUTOMATION_FLAG_UNSUPPORTED",
      message: `Configured Worktrunk automation mode requires ${mode.flag}, but wt ${missing.join(" and ")} help does not advertise it.`,
      hint: "Upgrade Worktrunk or adjust worktree.worktrunk.use_lifecycle_hooks before relying on automated STATION worktree mutations.",
      provider: this.id,
    };
    return {
      name: "worktrunk-automation",
      status: "error",
      message: error.message,
      error,
    };
  }

  async #run(
    args: string[],
    cwd?: string,
    fallback: {
      code: "WORKTRUNK_COMMAND_FAILED" | "WORKTRUNK_UNAVAILABLE";
      message: string;
    } = {
      code: "WORKTRUNK_UNAVAILABLE",
      message: "Worktrunk is not available.",
    },
    policy: { retries?: number } = {},
    env?: Record<string, string>,
  ) {
    const operation = `provider.worktrunk.${worktrunkSubcommand(args)}`;
    const result = await runRuntimeBoundaryWithRetryAndTimeout(
      {
        operation,
        clock: this.#clock,
        timeoutMs: this.#timeoutMs,
        error: {
          tag:
            fallback.code === "WORKTRUNK_UNAVAILABLE"
              ? "ProviderUnavailableError"
              : "WorktreeProviderError",
          code: fallback.code,
          message: fallback.message,
          provider: this.id,
        },
        timeoutError: {
          tag: "TimeoutError",
          code: "WORKTRUNK_TIMEOUT",
          message: "Worktrunk command timed out.",
          provider: this.id,
        },
        retry: {
          retries: policy.retries ?? 0,
          delayMs: 10,
          shouldRetry: (error) =>
            error.code !== "WORKTRUNK_TIMEOUT" && error.code !== "WORKTRUNK_CANCELLED",
        },
      },
      ({ signal }) =>
        runExternalCommand(
          {
            command: this.#command,
            args,
            ...(cwd === undefined ? {} : { cwd }),
            ...(env === undefined ? {} : { env }),
            signal,
            maxOutputChars: 512 * 1024,
          },
          this.#runner,
        ),
    );

    if (result.ok) {
      return result.value;
    }

    try {
      throw result.error;
    } catch (cause) {
      const diagnosticDetails = worktrunkCommandDiagnostics({
        error: cause,
        provider: this.id,
        operation,
        command: this.#command,
        args,
        cwd,
        durationMs: result.timing.durationMs,
      });
      if (isMissingBinary(cause)) {
        throw new ProviderUnavailableError("Worktrunk is not available.", {
          hint: worktrunkInstallHint(this.#command),
          command: this.#command,
          installHint: worktrunkInstallHint(this.#command),
          cause,
          diagnosticDetails,
        });
      }
      if (isTimeout(cause)) {
        throw new WorktrunkProviderError("WORKTRUNK_TIMEOUT", "Worktrunk command timed out.", {
          cause,
          diagnosticDetails,
        });
      }
      if (isAbort(cause)) {
        throw new WorktrunkProviderError(
          "WORKTRUNK_CANCELLED",
          "Worktrunk command was cancelled.",
          {
            cause,
            diagnosticDetails,
          },
        );
      }
      throw providerErrorFromUnknown(
        cause,
        classifyWorktrunkFailure(cause, {
          code: fallback.code,
          message: fallback.message,
        }),
        { diagnosticDetails },
      );
    }
  }
}

function dependencyDiagnostics(status: WorktrunkDependencyStatus): Record<string, string> {
  const diagnostics: Record<string, string> = {
    attemptedCommand: status.attemptedCommand,
    installHint: status.installHint,
  };
  if (status.resolvedPath !== undefined) diagnostics.resolvedPath = status.resolvedPath;
  if (status.status === "available") {
    if (status.version !== undefined) diagnostics.version = status.version;
    if (status.rawVersion !== undefined) diagnostics.rawVersion = status.rawVersion;
  }
  return diagnostics;
}

function worktrunkCommandDiagnostics(input: {
  error: unknown;
  provider: ProviderId;
  operation: string;
  command: string;
  args: readonly string[];
  cwd?: string | undefined;
  durationMs: number;
}): DiagnosticDetail[] {
  const detail: ExternalCommandDiagnosticDetail = {
    type: "external_command",
    provider: input.provider,
    operation: input.operation,
    command: stringFieldDeep(input.error, "command") ?? formatCommand(input.command, input.args),
  };
  const cwd = stringFieldDeep(input.error, "cwd") ?? input.cwd;
  if (cwd !== undefined) detail.cwd = cwd;
  const exitCode = numberFieldDeep(input.error, "exitCode");
  if (exitCode !== undefined) detail.exitCode = exitCode;
  const signal = stringFieldDeep(input.error, "signal");
  if (signal !== undefined) detail.signal = signal;
  const stdoutSnippet = stringFieldDeep(input.error, "stdoutSnippet");
  if (stdoutSnippet !== undefined && stdoutSnippet.length > 0) {
    detail.stdoutSnippet = stdoutSnippet;
  }
  const stderrSnippet = stringFieldDeep(input.error, "stderrSnippet");
  if (stderrSnippet !== undefined && stderrSnippet.length > 0) {
    detail.stderrSnippet = stderrSnippet;
  }
  detail.durationMs = input.durationMs;
  const parsed = ExternalCommandDiagnosticDetailSchema.safeParse(detail);
  return parsed.success ? [parsed.data] : [];
}

function classifyWorktrunkFailure(
  error: unknown,
  fallback: {
    code: "WORKTRUNK_COMMAND_FAILED" | "WORKTRUNK_UNAVAILABLE";
    message: string;
  },
): { code: WorktrunkProviderErrorCode; message: string; hint?: string } {
  if (fallback.code !== "WORKTRUNK_COMMAND_FAILED") {
    return fallback;
  }

  const text = diagnosticText(error).toLowerCase();
  if (isUnsupportedFlagText(text)) {
    return {
      code: "WORKTRUNK_UNSUPPORTED_FLAG",
      message: "Worktrunk rejected an automation flag used by STATION.",
      hint: "Upgrade Worktrunk or adjust worktree.worktrunk.use_lifecycle_hooks in STATION config.",
    };
  }

  if (isHookApprovalText(text)) {
    return {
      code: "WORKTRUNK_HOOK_APPROVAL_REQUIRED",
      message:
        "Worktrunk lifecycle hooks needed interactive approval during automated STATION work.",
      hint: "Set worktree.worktrunk.use_lifecycle_hooks to false to skip hooks or true to pre-approve hook prompts.",
    };
  }

  if (isDuplicateBranchText(text)) {
    return {
      code: "WORKTRUNK_BRANCH_EXISTS",
      message: "Worktrunk could not create the worktree because the branch already exists.",
      hint: "Choose a different branch name or start/focus the existing worktree.",
    };
  }

  if (isDuplicateWorktreeText(text)) {
    return {
      code: "WORKTRUNK_WORKTREE_EXISTS",
      message: "Worktrunk could not create the worktree because the worktree path already exists.",
      hint: "Choose a different branch/path or remove the stale worktree path.",
    };
  }

  if (isMissingBaseText(text)) {
    return {
      code: "WORKTRUNK_BASE_MISSING",
      message: "Worktrunk could not find the requested base for the new worktree.",
      hint: "Fetch the base branch or set a valid worktree.worktrunk.base/default branch in STATION config.",
    };
  }

  return fallback;
}

function isUnsupportedFlagText(text: string): boolean {
  return (
    /unknown (?:argument|flag|option).*--(?:no-hooks|yes)/.test(text) ||
    /unrecognized (?:argument|flag|option).*--(?:no-hooks|yes)/.test(text) ||
    /unexpected (?:argument|flag|option).*--(?:no-hooks|yes)/.test(text) ||
    /found argument ['"]--(?:no-hooks|yes)['"].*(?:not expected|wasn't expected)/.test(text) ||
    /invalid (?:argument|flag|option).*--(?:no-hooks|yes)/.test(text)
  );
}

function isHookApprovalText(text: string): boolean {
  return (
    /(?:approval|confirm|confirmation|prompt).*(?:required|needed)/.test(text) ||
    /(?:requires|needs).*(?:approval|confirmation|interactive)/.test(text) ||
    /(?:use|pass).*(?:--yes|-y).*(?:approve|confirm|continue)/.test(text) ||
    /not a tty/.test(text) ||
    /hook.*(?:cancelled|aborted|declined|refused)/.test(text)
  );
}

function isDuplicateBranchText(text: string): boolean {
  return (
    /branch\b.*\balready exists/.test(text) ||
    /\balready exists\b.*\bbranch\b/.test(text) ||
    /refs\/heads\/[^\s]+.*\balready exists/.test(text)
  );
}

function isDuplicateWorktreeText(text: string): boolean {
  return (
    /worktree\b.*\balready exists/.test(text) ||
    /\balready exists\b.*\bworktree\b/.test(text) ||
    /\bpath\b.*\balready exists/.test(text) ||
    /\bdestination\b.*\balready exists/.test(text)
  );
}

function isMissingBaseText(text: string): boolean {
  return (
    /base\b.*\b(?:not found|missing|does not exist|unknown)/.test(text) ||
    /(?:not found|missing|does not exist|unknown)\b.*\bbase\b/.test(text) ||
    /could(?:n't| not) find remote ref/.test(text) ||
    /invalid reference/.test(text) ||
    /not a valid object name/.test(text) ||
    /unknown revision/.test(text)
  );
}

function diagnosticText(error: unknown, seen = new Set<unknown>()): string {
  if (!error || typeof error !== "object" || seen.has(error)) {
    return "";
  }
  seen.add(error);
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["message", "stdoutSnippet", "stderrSnippet", "command"]) {
    const value = record[key];
    if (typeof value === "string") {
      parts.push(value);
    }
  }
  parts.push(diagnosticText(record.cause, seen));
  return parts.join("\n");
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function worktrunkSubcommand(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--config") {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return "command";
}

function parseCommandObservation(
  stdout: string,
  options: {
    project: ProviderProjectConfig;
    providerId: ProviderId;
    observedAt: string;
  },
): WorktreeObservation[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }
  try {
    return parseWorktrunkListJson(trimmed, options);
  } catch (cause) {
    try {
      return parseWorktrunkListPayload(JSON.parse(trimmed), options);
    } catch (nestedCause) {
      throw new WorktrunkProviderError(
        "WORKTRUNK_INVALID_OUTPUT",
        "Worktrunk command output is not valid worktree JSON.",
        { cause: nestedCause ?? cause },
      );
    }
  }
}

function removeTarget(observation: WorktreeObservation): string {
  return observation.branch.startsWith("detached:") ? observation.path : observation.branch;
}

function isManagedWorktreeObservation(
  project: ProviderProjectConfig,
  observation: WorktreeObservation,
): boolean {
  if (isMainWorktree(project, observation)) {
    return project.worktrunk.includeMain !== false;
  }

  const managedRoot = resolveManagedRoot(project);
  if (managedRoot === undefined || project.worktrunk.includeExternal !== false) {
    return true;
  }

  return isPathInside(observation.path, managedRoot);
}

function isMainWorktree(project: ProviderProjectConfig, observation: WorktreeObservation): boolean {
  const defaultBranch = project.defaultBranch ?? project.worktrunk.base;
  return (
    samePath(observation.path, project.root) ||
    (defaultBranch !== undefined && observation.branch === defaultBranch)
  );
}

function worktreePathEnv(
  project: ProviderProjectConfig,
  branch: string,
  requestedPath?: string,
): Record<string, string> | undefined {
  const managedRoot = resolveManagedRoot(project);
  if (managedRoot === undefined) {
    return undefined;
  }
  const path =
    requestedPath === undefined
      ? `${managedRoot}/${stableName({
          profile: "path-segment",
          display: [branch],
          unique: ["worktree-path", project.id, managedRoot, branch],
        })}`
      : normalize(isAbsolute(requestedPath) ? requestedPath : resolve(project.root, requestedPath));
  return {
    WORKTRUNK_WORKTREE_PATH: path,
  };
}

function resolveManagedRoot(project: ProviderProjectConfig): string | undefined {
  const configured = project.worktrunk.managedRoot;
  if (configured === undefined) {
    return undefined;
  }
  return normalize(isAbsolute(configured) ? configured : resolve(project.root, configured));
}

function isPathInside(path: string, root: string): boolean {
  const fromRoot = relative(canonicalPathForComparison(root), canonicalPathForComparison(path));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function samePath(left: string, right: string): boolean {
  return canonicalPathForComparison(left) === canonicalPathForComparison(right);
}

function canonicalPathForComparison(path: string): string {
  const normalized = normalize(path);
  if (normalized.startsWith("/private/var/")) {
    return normalized.slice("/private".length);
  }
  return normalized;
}

function isMissingBinary(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const cause = error as { code?: unknown; cause?: unknown };
  return cause.code === "ENOENT" || isMissingBinary(cause.cause);
}

function stringFieldDeep(
  error: unknown,
  key: "command" | "cwd" | "signal" | "stdoutSnippet" | "stderrSnippet",
  seen = new Set<unknown>(),
): string | undefined {
  if (!error || typeof error !== "object" || seen.has(error)) {
    return undefined;
  }
  seen.add(error);
  const record = error as Record<string, unknown>;
  const value = record[key];
  if (typeof value === "string") {
    return value;
  }
  return stringFieldDeep(record.cause, key, seen);
}

function numberFieldDeep(
  error: unknown,
  key: "exitCode",
  seen = new Set<unknown>(),
): number | undefined {
  if (!error || typeof error !== "object" || seen.has(error)) {
    return undefined;
  }
  seen.add(error);
  const record = error as Record<string, unknown>;
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return numberFieldDeep(record.cause, key, seen);
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "WORKTRUNK_TIMEOUT"
  );
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "WORKTRUNK_CANCELLED" || error.code === "EXTERNAL_COMMAND_ABORTED")
  );
}
