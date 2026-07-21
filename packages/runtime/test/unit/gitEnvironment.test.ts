import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type ExternalCommandInput,
  environmentWithoutGitLocals,
  isGitCheckoutConfiguredBare,
} from "@station/runtime";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

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
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-git-checkout-"));
  await git(root, ["init", "--quiet"]);
  return root;
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root, env: environmentWithoutGitLocals() });
}
