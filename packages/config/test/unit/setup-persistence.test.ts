import { readFile } from "node:fs/promises";
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
    expect(fs.replaceText).not.toHaveBeenCalled();
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
    expect(fs.replaceText).not.toHaveBeenCalled();
  });

  it("leaves the target unchanged when atomic replacement fails", async () => {
    const fs = memoryFileSystem({ [configPath]: before });
    fs.replaceText.mockRejectedValueOnce(new Error("rename denied"));

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
  const replaceText = vi.fn(async (path: string, value: string) => {
    files.set(path, value);
  });
  const fs = { readTextFile, writeBackup, replaceText } satisfies NonNullable<
    PersistSetupConfigMutationOptions["fs"]
  >;
  return { ...fs, files, backups };
}

function fixture(name: string): Promise<string> {
  return readFile(join("packages/config/test/fixtures/setup", name), "utf8");
}
