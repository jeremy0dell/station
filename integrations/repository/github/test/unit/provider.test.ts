import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { createFakeExternalCommandRunner } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { GithubRepositoryProvider } from "../../src/provider";

const now = "2026-05-20T12:00:00.000Z";
const headSha = "abcdef1234567890abcdef1234567890abcdef12";
const remote = {
  host: "github.com",
  owner: "example",
  repo: "web",
};

describe("GitHub repository provider", () => {
  it("supports github.com remotes", () => {
    expect(new GithubRepositoryProvider().supportsRemote(remote)).toBe(true);
  });

  it("supports hosts containing github.", () => {
    expect(
      new GithubRepositoryProvider().supportsRemote({
        host: "git.github.example",
        owner: "example",
        repo: "web",
      }),
    ).toBe(true);
  });

  it("rejects unrelated remotes", () => {
    expect(
      new GithubRepositoryProvider().supportsRemote({
        host: "forge.example",
        owner: "example",
        repo: "web",
      }),
    ).toBe(false);
  });

  it("discovers a unique pull request with gh pr list", async () => {
    const calls: string[] = [];
    const provider = providerWithResponses(calls, {
      "pr list --repo github.com/example/web --head feature --state all --limit 5 --json number,title,url,state,baseRefName,headRefName,headRefOid,isDraft,updatedAt,headRepository,headRepositoryOwner":
        JSON.stringify([
          {
            number: 42,
            title: "feat(web): expand the search",
            url: "https://github.com/example/web/pull/42",
            state: "OPEN",
            baseRefName: "main",
            headRefName: "feature",
            headRefOid: headSha,
            isDraft: false,
            updatedAt: now,
            headRepository: {
              nameWithOwner: "example/web",
            },
            headRepositoryOwner: {
              login: "example",
            },
          },
        ]),
    });

    await expect(
      provider.discoverPullRequest({
        remote,
        branch: "feature",
        headSha,
      }),
    ).resolves.toEqual({
      number: 42,
      title: "feat(web): expand the search",
      url: "https://github.com/example/web/pull/42",
      host: "github.com",
      state: "open",
      baseRef: "main",
      headRef: "feature",
      updatedAt: now,
      checkedAt: now,
    });
    expect(calls.join("\n")).not.toContain("pr status");
  });

  it("returns null when no pull request matches", async () => {
    const provider = providerWithResponses([], {
      "pr list --repo github.com/example/web --head feature --state all --limit 5 --json number,title,url,state,baseRefName,headRefName,headRefOid,isDraft,updatedAt,headRepository,headRepositoryOwner":
        "[]",
    });

    await expect(
      provider.discoverPullRequest({
        remote,
        branch: "feature",
        headSha,
      }),
    ).resolves.toBeNull();
  });

  it("rejects ambiguous pull request matches as a safe provider error", async () => {
    const provider = providerWithResponses([], {
      "pr list --repo github.com/example/web --head feature --state all --limit 5 --json number,title,url,state,baseRefName,headRefName,headRefOid,isDraft,updatedAt,headRepository,headRepositoryOwner":
        JSON.stringify([
          {
            number: 1,
            headRefName: "feature",
            headRefOid: "1111111111111111111111111111111111111111",
            headRepository: { nameWithOwner: "example/web" },
          },
          {
            number: 2,
            headRefName: "feature",
            headRefOid: "2222222222222222222222222222222222222222",
            headRepository: { nameWithOwner: "example/web" },
          },
        ]),
    });

    await expect(
      provider.discoverPullRequest({
        remote,
        branch: "feature",
      }),
    ).rejects.toMatchObject({
      tag: "RepositoryProviderError",
      code: "GITHUB_PULL_REQUEST_AMBIGUOUS",
    });
  });

  it("maps GitHub check buckets to aggregate check state", async () => {
    const provider = providerWithResponses([], {
      "pr checks 42 --repo github.com/example/web --json bucket,link,name,state,workflow,startedAt,completedAt":
        JSON.stringify([
          { bucket: "pass", link: "https://github.com/example/web/actions/runs/1" },
          { bucket: "skipping" },
          { bucket: "cancel" },
        ]),
    });

    await expect(
      provider.readChecks({
        remote,
        pullRequestNumber: 42,
      }),
    ).resolves.toEqual({
      state: "cancelled",
      url: "https://github.com/example/web/actions/runs/1",
      total: 3,
      passed: 1,
      skipped: 1,
      cancelled: 1,
      source: "github",
      checkedAt: now,
    });
  });

  it("parses checks JSON from gh non-zero status exits", async () => {
    const running = providerWithChecksStatusExit(8, [{ bucket: "pending" }]);
    await expect(
      running.readChecks({
        remote,
        pullRequestNumber: 42,
      }),
    ).resolves.toEqual({
      state: "running",
      total: 1,
      pending: 1,
      source: "github",
      checkedAt: now,
    });

    const failed = providerWithChecksStatusExit(1, [{ bucket: "fail" }]);
    await expect(
      failed.readChecks({
        remote,
        pullRequestNumber: 42,
      }),
    ).resolves.toEqual({
      state: "fail",
      total: 1,
      failed: 1,
      source: "github",
      checkedAt: now,
    });
  });

  it("normalizes auth, network, rate-limit, timeout, and abort errors", async () => {
    const auth = providerWithFailure("authentication required");
    await expect(auth.discoverPullRequest({ remote, branch: "feature" })).rejects.toMatchObject({
      code: "GITHUB_AUTH_UNAVAILABLE",
    });
    await expect(auth.readChecks({ remote, pullRequestNumber: 42 })).rejects.toMatchObject({
      code: "GITHUB_AUTH_UNAVAILABLE",
    });

    const rateLimit = providerWithFailure("API rate limit exceeded");
    await expect(
      rateLimit.discoverPullRequest({ remote, branch: "feature" }),
    ).rejects.toMatchObject({
      code: "GITHUB_RATE_LIMITED",
    });

    const network = providerWithFailure("ENOTFOUND github.com");
    await expect(network.discoverPullRequest({ remote, branch: "feature" })).rejects.toMatchObject({
      code: "GITHUB_NETWORK_FAILED",
    });

    const timeout = new GithubRepositoryProvider({
      timeoutMs: 1,
      clock: { now: () => new Date(now) },
      runner: createFakeExternalCommandRunner(
        (input) =>
          new Promise((_, reject) => {
            input.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          }),
      ),
    });
    await expect(timeout.discoverPullRequest({ remote, branch: "feature" })).rejects.toMatchObject({
      code: "GITHUB_COMMAND_TIMEOUT",
    });

    const controller = new AbortController();
    const aborted = new GithubRepositoryProvider({
      clock: { now: () => new Date(now) },
      runner: createFakeExternalCommandRunner(
        (input) =>
          new Promise((_, reject) => {
            if (input.signal?.aborted === true) {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              return;
            }
            input.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
            controller.abort();
          }),
      ),
    });
    await expect(
      aborted.discoverPullRequest({ remote, branch: "feature", signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "EXTERNAL_COMMAND_ABORTED",
    });
  });
});

function providerWithResponses(calls: string[], responses: Record<string, string>) {
  return new GithubRepositoryProvider({
    clock: { now: () => new Date(now) },
    runner: createFakeExternalCommandRunner(
      (input: ExternalCommandInput): ExternalCommandResult => {
        const key = [input.command, ...(input.args ?? [])].slice(1).join(" ");
        calls.push(key);
        const stdout = responses[key];
        if (stdout === undefined) {
          throw Object.assign(new Error(`No fake gh response for ${key}`), {
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
      },
    ),
  });
}

function providerWithChecksStatusExit(exitCode: number, checks: unknown[]) {
  return new GithubRepositoryProvider({
    clock: { now: () => new Date(now) },
    runner: createFakeExternalCommandRunner((input) => {
      expect([input.command, ...(input.args ?? [])].join(" ")).toBe(
        "gh pr checks 42 --repo github.com/example/web --json bucket,link,name,state,workflow,startedAt,completedAt",
      );
      expect(input.allowedExitCodes).toEqual([1, 8]);
      throw Object.assign(new Error("checks are not passing"), {
        code: exitCode,
        stdout: JSON.stringify(checks),
        stderr: "",
      });
    }),
  });
}

function providerWithFailure(stderr: string) {
  return new GithubRepositoryProvider({
    clock: { now: () => new Date(now) },
    runner: createFakeExternalCommandRunner(() => {
      throw Object.assign(new Error("failed"), {
        code: 1,
        stderr,
      });
    }),
  });
}
