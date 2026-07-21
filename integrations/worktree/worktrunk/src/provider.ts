import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
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
  SafeError,
  WorktreeCapabilities,
  WorktreeEventContext,
  WorktreeObservation,
  WorktreeProvider,
  WorktreeRemovalRefusalDiagnosticDetail,
  WorktreeRemovalRefusalReason,
} from "@station/contracts";
import { ExternalCommandDiagnosticDetailSchema } from "@station/contracts";
import {
  type ExternalCommandResult,
  type ExternalCommandRunner,
  gitLocalEnvironmentVariables,
  nodeExternalCommandRunner,
  type RuntimeClock,
  runExternalCommand,
  runRuntimeBoundaryWithRetryAndTimeout,
  safeErrorFromUnknown,
  stableName,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { z } from "zod";
import { missingWorktrunkAutomationFlagSupport, worktrunkAutomationMode } from "./automation.js";
import {
  type CheckWorktrunkDependencyOptions,
  checkWorktrunkDependency,
  type WorktrunkDependencyStatus,
  worktrunkInstallHint,
} from "./dependency.js";
import {
  operationErrorWithWorktrunkRepairFailure,
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
  resolveRegistrationIdentity?: (worktreePath: string) => Promise<string | undefined>;
  resolveRepositoryIdentity?: (gitDirectory: string) => Promise<string | undefined>;
};

type WorktrunkRunPolicy = {
  retries?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  settlement?: WorktrunkMutationSettlement;
};

type CoreBareValue = boolean | "absent";

type ProjectRootTopology = {
  gitDirectory: string;
  commonDirectory: string;
  bare: boolean;
};

type ProjectRootSnapshotBase = ProjectRootTopology & {
  root: string;
  repositoryIdentity: string;
  effectiveBare: CoreBareValue;
  localBare: CoreBareValue;
};

type ProjectRootSnapshot =
  | (ProjectRootSnapshotBase & { kind: "checkout" })
  | (ProjectRootSnapshotBase & { kind: "intentional-bare" });

type CoreBareCommandResult = {
  result: ExternalCommandResult;
  durationMs: number;
};

const coreBareBooleanSchema = z.enum(["true", "false"]);
const projectRootTopologySchema = z.tuple([
  z.string().min(1).refine(isAbsolute),
  z.string().min(1).refine(isAbsolute),
  coreBareBooleanSchema,
]);

class WorktrunkMutationSettlement {
  readonly #pending: Promise<void>[] = [];

  track(command: Promise<ExternalCommandResult>): void {
    this.#pending.push(
      command.then(
        () => undefined,
        () => undefined,
      ),
    );
  }

  async wait(): Promise<void> {
    await Promise.all(this.#pending);
  }
}

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
 * Mutations serialize per configured root and restore its non-bare checkout invariant; removal also revalidates native Git identity, path, and branch immediately before invoking Worktrunk.
 */
export class WorktrunkProvider implements WorktreeProvider {
  readonly id: ProviderId = "worktrunk";

  readonly #command: string;
  readonly #configPath: string | undefined;
  readonly #useLifecycleHooks: boolean | undefined;
  readonly #timeoutMs: number;
  readonly #runner: ExternalCommandRunner | undefined;
  readonly #clock: RuntimeClock;
  readonly #resolveRegistrationIdentity: (worktreePath: string) => Promise<string | undefined>;
  readonly #resolveRepositoryIdentity: (gitDirectory: string) => Promise<string | undefined>;
  readonly #observations = new Map<string, WorktreeObservation>();
  readonly #projects = new Map<string, ProviderProjectConfig>();
  readonly #projectRootMutationChains = new Map<string, Promise<void>>();

  constructor(options: WorktrunkProviderOptions = {}) {
    this.#command = options.command ?? process.env.STATION_WORKTRUNK_BIN ?? "wt";
    this.#configPath = options.configPath;
    this.#useLifecycleHooks = options.useLifecycleHooks;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#runner = options.runner;
    this.#clock = options.clock ?? systemClock;
    this.#resolveRegistrationIdentity =
      options.resolveRegistrationIdentity ?? nativeGitRegistrationIdentity;
    this.#resolveRepositoryIdentity =
      options.resolveRepositoryIdentity ?? nativeGitRepositoryIdentity;
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
    const workBudgetMs = doctorWorkBudgetMs(context.timeoutMs ?? this.#timeoutMs);
    const budgetSignal = AbortSignal.timeout(workBudgetMs);
    const signal =
      context.signal === undefined ? budgetSignal : AbortSignal.any([context.signal, budgetSignal]);
    const projects = context.projects ?? [];
    const [automationCheck, projectRootChecks, hookCheck] = await Promise.all([
      this.#automationCapabilityCheck({ signal, timeoutMs: workBudgetMs }),
      this.#projectRootChecks(projects, { signal, timeoutMs: workBudgetMs }),
      this.#hookCheck(context),
    ]);
    const unsafeProjectIds = new Set(
      projectRootChecks.flatMap((check) =>
        check.error?.projectId === undefined ? [] : [check.error.projectId],
      ),
    );
    // Worktrunk list diagnostics are meaningful only after Git topology is verified as a non-bare checkout.
    const staleChecks = await this.#staleRegistrationChecks(
      projects.filter((project) => !unsafeProjectIds.has(project.id)),
      { signal, timeoutMs: workBudgetMs },
    );
    return [automationCheck, ...projectRootChecks, ...staleChecks, hookCheck];
  }

  async #hookCheck(context: ProviderDoctorContext): Promise<ProviderDoctorCheck> {
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
      return check;
    } catch (cause) {
      const error = safeErrorFromUnknown(cause, {
        tag: "WorktrunkHookSetupError",
        code: "WORKTRUNK_HOOK_DIAGNOSTIC_FAILED",
        message: "Worktrunk hook diagnostics failed.",
        provider: this.id,
      });
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
    const base = request.base ?? request.project.worktrunk.base;
    const output = await this.#withProjectRootMutation(request.project, () =>
      this.#runGuardedProjectMutation(request.project, (settlement) =>
        this.#run(
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
          { settlement },
          worktreeEnvironmentWithoutGitLocals(
            worktreePathEnv(request.project, request.branch, request.path),
          ),
        ),
      ),
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
        // Keep a failed cleanup observable because its mutation or root repair may already have completed.
        try {
          await this.removeWorktree({
            worktreeId: found.id,
            expectedPath: found.path,
            expectedBranch: found.branch,
            expectedRegistrationIdentity: found.registrationIdentity,
            force: true,
          });
          this.#observations.delete(found.id);
        } catch (cleanupError) {
          if (cleanupError instanceof WorktrunkProviderError) {
            throw operationErrorWithWorktrunkRepairFailure(seedError, cleanupError);
          }
          throw cleanupError;
        }
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

    return this.#withProjectRootMutation(project, async () => {
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
      await this.#runGuardedProjectMutation(project, (settlement) =>
        this.#run(
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
          { settlement },
        ),
      );
      this.#observations.delete(request.worktreeId);
      return {
        worktreeId: request.worktreeId,
        removed: true,
      };
    });
  }

  async #withProjectRootMutation<T>(
    project: ProviderProjectConfig,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = await canonicalProjectRoot(project.root);
    const previous = this.#projectRootMutationChains.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#projectRootMutationChains.set(key, tail);
    try {
      return await operation;
    } finally {
      if (this.#projectRootMutationChains.get(key) === tail) {
        this.#projectRootMutationChains.delete(key);
      }
    }
  }

  async #runGuardedProjectMutation<T>(
    project: ProviderProjectConfig,
    mutation: (settlement: WorktrunkMutationSettlement) => Promise<T>,
  ): Promise<T> {
    const preflight = await this.#inspectProjectRoot(project, {
      signal: AbortSignal.timeout(this.#timeoutMs),
      timeoutMs: this.#timeoutMs,
    });
    if (preflight.kind === "checkout" && preflight.bare) {
      throw new WorktrunkProviderError(
        "WORKTRUNK_PROJECT_ROOT_BARE",
        projectRootBareMessage(project),
        { hint: projectRootInspectionHint(project.root) },
      );
    }

    const settlement = new WorktrunkMutationSettlement();
    let operationOutcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
    let repairError: WorktrunkProviderError | undefined;
    try {
      try {
        operationOutcome = { ok: true, value: await mutation(settlement) };
      } catch (error) {
        operationOutcome = { ok: false, error };
      }
    } finally {
      await settlement.wait();
      // Postflight gets a fresh budget only after the mutation child has settled, so cancellation cannot race a config write against Worktrunk.
      const postflightSignal = AbortSignal.timeout(this.#timeoutMs);
      try {
        await this.#restoreProjectRootAfterMutation(project, preflight, {
          signal: postflightSignal,
          timeoutMs: this.#timeoutMs,
        });
      } catch (cause) {
        repairError = this.#projectRootRepairError(project, cause);
      }
    }

    if (operationOutcome === undefined) {
      throw new WorktrunkProviderError(
        "WORKTRUNK_COMMAND_FAILED",
        "Worktrunk mutation did not produce an outcome.",
      );
    }
    if (!operationOutcome.ok) {
      if (repairError !== undefined) {
        throw operationErrorWithWorktrunkRepairFailure(operationOutcome.error, repairError);
      }
      throw operationOutcome.error;
    }
    if (repairError !== undefined) {
      throw repairError;
    }
    return operationOutcome.value;
  }

  async #restoreProjectRootAfterMutation(
    project: ProviderProjectConfig,
    preflight: ProjectRootSnapshot,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<void> {
    const postflight = await this.#inspectProjectRoot(project, options);
    if (!sameRepositoryIdentity(preflight, postflight)) {
      throw new Error("The configured project root changed repository identity during mutation.");
    }
    if (preflight.kind === "intentional-bare") {
      if (postflight.kind !== "intentional-bare") {
        throw new Error("The intentional bare repository changed shape during mutation.");
      }
      return;
    }
    if (projectRootMatchesPreimage(preflight, postflight)) {
      return;
    }

    if (postflight.kind !== "checkout") {
      throw new Error("The configured checkout changed repository shape before repair.");
    }

    let restoreError: WorktrunkProviderError | undefined;
    try {
      const args =
        preflight.localBare === "absent"
          ? ["config", "--local", "--unset-all", "core.bare"]
          : ["config", "--local", "core.bare", "false"];
      const allowedExitCodes = preflight.localBare === "absent" ? [0, 5] : undefined;
      const command = await this.#runCoreBareCommand(project, args, {
        operation: "provider.worktrunk.coreBare.restore",
        code: "WORKTRUNK_PROJECT_ROOT_REPAIR_FAILED",
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        ...(allowedExitCodes === undefined ? {} : { allowedExitCodes }),
      });
      assertEmptyCoreBareCommandOutput(command.result);
    } catch (cause) {
      restoreError = this.#projectRootRepairError(project, cause);
    }

    let verification: ProjectRootSnapshot;
    try {
      verification = await this.#inspectProjectRoot(project, options);
    } catch (cause) {
      if (restoreError !== undefined) {
        throw restoreError;
      }
      throw cause;
    }
    if (
      sameRepositoryIdentity(preflight, verification) &&
      projectRootMatchesPreimage(preflight, verification)
    ) {
      return;
    }
    if (restoreError !== undefined) {
      throw restoreError;
    }
    throw new Error("The configured project root did not match its exact non-bare preimage.");
  }

  async #inspectProjectRoot(
    project: ProviderProjectConfig,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<ProjectRootSnapshot> {
    const before = await this.#readProjectRootTopology(project, options);
    const identityBefore = await this.#repositoryIdentity(project, before.gitDirectory);
    const effectiveBare = await this.#readCoreBareValue(project, false, options);
    const localBare = await this.#readCoreBareValue(project, true, options);
    const after = await this.#readProjectRootTopology(project, options);
    const identityAfter = await this.#repositoryIdentity(project, after.gitDirectory);

    if (!sameTopology(before, after) || identityBefore !== identityAfter) {
      throw this.#projectRootCheckError(
        project,
        new Error("Repository identity changed while Station inspected core.bare."),
      );
    }
    if (effectiveBare !== "absent" && effectiveBare !== before.bare) {
      throw this.#projectRootCheckError(
        project,
        new Error("Effective core.bare conflicts with Git repository mode."),
      );
    }
    if (localBare !== "absent" && (effectiveBare === "absent" || localBare !== effectiveBare)) {
      throw this.#projectRootCheckError(
        project,
        new Error("Repository-local core.bare conflicts with its effective value."),
      );
    }

    const root = await canonicalProjectRoot(project.root);
    const gitDirectoryIsRoot = samePath(before.gitDirectory, root);
    const commonDirectoryIsRoot = samePath(before.commonDirectory, root);
    let kind: ProjectRootSnapshot["kind"];
    if (!gitDirectoryIsRoot) {
      kind = "checkout";
    } else if (commonDirectoryIsRoot && before.bare) {
      kind = "intentional-bare";
    } else {
      throw this.#projectRootCheckError(
        project,
        new Error(
          "Configured root is neither a checkout nor a proven intentional bare repository.",
        ),
      );
    }

    return {
      kind,
      root,
      gitDirectory: before.gitDirectory,
      commonDirectory: before.commonDirectory,
      bare: before.bare,
      repositoryIdentity: identityBefore,
      effectiveBare,
      localBare,
    };
  }

  async #repositoryIdentity(project: ProviderProjectConfig, gitDirectory: string): Promise<string> {
    try {
      const identity = await this.#resolveRepositoryIdentity(gitDirectory);
      if (identity !== undefined) {
        return identity;
      }
      throw new Error("Git directory identity is unavailable.");
    } catch (cause) {
      throw this.#projectRootCheckError(project, cause);
    }
  }

  async #readProjectRootTopology(
    project: ProviderProjectConfig,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<ProjectRootTopology> {
    const args = [
      "rev-parse",
      "--path-format=absolute",
      "--absolute-git-dir",
      "--git-common-dir",
      "--is-bare-repository",
    ];
    const command = await this.#runCoreBareCommand(project, args, {
      operation: "provider.worktrunk.coreBare.inspect",
      code: "WORKTRUNK_PROJECT_ROOT_CHECK_FAILED",
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    try {
      return parseProjectRootTopology(command.result);
    } catch (cause) {
      throw this.#projectRootCheckError(
        project,
        cause,
        coreBareResultDiagnostics({
          operation: "provider.worktrunk.coreBare.inspect",
          args,
          cwd: project.root,
          result: command.result,
          durationMs: command.durationMs,
        }),
      );
    }
  }

  async #readCoreBareValue(
    project: ProviderProjectConfig,
    local: boolean,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<CoreBareValue> {
    const args = ["config", ...(local ? ["--local"] : []), "--type=bool", "--get", "core.bare"];
    const command = await this.#runCoreBareCommand(project, args, {
      operation: "provider.worktrunk.coreBare.inspect",
      code: "WORKTRUNK_PROJECT_ROOT_CHECK_FAILED",
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      allowedExitCodes: [0, 1],
    });
    try {
      return parseCoreBareValue(command.result);
    } catch (cause) {
      throw this.#projectRootCheckError(
        project,
        cause,
        coreBareResultDiagnostics({
          operation: "provider.worktrunk.coreBare.inspect",
          args,
          cwd: project.root,
          result: command.result,
          durationMs: command.durationMs,
        }),
      );
    }
  }

  async #runCoreBareCommand(
    project: ProviderProjectConfig,
    args: string[],
    options: {
      operation: "provider.worktrunk.coreBare.inspect" | "provider.worktrunk.coreBare.restore";
      code: "WORKTRUNK_PROJECT_ROOT_CHECK_FAILED" | "WORKTRUNK_PROJECT_ROOT_REPAIR_FAILED";
      signal: AbortSignal;
      timeoutMs: number;
      allowedExitCodes?: number[] | undefined;
    },
  ): Promise<CoreBareCommandResult> {
    const startedAt = this.#clock.now().getTime();
    try {
      const result = await runExternalCommand(
        {
          command: "git",
          args,
          cwd: project.root,
          unsetEnv: gitLocalEnvironmentVariables,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          maxOutputChars: 4096,
          ...(options.allowedExitCodes === undefined
            ? {}
            : { allowedExitCodes: options.allowedExitCodes }),
        },
        this.#runner,
      );
      return {
        result,
        durationMs: Math.max(0, this.#clock.now().getTime() - startedAt),
      };
    } catch (cause) {
      const durationMs = Math.max(0, this.#clock.now().getTime() - startedAt);
      const diagnostics = worktrunkCommandDiagnostics({
        error: cause,
        provider: this.id,
        operation: options.operation,
        command: "git",
        args,
        cwd: project.root,
        durationMs,
      });
      if (options.code === "WORKTRUNK_PROJECT_ROOT_REPAIR_FAILED") {
        throw this.#projectRootRepairError(project, cause, diagnostics);
      }
      throw this.#projectRootCheckError(project, cause, diagnostics);
    }
  }

  #projectRootCheckError(
    project: ProviderProjectConfig,
    cause: unknown,
    diagnosticDetails?: DiagnosticDetail[],
  ): WorktrunkProviderError {
    return new WorktrunkProviderError(
      "WORKTRUNK_PROJECT_ROOT_CHECK_FAILED",
      `Station could not verify project "${project.label}" configured root as a stable Git checkout.`,
      {
        cause,
        hint: projectRootInspectionHint(project.root),
        ...(diagnosticDetails === undefined ? {} : { diagnosticDetails }),
      },
    );
  }

  #projectRootRepairError(
    project: ProviderProjectConfig,
    cause: unknown,
    diagnosticDetails?: DiagnosticDetail[],
  ): WorktrunkProviderError {
    if (
      cause instanceof WorktrunkProviderError &&
      cause.code === "WORKTRUNK_PROJECT_ROOT_REPAIR_FAILED"
    ) {
      return cause;
    }
    const inheritedDiagnostics =
      cause instanceof WorktrunkProviderError ? cause.diagnosticDetails : undefined;
    const combinedDiagnostics = diagnosticDetails ?? inheritedDiagnostics;
    const errorOptions: {
      cause: unknown;
      hint: string;
      diagnosticDetails?: DiagnosticDetail[];
    } = {
      cause,
      hint: projectRootRepairHint(project.root),
    };
    if (combinedDiagnostics !== undefined) {
      errorOptions.diagnosticDetails = combinedDiagnostics;
    }
    return new WorktrunkProviderError(
      "WORKTRUNK_PROJECT_ROOT_REPAIR_FAILED",
      "Station could not restore the configured project root after the Worktrunk mutation; the mutation may already have completed.",
      errorOptions,
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

  #automationHookArgs(): string[] {
    if (this.#useLifecycleHooks === false) {
      return ["--no-hooks"];
    }
    if (this.#useLifecycleHooks === true) {
      return ["--yes"];
    }
    return [];
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

  async #projectRootChecks(
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
          let snapshot: ProjectRootSnapshot;
          try {
            snapshot = await this.#inspectProjectRoot(project, options);
            completed += 1;
          } catch {
            if (options.signal.aborted) return;
            completed += 1;
            const error: SafeError = {
              tag: "WorktrunkProjectRootDiagnosticError",
              code: "WORKTRUNK_PROJECT_ROOT_CHECK_FAILED",
              message: `Station could not verify project "${project.label}" configured root Git mode.`,
              hint: projectRootInspectionHint(project.root),
              provider: this.id,
              projectId: project.id,
            };
            checks[index] = {
              name: `worktrunk-project-root-${project.id}`,
              status: "warn",
              message: error.message,
              error,
            };
            return;
          }
          if (snapshot.kind !== "checkout" || !snapshot.bare) {
            return;
          }
          const message = projectRootBareMessage(project);
          checks[index] = {
            name: `worktrunk-project-root-${project.id}`,
            status: "warn",
            message,
            error: {
              tag: "WorktrunkProjectRootDiagnosticError",
              code: "WORKTRUNK_PROJECT_ROOT_BARE",
              message,
              hint: projectRootInspectionHint(project.root),
              provider: this.id,
              projectId: project.id,
            },
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
        name: "worktrunk-project-root-scan",
        status: "warn",
        message: `Worktrunk project-root diagnostics reached their time budget after checking ${completed} of ${enabledProjects.length} project(s).`,
      });
    }
    return completedChecks;
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
      ({ signal }) => {
        const runner =
          policy.settlement === undefined
            ? this.#runner
            : trackedExternalCommandRunner(
                this.#runner ?? nodeExternalCommandRunner,
                policy.settlement,
              );
        return runExternalCommand(
          {
            command: this.#command,
            args,
            unsetEnv: gitLocalEnvironmentVariables,
            ...(cwd === undefined ? {} : { cwd }),
            ...(env === undefined ? {} : { env }),
            signal: mergeAbortSignals(signal, policy.signal),
            maxOutputChars: 512 * 1024,
          },
          runner,
        );
      },
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
      throw providerErrorFromUnknown(cause, classifyWorktrunkFailure(cause, fallback), {
        diagnosticDetails,
      });
    }
  }
}

