import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceTextFile } from "@station/runtime";
import { describe, expect, it } from "vitest";

describe("replaceTextFile", () => {
  it("atomically replaces contents and applies the requested mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-replace-text-"));
    const path = join(root, "config.toml");
    await writeFile(path, "before\n", "utf8");
    await chmod(path, 0o644);

    await replaceTextFile({ path, contents: "after\n", mode: 0o600 });

    expect(await readFile(path, "utf8")).toBe("after\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("applies the requested mode independently of the process umask", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-replace-umask-"));
    const path = join(root, "hook.sh");
    const previousUmask = process.umask(0o777);
    try {
      await replaceTextFile({ path, contents: "#!/bin/sh\n", mode: 0o700 });
    } finally {
      process.umask(previousUmask);
    }

    expect((await stat(path)).mode & 0o777).toBe(0o700);
  });

  it("updates an existing symlink target without replacing the link", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-replace-link-"));
    const target = join(root, "target.toml");
    const path = join(root, "config.toml");
    await writeFile(target, "before\n", "utf8");
    await symlink(target, path);

    await replaceTextFile({ path, contents: "after\n", mode: 0o600 });

    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("after\n");
  });

  it("rejects dangling symlinks instead of replacing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-replace-dangling-link-"));
    const path = join(root, "config.toml");
    await symlink(join(root, "missing.toml"), path);

    await expect(replaceTextFile({ path, contents: "after\n", mode: 0o600 })).rejects.toThrow(
      "Cannot replace dangling symbolic link",
    );

    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  it("removes its temporary file when replacement fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-replace-failure-"));
    const path = join(root, "config.toml");
    await mkdir(path);
    await writeFile(join(path, "keep"), "x", "utf8");

    await expect(replaceTextFile({ path, contents: "after\n", mode: 0o600 })).rejects.toThrow();

    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
