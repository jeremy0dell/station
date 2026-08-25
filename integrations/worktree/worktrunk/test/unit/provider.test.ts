import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderProjectConfig } from "@station/contracts";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { gitLocalEnvironmentVariables, nodeExternalCommandRunner } from "@station/runtime";
import { WorktrunkProvider, type WorktrunkProviderOptions } from "@station/worktrunk";
import { describe, expect, it } from "vitest";

const now = "2026-05-21T12:00:00.000Z";
const project: ProviderProjectConfig = {
  id: "web",
  label: "web",
  root: "/tmp/station/web",
  defaultBranch: "main",
  defaults: {
    harness: "codex",
    terminal: "tmux",
    layout: "agent-shell",
  },
  worktrunk: {
    enabled: true,
    base: "main",
  },
};

function testProvider(options: WorktrunkProviderOptions): WorktrunkProvider {
  return new WorktrunkProvider({
    resolveRegistrationIdentity: async (path) => `git-registration:${path}`,
    ...options,
  });
}

describe("WorktrunkProvider", () => {
  it("lists worktrees through strict argv arrays", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = testProvider({
      command: "wt",
      configPath: "/tmp/wt/config.toml",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        return result(
          input,
          JSON.stringify([{ path: "/tmp/station/web/feature", branch: "feature" }]),
        );
      },
    });

    const observations = await provider.listWorktrees(project);

    expect(observations[0]).toMatchObject({
      id: expect.stringMatching(/^wt_web_feature_[a-f0-9]{10}$/),
      branch: "feature",
      observedAt: now,
    });
    expect(calls).toEqual([
      expect.objectContaining({
        command: "wt",
        args: ["--config", "/tmp/wt/config.toml", "list", "--format=json"],
        cwd: "/tmp/station/web",
      }),
    ]);
  });

  it("filters listed worktrees to the managed root when external worktrees are disabled", async () => {
    const managedProject = {
      ...project,
      worktrunk: {
        ...project.worktrunk,
        managedRoot: ".worktrees",
        includeMain: false,
        includeExternal: false,
      },
    };
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) =>
        result(
          input,
          JSON.stringify([
            { path: "/tmp/station/web", branch: "main", is_main: true },
            { path: "/tmp/station/web/.worktrees/feature", branch: "feature" },
            { path: "/tmp/station/web/.worktrees/merged", branch: "main", is_main: false },
            { path: "/tmp/station/web.sibling", branch: "sibling" },
            { path: "/tmp/codex/worktrees/abcd/web", commit: { short_sha: "9dd15ba" } },
          ]),
        ),
    });

    await expect(provider.listWorktrees(managedProject)).resolves.toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^wt_web_feature_[a-f0-9]{10}$/),
        branch: "feature",
        path: "/tmp/station/web/.worktrees/feature",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^wt_web_merged_[a-f0-9]{10}$/),
        branch: "main",
        path: "/tmp/station/web/.worktrees/merged",
      }),
    ]);
  });

  it("filters listed worktrees to a home-level managed project root", async () => {
    const managedProject = {
      ...project,
      worktrunk: {
        ...project.worktrunk,
        managedRoot: "/tmp/home/.worktrees/web",
        includeMain: false,
        includeExternal: false,
      },
    };
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) =>
        result(
          input,
          JSON.stringify([
            { path: "/tmp/station/web", branch: "main" },
            { path: "/tmp/home/.worktrees/web/feature", branch: "feature" },
            { path: "/tmp/home/.worktrees/api/feature", branch: "feature" },
            { path: "/tmp/station/web.sibling", branch: "sibling" },
          ]),
        ),
    });

    await expect(provider.listWorktrees(managedProject)).resolves.toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^wt_web_feature_[a-f0-9]{10}$/),
        branch: "feature",
        path: "/tmp/home/.worktrees/web/feature",
      }),
    ]);
  });

  it("matches macOS /private/var Worktrunk paths to /var managed roots", async () => {
    const managedProject = {
      ...project,
      root: "/var/folders/test/station/repo",
      worktrunk: {
        ...project.worktrunk,
        managedRoot: ".station-real-e2e/worktrees",
        includeMain: false,
        includeExternal: false,
      },
    };
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) =>
        result(
          input,
          JSON.stringify([
            {
              path: "/private/var/folders/test/station/repo/.station-real-e2e/worktrees/feature",
              branch: "feature",
            },
          ]),
        ),
    });

    await expect(provider.listWorktrees(managedProject)).resolves.toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^wt_web_feature_[a-f0-9]{10}$/),
        branch: "feature",
      }),
    ]);
  });

  it("keeps managed roots authoritative over Worktrunk project path templates", async () => {
    const calls: ExternalCommandInput[] = [];
    const managedProject = {
      ...project,
      worktrunk: {
        ...project.worktrunk,
        managedRoot: "/tmp/home/.worktrees/web",
        includeMain: false,
        includeExternal: false,
      },
    };
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "list") {
          return result(
            input,
            JSON.stringify([
              {
                path: "/tmp/station/web",
                branch: "main",
                is_main: true,
                repo: { host: "github.com", owner: "acme", name: "web" },
              },
            ]),
          );
        }
        return result(
          input,
          JSON.stringify([{ path: "/tmp/home/.worktrees/web/feature", branch: "feature" }]),
        );
      },
    });

    await expect(
      provider.createWorktree({ project: managedProject, branch: "feature" }),
    ).resolves.toMatchObject({
      path: "/tmp/home/.worktrees/web/feature",
    });
    expect(calls.map((call) => call.args)).toEqual([
      ["list", "--format=json"],
      [
        "--config-set",
        'projects."github.com/acme/web".worktree-path="/tmp/home/.worktrees/web/feature"',
        "switch",
        "--create",
        "feature",
        "--base",
        "main",
        "--no-cd",
        "--format=json",
      ],
    ]);
    expect(calls[1]?.env).toEqual({
      WORKTRUNK_WORKTREE_PATH: "/tmp/home/.worktrees/web/feature",
    });
  });

  it("overrides path-keyed Worktrunk project templates for repositories without remotes", async () => {
    const calls: ExternalCommandInput[] = [];
    const managedProject = {
      ...project,
      root: "/tmp/station/web-linked",
      worktrunk: {
        ...project.worktrunk,
        managedRoot: "/tmp/home/.worktrees/web",
        includeMain: false,
        includeExternal: false,
      },
    };
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "list") {
          return result(
            input,
            JSON.stringify([
              {
                path: "/tmp/station/web",
                branch: "main",
                is_main: true,
              },
            ]),
          );
        }
        return result(
          input,
          JSON.stringify([{ path: "/tmp/home/.worktrees/web/feature", branch: "feature" }]),
        );
      },
    });

    await expect(
      provider.createWorktree({ project: managedProject, branch: "feature" }),
    ).resolves.toMatchObject({
      path: "/tmp/home/.worktrees/web/feature",
    });
    expect(calls[1]?.args).toEqual([
      "--config-set",
      'projects."/tmp/station/web".worktree-path="/tmp/home/.worktrees/web/feature"',
      "switch",
      "--create",
      "feature",
      "--base",
      "main",
      "--no-cd",
      "--format=json",
    ]);
  });

  it("directs created worktrees into the managed root through Worktrunk config env", async () => {
    const calls: ExternalCommandInput[] = [];
    const managedProject = {
      ...project,
      worktrunk: {
        ...project.worktrunk,
        managedRoot: ".worktrees",
        includeMain: false,
        includeExternal: false,
      },
    };
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        return result(
          input,
          JSON.stringify([{ path: "/tmp/station/web/.worktrees/feature", branch: "feature" }]),
        );
      },
    });

    await expect(
      provider.createWorktree({ project: managedProject, branch: "feature" }),
    ).resolves.toMatchObject({
      id: expect.stringMatching(/^wt_web_feature_[a-f0-9]{10}$/),
      path: "/tmp/station/web/.worktrees/feature",
    });
    expect(calls[1]?.env).toEqual({
      WORKTRUNK_WORKTREE_PATH: "/tmp/station/web/.worktrees/feature",
    });
  });

  it("directs created worktrees into a home-level managed project root", async () => {
    const calls: ExternalCommandInput[] = [];
    const managedProject = {
      ...project,
      worktrunk: {
        ...project.worktrunk,
        managedRoot: "/tmp/home/.worktrees/web",
        includeMain: false,
        includeExternal: false,
      },
    };
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        return result(
          input,
          JSON.stringify([{ path: "/tmp/home/.worktrees/web/feature", branch: "feature" }]),
        );
      },
    });

    await expect(
      provider.createWorktree({ project: managedProject, branch: "feature" }),
    ).resolves.toMatchObject({
      id: expect.stringMatching(/^wt_web_feature_[a-f0-9]{10}$/),
      path: "/tmp/home/.worktrees/web/feature",
    });
    expect(calls[1]?.env).toEqual({
      WORKTRUNK_WORKTREE_PATH: "/tmp/home/.worktrees/web/feature",
    });
  });

  it("uses collision-resistant managed paths for lossy branch names", async () => {
    const calls: ExternalCommandInput[] = [];
    const managedProject = {
      ...project,
      worktrunk: {
        ...project.worktrunk,
        managedRoot: ".worktrees",
        includeMain: false,
        includeExternal: false,
      },
    };
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        return result(
          input,
          JSON.stringify([{ path: input.env?.WORKTRUNK_WORKTREE_PATH, branch: "feature/auth" }]),
        );
      },
    });

    await expect(
      provider.createWorktree({ project: managedProject, branch: "feature/auth" }),
    ).resolves.toMatchObject({
      id: expect.stringMatching(/^wt_web_feature-auth-[a-f0-9]{10}_[a-f0-9]{10}$/),
      path: expect.stringMatching(/^\/tmp\/station\/web\/\.worktrees\/feature-auth-[a-f0-9]{10}$/),
    });
    expect(calls[1]?.env).toEqual({
      WORKTRUNK_WORKTREE_PATH: expect.stringMatching(
        /^\/tmp\/station\/web\/\.worktrees\/feature-auth-[a-f0-9]{10}$/,
      ),
    });
  });

  it("creates and removes worktrees using Worktrunk lifecycle commands", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "switch") {
          return result(
            input,
            JSON.stringify([{ path: "/tmp/station/web/feature", branch: "feature" }]),
          );
        }
        if (input.args?.[0] === "remove") {
          return result(input, "{}");
        }
        return result(
          input,
          JSON.stringify([{ path: "/tmp/station/web/feature", branch: "feature" }]),
        );
      },
    });

    const created = await provider.createWorktree({ project, branch: "feature" });
    const removed = await provider.removeWorktree({
      project,
      worktreeId: created.id,
      expectedPath: created.path,
      expectedBranch: created.branch,
      expectedRegistrationIdentity: `git-registration:${created.path}`,
      force: true,
    });

    expect(removed).toEqual({ worktreeId: created.id, removed: true });
    expect(calls.map((call) => call.args)).toEqual([
      ["switch", "--create", "feature", "--base", "main", "--no-cd", "--format=json"],
      ["list", "--format=json"],
      ["-C", "/tmp/station/web/feature", "remove", "--force", "--force-delete", "--format=json"],
    ]);
  });

  it("retains a created worktree when its Git registration cannot be verified", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new WorktrunkProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      resolveRegistrationIdentity: async () => undefined,
      runner: async (input) => {
        calls.push(input);
        return result(
          input,
          JSON.stringify([{ path: "/tmp/station/web/feature", branch: "feature" }]),
        );
      },
    });

    await expect(provider.createWorktree({ project, branch: "feature" })).rejects.toMatchObject({
      code: "WORKTRUNK_WORKTREE_CHANGED",
      message: "Worktrunk created the worktree but Station could not verify its Git registration.",
      hint: "Inspect the created worktree and refresh before trying to manage it in Station.",
    });
    expect(calls.map((call) => call.args)).toEqual([
      ["switch", "--create", "feature", "--base", "main", "--no-cd", "--format=json"],
    ]);
  });

  it("removes a selected shared-branch worktree without deleting the shared branch", async () => {
    const calls: ExternalCommandInput[] = [];
    const linkedPath = "/tmp/station/web/duplicate-linked";
    const sharedProject = {
      ...project,
      worktrunk: {
        ...project.worktrunk,
        includeMain: false,
      },
    };
    let listCalls = 0;
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.includes("list")) {
          listCalls += 1;
          return result(
            input,
            JSON.stringify([
              { path: project.root, branch: listCalls === 1 ? "main" : "duplicate" },
              { path: linkedPath, branch: "duplicate" },
            ]),
          );
        }
        return result(input, "{}");
      },
    });

    const worktrees = await provider.listWorktrees(sharedProject);
    const selected = worktrees.find((worktree) => worktree.path === linkedPath);
    expect(selected).toBeDefined();
    if (selected === undefined) throw new Error("Expected the linked worktree to be listed.");

    await provider.removeWorktree({
      project: sharedProject,
      worktreeId: selected.id,
      expectedPath: selected.path,
      expectedBranch: selected.branch,
      expectedRegistrationIdentity: `git-registration:${selected.path}`,
      force: true,
    });

    expect(calls.map((call) => call.args)).toEqual([
      ["list", "--format=json"],
      ["list", "--format=json"],
      ["-C", linkedPath, "remove", "--no-hooks", "--force", "--no-delete-branch", "--format=json"],
    ]);
  });

  it("does not remove a worktree missing from the refreshed list", async () => {
    const calls: ExternalCommandInput[] = [];
    const linkedPath = "/tmp/station/web/feature";
    let listCalls = 0;
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.includes("list")) {
          listCalls += 1;
          return result(
            input,
            listCalls === 1 ? JSON.stringify([{ path: linkedPath, branch: "feature" }]) : "[]",
          );
        }
        return result(input, "{}");
      },
    });

    const [selected] = await provider.listWorktrees(project);
    expect(selected).toBeDefined();
    if (selected === undefined) throw new Error("Expected the linked worktree to be listed.");

    await expect(
      provider.removeWorktree({
        project,
        worktreeId: selected.id,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: `git-registration:${selected.path}`,
      }),
    ).rejects.toMatchObject({ code: "WORKTRUNK_WORKTREE_NOT_FOUND" });
    expect(calls.map((call) => call.args)).toEqual([
      ["list", "--format=json"],
      ["list", "--format=json"],
    ]);
  });

  it("does not remove a selected worktree whose branch changed before mutation", async () => {
    const calls: ExternalCommandInput[] = [];
    const linkedPath = "/tmp/station/web/feature";
    let listCalls = 0;
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.includes("list")) {
          listCalls += 1;
          return result(
            input,
            JSON.stringify([
              {
                path: linkedPath,
                branch: listCalls === 1 ? "feature" : "main",
                is_main: false,
              },
            ]),
          );
        }
        return result(input, "{}");
      },
    });

    const [selected] = await provider.listWorktrees(project);
    expect(selected).toBeDefined();
    if (selected === undefined) throw new Error("Expected the linked worktree to be listed.");

    await expect(
      provider.removeWorktree({
        project,
        worktreeId: selected.id,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: `git-registration:${selected.path}`,
      }),
    ).rejects.toMatchObject({ code: "WORKTRUNK_WORKTREE_CHANGED" });
    expect(calls.map((call) => call.args)).toEqual([
      ["list", "--format=json"],
      ["list", "--format=json"],
    ]);
  });

  it("seeds the new worktree's working tree from a source path when seedFrom is set", async () => {
    const root = await mkdtemp(join(tmpdir(), "wt-seed-"));
    const srcPath = join(root, "source");
    const tgtPath = join(root, "feature");
    const git = (cwd: string, ...args: string[]) =>
      nodeExternalCommandRunner({
        command: "git",
        args,
        cwd,
        unsetEnv: gitLocalEnvironmentVariables,
      });

    // Real source repo: a base commit, then a dirty working tree spanning every state
    // the seed must carry (unstaged mod, staged mod, tracked deletion, untracked + nested).
    await mkdir(srcPath, { recursive: true });
    await git(srcPath, "init", "-q");
    const commonDir = (
      await git(srcPath, "rev-parse", "--path-format=absolute", "--git-common-dir")
    ).stdout.trim();
    const physicalRoot = await realpath(root);
    expect(commonDir.startsWith(physicalRoot)).toBe(true);
    await writeFile(join(srcPath, "tracked.txt"), "base\n");
    await writeFile(join(srcPath, "staged.txt"), "base\n");
    await writeFile(join(srcPath, "deleteme.txt"), "bye\n");
    await git(srcPath, "add", ".");
    await git(
      srcPath,
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "init",
    );
    await writeFile(join(srcPath, "tracked.txt"), "base\nunstaged\n");
    await writeFile(join(srcPath, "staged.txt"), "base\nstaged\n");
    await git(srcPath, "add", "staged.txt");
    await rm(join(srcPath, "deleteme.txt"));
    await mkdir(join(srcPath, "nested"), { recursive: true });
    await writeFile(join(srcPath, "untracked.txt"), "untracked-contents");
    await writeFile(join(srcPath, "nested", "deep.txt"), "deep-contents");
    const srcStatusBefore = (await git(srcPath, "status", "--porcelain")).stdout;

    const calls: ExternalCommandInput[] = [];
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.command === "wt" && input.args?.[0] === "switch") {
          // Stand in for `wt switch --create`: a real linked worktree at the source HEAD
          // so the seed can materialize the snapshot tree into it.
          await git(srcPath, "worktree", "add", "-q", tgtPath, "-b", "feature", "HEAD");
          return result(input, JSON.stringify([{ path: tgtPath, branch: "feature" }]));
        }
        if (input.command === "wt" && input.args?.[0] === "list") {
          return result(input, JSON.stringify([{ path: tgtPath, branch: "feature", dirty: true }]));
        }
        // Run the seed's git plumbing for real against the temp repos.
        if (input.command === "git") {
          return nodeExternalCommandRunner(input);
        }
        return result(input, "");
      },
    });

    try {
      const created = await provider.createWorktree({
        project,
        branch: "feature",
        base: "source-branch",
        seedFrom: { path: srcPath },
      });

      // The post-seed re-list surfaces the copied dirty state on the returned observation.
      expect(created).toMatchObject({ branch: "feature", dirty: true });

      // The full working tree really lands in the target (git did the materialization):
      // unstaged mod, staged mod, untracked (incl. nested), and the tracked deletion.
      expect(await readFile(join(tgtPath, "tracked.txt"), "utf8")).toBe("base\nunstaged\n");
      expect(await readFile(join(tgtPath, "staged.txt"), "utf8")).toBe("base\nstaged\n");
      expect(await readFile(join(tgtPath, "untracked.txt"), "utf8")).toBe("untracked-contents");
      expect(await readFile(join(tgtPath, "nested", "deep.txt"), "utf8")).toBe("deep-contents");
      await expect(readFile(join(tgtPath, "deleteme.txt"))).rejects.toThrow();

      // The seed is read-only: the source worktree is byte-for-byte unchanged, so a live
      // agent running there is never disturbed.
      expect((await git(srcPath, "status", "--porcelain")).stdout).toBe(srcStatusBefore);

      // The seed is a temp-index snapshot — read-tree HEAD -> add -A -> write-tree against
      // a throwaway index in the source, materialized via read-tree -m -u in the target.
      const seedCalls = calls.filter((call) => call.command === "git");
      expect(seedCalls).toHaveLength(4);
      expect(seedCalls.slice(0, 3).map((call) => call.args)).toEqual([
        ["-C", srcPath, "read-tree", "HEAD"],
        ["-C", srcPath, "add", "-A"],
        ["-C", srcPath, "write-tree"],
      ]);
      expect(
        seedCalls.slice(0, 3).every((call) => typeof call.env?.GIT_INDEX_FILE === "string"),
      ).toBe(true);
      expect(seedCalls[3]?.args?.slice(0, 5)).toEqual(["-C", tgtPath, "read-tree", "-m", "-u"]);
      expect(seedCalls[3]?.args?.[5]).toMatch(/^[0-9a-f]{40}$/);

      // The fork's base is pinned to the source branch so the seed materializes cleanly.
      const switchCall = calls.find((c) => c.command === "wt" && c.args?.[0] === "switch");
      expect(switchCall?.args).toContain("source-branch");
    } finally {
      await git(srcPath, "worktree", "remove", "--force", tgtPath).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips Worktrunk hooks for automated mutations when lifecycle hooks are disabled", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "switch") {
          return result(
            input,
            JSON.stringify([{ path: "/tmp/station/web/feature", branch: "feature" }]),
          );
        }
        if (input.args?.[0] === "remove") {
          return result(input, "{}");
        }
        return result(
          input,
          JSON.stringify([{ path: "/tmp/station/web/feature", branch: "feature" }]),
        );
      },
    });

    const created = await provider.createWorktree({ project, branch: "feature" });
    await provider.removeWorktree({
      project,
      worktreeId: created.id,
      expectedPath: created.path,
      expectedBranch: created.branch,
      expectedRegistrationIdentity: `git-registration:${created.path}`,
    });

    expect(calls.map((call) => call.args)).toEqual([
      ["switch", "--no-hooks", "--create", "feature", "--base", "main", "--no-cd", "--format=json"],
      ["list", "--format=json"],
      ["-C", "/tmp/station/web/feature", "remove", "--no-hooks", "--format=json"],
    ]);
  });

  it("uses native Git for an explicitly hooks-disabled managed create and preserves discovery ID", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "station-wt-native-create-")));
    const managedRoot = join(root, "managed");
    const calls: ExternalCommandInput[] = [];
    let targetPath = "";
    const managedProject: ProviderProjectConfig = {
      ...project,
      root,
      worktrunk: { ...project.worktrunk, managedRoot },
    };
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.command === "git" && input.args?.includes("worktree")) {
          targetPath = input.args.at(-2) ?? "";
          return result(input, "");
        }
        if (input.command === "git" && input.args?.includes("rev-parse")) {
          return result(input, `${targetPath}\nfeature\n`);
        }
        return result(input, JSON.stringify([{ path: targetPath, branch: "feature" }]));
      },
    });

    try {
      const created = await provider.createWorktree({ project: managedProject, branch: "feature" });
      expect(created).toMatchObject({
        provider: "worktrunk",
        projectId: "web",
        branch: "feature",
        path: targetPath,
        registrationIdentity: `git-registration:${targetPath}`,
        source: "station",
        state: "exists",
      });
      expect(calls.map((call) => call.command)).toEqual(["git", "git"]);
      expect(calls[0]?.args).toEqual([
        "-C",
        root,
        "worktree",
        "add",
        "--quiet",
        "-b",
        "feature",
        targetPath,
        "main",
      ]);

      const [discovered] = await provider.listWorktrees(managedProject);
      expect(discovered?.id).toBe(created.id);
      expect(discovered?.path).toBe(targetPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps hooks-enabled managed creates on Worktrunk", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "station-wt-hooks-create-")));
    const targetPath = join(root, "managed", "feature");
    const calls: ExternalCommandInput[] = [];
    const managedProject: ProviderProjectConfig = {
      ...project,
      root,
      worktrunk: { ...project.worktrunk, managedRoot: join(root, "managed") },
    };
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: true,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        return result(input, JSON.stringify([{ path: targetPath, branch: "feature" }]));
      },
    });

    try {
      await expect(
        provider.createWorktree({ project: managedProject, branch: "feature" }),
      ).resolves.toMatchObject({ path: targetPath, branch: "feature" });
      expect(calls.some((call) => call.command === "git" && call.args?.includes("worktree"))).toBe(
        false,
      );
      expect(
        calls.some(
          (call) =>
            call.command === "wt" && call.args?.includes("switch") && call.args.includes("--yes"),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps hooks-disabled paths outside the managed root on Worktrunk", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "station-wt-external-create-")));
    const targetPath = join(root, "external", "feature");
    const calls: ExternalCommandInput[] = [];
    const managedProject: ProviderProjectConfig = {
      ...project,
      root,
      worktrunk: { ...project.worktrunk, managedRoot: join(root, "managed") },
    };
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        return result(input, JSON.stringify([{ path: targetPath, branch: "feature" }]));
      },
    });

    try {
      await expect(
        provider.createWorktree({
          project: managedProject,
          branch: "feature",
          path: targetPath,
        }),
      ).resolves.toMatchObject({ path: targetPath, branch: "feature" });
      expect(calls.some((call) => call.command === "git" && call.args?.includes("worktree"))).toBe(
        false,
      );
      expect(
        calls.some(
          (call) =>
            call.command === "wt" &&
            call.args?.includes("switch") &&
            call.args.includes("--no-hooks"),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("seeds a native managed create before refreshing provider evidence", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "station-wt-native-seed-")));
    const targetPath = join(root, "managed", "feature");
    const sourcePath = join(root, "source");
    const calls: ExternalCommandInput[] = [];
    const managedProject: ProviderProjectConfig = {
      ...project,
      root,
      worktrunk: { ...project.worktrunk, managedRoot: join(root, "managed") },
    };
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.command === "wt") {
          return result(
            input,
            JSON.stringify([{ path: targetPath, branch: "feature", dirty: true }]),
          );
        }
        if (input.args?.includes("rev-parse")) {
          return result(input, `${targetPath}\nfeature\n`);
        }
        if (input.args?.includes("write-tree")) {
          return result(input, "0123456789abcdef0123456789abcdef01234567\n");
        }
        return result(input, "");
      },
    });

    try {
      await expect(
        provider.createWorktree({
          project: managedProject,
          branch: "feature",
          seedFrom: { path: sourcePath },
        }),
      ).resolves.toMatchObject({ path: targetPath, branch: "feature", dirty: true });
      expect(calls.map((call) => call.args)).toEqual([
        ["-C", root, "worktree", "add", "--quiet", "-b", "feature", targetPath, "main"],
        [
          "-C",
          targetPath,
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--abbrev-ref=strict",
          "HEAD",
        ],
        ["-C", sourcePath, "read-tree", "HEAD"],
        ["-C", sourcePath, "add", "-A"],
        ["-C", sourcePath, "write-tree"],
        ["-C", targetPath, "read-tree", "-m", "-u", "0123456789abcdef0123456789abcdef01234567"],
        ["list", "--format=json"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects native create evidence whose verified branch does not match", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "station-wt-native-mismatch-")));
    const managedProject: ProviderProjectConfig = {
      ...project,
      root,
      worktrunk: { ...project.worktrunk, managedRoot: join(root, "managed") },
    };
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) =>
        result(input, input.args?.includes("rev-parse") ? `${input.cwd}\nwrong-branch\n` : ""),
    });

    try {
      await expect(
        provider.createWorktree({ project: managedProject, branch: "feature" }),
      ).rejects.toMatchObject({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        message: "Git created the worktree but Station could not verify its exact path and branch.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps base-less managed creates on Worktrunk", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "station-wt-native-baseless-")));
    const calls: ExternalCommandInput[] = [];
    const managedProject: ProviderProjectConfig = {
      ...project,
      root,
      worktrunk: { enabled: true, managedRoot: join(root, "managed") },
    };
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        return result(
          input,
          JSON.stringify([{ path: join(root, "managed", "feature"), branch: "feature" }]),
        );
      },
    });

    try {
      await provider.createWorktree({ project: managedProject, branch: "feature" });
      expect(calls.some((call) => call.command === "git")).toBe(false);
      expect(calls.some((call) => call.args?.includes("switch"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies duplicate branches from native Git creation", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "station-wt-native-duplicate-")));
    const managedProject: ProviderProjectConfig = {
      ...project,
      root,
      worktrunk: { ...project.worktrunk, managedRoot: join(root, "managed") },
    };
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async () => {
        throw Object.assign(new Error("git failed"), {
          code: 128,
          stderr: "fatal: a branch named 'feature' already exists",
        });
      },
    });

    try {
      await expect(
        provider.createWorktree({ project: managedProject, branch: "feature" }),
      ).rejects.toMatchObject({
        code: "WORKTRUNK_BRANCH_EXISTS",
        diagnosticDetails: [
          expect.objectContaining({
            type: "external_command",
            operation: "provider.worktrunk.native-create",
            command: expect.stringContaining("git -C"),
            exitCode: 128,
          }),
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pre-approves Worktrunk hook prompts for automated mutations when lifecycle hooks are enabled", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: true,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "switch") {
          return result(
            input,
            JSON.stringify([{ path: "/tmp/station/web/feature", branch: "feature" }]),
          );
        }
        if (input.args?.[0] === "remove") {
          return result(input, "{}");
        }
        return result(
          input,
          JSON.stringify([{ path: "/tmp/station/web/feature", branch: "feature" }]),
        );
      },
    });

    const created = await provider.createWorktree({ project, branch: "feature" });
    await provider.removeWorktree({
      project,
      worktreeId: created.id,
      expectedPath: created.path,
      expectedBranch: created.branch,
      expectedRegistrationIdentity: `git-registration:${created.path}`,
    });

    expect(calls.map((call) => call.args)).toEqual([
      ["switch", "--yes", "--create", "feature", "--base", "main", "--no-cd", "--format=json"],
      ["list", "--format=json"],
      ["-C", "/tmp/station/web/feature", "remove", "--yes", "--format=json"],
    ]);
  });

  it("classifies duplicate branch failures and preserves external command diagnostics", async () => {
    const managedProject = {
      ...project,
      worktrunk: {
        ...project.worktrunk,
        managedRoot: "/tmp/home/.worktrees/web",
      },
    };
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        if (input.args?.[0] === "list") {
          return result(
            input,
            JSON.stringify([
              {
                path: "/tmp/station/web",
                branch: "main",
                is_main: true,
                repo: { host: "github.com", owner: "acme", name: "web" },
              },
            ]),
          );
        }
        throw Object.assign(new Error("wt failed"), {
          code: 128,
          stderr: "fatal: a branch named 'feature' already exists",
          stdout: "checked refs",
        });
      },
    });

    await expect(
      provider.createWorktree({ project: managedProject, branch: "feature" }),
    ).rejects.toMatchObject({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_BRANCH_EXISTS",
      hint: expect.stringContaining("different branch"),
      diagnosticDetails: [
        expect.objectContaining({
          type: "external_command",
          provider: "worktrunk",
          operation: "provider.worktrunk.switch",
          command:
            'wt --config-set projects."github.com/acme/web".worktree-path="/tmp/home/.worktrees/web/feature" switch --create feature --base main --no-cd --format=json',
          cwd: "/tmp/station/web",
          exitCode: 128,
          stderrSnippet: "fatal: a branch named 'feature' already exists",
        }),
      ],
    });
  });

  it("classifies duplicate worktree path failures", async () => {
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async () => {
        throw Object.assign(new Error("wt failed"), {
          code: 128,
          stderr: "destination path '/tmp/station/web/feature' already exists",
        });
      },
    });

    await expect(provider.createWorktree({ project, branch: "feature" })).rejects.toMatchObject({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_WORKTREE_EXISTS",
      hint: expect.stringContaining("stale worktree"),
    });
  });

  it("classifies unsupported automation flag failures", async () => {
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async () => {
        throw Object.assign(new Error("wt failed"), {
          code: 2,
          stderr: "error: unexpected argument '--no-hooks' found",
        });
      },
    });

    await expect(provider.createWorktree({ project, branch: "feature" })).rejects.toMatchObject({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_UNSUPPORTED_FLAG",
      hint: expect.stringContaining("Upgrade Worktrunk"),
    });
  });

  it("classifies hook prompt approval failures", async () => {
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async () => {
        throw Object.assign(new Error("wt failed"), {
          code: 1,
          stderr: "hook confirmation required; pass --yes to continue",
        });
      },
    });

    await expect(provider.createWorktree({ project, branch: "feature" })).rejects.toMatchObject({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_HOOK_APPROVAL_REQUIRED",
      hint: expect.stringContaining("use_lifecycle_hooks"),
    });
  });

  it("explains an unborn main without affecting a healthy project", async () => {
    const root = await mkdtemp(join(tmpdir(), "wt-unborn-"));
    const unbornRoot = join(root, "unborn");
    const healthyRoot = join(root, "healthy");
    const healthyWorktreePath = join(healthyRoot, "feature");
    const git = (cwd: string, ...args: string[]) =>
      nodeExternalCommandRunner({
        command: "git",
        args,
        cwd,
        unsetEnv: gitLocalEnvironmentVariables,
      });
    await mkdir(unbornRoot, { recursive: true });
    await mkdir(healthyRoot, { recursive: true });
    await git(unbornRoot, "init", "-q", "-b", "main");
    await git(healthyRoot, "init", "-q", "-b", "main");
    await git(
      healthyRoot,
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    );
    const unbornProject: ProviderProjectConfig = {
      ...project,
      id: "unborn",
      label: "unborn",
      root: unbornRoot,
    };
    const healthyProject: ProviderProjectConfig = {
      ...project,
      id: "healthy",
      label: "healthy",
      root: healthyRoot,
    };
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        if (input.cwd === unbornProject.root) {
          throw Object.assign(new Error("wt failed"), {
            code: 1,
            stderr: input.args?.includes("feature-color")
              ? "\u001b[31m✗ No branch, tag, or commit named \u001b[1mmain\u001b[22m\u001b[0m"
              : "✗ No branch, tag, or commit named main",
          });
        }
        return result(
          input,
          JSON.stringify([{ path: healthyWorktreePath, branch: "feature", commit: "9dd15ba" }]),
        );
      },
    });

    try {
      await expect(git(unbornRoot, "rev-parse", "--verify", "HEAD^{commit}")).rejects.toThrow();
      await expect(
        git(healthyRoot, "rev-parse", "--verify", "HEAD^{commit}"),
      ).resolves.toMatchObject({ stdout: expect.stringMatching(/^[0-9a-f]+\n$/) });
      await expect(git(healthyRoot, "config", "--local", "--list")).resolves.toMatchObject({
        stdout: expect.not.stringContaining("user."),
      });

      await expect(
        provider.createWorktree({ project: unbornProject, branch: "feature" }),
      ).rejects.toMatchObject({
        tag: "WorktreeProviderError",
        code: "WORKTRUNK_BASE_MISSING",
        message: "Base `main` does not resolve to a commit.",
        hint: "Create its first commit or choose another base.",
        diagnosticDetails: [
          expect.objectContaining({
            operation: "provider.worktrunk.switch",
            cwd: unbornProject.root,
            exitCode: 1,
            stderrSnippet: "✗ No branch, tag, or commit named main",
          }),
        ],
      });
      await expect(
        provider.createWorktree({ project: unbornProject, branch: "feature-color" }),
      ).rejects.toMatchObject({
        code: "WORKTRUNK_BASE_MISSING",
        message: "Base `main` does not resolve to a commit.",
      });
      await expect(
        provider.createWorktree({
          project: unbornProject,
          branch: "feature-release",
          base: "release",
        }),
      ).rejects.toMatchObject({
        code: "WORKTRUNK_COMMAND_FAILED",
        message: "Worktrunk failed to create a worktree.",
      });
      await expect(
        provider.createWorktree({ project: healthyProject, branch: "feature" }),
      ).resolves.toMatchObject({
        projectId: healthyProject.id,
        branch: "feature",
        path: healthyWorktreePath,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies missing base failures", async () => {
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async () => {
        throw Object.assign(new Error("wt failed"), {
          code: 128,
          stderr: "fatal: invalid reference: origin/main",
        });
      },
    });

    await expect(provider.createWorktree({ project, branch: "feature" })).rejects.toMatchObject({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_BASE_MISSING",
      hint: expect.stringContaining("base branch"),
    });
  });

  it("reports supported Worktrunk automation mode in doctor checks", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        return result(input, "Usage: wt switch --no-hooks --yes\n");
      },
    });

    await expect(provider.doctorChecks()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "worktrunk-automation",
          status: "ok",
          message: expect.stringContaining("--no-hooks"),
        }),
        expect.objectContaining({
          name: "worktrunk-hooks",
          status: "ok",
          message: expect.stringContaining("skip hooks"),
        }),
      ]),
    );
    expect(calls.map((call) => call.args)).toEqual([
      ["switch", "--help"],
      ["remove", "--help"],
    ]);
  });

  it("refuses corrupted checkout roots before invoking Worktrunk", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-bare-root-"));
    await mkdir(join(root, ".git"));
    const bareProject = { ...project, root };
    const calls: ExternalCommandInput[] = [];
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        return result(input, input.command === "git" ? "true\n" : "[]");
      },
    });

    await expect(provider.listWorktrees(bareProject)).rejects.toMatchObject({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_PROJECT_ROOT_BARE",
      projectId: "web",
      hint: expect.stringContaining("config --local core.bare false"),
    });
    await expect(
      provider.createWorktree({ project: bareProject, branch: "feature" }),
    ).rejects.toMatchObject({
      code: "WORKTRUNK_PROJECT_ROOT_BARE",
      projectId: "web",
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.command === "git")).toBe(true);

    calls.length = 0;
    const checks = await provider.doctorChecks({ projects: [bareProject] });
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "worktrunk-project-root-web",
          status: "warn",
          message: expect.stringContaining("config --show-origin --get core.bare"),
          error: expect.objectContaining({
            code: "WORKTRUNK_PROJECT_ROOT_BARE",
            projectId: "web",
            hint: expect.stringContaining("config --local core.bare false"),
          }),
        }),
      ]),
    );
    expect(calls).toHaveLength(1);
    expect(calls.every((call) => call.command === "git")).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("rechecks the configured root before removing a previously listed worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-remove-bare-root-"));
    await mkdir(join(root, ".git"));
    const guardedProject = { ...project, root };
    const calls: ExternalCommandInput[] = [];
    let configuredBare = false;
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        return result(
          input,
          input.command === "git"
            ? `${configuredBare}\n`
            : JSON.stringify([{ path: join(root, "feature"), branch: "feature" }]),
        );
      },
    });
    const listed = await provider.listWorktrees(guardedProject);
    const selected = listed[0];
    if (selected?.registrationIdentity === undefined) {
      throw new Error("worktree fixture missing registration identity");
    }
    calls.length = 0;
    configuredBare = true;

    await expect(
      provider.removeWorktree({
        project: guardedProject,
        worktreeId: selected.id,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: selected.registrationIdentity,
      }),
    ).rejects.toMatchObject({
      code: "WORKTRUNK_PROJECT_ROOT_BARE",
      projectId: "web",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("git");
    await rm(root, { recursive: true, force: true });
  });

  it("warns about missing registrations with safe prune commands", async () => {
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) =>
        result(
          input,
          input.args?.includes("list")
            ? JSON.stringify([
                {
                  path: "/tmp/station/web/missing feature",
                  branch: "missing-feature",
                  state: "prunable",
                },
              ])
            : "--no-hooks",
        ),
    });

    const checks = await provider.doctorChecks({ projects: [project] });

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "worktrunk-stale-registrations-web",
          status: "warn",
          message: expect.stringContaining(
            "git -C '/tmp/station/web' worktree prune --dry-run --verbose",
          ),
        }),
      ]),
    );
  });

  it("returns completed stale warnings and aborts slow scans before the provider deadline", async () => {
    const slowProject: ProviderProjectConfig = {
      ...project,
      id: "api",
      label: "api",
      root: "/tmp/station/api",
    };
    let slowScanAborted = false;
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        if (input.args?.includes("list") && input.cwd === slowProject.root) {
          return new Promise((_, reject) => {
            const abort = () => {
              slowScanAborted = true;
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            };
            if (input.signal?.aborted === true) {
              abort();
            } else {
              input.signal?.addEventListener("abort", abort, { once: true });
            }
          });
        }
        return result(
          input,
          input.args?.includes("list")
            ? JSON.stringify([
                {
                  path: "/tmp/station/web/missing-feature",
                  branch: "missing-feature",
                  worktree: { state: "prunable" },
                },
              ])
            : "--no-hooks",
        );
      },
    });

    const checks = await provider.doctorChecks({
      projects: [project, slowProject],
      timeoutMs: 50,
    });

    expect(slowScanAborted).toBe(true);
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "worktrunk-stale-registrations-web",
          status: "warn",
        }),
        expect.objectContaining({
          name: "worktrunk-stale-registrations-scan",
          status: "warn",
          message: expect.stringContaining("1 of 2 project(s)"),
        }),
        expect.objectContaining({
          name: "worktrunk-hooks",
          status: "ok",
        }),
      ]),
    );
  });

  it("bounds concurrent stale-registration scans", async () => {
    const projects: ProviderProjectConfig[] = Array.from({ length: 6 }, (_, index) => ({
      ...project,
      id: `project-${index}`,
      label: `project-${index}`,
      root: `/tmp/station/project-${index}`,
    }));
    let activeScans = 0;
    let maxActiveScans = 0;
    let completedScans = 0;
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        if (input.args?.includes("list")) {
          activeScans += 1;
          maxActiveScans = Math.max(maxActiveScans, activeScans);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeScans -= 1;
          completedScans += 1;
          return result(input, "[]");
        }
        return result(input, "--no-hooks");
      },
    });

    const checks = await provider.doctorChecks({ projects, timeoutMs: 500 });

    expect(completedScans).toBe(projects.length);
    expect(maxActiveScans).toBe(4);
    expect(checks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "worktrunk-stale-registrations-scan" }),
      ]),
    );
  });

  it("reports unsupported configured Worktrunk automation flags in doctor checks", async () => {
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: true,
      clock: { now: () => new Date(now) },
      runner: async (input) => result(input, "Usage: wt switch\n"),
    });

    await expect(provider.doctorChecks()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "worktrunk-automation",
          status: "error",
          error: expect.objectContaining({
            code: "WORKTRUNK_AUTOMATION_FLAG_UNSUPPORTED",
            provider: "worktrunk",
          }),
        }),
      ]),
    );
  });

  it("reports unavailable health when the wt binary is missing", async () => {
    const provider = testProvider({
      command: "missing-wt",
      clock: { now: () => new Date(now) },
      runner: async () => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    });

    await expect(provider.health()).resolves.toMatchObject({
      status: "unavailable",
      lastError: {
        tag: "ProviderUnavailableError",
        code: "WORKTRUNK_UNAVAILABLE",
        hint: expect.stringContaining("brew install worktrunk"),
      },
      diagnostics: {
        attemptedCommand: "missing-wt",
        installHint: expect.stringContaining("brew install worktrunk"),
      },
    });
  });

  it("aborts Worktrunk subprocesses on timeout with a typed provider error", async () => {
    let aborted = false;
    const provider = testProvider({
      command: "wt",
      timeoutMs: 5,
      clock: { now: () => new Date(now) },
      runner: async (input) =>
        new Promise((_, reject) => {
          input.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
          });
        }),
    });

    await expect(provider.listWorktrees(project)).rejects.toMatchObject({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_TIMEOUT",
    });
    expect(aborted).toBe(true);
  });

  it("aborts a hung Worktrunk remove and maps it to WORKTRUNK_TIMEOUT", async () => {
    let aborted = false;
    let removeArgs: string[] | undefined;
    const provider = testProvider({
      command: "wt",
      timeoutMs: 5,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        if (input.command === "wt" && input.args?.includes("remove")) {
          removeArgs = input.args;
          return new Promise((_, reject) => {
            const abort = () => {
              aborted = true;
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }),
              );
            };
            if (input.signal?.aborted === true) {
              abort();
            } else {
              input.signal?.addEventListener("abort", abort, { once: true });
            }
          });
        }
        return result(
          input,
          JSON.stringify([{ path: "/tmp/station/web/feature", branch: "feature" }]),
        );
      },
    });

    const [selected] = await provider.listWorktrees(project);
    expect(selected).toBeDefined();
    if (selected === undefined) throw new Error("Expected the worktree to be listed.");

    await expect(
      provider.removeWorktree({
        project,
        worktreeId: selected.id,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: `git-registration:${selected.path}`,
      }),
    ).rejects.toMatchObject({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_TIMEOUT",
    });
    expect(removeArgs).toEqual(["-C", "/tmp/station/web/feature", "remove", "--format=json"]);
    expect(aborted).toBe(true);
  });

  it("maps invalid create output to a WorktrunkProviderError", async () => {
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => result(input, "{not-json"),
    });

    await expect(provider.createWorktree({ project, branch: "feature" })).rejects.toMatchObject({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_INVALID_OUTPUT",
    });
  });

  it("retries safe reads but not create commands", async () => {
    let listCalls = 0;
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        if (input.args?.includes("list")) {
          listCalls += 1;
          if (listCalls === 1) {
            throw Object.assign(new Error("temporary"), { code: "EAGAIN" });
          }
          return result(
            input,
            JSON.stringify([{ path: "/tmp/station/web/feature", branch: "feature" }]),
          );
        }
        if (input.args?.includes("switch")) {
          throw Object.assign(new Error("temporary"), { code: "EAGAIN" });
        }
        return result(input, "wt 0.0.0");
      },
    });

    await expect(provider.listWorktrees(project)).resolves.toHaveLength(1);
    await expect(provider.createWorktree({ project, branch: "feature" })).rejects.toMatchObject({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_COMMAND_FAILED",
    });
    expect(listCalls).toBe(2);
  });
});

function result(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}