function trackedExternalCommandRunner(
  runner: ExternalCommandRunner,
  settlement: WorktrunkMutationSettlement,
): ExternalCommandRunner {
  return (input) => {
    const command = Promise.resolve().then(() => runner(input));
    settlement.track(command);
    return command;
  };
}

function parseProjectRootTopology(result: ExternalCommandResult): ProjectRootTopology {
  assertEmptyStderr(result);
  if (result.exitCode !== 0) {
    throw new Error(`git rev-parse exited with ${result.exitCode}.`);
  }
  const parsed = projectRootTopologySchema.parse(strictOutputLines(result.stdout));
  return {
    gitDirectory: canonicalPathForComparison(parsed[0]),
    commonDirectory: canonicalPathForComparison(parsed[1]),
    bare: parsed[2] === "true",
  };
}

function parseCoreBareValue(result: ExternalCommandResult): CoreBareValue {
  assertEmptyStderr(result);
  if (result.exitCode === 1) {
    if (result.stdout.length !== 0) {
      throw new Error("Absent core.bare returned unexpected output.");
    }
    return "absent";
  }
  if (result.exitCode !== 0) {
    throw new Error(`git config exited with ${result.exitCode}.`);
  }
  return coreBareBooleanSchema.parse(singleStrictOutputLine(result.stdout)) === "true";
}

