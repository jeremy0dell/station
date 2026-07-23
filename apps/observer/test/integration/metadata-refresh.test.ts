import type { StationConfig } from "@station/config";
import type {
  ProviderHealth,
  RepositoryCapabilities,
  RepositoryChecksRequest,
  RepositoryProvider,
  RepositoryPullRequestRequest,
  RepositoryRemote,
  WorktreeChecksSummary,
  WorktreePullRequest,
} from "@station/contracts";
import type { ExternalCommandInput, ExternalCommandResult, RuntimeClock } from "@station/runtime";
import { createFakeExternalCommandRunner } from "@station/runtime";
import {
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  createCommandQueue,
  createLocalGitWorktreeChangeSource,
  createLocalGitWorktreeMetadataInvalidationSource,
  createObserverApi,
  createObserverEventBus,
  createWorktreeMetadataRefreshService,
  ProviderRegistry,
  providerProjectsFromConfig,
} from "../../src/internal";
import { createTestObserver } from "../support/testObserver";

const now = "2026-05-20T12:00:00.000Z";
const headSha = "2222222222222222222222222222222222222222";
const baseSha = "1111111111111111111111111111111111111111";
const mergeBaseSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const oldLocalMainSha = "3333333333333333333333333333333333333333";

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "fake-harness",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaultBranch: "main",
      defaults: {
        harness: "fake-harness",
        terminal: "fake-terminal",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
  ],
};

