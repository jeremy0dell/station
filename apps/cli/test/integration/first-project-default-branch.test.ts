import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type AddProjectToConfigResult, addProjectToConfig } from "@station/config";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { environmentWithoutGitLocals } from "@station/runtime";
import { WorktrunkProvider } from "@station/worktrunk";
import { describe, expect, it } from "vitest";
import { renderNewSetupConfig } from "../../src/commands/setup/configWriter.js";

const execFileAsync = promisify(execFile);

describe("first-project default branch", () => {
  it.each([
    "master",
    "trunk",
  ] as const)("persists the sole committed %s branch for worktree creation", async (defaultBranch) => {
    await withFreshConfig(`${defaultBranch}-project`, async ({ root, configPath, repo }) => {
      await initCommittedRepo(repo, defaultBranch);
      const added = await addProjectToConfig({ path: repo, configPath, homeDir: root });

      expect(added.writtenBlock).toMatchObject({
        defaultBranch,
        worktrunkBase: defaultBranch,
      });
      expect(added.project).toMatchObject({
        root: repo,
        defaultBranch,
        worktrunk: { enabled: true, base: defaultBranch },
      });
      const projectSource = projectBlock(await readFile(configPath, "utf8"));
      expect(projectSource).toContain(`default_branch = "${defaultBranch}"`);
      expect(projectSource).toContain(`[projects.worktrunk]\nbase = "${defaultBranch}"`);

      const worktreePath = join(root, ".worktrees", `${defaultBranch}-project`, "feature");
      const calls: ExternalCommandInput[] = [];
      const provider = new WorktrunkProvider({
        command: "wt",
        useLifecycleHooks: false,
        resolveRegistrationIdentity: async (path) => `git-registration:${path}`,
        runner: async (input) => {
          if (input.command === "git") {
            return result(input, "false\n");
          }
          calls.push(input);
          await mkdir(dirname(worktreePath), { recursive: true });
          await git(repo, "worktree", "add", "-b", "feature", worktreePath, defaultBranch);
          return result(input, JSON.stringify([{ path: worktreePath, branch: "feature" }]));
        },
      });

      try {
        await expect(
          provider.createWorktree({ project: added.project, branch: "feature" }),
        ).resolves.toMatchObject({
          branch: "feature",
          path: worktreePath,
          registrationIdentity: `git-registration:${worktreePath}`,
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args).toEqual([
          "switch",
          "--no-hooks",
          "--create",
          "feature",
          "--base",
          defaultBranch,
          "--no-cd",
          "--format=json",
        ]);
      } finally {
        await git(repo, "worktree", "remove", "--force", worktreePath).catch(() => undefined);
      }
    });
  });

  it("never rewrites an existing project when Git evidence changes", async () => {
    await withFreshConfig("existing-project", async ({ root, configPath, repo }) => {
      await initCommittedRepo(repo, "main");
      await addProjectToConfig({ path: repo, configPath, homeDir: root });
      const source = await readFile(configPath, "utf8");
      await git(repo, "branch", "trunk");

      const existing = await addProjectToConfig({ path: repo, configPath, homeDir: root });

      expect(existing.status).toBe("unchanged");
      expect(await readFile(configPath, "utf8")).toBe(source);
      expect(existing.project).toMatchObject({
        defaultBranch: "main",
        worktrunk: { base: "main" },
      });
    });
  });

  it("prefers a committed origin/HEAD over multiple local branches", async () => {
    await withFreshConfig("origin-project", async ({ root, configPath, repo }) => {
      await initCommittedRepo(repo, "feature");
      await addRemote(repo, "origin");
      await git(repo, "branch", "trunk");
      await git(repo, "update-ref", "refs/remotes/origin/trunk", "refs/heads/trunk");
      await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");

      const added = await addProjectToConfig({ path: repo, configPath, homeDir: root });

      expect(added.project).toMatchObject({
        defaultBranch: "trunk",
        worktrunk: { base: "origin/trunk" },
      });
    });
  });

  it("accepts one committed upstream HEAD when configured origin has no HEAD", async () => {
    await withFreshConfig("upstream-project", async ({ root, configPath, repo }) => {
      await initCommittedRepo(repo, "feature");
      await addRemote(repo, "origin");
      await addRemote(repo, "upstream");
      await git(repo, "branch", "trunk");
      await git(repo, "update-ref", "refs/remotes/upstream/trunk", "refs/heads/trunk");
      await git(repo, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/trunk");

      const added = await addProjectToConfig({ path: repo, configPath, homeDir: root });

      expect(added.project).toMatchObject({
        defaultBranch: "trunk",
        worktrunk: { base: "upstream/trunk" },
      });
    });
  });

  it.each([
    "outside-origin",
    "direct-ref",
  ] as const)("persists no default for a malformed origin/HEAD: %s", async (failure) => {
    await withFreshConfig("malformed-origin", async ({ root, configPath, repo }) => {
      await initCommittedRepo(repo, "main");
      await addRemote(repo, "origin");
      await git(repo, "branch", "trunk");
      if (failure === "outside-origin") {
        await git(repo, "update-ref", "refs/remotes/upstream/trunk", "refs/heads/trunk");
        await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/upstream/trunk");
      } else {
        await git(repo, "update-ref", "refs/remotes/origin/HEAD", "refs/heads/main");
      }

      const added = await addProjectToConfig({ path: repo, configPath, homeDir: root });

      await expectNoDetectedDefaults(added, configPath);
    });
  });

  it("persists no default for a dangling origin/HEAD with one local branch", async () => {
    await withFreshConfig("dangling-origin", async ({ root, configPath, repo }) => {
      await initCommittedRepo(repo, "main");
      await addRemote(repo, "origin");
      await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing");

      const added = await addProjectToConfig({ path: repo, configPath, homeDir: root });

      await expectNoDetectedDefaults(added, configPath);
    });
  });

  it("persists no default for a dangling upstream HEAD with one local branch", async () => {
    await withFreshConfig("dangling-upstream", async ({ root, configPath, repo }) => {
      await initCommittedRepo(repo, "main");
      await addRemote(repo, "upstream");
      await git(
        repo,
        "symbolic-ref",
        "refs/remotes/upstream/HEAD",
        "refs/remotes/upstream/missing",
      );

      const added = await addProjectToConfig({ path: repo, configPath, homeDir: root });

      await expectNoDetectedDefaults(added, configPath);
    });
  });

  it("persists no default for conflicting non-origin remote HEADs", async () => {
    await withFreshConfig("conflicting-remotes", async ({ root, configPath, repo }) => {
      await initCommittedRepo(repo, "main");
      await addRemote(repo, "upstream");
      await addRemote(repo, "fork");
      await git(repo, "branch", "trunk");
      await git(repo, "update-ref", "refs/remotes/upstream/trunk", "refs/heads/trunk");
      await git(repo, "update-ref", "refs/remotes/fork/main", "refs/heads/main");
      await git(repo, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/trunk");
      await git(repo, "symbolic-ref", "refs/remotes/fork/HEAD", "refs/remotes/fork/main");

      const added = await addProjectToConfig({ path: repo, configPath, homeDir: root });

      await expectNoDetectedDefaults(added, configPath);
    });
  });

  it("persists no default for multiple committed local branches", async () => {
    await withFreshConfig("ambiguous-local", async ({ root, configPath, repo }) => {
      await initCommittedRepo(repo, "main");
      await git(repo, "branch", "trunk");

      const added = await addProjectToConfig({ path: repo, configPath, homeDir: root });

      await expectNoDetectedDefaults(added, configPath);
    });
  });

  it("persists no default for an unborn repository", async () => {
    await withFreshConfig("unborn", async ({ root, configPath, repo }) => {
      await mkdir(repo, { recursive: true });
      await git(repo, "init", "-b", "trunk");

      const added = await addProjectToConfig({ path: repo, configPath, homeDir: root });

      await expectNoDetectedDefaults(added, configPath);
    });
  });

  it("persists no default when Git evidence cannot be read", async () => {
    await withFreshConfig("git-error", async ({ root, configPath, repo }) => {
      await mkdir(join(repo, ".git"), { recursive: true });

      const added = await addProjectToConfig({ path: repo, configPath, homeDir: root });

      await expectNoDetectedDefaults(added, configPath);
    });
  });
});

async function withFreshConfig(
  name: string,
  run: (context: { root: string; configPath: string; repo: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "station-first-project-"));
  const configPath = join(root, "config.toml");
  const repo = join(root, name);
  try {
    await writeFile(
      configPath,
      renderNewSetupConfig([
        {
          id: "codex",
          label: "Codex",
          status: "ok",
          command: "codex",
        },
      ]),
      "utf8",
    );
    await run({ root, configPath, repo });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function initCommittedRepo(repo: string, branch: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", branch);
  await git(
    repo,
    "-c",
    "user.email=station@example.invalid",
    "-c",
    "user.name=station",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
}

async function addRemote(repo: string, remote: string): Promise<void> {
  await git(repo, "remote", "add", remote, repo);
}

async function expectNoDetectedDefaults(
  added: AddProjectToConfigResult,
  configPath: string,
): Promise<void> {
  expect(added.project.defaultBranch).toBeUndefined();
  expect(added.project.worktrunk.base).toBeUndefined();
  const source = projectBlock(await readFile(configPath, "utf8"));
  expect(source).not.toContain("default_branch =");
  expect(source).not.toContain("[projects.worktrunk]");
}

function projectBlock(source: string): string {
  return source.slice(source.indexOf("[[projects]]"));
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, env: environmentWithoutGitLocals() });
}

function result(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}
