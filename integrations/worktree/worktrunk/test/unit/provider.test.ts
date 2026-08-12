import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

function gitWorktreePorcelain(
  worktrees: readonly { path: string; branch: string; headSha?: string; detached?: boolean }[],
): string {
  return worktrees
    .map((worktree, index) => {
      const headSha = worktree.headSha ?? (index + 1).toString(16).repeat(40);
      const branch = worktree.detached ? "detached" : `branch refs/heads/${worktree.branch}`;
      return `worktree ${worktree.path}\0HEAD ${headSha}\0${branch}\0\0`;
    })
    .join("");
}

function gitRemovalProbeResult(
  input: ExternalCommandInput,
  options: {
    targetPath: string;
    targetBranch: string;
    targetHeadSha?: string;
    targetCommonDir?: string;
    projectCommonDir?: string;
    status?: string;
    detached?: boolean;
  },
): ExternalCommandResult | undefined {
  if (input.command !== "git") return undefined;
  const args = input.args ?? [];
  const projectCommonDir = options.projectCommonDir ?? join(project.root, ".git");
  if (args.includes("--show-toplevel")) {
    return result(
      input,
      [
        options.targetPath,
        options.targetCommonDir ?? projectCommonDir,
        options.targetHeadSha ?? "2".repeat(40),
        options.detached ? "HEAD" : `refs/heads/${options.targetBranch}`,
        "",
      ].join("\n"),
    );
  }
  if (args.includes("rev-parse") && args.includes("--git-common-dir")) {
    return result(input, `${projectCommonDir}\n`);
  }
  if (args.includes("status")) {
    return result(input, options.status ?? "");
  }
  return undefined;
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
    const linkedPath = "/tmp/station/web/feature";
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: linkedPath,
          targetBranch: "feature",
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "main" },
              { path: linkedPath, branch: "feature" },
            ]),
          );
        }
        if (input.args?.[0] === "switch") {
          return result(input, JSON.stringify([{ path: linkedPath, branch: "feature" }]));
        }
        if (input.args?.[0] === "remove") {
          return result(input, "{}");
        }
        return result(input, JSON.stringify([{ path: linkedPath, branch: "feature" }]));
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
    expect(calls.filter((call) => call.command === "wt").map((call) => call.args)).toEqual([
      ["switch", "--create", "feature", "--base", "main", "--no-cd", "--format=json"],
      ["-C", "/tmp/station/web/feature", "remove", "--force", "--force-delete", "--format=json"],
    ]);
    expect(calls.filter((call) => call.command === "git").map((call) => call.args)).toEqual([
      ["-C", project.root, "worktree", "list", "--porcelain", "-z"],
      [
        "-C",
        linkedPath,
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
        "HEAD",
        "--symbolic-full-name",
        "HEAD",
      ],
      ["-C", project.root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["-C", project.root, "worktree", "list", "--porcelain", "-z"],
      [
        "-C",
        linkedPath,
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
        "HEAD",
        "--symbolic-full-name",
        "HEAD",
      ],
    ]);
    expect(calls.some((call) => call.command === "git" && call.args?.includes("status"))).toBe(
      false,
    );
  });

  it("removes a known target without prior Worktrunk inventory", async () => {
    const calls: ExternalCommandInput[] = [];
    const linkedPath = "/tmp/station/web/feature";
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: linkedPath,
          targetBranch: "feature",
        });
        if (probe !== undefined) return probe;
        if (input.command === "wt" && input.args?.includes("list")) {
          throw new Error("Worktrunk inventory is unavailable.");
        }
        if (input.command === "git" && input.args?.includes("config")) {
          return result(input, "false\n");
        }
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "main" },
              { path: linkedPath, branch: "feature" },
            ]),
          );
        }
        if (input.command === "wt" && input.args?.includes("remove")) {
          return result(input, "{}");
        }
        return result(input, "");
      },
    });

    await expect(
      provider.removeWorktree({
        project,
        worktreeId: "wt_web_feature",
        expectedPath: linkedPath,
        expectedBranch: "feature",
        expectedRegistrationIdentity: `git-registration:${linkedPath}`,
      }),
    ).resolves.toEqual({ worktreeId: "wt_web_feature", removed: true });

    const worktrunkCalls = calls.filter((call) => call.command === "wt");
    expect(worktrunkCalls).toEqual([
      expect.objectContaining({
        args: ["-C", linkedPath, "remove", "--no-hooks", "--format=json"],
      }),
    ]);
    expect(worktrunkCalls[0]?.args).not.toContain("--foreground");
  });

  it("refuses removal when Worktrunk is disabled without invoking external commands", async () => {
    const calls: ExternalCommandInput[] = [];
    const disabledProject = {
      ...project,
      worktrunk: { ...project.worktrunk, enabled: false },
    };
    const provider = testProvider({
      command: "wt",
      runner: async (input) => {
        calls.push(input);
        return result(input, "{}");
      },
    });

    await expect(
      provider.removeWorktree({
        project: disabledProject,
        worktreeId: "wt_web_feature",
        expectedPath: "/tmp/station/web/feature",
        expectedBranch: "feature",
        expectedRegistrationIdentity: "git-registration:/tmp/station/web/feature",
      }),
    ).rejects.toMatchObject({ code: "WORKTRUNK_WORKTREE_NOT_FOUND" });
    expect(calls).toEqual([]);
  });

  it("accepts a detached HEAD prefix but refuses an unverifiable detached fallback", async () => {
    const calls: ExternalCommandInput[] = [];
    const linkedPath = "/tmp/station/web/detached";
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: linkedPath,
          targetBranch: "detached",
          detached: true,
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "main" },
              {
                path: linkedPath,
                branch: "detached",
                headSha: "2".repeat(40),
                detached: true,
              },
            ]),
          );
        }
        return result(input, "{}");
      },
    });
    const request = {
      project,
      worktreeId: "wt_web_detached",
      expectedPath: linkedPath,
      expectedRegistrationIdentity: `git-registration:${linkedPath}`,
    } as const;

    await expect(
      provider.removeWorktree({ ...request, expectedBranch: "detached:2222222" }),
    ).resolves.toEqual({ worktreeId: request.worktreeId, removed: true });
    await expect(
      provider.removeWorktree({ ...request, expectedBranch: "detached:detached" }),
    ).rejects.toMatchObject({
      code: "WORKTRUNK_WORKTREE_CHANGED",
      diagnosticDetails: [expect.objectContaining({ refusalReason: "branch_changed" })],
    });
    expect(calls.filter((call) => call.command === "wt").map((call) => call.args)).toEqual([
      ["-C", linkedPath, "remove", "--no-hooks", "--format=json"],
    ]);
  });

  it("invokes removal through Git's final native path instead of a caller path alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-remove-alias-"));
    const nativePath = join(root, "native");
    const aliasPath = join(root, "alias");
    await mkdir(nativePath);
    await symlink(nativePath, aliasPath);
    const calls: ExternalCommandInput[] = [];
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: nativePath,
          targetBranch: "feature",
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "main" },
              { path: nativePath, branch: "feature" },
            ]),
          );
        }
        return result(input, "{}");
      },
    });

    try {
      await provider.removeWorktree({
        project,
        worktreeId: "wt_web_feature",
        expectedPath: aliasPath,
        expectedBranch: "feature",
        expectedRegistrationIdentity: `git-registration:${aliasPath}`,
      });
      expect(
        calls.filter((call) => call.command === "git" && call.args?.includes("status")),
      ).toEqual([
        expect.objectContaining({
          args: ["-C", nativePath, "status", "--porcelain=v1", "--untracked-files=normal"],
        }),
      ]);
      expect(calls.filter((call) => call.command === "wt").map((call) => call.args)).toEqual([
        ["-C", nativePath, "remove", "--no-hooks", "--format=json"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an unprimed target whose Git common directory belongs to another repository", async () => {
    const calls: ExternalCommandInput[] = [];
    const linkedPath = "/tmp/station/web/foreign";
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: linkedPath,
          targetBranch: "feature",
          targetCommonDir: "/tmp/foreign-repository/.git",
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "main" },
              { path: linkedPath, branch: "feature" },
            ]),
          );
        }
        return result(input, "{}");
      },
    });

    await expect(
      provider.removeWorktree({
        project,
        worktreeId: "wt_web_foreign",
        expectedPath: linkedPath,
        expectedBranch: "feature",
        expectedRegistrationIdentity: `git-registration:${linkedPath}`,
      }),
    ).rejects.toMatchObject({
      code: "WORKTRUNK_WORKTREE_CHANGED",
      diagnosticDetails: [expect.objectContaining({ refusalReason: "protection_unverified" })],
    });
    expect(calls.filter((call) => call.command === "wt")).toEqual([]);
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
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: linkedPath,
          targetBranch: "duplicate",
        });
        if (probe !== undefined) return probe;
        if (input.command === "wt" && input.args?.includes("list")) {
          return result(
            input,
            JSON.stringify([
              { path: project.root, branch: "main" },
              { path: linkedPath, branch: "duplicate" },
            ]),
          );
        }
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "duplicate" },
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

    expect(calls.filter((call) => call.command === "wt").map((call) => call.args)).toEqual([
      ["list", "--format=json"],
      ["-C", linkedPath, "remove", "--no-hooks", "--force", "--no-delete-branch", "--format=json"],
    ]);
    expect(
      calls.filter((call) => call.command === "git" && call.args?.includes("worktree")),
    ).toHaveLength(2);
  });

  it("does not remove a worktree missing from fresh native Git evidence", async () => {
    const calls: ExternalCommandInput[] = [];
    const linkedPath = "/tmp/station/web/feature";
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.command === "wt" && input.args?.includes("list")) {
          return result(input, JSON.stringify([{ path: linkedPath, branch: "feature" }]));
        }
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(input, gitWorktreePorcelain([{ path: project.root, branch: "main" }]));
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
    expect(calls.filter((call) => call.command === "wt").map((call) => call.args)).toEqual([
      ["list", "--format=json"],
    ]);
    expect(calls.filter((call) => call.command === "git").map((call) => call.args)).toEqual([
      ["-C", project.root, "worktree", "list", "--porcelain", "-z"],
    ]);
  });

  it("does not remove a selected worktree whose branch changed in native Git", async () => {
    const calls: ExternalCommandInput[] = [];
    const linkedPath = "/tmp/station/web/feature";
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: linkedPath,
          targetBranch: "main",
        });
        if (probe !== undefined) return probe;
        if (input.command === "wt" && input.args?.includes("list")) {
          return result(
            input,
            JSON.stringify([{ path: linkedPath, branch: "feature", is_main: false }]),
          );
        }
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "feature-root" },
              { path: linkedPath, branch: "main" },
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
    expect(calls.filter((call) => call.command === "wt").map((call) => call.args)).toEqual([
      ["list", "--format=json"],
    ]);
    expect(calls.filter((call) => call.command === "wt" && call.args?.includes("remove"))).toEqual(
      [],
    );
  });

  it("refuses dirty native Git evidence unless removal is forced", async () => {
    const calls: ExternalCommandInput[] = [];
    const linkedPath = "/tmp/station/web/feature";
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: linkedPath,
          targetBranch: "feature",
          status: " M tracked.txt\n",
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "main" },
              { path: linkedPath, branch: "feature" },
            ]),
          );
        }
        return result(input, "{}");
      },
    });

    await expect(
      provider.removeWorktree({
        project,
        worktreeId: "wt_web_feature",
        expectedPath: linkedPath,
        expectedBranch: "feature",
        expectedRegistrationIdentity: `git-registration:${linkedPath}`,
      }),
    ).rejects.toMatchObject({
      code: "WORKTREE_DIRTY_REQUIRES_FORCE",
      diagnosticDetails: [expect.objectContaining({ refusalReason: "dirty" })],
    });
    expect(calls.filter((call) => call.command === "wt")).toEqual([]);
  });

  it("refuses a checkout that becomes dirty at the final removal boundary", async () => {
    const calls: ExternalCommandInput[] = [];
    const linkedPath = "/tmp/station/web/feature";
    let targetIdentityReads = 0;
    let dirty = false;
    const provider = testProvider({
      command: "wt",
      runner: async (input) => {
        calls.push(input);
        if (input.command === "git" && input.args?.includes("--show-toplevel")) {
          targetIdentityReads += 1;
          if (targetIdentityReads === 2) dirty = true;
        }
        if (input.command === "git" && input.args?.includes("status")) {
          return result(input, dirty ? " M tracked.txt\n" : "");
        }
        const probe = gitRemovalProbeResult(input, {
          targetPath: linkedPath,
          targetBranch: "feature",
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "main" },
              { path: linkedPath, branch: "feature" },
            ]),
          );
        }
        return result(input, "{}");
      },
    });

    await expect(
      provider.removeWorktree({
        project,
        worktreeId: "wt_web_feature",
        expectedPath: linkedPath,
        expectedBranch: "feature",
        expectedRegistrationIdentity: `git-registration:${linkedPath}`,
      }),
    ).rejects.toMatchObject({
      code: "WORKTREE_DIRTY_REQUIRES_FORCE",
      diagnosticDetails: [expect.objectContaining({ refusalReason: "dirty" })],
    });
    expect(targetIdentityReads).toBe(2);
    expect(calls.filter((call) => call.command === "wt")).toEqual([]);
  });

  it("refuses registration replacement during final native identity validation", async () => {
    const calls: ExternalCommandInput[] = [];
    const linkedPath = "/tmp/station/web/feature";
    let targetIdentityReads = 0;
    let registrationIdentity = "git-registration:original";
    const provider = new WorktrunkProvider({
      command: "wt",
      resolveRegistrationIdentity: async () => registrationIdentity,
      runner: async (input) => {
        calls.push(input);
        if (input.command === "git" && input.args?.includes("--show-toplevel")) {
          targetIdentityReads += 1;
          if (targetIdentityReads === 2) registrationIdentity = "git-registration:replacement";
        }
        const probe = gitRemovalProbeResult(input, {
          targetPath: linkedPath,
          targetBranch: "feature",
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "main" },
              { path: linkedPath, branch: "feature" },
            ]),
          );
        }
        return result(input, "{}");
      },
    });

    await expect(
      provider.removeWorktree({
        project,
        worktreeId: "wt_web_feature",
        expectedPath: linkedPath,
        expectedBranch: "feature",
        expectedRegistrationIdentity: "git-registration:original",
      }),
    ).rejects.toMatchObject({
      code: "WORKTRUNK_WORKTREE_CHANGED",
      diagnosticDetails: [expect.objectContaining({ refusalReason: "registration_changed" })],
    });
    expect(targetIdentityReads).toBe(2);
    expect(calls.filter((call) => call.command === "wt")).toEqual([]);
  });

  it("refuses removal of the project root checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-primary-remove-"));
    await mkdir(join(root, ".git"));
    const guardedProject = { ...project, root };
    const calls: ExternalCommandInput[] = [];
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: root,
          targetBranch: "main",
          targetHeadSha: "1".repeat(40),
          projectCommonDir: join(root, ".git"),
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("config")) {
          return result(input, "false\n");
        }
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(input, gitWorktreePorcelain([{ path: root, branch: "main" }]));
        }
        return result(input, "{}");
      },
    });

    try {
      await expect(
        provider.removeWorktree({
          project: guardedProject,
          worktreeId: "wt_web_main",
          expectedPath: root,
          expectedBranch: "main",
          expectedRegistrationIdentity: `git-registration:${root}`,
        }),
      ).rejects.toMatchObject({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        diagnosticDetails: [expect.objectContaining({ refusalReason: "primary_checkout" })],
      });
      expect(calls.filter((call) => call.command === "wt")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses the native primary checkout when the configured root is linked", async () => {
    const calls: ExternalCommandInput[] = [];
    const primaryPath = "/tmp/station/web-primary";
    const linkedProject = { ...project, root: "/tmp/station/web-linked" };
    const provider = testProvider({
      command: "wt",
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: primaryPath,
          targetBranch: "legacy-primary",
          targetHeadSha: "1".repeat(40),
          projectCommonDir: join(linkedProject.root, ".git"),
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: primaryPath, branch: "legacy-primary", headSha: "1".repeat(40) },
              { path: linkedProject.root, branch: "feature" },
            ]),
          );
        }
        return result(input, "{}");
      },
    });

    await expect(
      provider.removeWorktree({
        project: linkedProject,
        worktreeId: "wt_web_primary",
        expectedPath: primaryPath,
        expectedBranch: "legacy-primary",
        expectedRegistrationIdentity: `git-registration:${primaryPath}`,
      }),
    ).rejects.toMatchObject({
      code: "WORKTRUNK_WORKTREE_CHANGED",
      diagnosticDetails: [expect.objectContaining({ refusalReason: "primary_checkout" })],
    });
    expect(calls.filter((call) => call.command === "wt")).toEqual([]);
  });

  it("refuses removal of a checkout that owns the configured default branch", async () => {
    const calls: ExternalCommandInput[] = [];
    const linkedPath = "/tmp/station/web/default-linked";
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: linkedPath,
          targetBranch: "main",
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "root-branch" },
              { path: linkedPath, branch: "main" },
            ]),
          );
        }
        return result(input, "{}");
      },
    });

    await expect(
      provider.removeWorktree({
        project,
        worktreeId: "wt_web_main",
        expectedPath: linkedPath,
        expectedBranch: "main",
        expectedRegistrationIdentity: `git-registration:${linkedPath}`,
      }),
    ).rejects.toMatchObject({
      code: "WORKTRUNK_WORKTREE_CHANGED",
      diagnosticDetails: [expect.objectContaining({ refusalReason: "default_branch" })],
    });
    expect(calls.filter((call) => call.command === "wt")).toEqual([]);
  });

  it("refuses an external checkout when the managed root is authoritative", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-managed-remove-"));
    const projectRoot = join(root, "repo");
    const managedRoot = join(projectRoot, ".worktrees");
    const externalPath = join(root, "external");
    await mkdir(managedRoot, { recursive: true });
    await mkdir(externalPath);
    const managedProject = {
      ...project,
      root: projectRoot,
      worktrunk: {
        ...project.worktrunk,
        managedRoot: ".worktrees",
        includeExternal: false,
      },
    };
    const calls: ExternalCommandInput[] = [];
    const provider = testProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: externalPath,
          targetBranch: "feature",
          projectCommonDir: join(projectRoot, ".git"),
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: projectRoot, branch: "main" },
              { path: externalPath, branch: "feature" },
            ]),
          );
        }
        return result(input, "{}");
      },
    });

    try {
      await expect(
        provider.removeWorktree({
          project: managedProject,
          worktreeId: "wt_web_external",
          expectedPath: externalPath,
          expectedBranch: "feature",
          expectedRegistrationIdentity: `git-registration:${externalPath}`,
        }),
      ).rejects.toMatchObject({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        diagnosticDetails: [expect.objectContaining({ refusalReason: "protection_unverified" })],
      });
      expect(calls.filter((call) => call.command === "wt")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses removal when the managed-root symlink changes during validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-managed-race-"));
    const projectRoot = join(root, "repo");
    const originalManagedRoot = join(root, "managed-original");
    const externalRoot = join(root, "external");
    const externalPath = join(externalRoot, "feature");
    const managedRootLink = join(projectRoot, ".worktrees");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(originalManagedRoot);
    await mkdir(externalPath, { recursive: true });
    await symlink(originalManagedRoot, managedRootLink);
    const managedProject = {
      ...project,
      root: projectRoot,
      worktrunk: {
        ...project.worktrunk,
        managedRoot: managedRootLink,
        includeExternal: false,
      },
    };
    const calls: ExternalCommandInput[] = [];
    let inventoryReads = 0;
    const provider = testProvider({
      command: "wt",
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: externalPath,
          targetBranch: "feature",
          projectCommonDir: join(projectRoot, ".git"),
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          inventoryReads += 1;
          if (inventoryReads === 2) {
            await rm(managedRootLink);
            await symlink(externalRoot, managedRootLink);
          }
          return result(
            input,
            gitWorktreePorcelain([
              { path: projectRoot, branch: "main" },
              { path: externalPath, branch: "feature" },
            ]),
          );
        }
        return result(input, "{}");
      },
    });

    try {
      await expect(
        provider.removeWorktree({
          project: managedProject,
          worktreeId: "wt_web_external",
          expectedPath: externalPath,
          expectedBranch: "feature",
          expectedRegistrationIdentity: `git-registration:${externalPath}`,
        }),
      ).rejects.toMatchObject({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        diagnosticDetails: [expect.objectContaining({ refusalReason: "protection_unverified" })],
      });
      expect(calls.filter((call) => call.command === "wt")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a managed-root retarget at the final removal boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-managed-final-race-"));
    const projectRoot = join(root, "repo");
    const managedRoot = join(root, "managed");
    const externalRoot = join(root, "external");
    const targetPath = join(managedRoot, "feature");
    const managedRootLink = join(projectRoot, ".worktrees");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(targetPath, { recursive: true });
    await mkdir(externalRoot);
    await symlink(managedRoot, managedRootLink);
    const managedProject = {
      ...project,
      root: projectRoot,
      worktrunk: {
        ...project.worktrunk,
        managedRoot: managedRootLink,
        includeExternal: false,
      },
    };
    const calls: ExternalCommandInput[] = [];
    let identityReads = 0;
    const provider = testProvider({
      command: "wt",
      runner: async (input) => {
        calls.push(input);
        if (input.command === "git" && input.args?.includes("--show-toplevel")) {
          identityReads += 1;
          if (identityReads === 2) {
            await rm(managedRootLink);
            await symlink(externalRoot, managedRootLink);
          }
        }
        const probe = gitRemovalProbeResult(input, {
          targetPath,
          targetBranch: "feature",
          projectCommonDir: join(projectRoot, ".git"),
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: projectRoot, branch: "main" },
              { path: targetPath, branch: "feature" },
            ]),
          );
        }
        return result(input, "{}");
      },
    });

    try {
      await expect(
        provider.removeWorktree({
          project: managedProject,
          worktreeId: "wt_web_feature",
          expectedPath: targetPath,
          expectedBranch: "feature",
          expectedRegistrationIdentity: `git-registration:${targetPath}`,
        }),
      ).rejects.toMatchObject({
        code: "WORKTRUNK_WORKTREE_CHANGED",
        diagnosticDetails: [expect.objectContaining({ refusalReason: "protection_unverified" })],
      });
      expect(identityReads).toBe(2);
      expect(calls.filter((call) => call.command === "wt")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    const linkedPath = "/tmp/station/web/feature";
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: false,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: linkedPath,
          targetBranch: "feature",
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "main" },
              { path: linkedPath, branch: "feature" },
            ]),
          );
        }
        if (input.args?.[0] === "switch") {
          return result(input, JSON.stringify([{ path: linkedPath, branch: "feature" }]));
        }
        if (input.args?.[0] === "remove") {
          return result(input, "{}");
        }
        return result(input, JSON.stringify([{ path: linkedPath, branch: "feature" }]));
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

    expect(calls.filter((call) => call.command === "wt").map((call) => call.args)).toEqual([
      ["switch", "--no-hooks", "--create", "feature", "--base", "main", "--no-cd", "--format=json"],
      ["-C", "/tmp/station/web/feature", "remove", "--no-hooks", "--format=json"],
    ]);
  });

  it("pre-approves Worktrunk hook prompts for automated mutations when lifecycle hooks are enabled", async () => {
    const calls: ExternalCommandInput[] = [];
    const linkedPath = "/tmp/station/web/feature";
    const provider = testProvider({
      command: "wt",
      useLifecycleHooks: true,
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        const probe = gitRemovalProbeResult(input, {
          targetPath: linkedPath,
          targetBranch: "feature",
        });
        if (probe !== undefined) return probe;
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "main" },
              { path: linkedPath, branch: "feature" },
            ]),
          );
        }
        if (input.args?.[0] === "switch") {
          return result(input, JSON.stringify([{ path: linkedPath, branch: "feature" }]));
        }
        if (input.args?.[0] === "remove") {
          return result(input, "{}");
        }
        return result(input, JSON.stringify([{ path: linkedPath, branch: "feature" }]));
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

    expect(calls.filter((call) => call.command === "wt").map((call) => call.args)).toEqual([
      ["switch", "--yes", "--create", "feature", "--base", "main", "--no-cd", "--format=json"],
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
        const probe = gitRemovalProbeResult(input, {
          targetPath: "/tmp/station/web/feature",
          targetBranch: "feature",
        });
        if (probe !== undefined) return probe;
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
        if (input.command === "git" && input.args?.includes("worktree")) {
          return result(
            input,
            gitWorktreePorcelain([
              { path: project.root, branch: "main" },
              { path: "/tmp/station/web/feature", branch: "feature" },
            ]),
          );
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
    expect(removeArgs).not.toContain("--foreground");
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
