import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { git, sourceArchive } from "../../src/source.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "station-e2b-source-test-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  return root;
}
it("exports the committed tree despite export attributes, without history or working files", async () => {
  const root = await repository();
  await writeFile(
    join(root, ".gitattributes"),
    "kept.txt export-ignore\nsubstituted.txt export-subst\n",
  );
  await writeFile(join(root, "kept.txt"), "committed\n");
  await writeFile(join(root, "substituted.txt"), "$Format:%H$\n");
  await symlink("kept.txt", join(root, "link"));
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "source",
  ]);
  await writeFile(join(root, "kept.txt"), "private working edit");
  await writeFile(join(root, "untracked-secret"), "not source");
  const source = await sourceArchive(root);
  const target = join(root, "exported");
  await mkdir(target);
  await writeFile(join(root, "source.tar"), source.archive);
  execFileSync("tar", ["-xf", join(root, "source.tar"), "-C", target]);
  await expect(readFile(join(target, "kept.txt"), "utf8")).resolves.toBe("committed\n");
  await expect(readFile(join(target, "substituted.txt"), "utf8")).resolves.toBe("$Format:%H$\n");
  await expect(readFile(join(target, "untracked-secret"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(readFile(join(target, ".git/config"))).rejects.toMatchObject({ code: "ENOENT" });
  await git(target, ["init"]);
  await git(target, ["add", "-f", "-A"]);
  expect(await git(target, ["write-tree"])).toBe(source.baseTree);
});
it("rejects submodules before uploading source", async () => {
  const root = await repository();
  await writeFile(join(root, "file"), "source");
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "source",
  ]);
  const commit = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["update-index", "--add", "--cacheinfo", `160000,${commit},submodule`]);
  await git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "submodule",
  ]);
  await expect(sourceArchive(root)).rejects.toMatchObject({
    code: "EXECUTION_SUBMODULE_UNSUPPORTED",
  });
});

it("preserves configured permission and profile settings in the remote runtime", async () => {
  const { runtimeConfig } = await import("../../src/remote.js");
  const config = runtimeConfig("claude", {
    permissionMode: "standard",
    approvalPolicy: "never",
    sandboxMode: "read-only",
    profile: "team",
  });
  expect(config).toContain('permission_mode = "standard"');
  expect(config).toContain('approval_policy = "never"');
  expect(config).toContain('sandbox_mode = "read-only"');
  expect(config).toContain('profile = "team"');
});
