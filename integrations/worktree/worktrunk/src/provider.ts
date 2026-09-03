import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import type {
  CreateWorktreeRequest,
  ProviderDoctorCheck,
  ProviderDoctorContext,
  ProviderHealth,
  ProviderId,
  ProviderProjectConfig,
  RemoveWorktreeRequest,
  RemoveWorktreeResult,
  SafeError,
  WorktreeCapabilities,
  WorktreeObservation,
  WorktreeProvider,
  WorktreeRemovalRefusalDiagnosticDetail,
  WorktreeRemovalRefusalReason,
} from "@station/contracts";
import {
  normalizeObservedPath,
  observedPathHasLexicalDotSegments,
  observedPathIsSameOrInside,
  sameObservedPath,
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
import {
  isWorktrunkConcurrentCreateRegistryFailure,
  worktrunkCommandFailure,
} from "./commandFailure.js";
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
import {
  createWorktreeRegistryMutationCoordinator,
  type WorktreeRegistryMutationCoordinator,
} from "./worktreeRegistryMutationCoordinator.js";

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

type StaleRegistrationInspection =
  | { status: "skipped" }
  | { status: "completed"; check?: ProviderDoctorCheck }
  | { status: "failed"; check: ProviderDoctorCheck };

type ProjectSetupPlan = {
  projectRoot: string;
  relativePaths: string[];
};

/**
 * ADAPTER
 *
 * Translates Worktrunk lifecycle output and commands into Station worktree contracts.
 * Hook diagnostics use an atomic requester runtime when supplied and retain the whole Observer composition
 * expectation as a fallback. List results are returned without retaining inventory; only the Worktrunk
 * project identifier needed to preserve managed-path precedence is memoized. Checkout roots are validated
 * before Worktrunk runs. Concurrent creates share only an in-flight managed-path identity probe and retain
 * their common-case mutation overlap. Reads and removals drain active creates; the exact nested Git
 * sibling-registration race does the same before Worktrunk resumes its half-created branch. Removal freshly
 * revalidates native Git identity, path, and branch before mutation. Create validates and copies configured
 * project-root files after any working-tree seed. Copy failure removes the exact new worktree or reports
 * cleanup uncertainty.
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
  readonly #platform: NodeJS.Platform;
  readonly #managedPathProjectIdentifiers = new Map<string, string | null>();
  readonly #managedPathProjectIdentifierProbes = new Map<string, Promise<void>>();
  readonly #registryMutations: WorktreeRegistryMutationCoordinator;

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
    this.#platform = options.platform ?? process.platform;
    this.#registryMutations = createWorktreeRegistryMutationCoordinator();
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
        provider: this.id,
        providerType: "worktree",
        status: "healthy",
        lastCheckedAt: checkedAt,
        capabilities: this.capabilities(),
        diagnostics: dependencyDiagnostics(dependency),
      };
    }

    return {
      provider: this.id,
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
        const ownershipConflict =
          result.ownership?.status === "different-owner" ||
          result.ownership?.status === "unknown-owner";
        check.error = {
          tag: "WorktrunkHookSetupError",
          code: ownershipConflict ? "WORKTRUNK_HOOK_OWNERSHIP_CONFLICT" : "WORKTRUNK_HOOKS_MISSING",
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

  async listWorktrees(project: ProviderProjectConfig): Promise<WorktreeObservation[]> {
    return this.#registryMutations.runExclusive(project.id, () =>
      this.#listWorktrees(project, { retries: 1 }),
    );
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
      isManagedWorktreeObservation(project, observation, this.#platform),
    );
    return Promise.all(
      managedObservations.map((observation) =>
        applyRecoveryBreadcrumbMetadata(observation, project),
      ),
    );
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
      platform: this.#platform,
    });
    const safeObservations = observations.filter((observation) =>
      isSafeWorktrunkObservationPath(observation.path),
    );
    this.#managedPathProjectIdentifiers.set(
      project.id,
      worktrunkProjectConfigIdentifier(safeObservations),
    );
    return Promise.all(
      safeObservations.map((observation) => this.#withRegistrationIdentity(observation)),
    );
  }

  async createWorktree(request: CreateWorktreeRequest): Promise<WorktreeObservation> {
    await this.#assertProjectRootUsable(request.project);
    const setup = await this.#preflightProjectSetup(request.project);
    const base = request.base ?? request.project.worktrunk.base;
    const pathEnv = worktreePathEnv(request.project, request.branch, request.path);
    const managedPathArgs = await this.#managedWorktreePathArgs(request.project, pathEnv);
    const automationArgs = this.#automationHookArgs();
    const output = await this.#registryMutations.runCreate(
      request.project.id,
      () =>
        this.#run(
          this.#args([
            ...managedPathArgs,
            "switch",
            ...automationArgs,
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
        ),
      (error) =>
        error instanceof WorktrunkProviderError &&
        isWorktrunkConcurrentCreateRegistryFailure(error, request.branch),
      () =>
        this.#run(
          this.#args([
            ...managedPathArgs,
            "switch",
            ...automationArgs,
            request.branch,
            "--no-cd",
            "--format=json",
          ]),
          request.project.root,
          {
            code: "WORKTRUNK_COMMAND_FAILED",
            message: "Worktrunk failed to finish a worktree after a concurrent Git registry race.",
          },
          {},
          pathEnv,
        ),
    );

    const commandObservations = parseCommandObservation(output.stdout, {
      project: request.project,
      providerId: this.id,
      observedAt: toIsoTimestamp(this.#clock.now()),
      platform: this.#platform,
    });
    const safeCommandObservations = commandObservations.filter((observation) =>
      isSafeWorktrunkObservationPath(observation.path),
    );
    const observations = (
      await Promise.all(
        safeCommandObservations.map((observation) => this.#withRegistrationIdentity(observation)),
      )
    ).filter((observation) =>
      isManagedWorktreeObservation(request.project, observation, this.#platform),
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
        throw seedError;
      }
    }
    if (setup !== undefined) {
      try {
        await this.#copyProjectSetup(request.project, setup, found.path);
      } catch (copyError) {
        try {
          const cleanup = await this.removeWorktree({
            project: request.project,
            worktreeId: found.id,
            expectedPath: found.path,
            expectedBranch: found.branch,
            expectedRegistrationIdentity: found.registrationIdentity,
            force: true,
          });
          if (!cleanup.removed) {
            throw new Error("Worktrunk did not confirm removal.");
          }
        } catch (cleanupError) {
          throw new WorktrunkProviderError(
            "WORKTRUNK_SETUP_CLEANUP_FAILED",
            "Station could not confirm cleanup after project setup failed.",
            {
              projectId: request.project.id,
              worktreeId: found.id,
              hint: `Inspect ${found.path} before retrying worktree creation.`,
              cause: cleanupError,
            },
          );
        }
        throw copyError;
      }
    }
    if (request.seedFrom !== undefined || setup !== undefined) {
      // Re-list so the caller sees the post-setup dirty state.
      const refreshed = (await this.listWorktrees(request.project)).find(
        (observation) => observation.id === found.id,
      );
      if (refreshed !== undefined) {
        return refreshed;
      }
    }
    return found;
  }

  async #preflightProjectSetup(
    project: ProviderProjectConfig,
  ): Promise<ProjectSetupPlan | undefined> {
    if (project.setup === undefined) {
      return undefined;
    }
    let projectRoot: string;
    try {
      projectRoot = await realpath(project.root);
    } catch (cause) {
      throw new WorktrunkProviderError(
        "WORKTRUNK_SETUP_SOURCE_INVALID",
        "Station could not resolve the project root for configured setup files.",
        { projectId: project.id, cause },
      );
    }
    for (const relativePath of project.setup.copyFromProjectRoot) {
      await this.#validateSetupSource(project, projectRoot, relativePath);
    }
    return {
      projectRoot,
      relativePaths: [...project.setup.copyFromProjectRoot],
    };
  }

  async #validateSetupSource(
    project: ProviderProjectConfig,
    projectRoot: string,
    relativePath: string,
  ): Promise<{ path: string; mode: number }> {
    const sourcePath = resolve(projectRoot, relativePath);
    try {
      const [metadata, resolvedPath] = await Promise.all([lstat(sourcePath), realpath(sourcePath)]);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        !isPathInside(resolvedPath, projectRoot, this.#platform)
      ) {
        throw new Error("The setup source is not a regular file inside the project root.");
      }
      return { path: sourcePath, mode: metadata.mode };
    } catch (cause) {
      throw new WorktrunkProviderError(
        "WORKTRUNK_SETUP_SOURCE_INVALID",
        `Configured setup file is unavailable or unsafe: ${relativePath}.`,
        { projectId: project.id, cause },
      );
    }
  }

  async #copyProjectSetup(
    project: ProviderProjectConfig,
    setup: ProjectSetupPlan,
    worktreePath: string,
  ): Promise<void> {
    let worktreeRoot: string;
    try {
      worktreeRoot = await realpath(worktreePath);
    } catch (cause) {
      throw new WorktrunkProviderError(
        "WORKTRUNK_SETUP_COPY_FAILED",
        "Station could not resolve the created worktree for project setup.",
        { projectId: project.id, cause },
      );
    }
    for (const relativePath of setup.relativePaths) {
      try {
        const source = await this.#validateSetupSource(project, setup.projectRoot, relativePath);
        const components = relativePath.split("/");
        const fileName = components.pop();
        if (fileName === undefined) {
          throw new Error("The setup destination has no file name.");
        }
        let parentPath = worktreeRoot;
        for (const component of components) {
          parentPath = join(parentPath, component);
          await ensureSetupDirectory(parentPath);
        }
        const resolvedParent = await realpath(parentPath);
        if (!isPathInside(resolvedParent, worktreeRoot, this.#platform)) {
          throw new Error("The setup destination resolves outside the worktree.");
        }
        const destinationPath = join(resolvedParent, fileName);
        if (await isExistingRegularFile(destinationPath)) {
          continue;
        }
        await copyFile(source.path, destinationPath, constants.COPYFILE_EXCL);
        await chmod(destinationPath, source.mode & 0o777);
      } catch (cause) {
        if (
          cause instanceof WorktrunkProviderError &&
          cause.code === "WORKTRUNK_SETUP_SOURCE_INVALID"
        ) {
          throw cause;
        }
        throw new WorktrunkProviderError(
          "WORKTRUNK_SETUP_COPY_FAILED",
          `Station could not copy configured setup file: ${relativePath}.`,
          { projectId: project.id, cause },
        );
      }
    }
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
    return this.#registryMutations.runExclusive(request.project.id, () =>
      this.#removeWorktree(request),
    );
  }

  async #removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult> {
    const project = request.project;
    await this.#assertProjectRootUsable(project);
    if (!isSafeWorktrunkObservationPath(request.expectedPath)) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        message: "The selected worktree path is not safe for Worktrunk removal.",
        hint: "Refresh and reselect the worktree before retrying removal.",
        request,
        canonicalPath: request.expectedPath,
        observedBranch: request.expectedBranch,
        refusalReason: "path_changed",
        platform: this.#platform,
      });
    }

    const currentWorktrees = await this.#readWorktrees(project, { retries: 1 });
    const identityMatches = currentWorktrees.filter(
      (worktree) => worktree.id === request.worktreeId,
    );
    const pathMatches = currentWorktrees.filter((worktree) =>
      samePath(worktree.path, request.expectedPath, this.#platform),
    );
    if (identityMatches.length === 0 && pathMatches.length === 0) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_NOT_FOUND",
        message: "Worktrunk remove could not confirm that the selected worktree still exists.",
        hint: "Run listWorktrees again before retrying removal.",
        request,
        canonicalPath: request.expectedPath,
        observedBranch: request.expectedBranch,
        refusalReason: "missing_target",
        platform: this.#platform,
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
            : changedRemovalIdentityReason(selected, request, this.#platform);
    if (finalRefusalReason !== undefined || selected === undefined || pathMatch === undefined) {
      throw worktreeRemovalRefusalError({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        message: "The selected worktree changed before Worktrunk could remove it.",
        hint: "Refresh and reselect the worktree before retrying removal.",
        request,
        canonicalPath: selected?.path ?? pathMatch?.path ?? request.expectedPath,
        observedBranch: selected?.branch ?? pathMatch?.branch ?? request.expectedBranch,
        refusalReason: finalRefusalReason ?? "ambiguous_identity",
        platform: this.#platform,
      });
    }
    const branchIsShared =
      !selected.branch.startsWith("detached:") &&
      currentWorktrees.some(
        (worktree) =>
          worktree.state === "exists" &&
          worktree.branch === selected.branch &&
          !samePath(worktree.path, selected.path, this.#platform),
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
    return {
      worktreeId: request.worktreeId,
      removed: true,
    };
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
    if (!this.#managedPathProjectIdentifiers.has(project.id)) {
      await this.#ensureManagedPathProjectIdentifier(project);
    }
    const identifier = this.#managedPathProjectIdentifiers.get(project.id);
    if (identifier === undefined || identifier === null) {
      return [];
    }
    // Worktrunk applies a user [projects.<id>] path after the environment, so use its higher-precedence command config too.
    return ["--config-set", worktrunkProjectPathOverride(identifier, worktreePath)];
  }

  async #ensureManagedPathProjectIdentifier(project: ProviderProjectConfig): Promise<void> {
    const current = this.#managedPathProjectIdentifierProbes.get(project.id);
    if (current !== undefined) {
      await current;
      return;
    }
    const probe = this.#readWorktrees(project, { retries: 0 }).then(() => undefined);
    this.#managedPathProjectIdentifierProbes.set(project.id, probe);
    try {
      await probe;
    } finally {
      if (this.#managedPathProjectIdentifierProbes.get(project.id) === probe) {
        this.#managedPathProjectIdentifierProbes.delete(project.id);
      }
    }
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
          const inspection = await this.#inspectStaleRegistration(project, options);
          if (inspection.status === "skipped") {
            return;
          }
          if (inspection.status === "completed") {
            completed += 1;
          }
          if (inspection.check !== undefined) {
            checks[offset + batchIndex] = inspection.check;
          }
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

  async #inspectStaleRegistration(
    project: ProviderProjectConfig,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<StaleRegistrationInspection> {
    if (options.signal.aborted) {
      return { status: "skipped" };
    }
    const gitOptions = {
      ...(this.#runner === undefined ? {} : { runner: this.#runner }),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    };
    if (await isGitCheckoutConfiguredBare(project.root, gitOptions)) {
      const providerError = projectRootBareError(project);
      return {
        status: "completed",
        check: {
          name: `worktrunk-project-root-${project.id}`,
          status: "warn",
          message: `${providerError.message} ${providerError.hint}`,
          error: projectDoctorError(providerError, project.id),
        },
      };
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
    } catch (cause) {
      if (options.signal.aborted) {
        return { status: "skipped" };
      }
      const failure = safeErrorFromUnknown(cause, {
        tag: "WorktrunkStaleRegistrationDiagnosticError",
        code: "WORKTRUNK_STALE_REGISTRATION_CHECK_FAILED",
        message: `Worktrunk could not inspect stale registrations for ${project.label}.`,
        provider: this.id,
      });
      return {
        status: "failed",
        check: {
          name: `worktrunk-stale-registrations-${project.id}`,
          status: "warn",
          message: failure.message,
          error: projectDoctorError(failure, project.id),
        },
      };
    }
    if (missing.length === 0) {
      return { status: "completed" };
    }
    return {
      status: "completed",
      check: {
        name: `worktrunk-stale-registrations-${project.id}`,
        status: "warn",
        message: staleRegistrationMessage(project, missing),
      },
    };
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
    const unavailable = fallback.code === "WORKTRUNK_UNAVAILABLE";
    const result = await runRuntimeBoundaryWithRetryAndTimeout(
      {
        operation,
        clock: this.#clock,
        timeoutMs: policy.timeoutMs ?? this.#timeoutMs,
        error: {
          tag: unavailable ? "ProviderUnavailableError" : "WorktreeProviderError",
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
            signal: policy.signal === undefined ? signal : AbortSignal.any([signal, policy.signal]),
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

function staleRegistrationMessage(
  project: ProviderProjectConfig,
  missing: readonly WorktreeObservation[],
): string {
  const registrations = missing.map((item) => `${item.branch} (${item.path})`).join(", ");
  const root = shellQuote(project.root);
  return `Worktrunk found missing/prunable registrations for ${project.label}: ${registrations}. Inspect with git -C ${root} worktree prune --dry-run --verbose, then clean with git -C ${root} worktree prune --verbose.`;
}

function projectDoctorError(error: SafeError, projectId: string): SafeError {
  const next: SafeError = {
    tag: error.tag,
    code: error.code,
    message: error.message,
    projectId,
  };
  if (error.hint !== undefined) next.hint = error.hint;
  if (error.provider !== undefined) next.provider = error.provider;
  return next;
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
    platform: NodeJS.Platform;
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
  platform: NodeJS.Platform,
): boolean {
  if (!isSafeWorktrunkObservationPath(observation.path)) return false;
  if (isMainWorktree(project, observation, platform)) {
    return project.worktrunk.includeMain !== false;
  }

  const managedRoot = resolveManagedRoot(project);
  if (managedRoot === undefined || project.worktrunk.includeExternal !== false) {
    return true;
  }

  return isPathInside(observation.path, managedRoot, platform);
}

function isSafeWorktrunkObservationPath(path: string): boolean {
  return isAbsolute(path) && !observedPathHasLexicalDotSegments(path);
}

function isMainWorktree(
  project: ProviderProjectConfig,
  observation: WorktreeObservation,
  platform: NodeJS.Platform,
): boolean {
  return (
    samePath(observation.path, project.root, platform) || observation.isPrimaryCheckout === true
  );
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

async function ensureSetupDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("A setup destination parent is not a directory.");
    }
    return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw cause;
    }
  }
  try {
    await mkdir(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
      throw cause;
    }
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("A setup destination parent is not a directory.");
  }
}

async function isExistingRegularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("A setup destination exists but is not a regular file.");
    }
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw cause;
  }
}

function isPathInside(path: string, root: string, platform: NodeJS.Platform): boolean {
  return isAbsolute(path) && isAbsolute(root) && observedPathIsSameOrInside(path, root, platform);
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return sameObservedPath(left, right, platform);
}

function changedRemovalIdentityReason(
  observation: WorktreeObservation,
  request: RemoveWorktreeRequest,
  platform: NodeJS.Platform,
): WorktreeRemovalRefusalReason | undefined {
  if (!samePath(observation.path, request.expectedPath, platform)) {
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
  canonicalPath: string;
  observedBranch: string;
  refusalReason: WorktreeRemovalRefusalReason;
  platform: NodeJS.Platform;
}): WorktrunkProviderError {
  const detail: WorktreeRemovalRefusalDiagnosticDetail = {
    type: "worktree_removal_refusal",
    worktreeId: input.request.worktreeId,
    canonicalPath: normalizeObservedPath(input.canonicalPath, input.platform),
    observedBranch: input.observedBranch,
    refusalReason: input.refusalReason,
    provider: "worktrunk",
    projectId: input.request.project.id,
  };
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
