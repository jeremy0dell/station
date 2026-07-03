import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProjectToConfig,
  ConfigError,
  loadConfig,
  removeProjectFromConfig,
  setProjectDefaultHarnessInConfig,
  setTuiWidgetsInConfig,
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

  it("sets a project default harness on a minimal project block", async () => {
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

    const result = await setProjectDefaultHarnessInConfig({
      projectId: "web",
      harness: "opencode",
      configPath,
      homeDir: tempDir,
    });

    expect(result.status).toBe("updated");
    const loaded = await loadConfig({ configPath, homeDir: tempDir });
    expect(loaded.projects[0]?.defaults.harness).toBe("opencode");
    const source = await readFile(configPath, "utf8");
    expect(source).toContain('[projects.defaults]\nharness = "opencode"');
  });

  it("replaces an existing project default harness", async () => {
    const tempDir = await makeTempDir();
    const web = await makeRepo(tempDir, "web");
    const configPath = await writeBaseConfig(
      tempDir,
      `
[[projects]]
id = "web"
label = "web"
root = ${JSON.stringify(web)}

[projects.defaults]
harness = "codex"
layout = "agent-shell"
`,
    );

    await setProjectDefaultHarnessInConfig({
      projectId: "web",
      harness: "opencode",
      configPath,
      homeDir: tempDir,
    });

    const source = await readFile(configPath, "utf8");
    expect(source).toContain('[projects.defaults]\nharness = "opencode"\nlayout = "agent-shell"');
    const loaded = await loadConfig({ configPath, homeDir: tempDir });
    expect(loaded.projects[0]?.defaults).toEqual({
      harness: "opencode",
      terminal: "tmux",
      layout: "agent-shell",
    });
  });

  it("preserves indentation and inline comments when replacing a project default harness", async () => {
    const tempDir = await makeTempDir();
    const web = await makeRepo(tempDir, "web");
    const configPath = await writeBaseConfig(
      tempDir,
      `
[[projects]]
id = "web"
label = "web"
root = ${JSON.stringify(web)}

[projects.defaults]
  harness = "codex" # team pin
layout = "agent-shell"
`,
    );

    await setProjectDefaultHarnessInConfig({
      projectId: "web",
      harness: "opencode",
      configPath,
      homeDir: tempDir,
    });

    await expect(readFile(configPath, "utf8")).resolves.toContain(
      '  harness = "opencode" # team pin',
    );
  });

  it("inserts a missing harness into an existing project defaults table", async () => {
    const tempDir = await makeTempDir();
    const web = await makeRepo(tempDir, "web");
    const configPath = await writeBaseConfig(
      tempDir,
      `
[[projects]]
id = "web"
label = "web"
root = ${JSON.stringify(web)}

[projects.defaults]
layout = "agent-shell"
`,
    );

    await setProjectDefaultHarnessInConfig({
      projectId: "web",
      harness: "opencode",
      configPath,
      homeDir: tempDir,
    });

    const source = await readFile(configPath, "utf8");
    expect(source).toContain('[projects.defaults]\nharness = "opencode"\nlayout = "agent-shell"');
  });

  it("sets the default harness on a non-first project block", async () => {
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

    await setProjectDefaultHarnessInConfig({
      projectId: "api",
      harness: "opencode",
      configPath,
      homeDir: tempDir,
    });

    const loaded = await loadConfig({ configPath, homeDir: tempDir });
    expect(loaded.projects.find((project) => project.id === "web")?.defaults.harness).toBe("codex");
    expect(loaded.projects.find((project) => project.id === "api")?.defaults.harness).toBe(
      "opencode",
    );
  });

  it("rejects project default harness changes shadowed by project-local defaults", async () => {
    const tempDir = await makeTempDir();
    const web = await makeRepo(tempDir, "web");
    await mkdir(join(web, ".station"), { recursive: true });
    await writeFile(
      join(web, ".station", "config.toml"),
      `
schema_version = 1

[defaults]
harness = "claude"
`,
      "utf8",
    );
    const configPath = await writeBaseConfig(
      tempDir,
      `
[[projects]]
id = "web"
label = "web"
root = ${JSON.stringify(web)}

[projects.local_config]
enabled = true
path = ".station/config.toml"
`,
    );
    const before = await readFile(configPath, "utf8");

    await expect(
      setProjectDefaultHarnessInConfig({
        projectId: "web",
        harness: "opencode",
        configPath,
        homeDir: tempDir,
      }),
    ).rejects.toMatchObject({
      tag: "ProjectConfigError",
      code: "PROJECT_DEFAULT_HARNESS_OVERRIDDEN",
      projectId: "web",
    });
    await expect(readFile(configPath, "utf8")).resolves.toBe(before);
  });

  it("does not write when the selected project harness is already effective", async () => {
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
    const before = await readFile(configPath, "utf8");

    const result = await setProjectDefaultHarnessInConfig({
      projectId: "web",
      harness: "codex",
      configPath,
      homeDir: tempDir,
    });

    expect(result.status).toBe("unchanged");
    await expect(readFile(configPath, "utf8")).resolves.toBe(before);
  });

  it("rejects default harness changes for an unknown project id", async () => {
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

    await expect(
      setProjectDefaultHarnessInConfig({
        projectId: "ghost",
        harness: "opencode",
        configPath,
        homeDir: tempDir,
      }),
    ).rejects.toMatchObject({
      tag: "ProjectConfigError",
      code: "PROJECT_NOT_CONFIGURED",
      projectId: "ghost",
    });
  });
});

describe("TUI widget config mutation", () => {
  it("writes configured widgets and reloads them in order", async () => {
    const tempDir = await makeTempDir();
    const configPath = await writeBaseConfig(tempDir);

    const result = await setTuiWidgetsInConfig({
      configPath,
      homeDir: tempDir,
      widgets: [
        { type: "time", timeFormat: "24h" },
        { type: "fleet" },
        { type: "prs", enabled: false },
        { type: "moon" },
      ],
    });

    expect(result.status).toBe("updated");
    const source = await readFile(configPath, "utf8");
    expect(source).toContain('[[tui.widgets]]\ntype = "time"\ntime_format = "24h"');
    expect(source).toContain('[[tui.widgets]]\ntype = "prs"\nenabled = false');

    const loaded = await loadConfig({ configPath, homeDir: tempDir });
    expect(loaded.config.tui?.widgets).toEqual([
      { type: "time", timeFormat: "24h" },
      { type: "fleet" },
      { type: "prs", enabled: false },
      { type: "moon" },
    ]);
  });

  it("replaces old widget blocks without dropping other [tui] settings", async () => {
    const tempDir = await makeTempDir();
    const configPath = await writeBaseConfig(tempDir);
    const base = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${base}
[[tui.widgets]]
type = "weather"
city = "New York, NY"

[tui.island]
rest_counts = true
`,
      "utf8",
    );

    await setTuiWidgetsInConfig({
      configPath,
      homeDir: tempDir,
      widgets: [],
    });

    const source = await readFile(configPath, "utf8");
    expect(source).not.toContain("[[tui.widgets]]");
    expect(source).toContain("widgets = []");
    expect(source).toContain("[tui.island]\nrest_counts = true");

    const loaded = await loadConfig({ configPath, homeDir: tempDir });
    expect(loaded.config.tui).toEqual({ widgets: [], island: { restCounts: true } });
  });
});