describe("observer worktree metadata refresh", () => {
  it("merges cached pull request and checks metadata into hot snapshots, including stale rows", async () => {
    const fixture = createFixture();
    await fixture.persistence.upsertWorktreeMetadataCurrent({
      worktreeId: "wt_web_feature",
      kind: "pull_request",
      cacheKey: "pr-cache",
      expiresAt: "2026-05-20T11:59:00.000Z",
      payload: {
        number: 123,
        url: "https://github.com/example/web/pull/123",
        host: "github.com",
        baseRef: "main",
        headRef: "feature",
        checkedAt: "2026-05-20T11:55:00.000Z",
      },
    });
    await fixture.persistence.upsertWorktreeMetadataCurrent({
      worktreeId: "wt_web_feature",
      kind: "checks",
      cacheKey: "checks-cache",
      expiresAt: "2026-05-20T11:59:00.000Z",
      payload: {
        state: "running",
        pending: 1,
        source: "github",
        checkedAt: "2026-05-20T11:55:00.000Z",
      },
    });

    const snapshot = await fixture.core.reconcile("metadata-hot-cache");
    const row = snapshot.rows.find((candidate) => candidate.id === "wt_web_feature");

    expect(row?.worktree.pr).toMatchObject({
      number: 123,
      stale: true,
    });
    expect(row?.worktree.checks).toMatchObject({
      state: "running",
      stale: true,
    });
    fixture.sqlite.close();
  });

  it("writes changed local git change summary metadata and requests a metadata reconcile", async () => {
    const fixture = createFixture();
    const reasons: string[] = [];
    const runner = gitRunner({
      "rev-parse --verify HEAD^{commit}": headSha,
      remote: "",
      "rev-parse --verify refs/heads/main^{commit}": baseSha,
      "merge-base main HEAD": mergeBaseSha,
      [`diff --numstat ${mergeBaseSha}..HEAD`]: "4\t2\tsrc/a.ts\n-\t-\tassets/logo.png\n",
    });
    const service = createWorktreeMetadataRefreshService({
      projects: providerProjectsFromConfig(config),
      persistence: fixture.persistence,
      requestReconcile: (reason) => reasons.push(reason),
      clock: fixture.clock,
      worktreeChangeSource: createLocalGitWorktreeChangeSource({ runner }),
      worktreeMetadataInvalidationSource: createLocalGitWorktreeMetadataInvalidationSource({
        requestReconcile: (reason) => reasons.push(reason),
      }),
    });

    const snapshot = await fixture.core.reconcile("metadata-refresh-before");
    await service.refresh(snapshot);

    await expect(
      fixture.persistence.listWorktreeMetadataCurrent({ kind: "change_summary", now }),
    ).resolves.toEqual([
      expect.objectContaining({
        worktreeId: "wt_web_feature",
        payload: expect.objectContaining({
          additions: 4,
          deletions: 2,
          filesChanged: 2,
          binaryFiles: 1,
          baseRef: "main",
          baseSha,
          mergeBaseSha,
          headSha,
          source: "local_git",
        }),
      }),
    ]);
    expect(reasons).toEqual(["metadata:change_summary"]);
    fixture.sqlite.close();
  });

  it("uses config defaultBranch remote refs through refresh, SQLite cache, and hot reconcile", async () => {
    const fixture = createFixture();
    const reasons: string[] = [];
    const calls: string[] = [];
    const runner = gitRunner(
      {
        "rev-parse --verify HEAD^{commit}": headSha,
        remote: "origin\n",
        "rev-parse --verify refs/remotes/origin/main^{commit}": headSha,
        "rev-parse --verify refs/heads/main^{commit}": oldLocalMainSha,
        "merge-base origin/main HEAD": headSha,
        "merge-base main HEAD": oldLocalMainSha,
        [`diff --numstat ${headSha}..HEAD`]: "",
        [`diff --numstat ${oldLocalMainSha}..HEAD`]: "51\t15\tsrc/stale.ts\n",
      },
      calls,
    );
    const service = createWorktreeMetadataRefreshService({
      projects: providerProjectsFromConfig(config),
      persistence: fixture.persistence,
      requestReconcile: (reason) => reasons.push(reason),
      clock: fixture.clock,
      worktreeChangeSource: createLocalGitWorktreeChangeSource({ runner }),
      worktreeMetadataInvalidationSource: createLocalGitWorktreeMetadataInvalidationSource({
        requestReconcile: (reason) => reasons.push(reason),
      }),
    });

    const snapshotBefore = await fixture.core.reconcile("metadata-default-branch-before");
    await service.refresh(snapshotBefore);

    const currentRows = await fixture.persistence.listWorktreeMetadataCurrent({
      kind: "change_summary",
      now,
    });
    expect(currentRows).toEqual([
      expect.objectContaining({
        worktreeId: "wt_web_feature",
        payload: expect.objectContaining({
          additions: 0,
          deletions: 0,
          filesChanged: 0,
          baseRef: "origin/main",
          baseSha: headSha,
          mergeBaseSha: headSha,
          headSha,
        }),
      }),
    ]);

    const snapshotAfter = await fixture.core.reconcile("metadata-default-branch-after");
    expect(snapshotAfter.rows[0]?.worktree.changeSummary).toMatchObject({
      additions: 0,
      deletions: 0,
      baseRef: "origin/main",
      baseSha: headSha,
      mergeBaseSha: headSha,
    });
    expect(calls).not.toContain("rev-parse --verify refs/heads/main^{commit}");
    expect(calls).not.toContain(`diff --numstat ${oldLocalMainSha}..HEAD`);
    expect(reasons).toEqual(["metadata:change_summary"]);
    fixture.sqlite.close();
  });

  it("marks an existing change summary stale when local git refresh fails", async () => {
    const fixture = createFixture();
    const reasons: string[] = [];
    await fixture.persistence.upsertWorktreeMetadataCurrent({
      worktreeId: "wt_web_feature",
      kind: "change_summary",
      cacheKey: "old",
      expiresAt: "2026-05-20T12:05:00.000Z",
      payload: {
        kind: "branch_diff",
        additions: 1,
        deletions: 0,
        source: "local_git",
        checkedAt: now,
      },
    });
    const runner = gitRunner({
      "rev-parse --verify HEAD^{commit}": headSha,
      remote: "",
      "rev-parse --verify refs/heads/main^{commit}": baseSha,
      "merge-base main HEAD": mergeBaseSha,
      [`diff --numstat ${mergeBaseSha}..HEAD`]: "bad\t1\tsrc/a.ts\n",
    });
    const service = createWorktreeMetadataRefreshService({
      projects: providerProjectsFromConfig(config),
      persistence: fixture.persistence,
      requestReconcile: (reason) => reasons.push(reason),
      clock: fixture.clock,
      worktreeChangeSource: createLocalGitWorktreeChangeSource({ runner }),
      worktreeMetadataInvalidationSource: createLocalGitWorktreeMetadataInvalidationSource({
        requestReconcile: (reason) => reasons.push(reason),
      }),
    });

    const snapshot = await fixture.core.reconcile("metadata-refresh-failure-before");
    await service.refresh(snapshot);

    await expect(
      fixture.persistence.listWorktreeMetadataCurrent({ kind: "change_summary", now }),
    ).resolves.toEqual([
      expect.objectContaining({
        worktreeId: "wt_web_feature",
        stale: true,
        payload: expect.objectContaining({ stale: true }),
        lastError: expect.objectContaining({
          tag: "LocalGitMetadataError",
          code: "LOCAL_GIT_NUMSTAT_INVALID",
        }),
      }),
    ]);
    expect(reasons).toEqual(["metadata:change_summary"]);
    fixture.sqlite.close();
  });

  it("backs off repeated local git refresh failures without scheduling a reconcile loop", async () => {
    const fixture = createFixture();
    const reasons: string[] = [];
    const calls: string[] = [];
    await fixture.persistence.upsertWorktreeMetadataCurrent({
      worktreeId: "wt_web_feature",
      kind: "change_summary",
      cacheKey: "old",
      expiresAt: "2026-05-20T11:59:00.000Z",
      payload: {
        kind: "branch_diff",
        additions: 1,
        deletions: 0,
        source: "local_git",
        checkedAt: now,
      },
    });
    const runner = gitRunner(
      {
        "rev-parse --verify HEAD^{commit}": headSha,
        remote: "",
        "rev-parse --verify refs/heads/main^{commit}": baseSha,
        "merge-base main HEAD": mergeBaseSha,
        [`diff --numstat ${mergeBaseSha}..HEAD`]: "bad\t1\tsrc/a.ts\n",
      },
      calls,
    );
    const service = createWorktreeMetadataRefreshService({
      projects: providerProjectsFromConfig(config),
      persistence: fixture.persistence,
      requestReconcile: (reason) => reasons.push(reason),
      clock: fixture.clock,
      worktreeChangeSource: createLocalGitWorktreeChangeSource({ runner }),
      worktreeMetadataInvalidationSource: createLocalGitWorktreeMetadataInvalidationSource({
        requestReconcile: (reason) => reasons.push(reason),
      }),
    });

    const snapshot = await fixture.core.reconcile("metadata-refresh-failure-loop-before");
    await service.refresh(snapshot);
    const callsAfterFailure = calls.length;
    await service.refresh(snapshot);

    await expect(
      fixture.persistence.listWorktreeMetadataCurrent({
        kind: "change_summary",
        includeExpired: true,
        now,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        worktreeId: "wt_web_feature",
        stale: true,
        expired: false,
        expiresAt: "2026-05-20T12:05:00.000Z",
        lastError: expect.objectContaining({
          tag: "LocalGitMetadataError",
          code: "LOCAL_GIT_NUMSTAT_INVALID",
        }),
      }),
    ]);
    expect(calls.length).toBe(callsAfterFailure);
    expect(reasons).toEqual(["metadata:change_summary"]);
    fixture.sqlite.close();
  });

  it("does not fail API reconcile when background metadata refresh fails", async () => {
    const fixture = createFixture();
    const eventBus = createObserverEventBus();
    const api = createObserverApi({
      core: fixture.core,
      persistence: fixture.persistence,
      persistenceHealth: fixture.persistence,
      commandQueue: createCommandQueue({
        persistence: fixture.persistence,
        clock: fixture.clock,
        idFactory: ids(),
        eventBus,
      }),
      eventBus,
      clock: fixture.clock,
      metadataRefresh: {
        refresh: async () => {
          throw new Error("metadata refresh failed");
        },
      },
    });

    await expect(api.reconcile("metadata-refresh-background-failure")).resolves.toMatchObject({
      reason: "metadata-refresh-background-failure",
      snapshot: {
        counts: {
          worktrees: 1,
        },
      },
    });
    fixture.sqlite.close();
  });

  it("refreshes GitHub repository metadata in the background", async () => {
    const fixture = createFixture();
    const reasons: string[] = [];
    const repository = new FakeRepositoryProvider({
      clock: fixture.clock,
      supportsRemote: supportsGithubRemote,
      pullRequest: {
        number: 77,
        url: "https://github.com/example/web/pull/77",
        host: "github.com",
        baseRef: "main",
        headRef: "feature",
        checkedAt: now,
      },
      checks: {
        state: "pass",
        total: 1,
        passed: 1,
        source: "github",
        checkedAt: now,
      },
    });
    const runner = gitRunner({
      "rev-parse --verify HEAD^{commit}": headSha,
      remote: "origin\n",
      "rev-parse --verify refs/remotes/origin/main^{commit}": baseSha,
      "merge-base origin/main HEAD": mergeBaseSha,
      [`diff --numstat ${mergeBaseSha}..HEAD`]: "1\t0\tsrc/a.ts\n",
      "remote get-url origin": "git@github.com:example/web.git\n",
    });
    const service = createWorktreeMetadataRefreshService({
      projects: providerProjectsFromConfig(config),
      persistence: fixture.persistence,
      requestReconcile: (reason) => reasons.push(reason),
      clock: fixture.clock,
      worktreeChangeSource: createLocalGitWorktreeChangeSource({ runner }),
      worktreeMetadataInvalidationSource: createLocalGitWorktreeMetadataInvalidationSource({
        requestReconcile: (reason) => reasons.push(reason),
      }),
      repositoryProviders: [repository],
    });

    const snapshot = await fixture.core.reconcile("metadata-repository-before");
    await service.refresh(snapshot);

    await expect(
      fixture.persistence.listWorktreeMetadataCurrent({
        kind: ["pull_request", "checks"],
        now,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "pull_request",
          payload: expect.objectContaining({ number: 77 }),
        }),
        expect.objectContaining({
          kind: "checks",
          payload: expect.objectContaining({ state: "pass" }),
        }),
      ]),
    );
    expect(reasons).toEqual([
      "metadata:change_summary",
      "metadata:pull_request",
      "metadata:checks",
    ]);
    fixture.sqlite.close();
  });

  it("refreshes repository metadata through a non-GitHub provider", async () => {
    const fixture = createFixture({ host: "forge.example", owner: "example", repo: "web" });
    const repository = new FakeRepositoryProvider({
      id: "forge",
      clock: fixture.clock,
      supportsRemote: (remote) => remote.host === "forge.example",
      pullRequest: {
        number: 88,
        url: "https://forge.example/example/web/pulls/88",
        host: "forge.example",
        baseRef: "main",
        headRef: "feature",
        checkedAt: now,
      },
      checks: {
        state: "pass",
        total: 1,
        passed: 1,
        source: "forge",
        checkedAt: now,
      },
    });
    const runner = gitRunner({
      "rev-parse --verify HEAD^{commit}": headSha,
      remote: "origin\n",
      "rev-parse --verify refs/remotes/origin/main^{commit}": baseSha,
      "merge-base origin/main HEAD": mergeBaseSha,
      [`diff --numstat ${mergeBaseSha}..HEAD`]: "1\t0\tsrc/a.ts\n",
      "remote get-url origin": "git@forge.example:example/web.git\n",
    });
    const service = createWorktreeMetadataRefreshService({
      projects: providerProjectsFromConfig(config),
      persistence: fixture.persistence,
      requestReconcile: () => undefined,
      clock: fixture.clock,
      worktreeChangeSource: createLocalGitWorktreeChangeSource({ runner }),
      worktreeMetadataInvalidationSource: createLocalGitWorktreeMetadataInvalidationSource({
        requestReconcile: (reason) => reasons.push(reason),
      }),
      repositoryProviders: [repository],
    });

    const snapshot = await fixture.core.reconcile("metadata-forge-before");
    await service.refresh(snapshot);

    await expect(
      fixture.persistence.listWorktreeMetadataCurrent({
        kind: ["pull_request", "checks"],
        now,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "pull_request",
          payload: expect.objectContaining({ number: 88, host: "forge.example" }),
        }),
        expect.objectContaining({
          kind: "checks",
          payload: expect.objectContaining({ state: "pass", source: "forge" }),
        }),
      ]),
    );
    fixture.sqlite.close();
  });

  it("rejects ambiguous repository support before provider operations run", async () => {
    const fixture = createFixture({ host: "forge.example", owner: "example", repo: "web" });
    let operations = 0;
    const providers = ["forge-a", "forge-b"].map(
      (id) =>
        new FakeRepositoryProvider({
          id,
          clock: fixture.clock,
          supportsRemote: (remote) => remote.host === "forge.example",
          discover: async () => {
            operations += 1;
            return null;
          },
        }),
    );
    const runner = gitRunner({
      "rev-parse --verify HEAD^{commit}": headSha,
      remote: "origin\n",
      "rev-parse --verify refs/remotes/origin/main^{commit}": baseSha,
      "merge-base origin/main HEAD": mergeBaseSha,
      [`diff --numstat ${mergeBaseSha}..HEAD`]: "1\t0\tsrc/a.ts\n",
      "remote get-url origin": "git@forge.example:example/web.git\n",
    });
    const service = createWorktreeMetadataRefreshService({
      projects: providerProjectsFromConfig(config),
      persistence: fixture.persistence,
      requestReconcile: () => undefined,
      clock: fixture.clock,
      worktreeChangeSource: createLocalGitWorktreeChangeSource({ runner }),
      worktreeMetadataInvalidationSource: createLocalGitWorktreeMetadataInvalidationSource({
        requestReconcile: (reason) => reasons.push(reason),
      }),
      repositoryProviders: providers,
    });

    const snapshot = await fixture.core.reconcile("metadata-ambiguous-before");

    await expect(service.refresh(snapshot)).rejects.toMatchObject({
      tag: "RepositoryProviderError",
      code: "REPOSITORY_PROVIDER_AMBIGUOUS",
    });
    expect(operations).toBe(0);
    fixture.sqlite.close();
  });

  it("marks existing repository metadata stale when remote refresh fails", async () => {
    const fixture = createFixture();
    await fixture.persistence.upsertWorktreeMetadataCurrent({
      worktreeId: "wt_web_feature",
      kind: "pull_request",
      cacheKey: "old",
      expiresAt: "2026-05-20T11:59:00.000Z",
      payload: {
        number: 77,
        host: "github.com",
        checkedAt: now,
      },
    });
    const repository = new FakeRepositoryProvider({
      clock: fixture.clock,
      supportsRemote: supportsGithubRemote,
      error: {
        tag: "RepositoryProviderError",
        code: "GITHUB_NETWORK_FAILED",
        message: "GitHub CLI network request failed.",
        provider: "github",
      },
    });
    const runner = gitRunner({
      "rev-parse --verify HEAD^{commit}": headSha,
      remote: "origin\n",
      "rev-parse --verify refs/remotes/origin/main^{commit}": baseSha,
      "merge-base origin/main HEAD": mergeBaseSha,
      [`diff --numstat ${mergeBaseSha}..HEAD`]: "1\t0\tsrc/a.ts\n",
      "remote get-url origin": "git@github.com:example/web.git\n",
    });
    const service = createWorktreeMetadataRefreshService({
      projects: providerProjectsFromConfig(config),
      persistence: fixture.persistence,
      requestReconcile: () => undefined,
      clock: fixture.clock,
      worktreeChangeSource: createLocalGitWorktreeChangeSource({ runner }),
      worktreeMetadataInvalidationSource: createLocalGitWorktreeMetadataInvalidationSource({
        requestReconcile: (reason) => reasons.push(reason),
      }),
      repositoryProviders: [repository],
    });

    const snapshot = await fixture.core.reconcile("metadata-repository-failure-before");
    await expect(service.refresh(snapshot)).resolves.toBeUndefined();

    await expect(
      fixture.persistence.listWorktreeMetadataCurrent({
        kind: "pull_request",
        includeExpired: true,
        now,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        stale: true,
        payload: expect.objectContaining({ stale: true }),
        lastError: expect.objectContaining({ code: "GITHUB_NETWORK_FAILED" }),
      }),
    ]);
    fixture.sqlite.close();
  });

  it("aborts in-flight repository refresh work on shutdown", async () => {
    const fixture = createFixture();
    let started = false;
    let aborted = false;
    const repository = new FakeRepositoryProvider({
      clock: fixture.clock,
      supportsRemote: supportsGithubRemote,
      discover: async (request) => {
        started = true;
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
        return null;
      },
    });
    const runner = gitRunner({
      "rev-parse --verify HEAD^{commit}": headSha,
      remote: "origin\n",
      "rev-parse --verify refs/remotes/origin/main^{commit}": baseSha,
      "merge-base origin/main HEAD": mergeBaseSha,
      [`diff --numstat ${mergeBaseSha}..HEAD`]: "1\t0\tsrc/a.ts\n",
      "remote get-url origin": "git@github.com:example/web.git\n",
    });
    const service = createWorktreeMetadataRefreshService({
      projects: providerProjectsFromConfig(config),
      persistence: fixture.persistence,
      requestReconcile: () => undefined,
      clock: fixture.clock,
      worktreeChangeSource: createLocalGitWorktreeChangeSource({ runner }),
      worktreeMetadataInvalidationSource: createLocalGitWorktreeMetadataInvalidationSource({
        requestReconcile: (reason) => reasons.push(reason),
      }),
      repositoryProviders: [repository],
    });

    const snapshot = await fixture.core.reconcile("metadata-repository-shutdown-before");
    const refresh = service.refresh(snapshot);
    await waitFor(() => started);
    await service.shutdown?.();
    await refresh;

    expect(aborted).toBe(true);
    fixture.sqlite.close();
  });
});

