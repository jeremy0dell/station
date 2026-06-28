import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { nodeExternalCommandRunner } from "@station/runtime";
import { WorktrunkProvider } from "@station/worktrunk";
import { describe, expect, it } from "vitest";

const now = "2026-05-21T12:00:00.000Z";
const project = {
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

describe("WorktrunkProvider", () => {
  it("lists worktrees through strict argv arrays", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new WorktrunkProvider({
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
    const provider = new WorktrunkProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async (input) =>
        result(
          input,
          JSON.stringify([
            { path: "/tmp/station/web", branch: "main" },
            { path: "/tmp/station/web/.worktrees/feature", branch: "feature" },
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
    const provider = new WorktrunkProvider({
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
    const provider = new WorktrunkProvider({
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
    const provider = new WorktrunkProvider({
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
    expect(calls[0]?.env).toEqual({
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
    const provider = new WorktrunkProvider({
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
    expect(calls[0]?.env).toEqual({
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
    const provider = new WorktrunkProvider({
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
    expect(calls[0]?.env).toEqual({
      WORKTRUNK_WORKTREE_PATH: expect.stringMatching(
        /^\/tmp\/station\/web\/\.worktrees\/feature-auth-[a-f0-9]{10}$/,
      ),
    });
  });

  it("creates and removes worktrees using Worktrunk lifecycle commands", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new WorktrunkProvider({
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
    const removed = await provider.removeWorktree({ worktreeId: created.id, force: true });

    expect(removed).toEqual({ worktreeId: created.id, removed: true });
    expect(calls.map((call) => call.args)).toEqual([
      ["switch", "--create", "feature", "--base", "main", "--no-cd", "--format=json"],
      ["remove", "feature", "--force", "--force-delete", "--foreground", "--format=json"],
    ]);
  });

  it("seeds the new worktree's working tree from a source path when seedFrom is set", async () => {
    const root = await mkdtemp(join(tmpdir(), "wt-seed-"));
    const srcPath = join(root, "source");
    const tgtPath = join(root, "feature");
    const git = (cwd: string, ...args: string[]) =>
      nodeExternalCommandRunner({ command: "git", args, cwd });

    // Real source repo: a base commit, then a dirty working tree spanning every state
    // the seed must carry (unstaged mod, staged mod, tracked deletion, untracked + nested).
    await mkdir(srcPath, { recursive: true });
    await git(srcPath, "init", "-q");
    await git(srcPath, "config", "user.email", "t@example.com");
    await git(srcPath, "config", "user.name", "t");
    await git(srcPath, "config", "commit.gpgsign", "false");
    await writeFile(join(srcPath, "tracked.txt"), "base\n");
    await writeFile(join(srcPath, "staged.txt"), "base\n");
    await writeFile(join(srcPath, "deleteme.txt"), "bye\n");
    await git(srcPath, "add", ".");
    await git(srcPath, "commit", "-qm", "init");
    await writeFile(join(srcPath, "tracked.txt"), "base\nunstaged\n");
    await writeFile(join(srcPath, "staged.txt"), "base\nstaged\n");
    await git(srcPath, "add", "staged.txt");
    await rm(join(srcPath, "deleteme.txt"));
    await mkdir(join(srcPath, "nested"), { recursive: true });
    await writeFile(join(srcPath, "untracked.txt"), "untracked-contents");
    await writeFile(join(srcPath, "nested", "deep.txt"), "deep-contents");
    const srcStatusBefore = (await git(srcPath, "status", "--porcelain")).stdout;

    const calls: ExternalCommandInput[] = [];
    const provider = new WorktrunkProvider({
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
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips Worktrunk hooks for automated mutations when lifecycle hooks are disabled", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new WorktrunkProvider({
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
        return result(input, "[]");
      },
    });

    const created = await provider.createWorktree({ project, branch: "feature" });
    await provider.removeWorktree({ worktreeId: created.id });

    expect(calls.map((call) => call.args)).toEqual([
      ["switch", "--no-hooks", "--create", "feature", "--base", "main", "--no-cd", "--format=json"],
      ["remove", "--no-hooks", "feature", "--foreground", "--format=json"],
    ]);
  });

  it("pre-approves Worktrunk hook prompts for automated mutations when lifecycle hooks are enabled", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new WorktrunkProvider({
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
        return result(input, "[]");
      },
    });

    const created = await provider.createWorktree({ project, branch: "feature" });
    await provider.removeWorktree({ worktreeId: created.id });

    expect(calls.map((call) => call.args)).toEqual([
      ["switch", "--yes", "--create", "feature", "--base", "main", "--no-cd", "--format=json"],
      ["remove", "--yes", "feature", "--foreground", "--format=json"],
    ]);
  });

  it("classifies duplicate branch failures and preserves external command diagnostics", async () => {
    const provider = new WorktrunkProvider({
      command: "wt",
      clock: { now: () => new Date(now) },
      runner: async () => {
        throw Object.assign(new Error("wt failed"), {
          code: 128,
          stderr: "fatal: a branch named 'feature' already exists",
          stdout: "checked refs",
        });
      },
    });

    await expect(provider.createWorktree({ project, branch: "feature" })).rejects.toMatchObject({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_BRANCH_EXISTS",
      hint: expect.stringContaining("different branch"),
      diagnosticDetails: [
        expect.objectContaining({
          type: "external_command",
          provider: "worktrunk",
          operation: "provider.worktrunk.switch",
          command: "wt switch --create feature --base main --no-cd --format=json",
          cwd: "/tmp/station/web",
          exitCode: 128,
          stderrSnippet: "fatal: a branch named 'feature' already exists",
        }),
      ],
    });
  });

  it("classifies duplicate worktree path failures", async () => {
    const provider = new WorktrunkProvider({
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
    const provider = new WorktrunkProvider({
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
    const provider = new WorktrunkProvider({
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

  it("classifies missing base failures", async () => {
    const provider = new WorktrunkProvider({
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
    const provider = new WorktrunkProvider({
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

  it("reports unsupported configured Worktrunk automation flags in doctor checks", async () => {
    const provider = new WorktrunkProvider({
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
    const provider = new WorktrunkProvider({
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
    const provider = new WorktrunkProvider({
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

  it("maps invalid create output to a WorktrunkProviderError", async () => {
    const provider = new WorktrunkProvider({
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
    const provider = new WorktrunkProvider({
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