function strictOutputLines(stdout: string): string[] {
  const withoutTerminator = stdout.replace(/\r?\n$/, "");
  if (withoutTerminator.includes("\n") && stdout.endsWith("\n\n")) {
    throw new Error("Git output contained an unexpected blank line.");
  }
  return withoutTerminator.split(/\r?\n/);
}

function singleStrictOutputLine(stdout: string): string {
  const lines = strictOutputLines(stdout);
  if (lines.length !== 1 || lines[0] === undefined) {
    throw new Error("Git output did not contain exactly one value.");
  }
  return lines[0];
}

function assertEmptyStderr(result: ExternalCommandResult): void {
  if (result.stderr.length !== 0) {
    throw new Error("Git inspection returned unexpected stderr output.");
  }
}

function assertEmptyCoreBareCommandOutput(result: ExternalCommandResult): void {
  if (result.exitCode !== 0 && result.exitCode !== 5) {
    throw new Error(`git config restore exited with ${result.exitCode}.`);
  }
  if (result.stdout.length !== 0 || result.stderr.length !== 0) {
    throw new Error("Git config restore returned unexpected output.");
  }
}

function coreBareResultDiagnostics(input: {
  operation: "provider.worktrunk.coreBare.inspect" | "provider.worktrunk.coreBare.restore";
  args: readonly string[];
  cwd: string;
  result: ExternalCommandResult;
  durationMs: number;
}): DiagnosticDetail[] {
  const detail: ExternalCommandDiagnosticDetail = {
    type: "external_command",
    provider: "worktrunk",
    operation: input.operation,
    command: formatCommand("git", input.args),
    cwd: input.cwd,
    exitCode: input.result.exitCode,
    durationMs: input.durationMs,
  };
  const stdoutSnippet = input.result.stdout.slice(0, 2000);
  if (stdoutSnippet.length > 0) detail.stdoutSnippet = stdoutSnippet;
  const stderrSnippet = input.result.stderr.slice(0, 2000);
  if (stderrSnippet.length > 0) detail.stderrSnippet = stderrSnippet;
  const parsed = ExternalCommandDiagnosticDetailSchema.safeParse(detail);
  return parsed.success ? [parsed.data] : [];
}

