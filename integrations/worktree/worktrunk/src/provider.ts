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
  type GitCheckoutRemovalIdentity,
  type GitWorktreeRemovalEvidence,
  parseGitCheckoutRemovalIdentity,
  parseGitCommonDirectory,
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

type WorktreeRemovalInspection = {
  observation: WorktreeObservation;
  nativeIdentity: GitCheckoutRemovalIdentity;
  nativeEvidence: GitWorktreeRemovalEvidence;
  managedRootSnapshot: ManagedRootSnapshot | undefined;
  branchIsShared: boolean;
};

type ManagedRootSnapshot = { canonicalPath: string | null };

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
 * Worktrunk's project-specific path templates, and removal uses current native Git evidence without
 * requiring cached inventory before repeating exact target and safety validation at mutation time.
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
    this.#projectConfigIdentifiers.set(project.id, worktrunkProjectConfigIdentifier(observations));
    return Promise.all(
      observations.map((observation) => this.#withRegistrationIdentity(observation)),
    );
  }

  async createWorktree(request: CreateWorktreeRequest): Promise<WorktreeObservation> {
    await this.#assertProjectRootUsable(request.project);
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
      {},
      pathEnv,
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
    // Preserve the created observation for existing targeted reads while seeding runs.
    this.#observations.set(found.id, found);
    if (request.seedFrom !== undefined) {
      try {
        await this.#seedWorkingTree(request.seedFrom.path, found.path);
      } catch (seedError) {
        // Seeding failed after the worktree was created. Remove it so callers never
        // inherit a half-seeded worktree; best-effort, then rethrow the seed cause.
        await this.removeWorktree({
          project: request.project,
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
    const inspection = await this.#inspectRemovalTarget(request, false);
    if (inspection === null) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_NOT_FOUND",
        message: "Worktrunk remove could not confirm that the selected worktree still exists.",
        hint: "Refresh and reselect the worktree before retrying removal.",
        request,
        projectId: request.project.id,
        canonicalPath: request.expectedPath,
        observedBranch: request.expectedBranch,
        refusalReason: "missing_target",
      });
    }
    const selected = inspection.observation;
    const refusalReason = changedRemovalIdentityReason(selected, request);
    if (refusalReason !== undefined) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        message: "The selected worktree changed before Worktrunk could remove it.",
        hint: "Refresh and reselect the worktree before retrying removal.",
        request,
        projectId: request.project.id,
        canonicalPath: selected.path,
        observedBranch: selected.branch,
        refusalReason,
      });
    }
    assertRemovalProtection(selected, request);

    const removalFlags: string[] = [];
    if (request.force === true) {
      removalFlags.push("--force");
    }
    if (inspection.branchIsShared) {
      removalFlags.push("--no-delete-branch");
    } else if (request.force === true) {
      removalFlags.push("--force-delete");
    }

    await this.#assertFinalRemovalTarget(request, inspection);

    // Worktrunk 0.64 needs selected-checkout context and cannot delete a branch shared elsewhere.
    await this.#run(
      this.#args([
        "-C",
        inspection.nativeIdentity.path,
        "remove",
        ...this.#automationHookArgs(),
        ...removalFlags,
        // Omit --foreground so staged-trash cleanup can remain detached after logical removal.
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

  async inspectWorktreeForRemoval(
    request: RemoveWorktreeRequest,
  ): Promise<WorktreeObservation | null> {
    return (await this.#inspectRemovalTarget(request))?.observation ?? null;
  }

  async #inspectRemovalTarget(
    request: RemoveWorktreeRequest,
    inspectDirty = true,
  ): Promise<WorktreeRemovalInspection | null> {
    if (!request.project.worktrunk.enabled) return null;
    await this.#assertProjectRootUsable(request.project);
    const managedRootSnapshot = await captureManagedRootSnapshot(request.project);
    const initialEvidence = await this.#readRemovalEvidence(request.project);
    const initialMatches = await matchingRemovalEvidence(initialEvidence, request.expectedPath);
    const initialSelected = initialMatches[0];
    if (initialSelected === undefined || initialSelected.state !== "exists") {
      return null;
    }
    if (initialMatches.length !== 1) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        message: "Git returned ambiguous registration evidence for the selected worktree.",
        hint: "Refresh and inspect the repository's worktree registrations before retrying.",
        request,
        projectId: request.project.id,
        canonicalPath: request.expectedPath,
        observedBranch: request.expectedBranch,
        refusalReason: "ambiguous_identity",
      });
    }

    const registrationBefore = await this.#resolveRegistrationIdentity(request.expectedPath);
    if (registrationBefore === undefined) {
      throw unverifiedRemovalRegistrationError(request);
    }
    const targetIdentity = parseGitCheckoutRemovalIdentity(
      await this.#readTargetedGit(
        [
          "-C",
          request.expectedPath,
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--git-common-dir",
          "HEAD",
          "--symbolic-full-name",
          "HEAD",
        ],
        "Git failed to validate the selected worktree.",
      ),
    );
    const projectCommonDir = parseGitCommonDirectory(
      await this.#readTargetedGit(
        ["-C", request.project.root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        "Git failed to validate the selected worktree's project.",
      ),
    );
    if (
      !(await sameExistingPath(targetIdentity.path, request.expectedPath)) ||
      !(await sameExistingPath(targetIdentity.commonDir, projectCommonDir))
    ) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        message: "The selected checkout no longer belongs to the configured project.",
        hint: "Refresh and reselect the worktree before retrying removal.",
        request,
        projectId: request.project.id,
        canonicalPath: targetIdentity.path,
        observedBranch: targetIdentity.branch,
        refusalReason: "protection_unverified",
      });
    }
    if ((await this.#resolveRegistrationIdentity(request.expectedPath)) !== registrationBefore) {
      throw changedRemovalRegistrationError(request, request.expectedPath, targetIdentity.branch);
    }
    const finalEvidence = await this.#readRemovalEvidence(request.project);
    const finalMatches = await matchingRemovalEvidence(finalEvidence, request.expectedPath);
    const selected = finalMatches[0];
    if (selected === undefined || selected.state !== "exists") {
      return null;
    }
    if (finalMatches.length !== 1) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        message: "Git returned ambiguous registration evidence for the selected worktree.",
        hint: "Refresh and inspect the repository's worktree registrations before retrying.",
        request,
        projectId: request.project.id,
        canonicalPath: request.expectedPath,
        observedBranch: selected.branch,
        refusalReason: "ambiguous_identity",
      });
    }
    if (
      !samePath(selected.path, targetIdentity.path) ||
      selected.branch !== targetIdentity.branch ||
      selected.headSha !== targetIdentity.headSha
    ) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        message: "The selected checkout changed during removal validation.",
        hint: "Refresh and reselect the worktree before retrying removal.",
        request,
        projectId: request.project.id,
        canonicalPath: selected.path,
        observedBranch: selected.branch,
        refusalReason:
          selected.branch === targetIdentity.branch ? "identity_changed" : "branch_changed",
      });
    }
    await assertManagedRemovalTarget(request.project, selected, request, managedRootSnapshot);

    const isPrimaryCheckout =
      initialSelected.isPrimaryCheckout ||
      selected.isPrimaryCheckout ||
      (await sameExistingPath(selected.path, request.project.root));
    const status =
      inspectDirty && request.force !== true
        ? await this.#readTargetedGit(
            ["-C", targetIdentity.path, "status", "--porcelain=v1", "--untracked-files=normal"],
            "Git failed to inspect the worktree before removal.",
          )
        : undefined;
    const registrationIdentity = await this.#resolveRegistrationIdentity(request.expectedPath);
    if (registrationIdentity === undefined) {
      throw unverifiedRemovalRegistrationError(request, selected);
    }
    if (registrationIdentity !== registrationBefore) {
      throw changedRemovalRegistrationError(request, request.expectedPath, selected.branch);
    }
    const observedBranch = sameRemovalBranch(selected, request.expectedBranch)
      ? request.expectedBranch
      : selected.branch;
    const observation: WorktreeObservation = {
      id: request.worktreeId,
      provider: this.id,
      projectId: request.project.id,
      branch: observedBranch,
      path: request.expectedPath,
      state: "exists",
      source: "worktrunk",
      confidence: "high",
      reason: "Validated current native Git evidence for worktree removal.",
      observedAt: toIsoTimestamp(this.#clock.now()),
      registrationIdentity,
      headSha: selected.headSha,
      isPrimaryCheckout,
    };
    if (status !== undefined) observation.dirty = status.length > 0;
    const branchIsShared =
      !selected.branch.startsWith("detached:") &&
      finalEvidence.some(
        (candidate) =>
          candidate.state === "exists" &&
          candidate.branch === selected.branch &&
          !samePath(candidate.path, selected.path),
      );
    return {
      observation,
      nativeIdentity: targetIdentity,
      nativeEvidence: selected,
      managedRootSnapshot,
      branchIsShared,
    };
  }

  async #assertFinalRemovalTarget(
    request: RemoveWorktreeRequest,
    inspection: WorktreeRemovalInspection,
  ): Promise<void> {
    const expected = inspection.nativeIdentity;
    const current = parseGitCheckoutRemovalIdentity(
      await this.#readTargetedGit(
        [
          "-C",
          expected.path,
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--git-common-dir",
          "HEAD",
          "--symbolic-full-name",
          "HEAD",
        ],
        "Git failed to complete final worktree removal validation.",
      ),
    );
    if (
      !samePath(current.path, expected.path) ||
      !samePath(current.commonDir, expected.commonDir) ||
      current.branch !== expected.branch ||
      current.headSha !== expected.headSha ||
      !(await sameExistingPath(current.path, request.expectedPath))
    ) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        message: "The selected checkout changed at the Worktrunk removal boundary.",
        hint: "Refresh and reselect the worktree before retrying removal.",
        request,
        projectId: request.project.id,
        canonicalPath: current.path,
        observedBranch: current.branch,
        refusalReason: current.branch === expected.branch ? "identity_changed" : "branch_changed",
      });
    }
    if (request.force !== true) {
      const status = await this.#readTargetedGit(
        ["-C", current.path, "status", "--porcelain=v1", "--untracked-files=normal"],
        "Git failed to complete final worktree removal validation.",
      );
      if (status.length > 0) {
        assertRemovalProtection({ ...inspection.observation, dirty: true }, request);
      }
    }
    await assertManagedRemovalTarget(
      request.project,
      inspection.nativeEvidence,
      request,
      inspection.managedRootSnapshot,
    );
    const registrationIdentity = await this.#resolveRegistrationIdentity(request.expectedPath);
    if (registrationIdentity === undefined) {
      throw unverifiedRemovalRegistrationError(request);
    }
    if (
      registrationIdentity !== request.expectedRegistrationIdentity ||
      registrationIdentity !== inspection.observation.registrationIdentity
    ) {
      throw changedRemovalRegistrationError(request, current.path, current.branch);
    }
  }

  async #readRemovalEvidence(
    project: ProviderProjectConfig,
  ): Promise<GitWorktreeRemovalEvidence[]> {
    const stdout = await this.#readTargetedGit(
      ["-C", project.root, "worktree", "list", "--porcelain", "-z"],
      "Git failed to revalidate the worktree removal target.",
      512 * 1024,
    );
    return parseGitWorktreeRemovalEvidence(stdout);
  }

  async #readTargetedGit(
    args: string[],
    message: string,
    maxOutputChars = 16 * 1024,
  ): Promise<string> {
    const result = await runRuntimeBoundaryWithRetryAndTimeout(
      {
        operation: "provider.worktrunk.inspectWorktreeForRemoval",
        clock: this.#clock,
        timeoutMs: this.#timeoutMs,
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
          shouldRetry: (error) => error.code !== "WORKTRUNK_TIMEOUT",
        },
      },
      ({ signal }) =>
        runExternalCommand(
          {
            command: "git",
            args,
            unsetEnv: gitLocalEnvironmentVariables,
            signal,
            maxOutputChars,
          },
          this.#runner,
        ),
    );
    if (result.ok) {
      return result.value.stdout;
    }
    throw new WorktrunkProviderError(
      result.error.code === "WORKTRUNK_TIMEOUT" ? "WORKTRUNK_TIMEOUT" : "WORKTRUNK_COMMAND_FAILED",
      message,
      { cause: result.error },
    );
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