function createFixture(
  remote: RepositoryRemote = { host: "github.com", owner: "example", repo: "web" },
) {
  const clock = { now: () => new Date(now) };
  const providers = new ProviderRegistry({
    worktree: new FakeWorktreeProvider({
      now,
      worktrees: [
        createFakeWorktree({
          id: "wt_web_feature",
          projectId: "web",
          branch: "feature",
          path: "/tmp/station/web/feature",
          remote,
          headSha,
          now,
        }),
      ],
    }),
    terminal: new FakeTerminalProvider({ now }),
    harnesses: [new FakeHarnessProvider({ now })],
  });
  const { sqlite, persistence, core } = createTestObserver({ config, providers, clock });
  return {
    clock,
    sqlite,
    persistence,
    core,
  };
}

function gitRunner(responses: Record<string, string>, calls?: string[]) {
  return createFakeExternalCommandRunner((input: ExternalCommandInput): ExternalCommandResult => {
    const key = [input.command, ...(input.args ?? [])].slice(1).join(" ");
    calls?.push(key);
    const stdout = responses[key];
    if (stdout === undefined) {
      throw Object.assign(new Error(`No fake git response for ${key}`), {
        code: 1,
        stderr: "not found",
      });
    }
    return {
      command: input.command,
      args: input.args ?? [],
      stdout,
      stderr: "",
      exitCode: 0,
    };
  });
}

