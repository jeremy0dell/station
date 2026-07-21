import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type ExternalCommandInput,
  environmentWithoutGitLocals,
  isGitCheckoutConfiguredBare,
} from "@station/runtime";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const hookBoundaryPath = join(repoRoot, "scripts", "run-without-git-locals.mjs");

describe("Git environment", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("distinguishes normal and corrupted checkout config", async () => {
    const root = await createRepository();
    roots.push(root);

    await expect(isGitCheckoutConfiguredBare(root)).resolves.toBe(false);
    await git(root, ["config", "--local", "core.bare", "true"]);
    await expect(isGitCheckoutConfiguredBare(root)).resolves.toBe(true);
  });

  it("does not classify an intentional bare repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-git-bare-"));
    roots.push(root);
    await git(root, ["init", "--bare"]);

    await expect(isGitCheckoutConfiguredBare(root)).resolves.toBe(false);
  });

  it("returns false when the probe fails", async () => {
    const root = await createRepository();
    roots.push(root);

    await expect(
      isGitCheckoutConfiguredBare(root, {
        runner: async () => {
          throw new Error("probe failed");
        },
      }),
    ).resolves.toBe(false);
  });

  it("clears inherited Git-local variables for the probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-git-probe-"));
    roots.push(root);
    await mkdir(join(root, ".git"));
    let captured: ExternalCommandInput | undefined;

    await expect(
      isGitCheckoutConfiguredBare(root, {
        runner: async (input) => {
          captured = input;
          return {
            command: input.command,
            args: input.args ?? [],
            stdout: "true\n",
            stderr: "",
            exitCode: 0,
          };
        },
      }),
    ).resolves.toBe(true);
    expect(captured?.unsetEnv).toEqual(
      expect.arrayContaining(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]),
    );
  });

  it("clears every Git-local variable while preserving unrelated hook environment", async () => {
    const localVariables = (await gitOutput(repoRoot, ["rev-parse", "--local-env-vars"]))
      .trim()
      .split("\n");
    const hostileEnv: NodeJS.ProcessEnv = {
      ...environmentWithoutGitLocals(),
      STATION_HOOK_ENV_SENTINEL: "preserved",
    };
    for (const variable of localVariables) hostileEnv[variable] = "hostile";
    hostileEnv.GIT_CONFIG_COUNT = "0";
    const childScript = `
      const localVariables = JSON.parse(process.argv[1]);
      const inherited = localVariables.filter((name) => process.env[name] !== undefined);
      process.stdout.write(JSON.stringify({ inherited, sentinel: process.env.STATION_HOOK_ENV_SENTINEL }));
    `;

    const result = await execFileAsync(
      process.execPath,
      [hookBoundaryPath, process.execPath, "-e", childScript, JSON.stringify(localVariables)],
      { cwd: repoRoot, env: hostileEnv },
    );

    expect(JSON.parse(result.stdout)).toEqual({ inherited: [], sentinel: "preserved" });
  });

  it("isolates every Git-hook child from the invoking linked worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-git-hook-boundary-"));
    const victim = join(root, "victim");
    const linked = join(root, "linked");
    const fixture = join(root, "fixture");
    roots.push(root);
    await Promise.all([mkdir(victim), mkdir(fixture)]);
    await git(victim, ["init", "--quiet", "-b", "main"]);
    await git(victim, ["config", "user.email", "station@example.invalid"]);
    await git(victim, ["config", "user.name", "Station Test"]);
    await git(victim, ["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    await git(victim, ["worktree", "add", "--quiet", "-b", "linked", linked]);

    const before = {
      config: await readFile(join(victim, ".git", "config"), "utf8"),
      head: await gitOutput(linked, ["rev-parse", "HEAD"]),
      status: await gitOutput(linked, ["status", "--porcelain=v2", "--branch"]),
      worktrees: await gitOutput(victim, ["worktree", "list", "--porcelain"]),
    };
    const hostileGitDir = (await gitOutput(linked, ["rev-parse", "--absolute-git-dir"])).trim();

    await execFileAsync(process.execPath, [hookBoundaryPath, "git", "init", "-b", "main"], {
      cwd: fixture,
      env: { ...environmentWithoutGitLocals(), GIT_DIR: hostileGitDir },
    });

    await expect(readFile(join(victim, ".git", "config"), "utf8")).resolves.toBe(before.config);
    await expect(gitOutput(linked, ["rev-parse", "HEAD"])).resolves.toBe(before.head);
    await expect(gitOutput(linked, ["status", "--porcelain=v2", "--branch"])).resolves.toBe(
      before.status,
    );
    await expect(gitOutput(victim, ["worktree", "list", "--porcelain"])).resolves.toBe(
      before.worktrees,
    );
    await expect(gitOutput(fixture, ["rev-parse", "--is-bare-repository"])).resolves.toBe(
      "false\n",
    );

    const lefthook = await readFile(join(repoRoot, "lefthook.yml"), "utf8");
    expect(lefthook.match(/run: node scripts\/run-without-git-locals\.mjs /gu)).toHaveLength(2);
    await git(victim, ["worktree", "remove", "--force", linked]);
  });

  it("fails closed when Git-local environment discovery is unavailable", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [hookBoundaryPath, process.execPath, "-e", "process.exit(0)"],
        { cwd: repoRoot, env: { ...environmentWithoutGitLocals(), PATH: "" } },
      ),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("preserves a failing hook child's exit status and termination signal", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [hookBoundaryPath, process.execPath, "-e", "process.exit(23)"],
        { cwd: repoRoot, env: environmentWithoutGitLocals() },
      ),
    ).rejects.toMatchObject({ code: 23 });
    await expect(
      execFileAsync(
        process.execPath,
        [hookBoundaryPath, process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")'],
        { cwd: repoRoot, env: environmentWithoutGitLocals() },
      ),
    ).rejects.toMatchObject({ signal: "SIGTERM" });
  });
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-git-checkout-"));
  await git(root, ["init", "--quiet"]);
  return root;
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root, env: environmentWithoutGitLocals() });
}

async function gitOutput(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: environmentWithoutGitLocals(),
  });
  return result.stdout;
}