async function matchingRemovalEvidence(
  evidence: readonly GitWorktreeRemovalEvidence[],
  path: string,
): Promise<GitWorktreeRemovalEvidence[]> {
  const exactMatches = evidence.filter((candidate) => samePath(candidate.path, path));
  if (exactMatches.length > 0) return exactMatches;

  const canonicalPath = await realpath(path).catch(() => undefined);
  if (canonicalPath === undefined) return [];
  const matches = await Promise.all(
    evidence.map(async (candidate) => {
      const canonicalCandidate = await realpath(candidate.path).catch(() => undefined);
      return canonicalCandidate !== undefined && samePath(canonicalCandidate, canonicalPath)
        ? candidate
        : undefined;
    }),
  );
  return matches.filter((candidate) => candidate !== undefined);
}

async function assertManagedRemovalTarget(
  project: ProviderProjectConfig,
  evidence: GitWorktreeRemovalEvidence,
  request: RemoveWorktreeRequest,
  snapshot: ManagedRootSnapshot | undefined,
): Promise<void> {
  if (snapshot === undefined) return;
  const managedRoot = resolveManagedRoot(project);
  if (managedRoot === undefined) return;
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    realpath(managedRoot).catch(() => undefined),
    realpath(evidence.path).catch(() => undefined),
  ]);
  if (
    snapshot.canonicalPath !== null &&
    canonicalRoot !== undefined &&
    canonicalTarget !== undefined &&
    samePath(canonicalRoot, snapshot.canonicalPath) &&
    isPathInside(canonicalTarget, snapshot.canonicalPath)
  ) {
    return;
  }
  throw worktreeRemovalRefusalError({
    code: "WORKTRUNK_WORKTREE_CHANGED",
    message: "Station could not verify that the selected checkout remains in its managed root.",
    hint: "Refresh the project and inspect its managed worktree root before retrying removal.",
    request,
    projectId: project.id,
    canonicalPath: evidence.path,
    observedBranch: evidence.branch,
    refusalReason: "protection_unverified",
  });
}