function ids() {
  let command = 0;
  let event = 0;
  let observation = 0;
  let breadcrumb = 0;
  return {
    commandId: () => `cmd_${++command}`,
    eventId: () => `evt_${++event}`,
    observationId: () => `obs_${++observation}`,
    breadcrumbId: () => `crumb_${++breadcrumb}`,
  };
}

class FakeRepositoryProvider implements RepositoryProvider {
  readonly id: string;

  readonly #clock: RuntimeClock;
  readonly #pullRequest: WorktreePullRequest | null;
  readonly #checks: WorktreeChecksSummary | null;
  readonly #error: unknown;
  readonly #supportsRemote: (remote: RepositoryRemote) => boolean;
  readonly #discover:
    | ((request: RepositoryPullRequestRequest) => Promise<WorktreePullRequest | null>)
    | undefined;

  constructor(input: {
    id?: string;
    clock: RuntimeClock;
    pullRequest?: WorktreePullRequest | null;
    checks?: WorktreeChecksSummary | null;
    error?: unknown;
    supportsRemote: (remote: RepositoryRemote) => boolean;
    discover?: (request: RepositoryPullRequestRequest) => Promise<WorktreePullRequest | null>;
  }) {
    this.id = input.id ?? "github";
    this.#clock = input.clock;
    this.#pullRequest = input.pullRequest ?? null;
    this.#checks = input.checks ?? null;
    this.#error = input.error;
    this.#supportsRemote = input.supportsRemote;
    this.#discover = input.discover;
  }

  supportsRemote(remote: RepositoryRemote): boolean {
    return this.#supportsRemote(remote);
  }

  capabilities(): RepositoryCapabilities {
    return {
      canDiscoverPullRequests: true,
      canReadChecks: true,
      canUseCliAuth: true,
    };
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      providerType: "repository",
      status: "unknown",
      lastCheckedAt: toIso(this.#clock),
      capabilities: this.capabilities(),
    };
  }

  async discoverPullRequest(
    request: RepositoryPullRequestRequest,
  ): Promise<WorktreePullRequest | null> {
    if (this.#discover !== undefined) {
      return this.#discover(request);
    }
    if (this.#error !== undefined) {
      throw this.#error;
    }
    return this.#pullRequest;
  }

  async readChecks(_request: RepositoryChecksRequest): Promise<WorktreeChecksSummary | null> {
    if (this.#error !== undefined) {
      throw this.#error;
    }
    return this.#checks;
  }
}

function supportsGithubRemote(remote: RepositoryRemote): boolean {
  return remote.host === "github.com" || remote.host.includes("github.");
}

function toIso(clock: RuntimeClock): string {
  return clock.now().toISOString();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for predicate.");
}