function sameTopology(left: ProjectRootTopology, right: ProjectRootTopology): boolean {
  return (
    samePath(left.gitDirectory, right.gitDirectory) &&
    samePath(left.commonDirectory, right.commonDirectory) &&
    left.bare === right.bare
  );
}

function sameRepositoryIdentity(left: ProjectRootSnapshot, right: ProjectRootSnapshot): boolean {
  return (
    samePath(left.root, right.root) &&
    samePath(left.gitDirectory, right.gitDirectory) &&
    samePath(left.commonDirectory, right.commonDirectory) &&
    left.repositoryIdentity === right.repositoryIdentity
  );
}

function projectRootMatchesPreimage(
  preflight: ProjectRootSnapshot & { kind: "checkout" },
  current: ProjectRootSnapshot,
): boolean {
  return (
    current.kind === "checkout" &&
    !current.bare &&
    current.effectiveBare !== true &&
    current.localBare === preflight.localBare
  );
}

async function canonicalProjectRoot(path: string): Promise<string> {
  try {
    return canonicalPathForComparison(await realpath(path));
  } catch {
    return canonicalPathForComparison(resolve(path));
  }
}

function projectRootBareMessage(project: ProviderProjectConfig): string {
  return `Project "${project.label}" configured root ${shellQuote(project.root)} is marked bare (core.bare=true).`;
}

