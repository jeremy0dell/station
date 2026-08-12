import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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
  type GitWorktreeRemovalEvidence,
  parseGitWorktreeRemovalEvidence,
} from "./removalEvidence.js";
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
 * expectation as a fallback. Checkout roots are validated before Worktrunk runs, managed roots override
 * Worktrunk's project-specific path templates, mutation cancellation reaches owned Git/Worktrunk
 * subprocesses, cancelled removals confirm post-mutation completion through fresh Git evidence,
 * seeded dirty state refreshes from the created checkout only, restart lookup validates
 * durable hints and stable native path aliases through targeted Git evidence while native identity
 * stays stable between reads, managed-root aliases stay stable across inventory, and removal
 * revalidates native Git identity, path, branch, and unforced dirty state before mutation.
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
  readonly #projectConfigIdentifiers = new Map<string, string | null>();

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
        if (runtime.artifactOwner !== undefined) {
          expectation.artifactOwner = runtime.artifactOwner;
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
          code:
            result.ownership?.status === "different-owner" ||
            result.ownership?.status === "unknown-owner"
              ? "WORKTRUNK_HOOK_OWNERSHIP_CONFLICT"
              : "WORKTRUNK_HOOKS_MISSING",
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

    const managedRootSnapshot = await captureManagedRootSnapshot(project);
    const observations = await this.#readWorktrees(project, policy);
    const managedObservations = await filterManagedWorktreeObservations(
      project,
      observations,
      managedRootSnapshot,
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
    this.#projectConfigIdentifiers.set(project.id, worktrunkProjectConfigIdentifier(observations));
    return Promise.all(
      observations.map((observation) => this.#withRegistrationIdentity(observation)),
    );
  }

  async createWorktree(request: CreateWorktreeRequest): Promise<WorktreeObservation> {
    this.#projects.set(request.project.id, request.project);
    const signalPolicy: WorktrunkRunPolicy =
      request.signal === undefined ? {} : { signal: request.signal };
    await this.#assertProjectRootUsable(request.project, signalPolicy);
    const base = request.base ?? request.project.worktrunk.base;
    const pathEnv = worktreePathEnv(request.project, request.branch, request.path);
    const managedPathArgs = await this.#managedWorktreePathArgs(request.project, pathEnv);
    const output = await this.#run(
      this.#args([
        ...managedPathArgs,
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
      signalPolicy,
      pathEnv,
    );

    const commandObservations = parseCommandObservation(output.stdout, {
      project: request.project,
      providerId: this.id,
      observedAt: toIsoTimestamp(this.#clock.now()),
    });
    const withRegistrationIdentity = await Promise.all(
      commandObservations.map((observation) => this.#withRegistrationIdentity(observation)),
    );
    const observations = await filterManagedWorktreeObservations(
      request.project,
      withRegistrationIdentity,
    );
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
      const status = await this.#runSeedCommand(
        "git",
        ["-C", found.path, "status", "--porcelain=v1", "-z"],
        {
          failureMessage:
            "Worktrunk created and seeded the worktree but failed to read its working tree status.",
        },
      );
      const refreshed = { ...found, dirty: status.stdout.length > 0 };
      this.#observations.set(refreshed.id, refreshed);
      return refreshed;
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
    options?: { env?: Record<string, string>; failureMessage?: string },
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
        options?.failureMessage ??
          "Worktrunk created the worktree but failed to seed its working tree from the source.",
        { cause },
      );
    }
  }

  async #readRemovalEvidence(
    project: ProviderProjectConfig,
    policy: WorktrunkRunPolicy = {},
  ): Promise<GitWorktreeRemovalEvidence[]> {
    const args = ["-C", project.root, "worktree", "list", "--porcelain", "-z"];
    const result = await runRuntimeBoundaryWithRetryAndTimeout(
      {
        operation: "provider.worktrunk.gitWorktreeList",
        clock: this.#clock,
        timeoutMs: this.#timeoutMs,
        error: {
          tag: "WorktreeProviderError",
          code: "WORKTRUNK_COMMAND_FAILED",
          message: "Git failed to revalidate the worktree removal target.",
          provider: this.id,
        },
        timeoutError: {
          tag: "TimeoutError",
          code: "WORKTRUNK_TIMEOUT",
          message: "Git worktree revalidation timed out.",
          provider: this.id,
        },
        retry: {
          retries: 1,
          delayMs: 10,
        },
      },
      ({ signal }) =>
        runExternalCommand(
          {
            command: "git",
            args,
            unsetEnv: gitLocalEnvironmentVariables,
            signal: mergeAbortSignals(signal, policy.signal),
            maxOutputChars: 512 * 1024,
          },
          this.#runner,
        ),
    );
    if (!result.ok) {
      throw new WorktrunkProviderError(
        "WORKTRUNK_COMMAND_FAILED",
        "Git failed to revalidate the worktree removal target.",
        { cause: result.error },
      );
    }
    return parseGitWorktreeRemovalEvidence(result.value.stdout);
  }

  async removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult> {
    const signalPolicy: WorktrunkRunPolicy =
      request.signal === undefined ? {} : { signal: request.signal };
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
    await this.#assertProjectRootUsable(project, signalPolicy);

    const currentWorktrees = await this.#readRemovalEvidence(project, signalPolicy);
    const pathMatches = currentWorktrees.filter((worktree) =>
      samePath(worktree.path, request.expectedPath),
    );
    if (pathMatches.length === 0) {
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
    const selected = pathMatches[0];
    const registrationIdentity =
      selected?.state === "exists"
        ? await this.#resolveRegistrationIdentity(selected.path)
        : undefined;
    const finalRefusalReason =
      pathMatches.length !== 1
        ? "ambiguous_identity"
        : selected === undefined
          ? "missing_target"
          : selected.state !== "exists"
            ? "missing_target"
            : changedGitRemovalIdentityReason(selected, registrationIdentity, request);
    if (finalRefusalReason !== undefined || selected === undefined) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        message: "The selected worktree changed before Worktrunk could remove it.",
        hint: "Refresh and reselect the worktree before retrying removal.",
        request,
        projectId: project.id,
        canonicalPath: selected?.path ?? request.expectedPath,
        observedBranch: selected?.branch ?? request.expectedBranch,
        refusalReason: finalRefusalReason ?? "ambiguous_identity",
      });
    }
    if (request.force !== true) {
      const status = await this.#readTargetedGit(
        ["-C", selected.path, "status", "--porcelain=v1", "--untracked-files=normal"],
        "Git failed to inspect the worktree before removal.",
        signalPolicy,
      );
      if (status.length > 0) {
        throw worktreeRemovalRefusalError({
          code: "WORKTREE_DIRTY_REQUIRES_FORCE",
          message: "This worktree has uncommitted changes and cannot be removed without force.",
          hint: "Review the worktree changes, or confirm the removal with force.",
          request,
          projectId: project.id,
          canonicalPath: selected.path,
          observedBranch: selected.branch ?? request.expectedBranch,
          refusalReason: "dirty",
        });
      }
    }
    const branchIsShared =
      selected.branch !== undefined &&
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
    try {
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
        signalPolicy,
      );
    } catch (error) {
      if (!(error instanceof WorktrunkProviderError) || error.code !== "WORKTRUNK_CANCELLED") {
        throw error;
      }
      // Caller cancellation can win after deletion; only fresh Git absence confirms that edge.
      let currentEvidence: GitWorktreeRemovalEvidence[];
      try {
        currentEvidence = await this.#readRemovalEvidence(project, {});
      } catch (cause) {
        throw new WorktrunkProviderError(
          "WORKTRUNK_REMOVE_OUTCOME_UNKNOWN",
          "Worktrunk removal was cancelled after it started, and Git could not confirm the outcome.",
          {
            cause,
            hint: "Refresh worktrees and inspect the selected path before retrying removal.",
          },
        );
      }
      if (
        currentEvidence.some(
          (worktree) => worktree.state === "exists" && samePath(worktree.path, selected.path),
        )
      ) {
        throw error;
      }
    }
    this.#observations.delete(request.worktreeId);
    return {
      worktreeId: request.worktreeId,
      removed: true,
    };
  }

  async getWorktree(request: GetWorktreeRequest): Promise<WorktreeObservation | null> {
    if (
      request.worktreeId === undefined ||
      request.path === undefined ||
      request.project === undefined
    ) {
      if (request.worktreeId !== undefined) {
        const cached = this.#observations.get(request.worktreeId);
        if (
          cached !== undefined &&
          (request.projectId === undefined || cached.projectId === request.projectId)
        ) {
          return cached;
        }
      }
      if (request.path !== undefined) {
        const cached = [...this.#observations.values()].find(
          (observation) => observation.path === request.path,
        );
        if (
          cached !== undefined &&
          (request.worktreeId === undefined || cached.id === request.worktreeId) &&
          (request.projectId === undefined || cached.projectId === request.projectId)
        ) {
          return cached;
        }
      }
      return null;
    }

    const registrationIdentity = await this.#resolveRegistrationIdentity(request.path);
    if (
      registrationIdentity === undefined ||
      (request.expectedRegistrationIdentity !== undefined &&
        registrationIdentity !== request.expectedRegistrationIdentity)
    ) {
      return null;
    }
    const signalPolicy: WorktrunkRunPolicy =
      request.signal === undefined ? {} : { signal: request.signal };
    await this.#assertProjectRootUsable(request.project, signalPolicy);
    const targetOutput = await this.#readTargetedGit(
      [
        "-C",
        request.path,
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
        "HEAD",
        "--symbolic-full-name",
        "HEAD",
      ],
      "Git failed to validate the hinted worktree.",
      signalPolicy,
    );
    if ((await this.#resolveRegistrationIdentity(request.path)) !== registrationIdentity) {
      return null;
    }
    const target = targetOutput.trim().split("\n");
    const projectCommonDir = (
      await this.#readTargetedGit(
        ["-C", request.project.root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        "Git failed to validate the hinted worktree project.",
        signalPolicy,
      )
    ).trim();
    if ((await this.#resolveRegistrationIdentity(request.path)) !== registrationIdentity) {
      return null;
    }
    const [topLevel, commonDir, headSha, branchRef] = target;
    if (
      topLevel === undefined ||
      commonDir === undefined ||
      headSha === undefined ||
      branchRef === undefined ||
      !(await sameExistingPath(topLevel, request.path)) ||
      !(await sameExistingPath(commonDir, projectCommonDir))
    ) {
      return null;
    }
    const dirty =
      (
        await this.#readTargetedGit(
          ["-C", request.path, "status", "--porcelain=v1", "--untracked-files=normal"],
          "Git failed to inspect the hinted worktree status.",
          signalPolicy,
        )
      ).length > 0;
    const observation: WorktreeObservation = {
      id: request.worktreeId,
      provider: this.id,
      projectId: request.project.id,
      branch: branchRef.startsWith("refs/heads/")
        ? branchRef.slice("refs/heads/".length)
        : `detached:${headSha.slice(0, 10)}`,
      path: topLevel,
      state: "exists",
      source: "worktrunk",
      confidence: "high",
      reason: "Validated a durable worktree hint against current Git identity.",
      observedAt: toIsoTimestamp(this.#clock.now()),
      registrationIdentity,
      headSha,
      dirty,
      isPrimaryCheckout: await sameExistingPath(topLevel, request.project.root),
    };
    const finalRegistrationIdentity = await this.#resolveRegistrationIdentity(request.path);
    if (
      finalRegistrationIdentity !== registrationIdentity ||
      (await filterManagedWorktreeObservations(request.project, [observation])).length === 0
    ) {
      return null;
    }
    this.#projects.set(request.project.id, request.project);
    this.#observations.set(observation.id, observation);
    return observation;
  }

  async #readTargetedGit(
    args: string[],
    message: string,
    policy: WorktrunkRunPolicy = {},
  ): Promise<string> {
    const result = await runRuntimeBoundaryWithRetryAndTimeout(
      {
        operation: "provider.worktrunk.targetedWorktreeLookup",
        clock: this.#clock,
        timeoutMs: policy.timeoutMs ?? this.#timeoutMs,
        error: {
          tag: "WorktreeProviderError",
          code: "WORKTRUNK_COMMAND_FAILED",
          message,
          provider: this.id,
        },
        timeoutError: {
          tag: "TimeoutError",
          code: "WORKTRUNK_TIMEOUT",
          message,
          provider: this.id,
        },
        retry: {
          retries: 1,
          delayMs: 10,
          shouldRetry: (error) =>
            error.code !== "WORKTRUNK_TIMEOUT" &&
            error.code !== "EXTERNAL_COMMAND_ABORTED" &&
            error.tag !== "CancellationError",
        },
      },
      ({ signal }) =>
        runExternalCommand(
          {
            command: "git",
            args,
            unsetEnv: gitLocalEnvironmentVariables,
            signal: mergeAbortSignals(signal, policy.signal),
            maxOutputChars: 16 * 1024,
          },
          this.#runner,
        ),
    );
    if (!result.ok) {
      if (result.error.code === "WORKTRUNK_TIMEOUT") {
        throw new WorktrunkProviderError("WORKTRUNK_TIMEOUT", message, {
          cause: result.error,
        });
      }
      if (
        result.error.code === "EXTERNAL_COMMAND_ABORTED" ||
        result.error.tag === "CancellationError"
      ) {
        throw new WorktrunkProviderError(
          "WORKTRUNK_CANCELLED",
          "Worktrunk command was cancelled.",
          {
            cause: result.error,
          },
        );
      }
      throw new WorktrunkProviderError("WORKTRUNK_COMMAND_FAILED", message, {
        cause: result.error,
      });
    }
    return result.value.stdout;
  }

  #args(args: string[]): string[] {
    return this.#configPath === undefined ? args : ["--config", this.#configPath, ...args];
  }

  async #managedWorktreePathArgs(
    project: ProviderProjectConfig,
    env: Record<string, string> | undefined,
  ): Promise<string[]> {
    const worktreePath = env?.WORKTRUNK_WORKTREE_PATH;
    if (worktreePath === undefined) {
      return [];
    }
    if (!this.#projectConfigIdentifiers.has(project.id)) {
      await this.#readWorktrees(project, { retries: 0 });
    }
    const identifier = this.#projectConfigIdentifiers.get(project.id);
    if (identifier === undefined || identifier === null) {
      return [];
    }
    // Worktrunk applies a user [projects.<id>] path after the environment, so use its higher-precedence command config too.
    return ["--config-set", worktrunkProjectPathOverride(identifier, worktreePath)];
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
    if (arg === "--config" || arg === "--config-set" || arg === "-C") {
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

async function filterManagedWorktreeObservations(
  project: ProviderProjectConfig,
  observations: WorktreeObservation[],
  expectedManagedRoot?: ManagedRootSnapshot,
): Promise<WorktreeObservation[]> {
  const managedRoot = resolveManagedRoot(project);
  if (managedRoot === undefined || project.worktrunk.includeExternal !== false) {
    return observations.filter(
      (observation) =>
        !isMainWorktree(project, observation) || project.worktrunk.includeMain !== false,
    );
  }
  const canonicalManagedRoot = await realpath(managedRoot).catch(() => undefined);
  if (
    expectedManagedRoot !== undefined &&
    (expectedManagedRoot.canonicalPath === null
      ? canonicalManagedRoot !== undefined
      : canonicalManagedRoot === undefined ||
        !samePath(expectedManagedRoot.canonicalPath, canonicalManagedRoot))
  ) {
    return observations.filter(
      (observation) =>
        isMainWorktree(project, observation) && project.worktrunk.includeMain !== false,
    );
  }
  const managed = await Promise.all(
    observations.map(async (observation) => {
      if (isMainWorktree(project, observation)) return project.worktrunk.includeMain !== false;
      if (
        isPathInside(observation.path, managedRoot) ||
        (canonicalManagedRoot !== undefined && isPathInside(observation.path, canonicalManagedRoot))
      ) {
        return true;
      }
      const canonicalObservationPath = await realpath(observation.path).catch(() => undefined);
      return (
        canonicalManagedRoot !== undefined &&
        canonicalObservationPath !== undefined &&
        isPathInside(canonicalObservationPath, canonicalManagedRoot)
      );
    }),
  );
  return observations.filter((_, index) => managed[index] === true);
}

type ManagedRootSnapshot = { canonicalPath: string | null };

async function captureManagedRootSnapshot(
  project: ProviderProjectConfig,
): Promise<ManagedRootSnapshot | undefined> {
  const managedRoot = resolveManagedRoot(project);
  if (managedRoot === undefined || project.worktrunk.includeExternal !== false) return undefined;
  return { canonicalPath: await realpath(managedRoot).catch(() => null) };
}

function isMainWorktree(project: ProviderProjectConfig, observation: WorktreeObservation): boolean {
  return samePath(observation.path, project.root) || observation.isPrimaryCheckout === true;
}

function worktrunkProjectConfigIdentifier(
  observations: readonly WorktreeObservation[],
): string | null {
  const remoteIdentifiers = new Set<string>();
  for (const observation of observations) {
    if (observation.remote !== undefined) {
      remoteIdentifiers.add(
        `${observation.remote.host}/${observation.remote.owner}/${observation.remote.repo}`,
      );
    }
  }
  if (remoteIdentifiers.size > 0) {
    return remoteIdentifiers.size === 1 ? ([...remoteIdentifiers][0] ?? null) : null;
  }

  const primaryCheckoutPaths = new Set(
    observations
      .filter((observation) => observation.isPrimaryCheckout === true)
      .map((observation) => observation.path),
  );
  return primaryCheckoutPaths.size === 1 ? ([...primaryCheckoutPaths][0] ?? null) : null;
}

function worktrunkProjectPathOverride(identifier: string, worktreePath: string): string {
  return `projects.${JSON.stringify(identifier)}.worktree-path=${JSON.stringify(worktreePath)}`;
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

async function sameExistingPath(left: string, right: string): Promise<boolean> {
  if (samePath(left, right)) return true;
  const [canonicalLeft, canonicalRight] = await Promise.all([
    realpath(left).catch(() => undefined),
    realpath(right).catch(() => undefined),
  ]);
  return (
    canonicalLeft !== undefined &&
    canonicalRight !== undefined &&
    samePath(canonicalLeft, canonicalRight)
  );
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

function changedGitRemovalIdentityReason(
  evidence: GitWorktreeRemovalEvidence,
  registrationIdentity: string | undefined,
  request: RemoveWorktreeRequest,
): WorktreeRemovalRefusalReason | undefined {
  if (!samePath(evidence.path, request.expectedPath)) {
    return "path_changed";
  }
  if (
    evidence.branch === undefined ||
    !sameRemovalBranch(evidence.branch, request.expectedBranch)
  ) {
    return "branch_changed";
  }
  if (registrationIdentity === undefined) {
    return "registration_unverified";
  }
  if (registrationIdentity !== request.expectedRegistrationIdentity) {
    return "registration_changed";
  }
  return undefined;
}

function sameRemovalBranch(current: string, expected: string): boolean {
  if (current === expected) {
    return true;
  }
  if (!current.startsWith("detached:") || !expected.startsWith("detached:")) {
    return false;
  }
  const currentIdentity = current.slice("detached:".length);
  const expectedIdentity = expected.slice("detached:".length);
  return (
    currentIdentity.startsWith(expectedIdentity) || expectedIdentity.startsWith(currentIdentity)
  );
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