async function captureManagedRootSnapshot(
  project: ProviderProjectConfig,
): Promise<ManagedRootSnapshot | undefined> {
  const managedRoot = resolveManagedRoot(project);
  if (managedRoot === undefined || project.worktrunk.includeExternal !== false) return undefined;
  return { canonicalPath: await realpath(managedRoot).catch(() => null) };
}

function assertRemovalProtection(
  observation: WorktreeObservation,
  request: RemoveWorktreeRequest,
): void {
  if (observation.isPrimaryCheckout === true) {
    throw worktreeRemovalRefusalError({
      code: "WORKTRUNK_WORKTREE_CHANGED",
      message: "The project root checkout cannot be removed as a worktree.",
      hint: "Close the session without removing the checkout, or choose a managed worktree.",
      request,
      projectId: request.project.id,
      canonicalPath: observation.path,
      observedBranch: observation.branch,
      refusalReason: "primary_checkout",
    });
  }

  const configuredDefaultBranch = request.project.defaultBranch ?? request.project.worktrunk.base;
  const defaultBranches =
    configuredDefaultBranch === undefined
      ? []
      : configuredDefaultBranchCandidates(configuredDefaultBranch);
  if (defaultBranches.length === 0) {
    throw worktreeRemovalRefusalError({
      code: "WORKTRUNK_WORKTREE_CHANGED",
      message: "Station could not verify which checkout owns the repository default branch.",
      hint: "Configure the project's default branch, refresh, and retry.",
      request,
      projectId: request.project.id,
      canonicalPath: observation.path,
      observedBranch: observation.branch,
      refusalReason: "protection_unverified",
    });
  }
  if (defaultBranches.includes(observation.branch)) {
    throw worktreeRemovalRefusalError({
      code: "WORKTRUNK_WORKTREE_CHANGED",
      message: `The selected checkout currently owns the repository default branch '${observation.branch}'.`,
      hint: "Move the default branch back to its protected checkout, refresh, and reselect the disposable worktree.",
      request,
      projectId: request.project.id,
      canonicalPath: observation.path,
      observedBranch: observation.branch,
      refusalReason: "default_branch",
    });
  }
  if (observation.dirty === true && request.force !== true) {
    throw worktreeRemovalRefusalError({
      code: "WORKTREE_DIRTY_REQUIRES_FORCE",
      message: "This worktree has uncommitted changes and cannot be removed without force.",
      hint: "Review the worktree changes, or confirm the removal with force.",
      request,
      projectId: request.project.id,
      canonicalPath: observation.path,
      observedBranch: observation.branch,
      refusalReason: "dirty",
    });
  }
}

