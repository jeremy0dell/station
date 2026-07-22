import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type {
  CreateWorktreeRequest,
  GetWorktreeRequest,
  ProviderDoctorCheck,
  ProviderDoctorContext,
  ProviderHealth,
  ProviderId,
  ProviderProjectConfig,
  RawWorktreeEvent,
  RemoveWorktreeRequest,
  RemoveWorktreeResult,
  SafeError,
  WorktreeCapabilities,
  WorktreeEventContext,
  WorktreeObservation,
  WorktreeProvider,
  WorktreeRemovalRefusalDiagnosticDetail,
  WorktreeRemovalRefusalReason,
} from "@station/contracts";
import {
  type ExternalCommandRunner,
  gitCheckoutBareRepairHint,
  gitLocalEnvironmentVariables,
  isGitCheckoutConfiguredBare,
  publicSafeErrorFromUnknown,
  type RuntimeClock,
  runExternalCommand,
  runRuntimeBoundaryWithRetryAndTimeout,
  safeErrorFromUnknown,
  stableName,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { missingWorktrunkAutomationFlagSupport, worktrunkAutomationMode } from "./automation.js";
import { worktrunkCommandFailure } from "./commandFailure.js";
import {
  type CheckWorktrunkDependencyOptions,
  checkWorktrunkDependency,
  type WorktrunkDependencyStatus,
  worktrunkInstallHint,
} from "./dependency.js";
import { WorktrunkProviderError, type WorktrunkProviderErrorCode } from "./errors.js";
import { doctorWorktrunkHooks } from "./hooks.js";
import { applyRecoveryBreadcrumbMetadata } from "./metadata.js";
import { parseWorktrunkListJson, parseWorktrunkListPayload } from "./parse.js";
import {
  WORKTRUNK_HOOK_NAMES,
  type WorktrunkHookExpectation,
  type WorktrunkProviderOptions,
} from "./types.js";

type WorktrunkRunPolicy = {
  retries?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const defaultCapabilities: WorktreeCapabilities = {
  canCreate: true,
  canRemove: true,
  canList: true,
  canEmitLifecycleEvents: true,
  canExposeDirtyState: true,
  canSeedWorkingTree: true,
};

/**
 * ADAPTER
 *
 * Translates Worktrunk lifecycle output and commands into Station worktree contracts.
 * Hook diagnostics use an atomic requester runtime when supplied and retain the whole Observer composition
 * expectation as a fallback. Checkout roots are validated before Worktrunk runs, and removal revalidates
 * native Git identity, path, and branch before mutation.
 */
export class WorktrunkProvider implements WorktreeProvider {
  readonly id: ProviderId = "worktrunk";

  readonly #command: string;
  readonly #configPath: string | undefined;
  readonly #useLifecycleHooks: boolean | undefined;
  readonly #hookExpectation: WorktrunkHookExpectation | undefined;
  readonly #timeoutMs: number;
  readonly #runner: ExternalCommandRunner | undefined;
  readonly #clock: RuntimeClock;
  readonly #resolveRegistrationIdentity: (worktreePath: string) => Promise<string | undefined>;
  readonly #observations = new Map<string, WorktreeObservation>();
  readonly #projects = new Map<string, ProviderProjectConfig>();

  constructor(options: WorktrunkProviderOptions = {}) {
    this.#command = options.command ?? process.env.STATION_WORKTRUNK_BIN ?? "wt";
    this.#configPath = options.configPath;
    this.#useLifecycleHooks = options.useLifecycleHooks;
    this.#hookExpectation = options.hookExpectation;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#runner = options.runner;
    this.#clock = options.clock ?? systemClock;
    this.#resolveRegistrationIdentity =
      options.resolveRegistrationIdentity ?? nativeGitRegistrationIdentity;
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
      lastError: publicSafeErrorFromUnknown(dependency.error, {
        tag: "ProviderUnavailableError",
        code: "WORKTRUNK_UNAVAILABLE",
        message: "Worktrunk is not available.",
        provider: this.id,
      }),
      capabilities: this.capabilities(),
      diagnostics: dependencyDiagnostics(dependency),
    };
  }

  async doctorChecks(context: ProviderDoctorContext = {}): Promise<ProviderDoctorCheck[]> {
    const workBudgetMs = doctorWorkBudgetMs(context.timeoutMs ?? this.#timeoutMs);
    const budgetSignal = AbortSignal.timeout(workBudgetMs);
    const signal =
      context.signal === undefined ? budgetSignal : AbortSignal.any([context.signal, budgetSignal]);
    const [automationCheck, staleChecks, hookCheck] = await Promise.all([
      this.#automationCapabilityCheck({ signal, timeoutMs: workBudgetMs }),
      this.#staleRegistrationChecks(context.projects ?? [], {
        signal,
        timeoutMs: workBudgetMs,
      }),
      this.#hookCheck(context),
    ]);
    return [automationCheck, ...staleChecks, hookCheck];
  }

  async #hookCheck(context: ProviderDoctorContext): Promise<ProviderDoctorCheck> {
    if (this.#useLifecycleHooks === false) {
      return {
        name: "worktrunk-hooks",
        status: "ok",
        message:
          "Worktrunk lifecycle hooks are disabled in station config; automated mutations skip hooks.",
      };
    }
    if (this.#hookExpectation === undefined) {
      const message = `Worktrunk lifecycle hooks are missing: ${WORKTRUNK_HOOK_NAMES.join(", ")}.`;
      const error: SafeError = {
        tag: "WorktrunkHookSetupError",
        code: "WORKTRUNK_HOOKS_MISSING",
        message,
        provider: this.id,
      };
      return {
        name: "worktrunk-hooks",
        status: "warn",
        message,
        error,
      };
    }

    try {
      const runtime = context.providerHookRuntime;
      let expectation: WorktrunkHookExpectation;
      if (runtime === undefined) {
        expectation = { ...this.#hookExpectation };
      } else {
        expectation = {
          hookBin: runtime.ingressLauncher,
          observerSocketPath: runtime.observerSocketPath,
          stateDir: runtime.stateDir,
          hookSpoolDir: runtime.hookSpoolDir,
          autoStartFromHooks: runtime.autoStartFromHooks,
        };
        if (runtime.stationConfigPath !== undefined) {
          expectation.stationConfigPath = runtime.stationConfigPath;
        }
      }
      const hookOptions: Parameters<typeof doctorWorktrunkHooks>[0] = {
        expectation,
        enabled: true,
      };
      if (this.#configPath !== undefined) {
        hookOptions.worktrunkConfigPath = this.#configPath;
      }
      const result = await doctorWorktrunkHooks(hookOptions);
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
      return check;
    } catch (cause) {
      const fallback = {
        tag: "WorktrunkHookSetupError",
        code: "WORKTRUNK_HOOK_DIAGNOSTIC_FAILED",
        message: "Worktrunk hook diagnostics failed.",
        provider: this.id,
      };
      const error = publicSafeErrorFromUnknown(cause, fallback);
      return {
        name: "worktrunk-hooks",
        status: "error",
        message: error.message,
        error,
      };
    }
  }

  async ingestEvent(
    _event: RawWorktreeEvent,
    _context: WorktreeEventContext,
  ): Promise<WorktreeObservation[]> {
    return [];
  }

  async listWorktrees(project: ProviderProjectConfig): Promise<WorktreeObservation[]> {
    return this.#listWorktrees(project, { retries: 1 });
  }

  async #listWorktrees(
    project: ProviderProjectConfig,
    policy: WorktrunkRunPolicy,
  ): Promise<WorktreeObservation[]> {
    if (!project.worktrunk.enabled) {
      return [];
    }
    this.#projects.set(project.id, project);
    await this.#assertProjectRootUsable(project, policy);

    const observations = await this.#readWorktrees(project, policy);
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

  async #readWorktrees(
    project: ProviderProjectConfig,
    policy: WorktrunkRunPolicy,
  ): Promise<WorktreeObservation[]> {
    const output = await this.#run(
      this.#args(["list", "--format=json"]),
      project.root,
      {
        code: "WORKTRUNK_COMMAND_FAILED",
        message: "Worktrunk failed to list worktrees.",
      },
      policy,
    );
    const observations = parseWorktrunkListJson(output.stdout, {
      project,
      providerId: this.id,
      observedAt: toIsoTimestamp(this.#clock.now()),
    });
    return Promise.all(
      observations.map((observation) => this.#withRegistrationIdentity(observation)),
    );
  }

  async createWorktree(request: CreateWorktreeRequest): Promise<WorktreeObservation> {
    this.#projects.set(request.project.id, request.project);
    await this.#assertProjectRootUsable(request.project);
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
        ...(base === undefined ? {} : { unresolvedBase: base }),
      },
      {},
      worktreePathEnv(request.project, request.branch, request.path),
    );

    const commandObservations = parseCommandObservation(output.stdout, {
      project: request.project,
      providerId: this.id,
      observedAt: toIsoTimestamp(this.#clock.now()),
    });
    const observations = (
      await Promise.all(
        commandObservations.map((observation) => this.#withRegistrationIdentity(observation)),
      )
    ).filter((observation) => isManagedWorktreeObservation(request.project, observation));
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
    if (found.registrationIdentity === undefined) {
      throw new WorktrunkProviderError(
        "WORKTRUNK_WORKTREE_CHANGED",
        "Worktrunk created the worktree but Station could not verify its Git registration.",
        {
          hint: "Inspect the created worktree and refresh before trying to manage it in Station.",
        },
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
        await this.removeWorktree({
          worktreeId: found.id,
          expectedPath: found.path,
          expectedBranch: found.branch,
          expectedRegistrationIdentity: found.registrationIdentity,
          force: true,
        }).catch(() => {});
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

  async #withRegistrationIdentity(observation: WorktreeObservation): Promise<WorktreeObservation> {
    if (observation.state !== "exists") {
      return observation;
    }
    const registrationIdentity = await this.#resolveRegistrationIdentity(observation.path);
    return registrationIdentity === undefined
      ? observation
      : { ...observation, registrationIdentity };
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
          unsetEnv: gitLocalEnvironmentVariables,
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
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_NOT_FOUND",
        message: "Worktrunk remove requires a previously observed worktree.",
        hint: "Run listWorktrees before removeWorktree so the provider can resolve the target.",
        request,
        canonicalPath: request.expectedPath,
        observedBranch: request.expectedBranch,
        refusalReason: "missing_target",
      });
    }
    const cachedRefusalReason = changedRemovalIdentityReason(observation, request);
    if (cachedRefusalReason !== undefined) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        message: "Worktrunk remove received stale checkout identity.",
        hint: "Refresh and reselect the worktree before retrying removal.",
        request,
        projectId: observation.projectId,
        canonicalPath: observation.path,
        observedBranch: observation.branch,
        refusalReason: cachedRefusalReason,
      });
    }
    const project = this.#projects.get(observation.projectId);
    if (project === undefined) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_NOT_FOUND",
        message: "Worktrunk remove requires the repository root from a previous project listing.",
        hint: "Run listWorktrees for the project before removeWorktree.",
        request,
        projectId: observation.projectId,
        canonicalPath: observation.path,
        observedBranch: observation.branch,
        refusalReason: "protection_unverified",
      });
    }
    await this.#assertProjectRootUsable(project);

    const currentWorktrees = await this.#readWorktrees(project, { retries: 1 });
    const identityMatches = currentWorktrees.filter(
      (worktree) => worktree.id === request.worktreeId,
    );
    const pathMatches = currentWorktrees.filter((worktree) =>
      samePath(worktree.path, request.expectedPath),
    );
    if (identityMatches.length === 0 && pathMatches.length === 0) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_NOT_FOUND",
        message: "Worktrunk remove could not confirm that the selected worktree still exists.",
        hint: "Run listWorktrees again before retrying removal.",
        request,
        projectId: project.id,
        canonicalPath: request.expectedPath,
        observedBranch: request.expectedBranch,
        refusalReason: "missing_target",
      });
    }
    const selected = identityMatches[0];
    const pathMatch = pathMatches[0];
    const finalRefusalReason =
      identityMatches.length !== 1 || pathMatches.length !== 1
        ? "ambiguous_identity"
        : selected === undefined || pathMatch === undefined || selected.id !== pathMatch.id
          ? "identity_changed"
          : selected.state !== "exists"
            ? "missing_target"
            : changedRemovalIdentityReason(selected, request);
    if (finalRefusalReason !== undefined || selected === undefined || pathMatch === undefined) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        message: "The selected worktree changed before Worktrunk could remove it.",
        hint: "Refresh and reselect the worktree before retrying removal.",
        request,
        projectId: project.id,
        canonicalPath: selected?.path ?? pathMatch?.path ?? request.expectedPath,
        observedBranch: selected?.branch ?? pathMatch?.branch ?? request.expectedBranch,
        refusalReason: finalRefusalReason ?? "ambiguous_identity",
      });
    }
    const branchIsShared =
      !selected.branch.startsWith("detached:") &&
      currentWorktrees.some(
        (worktree) =>
          worktree.state === "exists" &&
          worktree.branch === selected.branch &&
          !samePath(worktree.path, selected.path),
      );
    const removalFlags: string[] = [];
    if (request.force === true) {
      removalFlags.push("--force");
    }
    if (branchIsShared) {
      removalFlags.push("--no-delete-branch");
    } else if (request.force === true) {
      removalFlags.push("--force-delete");
    }

    // Worktrunk 0.64 needs selected-checkout context and cannot delete a branch shared elsewhere.
    await this.#run(
      this.#args([
        "-C",
        selected.path,
        "remove",
        ...this.#automationHookArgs(),
        ...removalFlags,
        "--foreground",
        "--format=json",
      ]),
      undefined,
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

  async #assertProjectRootUsable(
    project: ProviderProjectConfig,
    policy: WorktrunkRunPolicy = {},
  ): Promise<void> {
    if (
      await isGitCheckoutConfiguredBare(project.root, {
        ...(this.#runner === undefined ? {} : { runner: this.#runner }),
        ...(policy.signal === undefined ? {} : { signal: policy.signal }),
        timeoutMs: policy.timeoutMs ?? this.#timeoutMs,
      })
    ) {
      throw projectRootBareError(project);
    }
  }

  async #automationCapabilityCheck(options: {
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<ProviderDoctorCheck> {
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
        timeoutMs: options.timeoutMs,
        runner: this.#runner,
        signal: options.signal,
      });
    } catch (cause) {
      const fallback = safeErrorFromUnknown(cause, {
        tag: "WorktrunkAutomationDiagnosticError",
        code: "WORKTRUNK_AUTOMATION_DIAGNOSTIC_FAILED",
        message: "Worktrunk automation capability diagnostics failed.",
        provider: this.id,
      });
      const missingBinary = fallback.code === "ENOENT";
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

  async #staleRegistrationChecks(
    projects: readonly ProviderProjectConfig[],
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<ProviderDoctorCheck[]> {
    const enabledProjects = projects.filter((candidate) => candidate.worktrunk.enabled);
    const checks: Array<ProviderDoctorCheck | undefined> = enabledProjects.map(() => undefined);
    let completed = 0;
    for (let offset = 0; offset < enabledProjects.length; offset += 4) {
      const batch = enabledProjects.slice(offset, offset + 4);
      await Promise.all(
        batch.map(async (project, batchIndex) => {
          if (options.signal.aborted) return;
          const index = offset + batchIndex;
          if (
            await isGitCheckoutConfiguredBare(project.root, {
              ...(this.#runner === undefined ? {} : { runner: this.#runner }),
              signal: options.signal,
              timeoutMs: options.timeoutMs,
            })
          ) {
            const providerError = projectRootBareError(project);
            const error: SafeError = {
              tag: providerError.tag,
              code: providerError.code,
              message: providerError.message,
              provider: providerError.provider,
              projectId: project.id,
            };
            if (providerError.hint !== undefined) error.hint = providerError.hint;
            checks[index] = {
              name: `worktrunk-project-root-${project.id}`,
              status: "warn",
              message: `${providerError.message} ${providerError.hint}`,
              error,
            };
            completed += 1;
            return;
          }
          let missing: WorktreeObservation[];
          try {
            missing = (
              await this.#listWorktrees(project, {
                retries: 0,
                signal: options.signal,
                timeoutMs: options.timeoutMs,
              })
            ).filter((observation) => observation.state !== "exists");
            completed += 1;
          } catch (cause) {
            if (options.signal.aborted) return;
            const failure = safeErrorFromUnknown(cause, {
              tag: "WorktrunkStaleRegistrationDiagnosticError",
              code: "WORKTRUNK_STALE_REGISTRATION_CHECK_FAILED",
              message: `Worktrunk could not inspect stale registrations for ${project.label}.`,
              provider: this.id,
            });
            const error: SafeError = {
              tag: failure.tag,
              code: failure.code,
              message: failure.message,
              projectId: project.id,
            };
            if (failure.hint !== undefined) error.hint = failure.hint;
            if (failure.provider !== undefined) error.provider = failure.provider;
            checks[index] = {
              name: `worktrunk-stale-registrations-${project.id}`,
              status: "warn",
              message: error.message,
              error,
            };
            return;
          }
          if (missing.length === 0) return;
          const root = shellQuote(project.root);
          checks[index] = {
            name: `worktrunk-stale-registrations-${project.id}`,
            status: "warn",
            message: `Worktrunk found missing/prunable registrations for ${project.label}: ${missing
              .map((item) => `${item.branch} (${item.path})`)
              .join(
                ", ",
              )}. Inspect with git -C ${root} worktree prune --dry-run --verbose, then clean with git -C ${root} worktree prune --verbose.`,
          };
        }),
      );
      if (options.signal.aborted) break;
    }
    const completedChecks = checks.filter(
      (check): check is ProviderDoctorCheck => check !== undefined,
    );
    if (options.signal.aborted && completed < enabledProjects.length) {
      completedChecks.push({
        name: "worktrunk-stale-registrations-scan",
        status: "warn",
        message: `Worktrunk stale-registration diagnostics reached their time budget after checking ${completed} of ${enabledProjects.length} project(s).`,
      });
    }
    return completedChecks;
  }

  async #run(
    args: string[],
    cwd?: string,
    fallback: {
      code: "WORKTRUNK_COMMAND_FAILED" | "WORKTRUNK_UNAVAILABLE";
      message: string;
      unresolvedBase?: string;
    } = {
      code: "WORKTRUNK_UNAVAILABLE",
      message: "Worktrunk is not available.",
    },
    policy: WorktrunkRunPolicy = {},
    env?: Record<string, string>,
  ) {
    const operation = `provider.worktrunk.${worktrunkSubcommand(args)}`;
    const result = await runRuntimeBoundaryWithRetryAndTimeout(
      {
        operation,
        clock: this.#clock,
        timeoutMs: policy.timeoutMs ?? this.#timeoutMs,
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
            error.code !== "WORKTRUNK_TIMEOUT" &&
            error.code !== "WORKTRUNK_CANCELLED" &&
            error.code !== "EXTERNAL_COMMAND_ABORTED",
        },
      },
      ({ signal }) =>
        runExternalCommand(
          {
            command: this.#command,
            args,
            unsetEnv: gitLocalEnvironmentVariables,
            ...(cwd === undefined ? {} : { cwd }),
            ...(env === undefined ? {} : { env }),
            signal: mergeAbortSignals(signal, policy.signal),
            maxOutputChars: 512 * 1024,
          },
          this.#runner,
        ),
    );

    if (result.ok) {
      return result.value;
    }

    throw worktrunkCommandFailure({
      error: result.error,
      provider: this.id,
      operation,
      command: this.#command,
      args,
      cwd,
      durationMs: result.timing.durationMs,
      fallback,
      installHint: worktrunkInstallHint(this.#command),
    });
  }
}