function projectRootInspectionHint(root: string): string {
  const quotedRoot = shellQuote(root);
  return `Inspect with git -C ${quotedRoot} config --show-origin --get core.bare. If this is the intended checkout, run git -C ${quotedRoot} config --local core.bare false; otherwise correct projects.root.`;
}

function projectRootRepairHint(root: string): string {
  return `Refresh current worktree state and ${projectRootInspectionHint(root)} Do not retry the mutation until the configured root is non-bare.`;
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
    unresolvedBase?: string;
  },
): { code: WorktrunkProviderErrorCode; message: string; hint?: string } {
  if (fallback.code !== "WORKTRUNK_COMMAND_FAILED") {
    return fallback;
  }

  const diagnostic = stripVTControlCharacters(diagnosticText(error));
  const text = diagnostic.toLowerCase();
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

  if (
    fallback.unresolvedBase !== undefined &&
    unresolvedNamedReference(diagnostic) === fallback.unresolvedBase
  ) {
    return {
      code: "WORKTRUNK_BASE_MISSING",
      message: `Base \`${fallback.unresolvedBase}\` does not resolve to a commit.`,
      hint: "Create its first commit or choose another base.",
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

function unresolvedNamedReference(text: string): string | undefined {
  return /no branch, tag, or commit named ['"]?([^'"\s]+)['"]?/i.exec(text)?.[1];
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

function worktreeEnvironmentWithoutGitLocals(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  const sanitized = { ...env };
  for (const key of gitLocalEnvironmentVariables) delete sanitized[key];
  return sanitized;
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

async function nativeGitRepositoryIdentity(gitDirectory: string): Promise<string | undefined> {
  try {
    const before = await lstat(gitDirectory, { bigint: true });
    if (!before.isDirectory()) {
      return undefined;
    }
    const after = await lstat(gitDirectory, { bigint: true });
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
        [before.dev.toString(), before.ino.toString(), before.birthtimeNs.toString()].join("\0"),
      )
      .digest("hex");
    return `git-repository:${digest}`;
  } catch {
    return undefined;
  }
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

function isMissingBinary(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const cause = error as { code?: unknown; cause?: unknown };
  if (cause.code === "EXTERNAL_COMMAND_CWD_NOT_FOUND") return false;
  return cause.code === "ENOENT" || isMissingBinary(cause.cause);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
