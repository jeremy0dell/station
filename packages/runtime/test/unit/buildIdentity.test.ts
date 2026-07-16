import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildIdentityPath,
  buildWithIdentity,
  computeBuildIdentity,
  publishBuildIdentity,
  readBuildIdentity,
  verifyBuildIdentity,
} from "../../../../scripts/build-identity.mjs";
import { environmentWithoutGitLocals } from "../../src/gitEnvironment.js";

describe("build identity", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("is deterministic and changes with HEAD, inputs, modes, and production outputs", async () => {
    const root = await createRepository();
    roots.push(root);
    const trackedPath = join(root, "tracked.txt");
    const clean = await computeBuildIdentity(root);

    expect(clean).toMatch(/^[0-9a-f]{64}$/u);
    await expect(computeBuildIdentity(root)).resolves.toBe(clean);

    await writeFile(join(root, "packages", "example", "test", "value.test.ts"), "changed\n");
    await writeFile(join(root, "packages", "example", "value.spec.tsx"), "changed\n");
    await expect(computeBuildIdentity(root)).resolves.toBe(clean);

    await writeFile(trackedPath, "changed\n");
    const dirty = await computeBuildIdentity(root);
    expect(dirty).not.toBe(clean);
    await expect(computeBuildIdentity(root)).resolves.toBe(dirty);

    await writeFile(trackedPath, "tracked\n");
    await expect(computeBuildIdentity(root)).resolves.toBe(clean);

    const untrackedPath = join(root, "untracked.txt");
    await writeFile(untrackedPath, "one\n");
    const untracked = await computeBuildIdentity(root);
    await writeFile(untrackedPath, "two\n");
    expect(await computeBuildIdentity(root)).not.toBe(untracked);
    await rm(untrackedPath);

    const outputPath = join(root, "packages", "example", "dist", "index.js");
    await writeFile(outputPath, "export const build = 'changed';\n");
    expect(await computeBuildIdentity(root)).not.toBe(clean);
    await writeFile(outputPath, "export const build = 'current';\n");
    await expect(computeBuildIdentity(root)).resolves.toBe(clean);

    await chmod(trackedPath, 0o755);
    expect(await computeBuildIdentity(root)).not.toBe(clean);
    await chmod(trackedPath, 0o644);
    await expect(computeBuildIdentity(root)).resolves.toBe(clean);

    await writeFile(join(root, "ignored.txt"), "ignored\n");
    await expect(computeBuildIdentity(root)).resolves.toBe(clean);

    git(root, ["commit", "--allow-empty", "-m", "identity-only commit"]);
    expect(await computeBuildIdentity(root)).not.toBe(clean);
  });

  it("atomically publishes and validates the runtime sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-build-identity-sidecar-"));
    roots.push(root);
    const identity = "b".repeat(64);

    await publishBuildIdentity(identity, root);

    await expect(readBuildIdentity(root)).resolves.toBe(identity);
    expect(buildIdentityPath(root)).toBe(
      join(root, "packages", "runtime", "dist", "station-build-id"),
    );
    await expect(publishBuildIdentity("not-an-identity", root)).rejects.toThrow(
      "64 lowercase hexadecimal",
    );
  });

  it("verifies only the current published identity", async () => {
    const root = await createRepository();
    roots.push(root);
    const identity = await computeBuildIdentity(root);

    await expect(verifyBuildIdentity(identity, root)).resolves.toBe(false);
    await publishBuildIdentity(identity, root);
    await expect(verifyBuildIdentity(identity, root)).resolves.toBe(true);

    await writeFile(join(root, "tracked.txt"), "changed\n");
    await expect(verifyBuildIdentity(identity, root)).resolves.toBe(false);

    await writeFile(join(root, "tracked.txt"), "tracked\n");
    await writeFile(
      join(root, "packages", "example", "dist", "index.js"),
      "export const build = 'stale-output';\n",
    );
    await expect(verifyBuildIdentity(identity, root)).resolves.toBe(false);
  });

  it("publishes the stable identity after an injected build succeeds", async () => {
    const root = await createRepository();
    roots.push(root);
    const identity = await computeBuildIdentity(root);
    await publishBuildIdentity("f".repeat(64), root);

    await buildWithIdentity(root, async () => {
      await expect(readBuildIdentity(root)).rejects.toMatchObject({ code: "ENOENT" });
    });

    await expect(readBuildIdentity(root)).resolves.toBe(identity);
    await expect(verifyBuildIdentity(identity, root)).resolves.toBe(true);
  });

  it("removes the identity when inputs drift during an injected build", async () => {
    const root = await createRepository();
    roots.push(root);
    const identity = await computeBuildIdentity(root);
    await publishBuildIdentity("f".repeat(64), root);

    await expect(
      buildWithIdentity(root, () => writeFile(join(root, "tracked.txt"), "changed\n")),
    ).rejects.toThrow("build inputs changed");

    await expect(computeBuildIdentity(root)).resolves.not.toBe(identity);
    await expect(readBuildIdentity(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a stale identity when an injected build fails", async () => {
    const root = await createRepository();
    roots.push(root);
    const failure = new Error("injected build failure");
    await publishBuildIdentity("f".repeat(64), root);

    await expect(
      buildWithIdentity(root, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    await expect(readBuildIdentity(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-build-identity-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "station@example.invalid"]);
  git(root, ["config", "user.name", "Station Test"]);
  await writeFile(join(root, ".gitignore"), "dist/\nignored.txt\n");
  await writeFile(join(root, "tracked.txt"), "tracked\n");
  await mkdir(join(root, "packages", "example", "dist"), { recursive: true });
  await writeFile(
    join(root, "packages", "example", "package.json"),
    '{"name":"@station/example","scripts":{"build":"tsc"}}\n',
  );
  await mkdir(join(root, "packages", "example", "test"), { recursive: true });
  await writeFile(join(root, "packages", "example", "test", "value.test.ts"), "tracked\n");
  await writeFile(
    join(root, "packages", "example", "dist", "index.js"),
    "export const build = 'current';\n",
  );
  git(root, [
    "add",
    ".gitignore",
    "tracked.txt",
    "packages/example/package.json",
    "packages/example/test/value.test.ts",
  ]);
  git(root, ["commit", "--quiet", "-m", "initial"]);
  return root;
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    env: environmentWithoutGitLocals(),
    stdio: "ignore",
  });
}
