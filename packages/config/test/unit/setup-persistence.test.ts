import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PersistSetupConfigMutationOptions,
  persistSetupConfigMutation,
} from "@station/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const configPath = "/tmp/station-config.toml";
const homeDir = "/tmp";
let before: string;
let content: string;

beforeEach(async () => {
  before = await fixture("update.before.toml");
  content = await fixture("update.expected.toml");
});

describe("setup config persistence", () => {
  it("creates a missing config and treats the same bytes as an idempotent retry", async () => {
    const fs = memoryFileSystem();
    const plan = { operation: "create" as const, path: configPath, content };

    await expect(persistSetupConfigMutation(plan, { homeDir, fs })).resolves.toEqual({
      status: "created",
      configPath,
    });
    await expect(persistSetupConfigMutation(plan, { homeDir, fs })).resolves.toEqual({
      status: "unchanged",
      configPath,
    });
    expect(fs.backups).toEqual([]);
  });

  it("allows only one concurrent real-filesystem create to commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-setup-config-race-"));
    const path = join(root, "config.toml");
    const alternate = `${content}\n# alternate concurrent plan\n`;
    try {
      const results = await Promise.allSettled([
        persistSetupConfigMutation({ operation: "create", path, content }, { homeDir: root }),
        persistSetupConfigMutation(
          { operation: "create", path, content: alternate },
          { homeDir: root },
        ),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { code: "SETUP_CONFIG_PRECONDITION_FAILED" },
      });
      expect([content, alternate]).toContain(await readFile(path, "utf8"));
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(root)).toEqual(["config.toml"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("updates a real symlink target without replacing the link", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-setup-config-symlink-"));
    const targetPath = join(root, "target.toml");
    const linkPath = join(root, "config.toml");
    const backupPath = `${linkPath}.2026-06-08T12-00-00-000Z.bak`;
    try {
      await writeFile(targetPath, before, { encoding: "utf8", mode: 0o600 });
      await symlink(targetPath, linkPath);

      await expect(
        persistSetupConfigMutation(
          { operation: "update", path: linkPath, before, content },
          {
            homeDir: root,
            now: () => new Date("2026-06-08T12:00:00.000Z"),
          },
        ),
      ).resolves.toEqual({
        status: "updated",
        configPath: linkPath,
        backupPath,
      });
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(targetPath, "utf8")).toBe(content);
      expect(await readFile(backupPath, "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes one timestamped backup and makes no second backup on retry", async () => {
    const fs = memoryFileSystem({ [configPath]: before });
    const plan = { operation: "update" as const, path: configPath, before, content };
    const options = {
      homeDir,
      fs,
      now: () => new Date("2026-06-08T12:00:00.000Z"),
    };

    const first = await persistSetupConfigMutation(plan, options);
    const second = await persistSetupConfigMutation(plan, options);

    expect(first).toEqual({
      status: "updated",
      configPath,
      backupPath: `${configPath}.2026-06-08T12-00-00-000Z.bak`,
    });
    expect(second).toEqual({ status: "unchanged", configPath });
    expect(fs.backups).toEqual([`${configPath}.2026-06-08T12-00-00-000Z.bak`]);
    expect(fs.files.get(configPath)).toBe(content);
  });

  it("rejects stale create and update preconditions without mutation", async () => {
    const stale = `${before}\n# concurrent change\n`;
    const fs = memoryFileSystem({ [configPath]: stale });

    await expect(
      persistSetupConfigMutation(
        { operation: "create", path: configPath, content },
        { homeDir, fs },
      ),
    ).rejects.toMatchObject({ code: "SETUP_CONFIG_PRECONDITION_FAILED" });
    await expect(
      persistSetupConfigMutation(
        { operation: "update", path: configPath, before, content },
        { homeDir, fs },
      ),
    ).rejects.toMatchObject({ code: "SETUP_CONFIG_PRECONDITION_FAILED" });
    expect(fs.files.get(configPath)).toBe(stale);
    expect(fs.replaceTextIfCurrent).not.toHaveBeenCalled();
  });

  it("rejects a create that appears at the commit boundary", async () => {
    const concurrent = `${before}\n# created concurrently\n`;
    const fs = memoryFileSystem();
    fs.replaceTextIfCurrent.mockImplementationOnce(async (path) => {
      fs.files.set(path, concurrent);
      return "stale";
    });

    await expect(
      persistSetupConfigMutation(
        { operation: "create", path: configPath, content },
        { homeDir, fs },
      ),
    ).rejects.toMatchObject({ code: "SETUP_CONFIG_PRECONDITION_FAILED" });
    expect(fs.files.get(configPath)).toBe(concurrent);
  });

  it("revalidates an update after backup creation", async () => {
    const concurrent = `${before}\n# changed during backup\n`;
    const fs = memoryFileSystem({ [configPath]: before });
    fs.writeBackup.mockImplementationOnce(async (path, value) => {
      fs.backups.push(path);
      fs.files.set(path, value);
      fs.files.set(configPath, concurrent);
    });

    await expect(
      persistSetupConfigMutation(
        { operation: "update", path: configPath, before, content },
        { homeDir, fs },
      ),
    ).rejects.toMatchObject({ code: "SETUP_CONFIG_PRECONDITION_FAILED" });
    expect(fs.files.get(configPath)).toBe(concurrent);
  });

  it("leaves the target unchanged when backup creation fails", async () => {
    const fs = memoryFileSystem({ [configPath]: before });
    fs.writeBackup.mockRejectedValueOnce(new Error("backup denied"));

    await expect(
      persistSetupConfigMutation(
        { operation: "update", path: configPath, before, content },
        { homeDir, fs },
      ),
    ).rejects.toMatchObject({ code: "SETUP_CONFIG_BACKUP_FAILED" });
    expect(fs.files.get(configPath)).toBe(before);
    expect(fs.replaceTextIfCurrent).not.toHaveBeenCalled();
  });

  it("leaves the target unchanged when atomic replacement fails", async () => {
    const fs = memoryFileSystem({ [configPath]: before });
    fs.replaceTextIfCurrent.mockRejectedValueOnce(new Error("rename denied"));

    await expect(
      persistSetupConfigMutation(
        { operation: "update", path: configPath, before, content },
        { homeDir, fs },
      ),
    ).rejects.toMatchObject({ code: "CONFIG_WRITE_FAILED" });
    expect(fs.files.get(configPath)).toBe(before);
    expect(fs.backups).toHaveLength(1);
  });
});

function memoryFileSystem(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const backups: string[] = [];
  const readTextFile = vi.fn(async (path: string) => files.get(path));
  const writeBackup = vi.fn(async (path: string, value: string) => {
    backups.push(path);
    files.set(path, value);
  });
  const replaceTextIfCurrent = vi.fn(
    async (path: string, expectedValue: string | undefined, value: string) => {
      const current = files.get(path);
      if (current === value) return "unchanged" as const;
      if (current !== expectedValue) return "stale" as const;
      files.set(path, value);
      return "replaced" as const;
    },
  );
  const fs = { readTextFile, writeBackup, replaceTextIfCurrent } satisfies NonNullable<
    PersistSetupConfigMutationOptions["fs"]
  >;
  return { ...fs, files, backups };
}

function fixture(name: string): Promise<string> {
  return readFile(join("packages/config/test/fixtures/setup", name), "utf8");
}