function projectRootBareError(project: ProviderProjectConfig): WorktrunkProviderError {
  return new WorktrunkProviderError(
    "WORKTRUNK_PROJECT_ROOT_BARE",
    "Project checkout is configured as a bare repository.",
    {
      projectId: project.id,
      hint: gitCheckoutBareRepairHint(project.root),
    },
  );
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

function doctorWorkBudgetMs(timeoutMs: number): number {
  return Math.max(1, Math.floor(timeoutMs * 0.8));
}

function mergeAbortSignals(primary: AbortSignal, secondary: AbortSignal | undefined): AbortSignal {
  return secondary === undefined ? primary : AbortSignal.any([primary, secondary]);
}

function worktrunkSubcommand(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--config" || arg === "-C") {
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

function changedRemovalIdentityReason(
  observation: WorktreeObservation,
  request: RemoveWorktreeRequest,
): WorktreeRemovalRefusalReason | undefined {
  if (!samePath(observation.path, request.expectedPath)) {
    return "path_changed";
  }
  if (observation.branch !== request.expectedBranch) {
    return "branch_changed";
  }
  if (observation.registrationIdentity === undefined) {
    return "registration_unverified";
  }
  if (observation.registrationIdentity !== request.expectedRegistrationIdentity) {
    return "registration_changed";
  }
  return undefined;
}

function worktreeRemovalRefusalError(input: {
  code: WorktrunkProviderErrorCode;
  message: string;
  hint: string;
  request: RemoveWorktreeRequest;
  projectId?: string;
  canonicalPath: string;
  observedBranch: string;
  refusalReason: WorktreeRemovalRefusalReason;
}): WorktrunkProviderError {
  const detail: WorktreeRemovalRefusalDiagnosticDetail = {
    type: "worktree_removal_refusal",
    worktreeId: input.request.worktreeId,
    canonicalPath: canonicalPathForComparison(input.canonicalPath),
    observedBranch: input.observedBranch,
    refusalReason: input.refusalReason,
    provider: "worktrunk",
  };
  if (input.projectId !== undefined) {
    detail.projectId = input.projectId;
  }
  return new WorktrunkProviderError(input.code, input.message, {
    hint: input.hint,
    diagnosticDetails: [detail],
  });
}

async function nativeGitRegistrationIdentity(worktreePath: string): Promise<string | undefined> {
  const markerPath = join(worktreePath, ".git");
  try {
    const before = await lstat(markerPath, { bigint: true });
    const kind = before.isFile() ? "file" : before.isDirectory() ? "directory" : undefined;
    if (kind === undefined || (kind === "file" && before.size > 4096n)) {
      return undefined;
    }
    // Double-stat the native registration object so replacement during the read fails closed.
    const marker = kind === "file" ? await readFile(markerPath, "utf8") : "";
    const after = await lstat(markerPath, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.birthtimeNs !== after.birthtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      return undefined;
    }
    const digest = createHash("sha256")
      .update(
        [
          kind,
          before.dev.toString(),
          before.ino.toString(),
          before.birthtimeNs.toString(),
          before.ctimeNs.toString(),
          marker,
        ].join("\0"),
      )
      .digest("hex");
    return `git-registration:${digest}`;
  } catch {
    return undefined;
  }
}

function canonicalPathForComparison(path: string): string {
  const normalized = normalize(path);
  if (normalized.startsWith("/private/var/")) {
    return normalized.slice("/private".length);
  }
  return normalized;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
