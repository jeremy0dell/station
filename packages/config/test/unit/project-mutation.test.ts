import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProjectToConfig,
  ConfigError,
  loadConfig,
  removeProjectFromConfig,
} from "@station/config";
import { describe, expect, it } from "vitest";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "station-project-config-"));
}

async function makeRepo(root: string, name: string): Promise<string> {
  const repo = join(root, name);
  await mkdir(join(repo, ".git"), { recursive: true });
  return repo;
}

async function writeBaseConfig(root: string, projectsToml = "projects = []"): Promise<string> {
  const configPath = join(root, "config.toml");
  await writeFile(
    configPath,
    `
schema_version = 1
${projectsToml}

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"
default_branch = "main"

[worktree.worktrunk]
managed_root = "~/.worktrees"
base = "origin/main"
include_main = false
include_external = false
`,
    "utf8",
  );
  return configPath;
}

describe("project config mutation", () => {
  it("adds a minimal project block and lets global defaults fill derived config", async () => {
    const tempDir = await makeTempDir();
    const configPath = await writeBaseConfig(tempDir);
    const repo = await makeRepo(tempDir, "station");

    const result = await addProjectToConfig({ path: repo, configPath, homeDir: tempDir });

    expect(result.status).toBe("added");
    expect(result.writtenBlock).toEqual({
      id: "station",
      label: "station",
      root: repo,
    });

    const source = await readFile(configPath, "utf8");
    expect(source).toContain('[[projects]]\nid = "station"\nlabel = "station"');
    const projectBlock = source.slice(source.indexOf("[[projects]]"));
    expect(projectBlock).not.toContain("default_branch =");
    expect(projectBlock).not.toContain("[projects.worktrunk]");

    const loaded = await loadConfig({ configPath, homeDir: tempDir });
    expect(loaded.projects[0]).toMatchObject({
      id: "station",
      label: "station",
      root: repo,
      defaultBranch: "main",
      worktrunk: {
        enabled: true,
        base: "origin/main",
        managedRoot: join(tempDir, ".worktrees", "station"),
        includeMain: false,
        includeExternal: false,
      },
    });
  });

  it("is idempotent for an already configured root", async () => {
    const tempDir = await makeTempDir();
    const configPath = await writeBaseConfig(tempDir);
    const repo = await makeRepo(tempDir, "web");

    await addProjectToConfig({ path: repo, configPath, homeDir: tempDir });
    const result = await addProjectToConfig({ path: repo, configPath, homeDir: tempDir });

    expect(result.status).toBe("unchanged");
    const source = await readFile(configPath, "utf8");
    expect(source.match(/\[\[projects\]\]/g)).toHaveLength(1);
  });

  it("suffixes generated IDs when a different root uses the same basename", async () => {
    const tempDir = await makeTempDir();
    const configPath = await writeBaseConfig(tempDir);
    const first = await makeRepo(join(tempDir, "one"), "app");
    const second = await makeRepo(join(tempDir, "two"), "app");

    const firstResult = await addProjectToConfig({ path: first, configPath, homeDir: tempDir });
    const secondResult = await addProjectToConfig({ path: second, configPath, homeDir: tempDir });

    expect(firstResult.project.id).toBe("app");
    expect(secondResult.project.id).toBe("app-2");
  });

  it("rejects invalid roots before writing", async () => {
    const tempDir = await makeTempDir();
    const configPath = await writeBaseConfig(tempDir);

    await expect(
      addProjectToConfig({
        path: join(tempDir, "missing"),
        configPath,
        homeDir: tempDir,
      }),
    ).rejects.toMatchObject({
      tag: "ProjectConfigError",
      code: "PROJECT_ROOT_INVALID",
    });
  });

  it("rejects invalid TOML before writing", async () => {
    const tempDir = await makeTempDir();
    const configPath = join(tempDir, "config.toml");
    await writeFile(configPath, "schema_version = [", "utf8");
    const repo = await makeRepo(tempDir, "web");

    await expect(
      addProjectToConfig({ path: repo, configPath, homeDir: tempDir }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("removes a project block by id", async () => {
    const tempDir = await makeTempDir();
    const web = await makeRepo(tempDir, "web");
    const api = await makeRepo(tempDir, "api");
    const configPath = await writeBaseConfig(
      tempDir,
      `
[[projects]]
id = "web"
label = "web"
root = ${JSON.stringify(web)}

[[projects]]
id = "api"
label = "api"
root = ${JSON.stringify(api)}
`,
    );

    const result = await removeProjectFromConfig({
      projectId: "web",
      configPath,
      homeDir: tempDir,
    });

    expect(result.status).toBe("removed");
    const loaded = await loadConfig({ configPath, homeDir: tempDir });
    expect(loaded.projects.map((project) => project.id)).toEqual(["api"]);
    const source = await readFile(configPath, "utf8");
    expect(source).not.toContain('id = "web"');
  });

  it("writes an empty projects array when removing the last project", async () => {
    const tempDir = await makeTempDir();
    const web = await makeRepo(tempDir, "web");
    const configPath = await writeBaseConfig(
      tempDir,
      `
[[projects]]
id = "web"
label = "web"
root = ${JSON.stringify(web)}
`,
    );

    await removeProjectFromConfig({ projectId: "web", configPath, homeDir: tempDir });

    const loaded = await loadConfig({ configPath, homeDir: tempDir });
    expect(loaded.projects).toEqual([]);
    await expect(readFile(configPath, "utf8")).resolves.toContain("projects = []");
  });
});