function configuredDefaultBranchCandidates(value: string): string[] {
  const configured = value.trim();
  if (configured === "") return [];
  if (configured.startsWith("refs/heads/")) {
    return [configured.slice("refs/heads/".length)].filter(Boolean);
  }
  const remoteRef = configured.match(/^refs\/remotes\/[^/]+\/(.+)$/)?.[1];
  if (remoteRef !== undefined) return [remoteRef];
  const slash = configured.indexOf("/");
  if (slash < 1 || slash === configured.length - 1) return [configured];
  return [...new Set([configured, configured.slice(slash + 1)])];
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

function sameRemovalBranch(
  evidence: Pick<GitWorktreeRemovalEvidence, "branch" | "headSha">,
  expected: string,
): boolean {
  if (evidence.branch === expected) {
    return true;
  }
  if (!evidence.branch.startsWith("detached:") || !expected.startsWith("detached:")) {
    return false;
  }
  const expectedHead = expected.slice("detached:".length);
  return /^[0-9a-f]{4,64}$/.test(expectedHead) && evidence.headSha.startsWith(expectedHead);
}

function unverifiedRemovalRegistrationError(
  request: RemoveWorktreeRequest,
  evidence?: GitWorktreeRemovalEvidence,
): WorktrunkProviderError {
  return worktreeRemovalRefusalError({
    code: "WORKTRUNK_WORKTREE_CHANGED",
    message: "Station could not verify the selected checkout's Git registration.",
    hint: "Refresh and reselect the worktree before retrying removal.",
    request,
    projectId: request.project.id,
    canonicalPath: evidence?.path ?? request.expectedPath,
    observedBranch: evidence?.branch ?? request.expectedBranch,
    refusalReason: "registration_unverified",
  });
}

function changedRemovalRegistrationError(
  request: RemoveWorktreeRequest,
  path: string,
  branch: string,
): WorktrunkProviderError {
  return worktreeRemovalRefusalError({
    code: "WORKTRUNK_WORKTREE_CHANGED",
    message: "The selected Git checkout registration changed during removal validation.",
    hint: "Refresh and reselect the worktree before retrying removal.",
    request,
    projectId: request.project.id,
    canonicalPath: path,
    observedBranch: branch,
    refusalReason: "registration_changed",
  });
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
