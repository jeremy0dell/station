import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  ConfigError,
  DEFAULT_WORKSPACE_CONFIG,
  loadConfig,
  loadConfigFromToml,
} from "@station/config";
import { SafeErrorSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";

const quoteTomlString = (value: string) => JSON.stringify(value);

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "station-config-"));
}

async function makeProjectRoot(parent: string, name: string): Promise<string> {
  const root = join(parent, name);
  await mkdir(root, { recursive: true });
  return root;
}

function baseToml(projectsToml: string): string {
  return `
schema_version = 1

[observer]
socket_path = "~/.local/state/station/observer.sock"
state_dir = "~/.local/state/station"

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

${projectsToml}
`;
}

function projectToml(
  id: string,
  root: string,
  options: {
    aliases?: string[];
    defaults?: string;
    localConfig?: string;
    commands?: string;
    recoveryBreadcrumbs?: string;
    label?: string;
    worktrunk?: string;
  } = {},
): string {
  const aliases =
    options.aliases === undefined
      ? ""
      : `aliases = [${options.aliases.map(quoteTomlString).join(", ")}]\n`;

  return `
[[projects]]
id = ${quoteTomlString(id)}
label = ${quoteTomlString(options.label ?? id)}
${aliases}root = ${quoteTomlString(root)}
repo = "github.com/example/${id}"
default_branch = "main"

[projects.worktrunk]
enabled = true
base = "main"
${options.worktrunk ?? ""}

${options.defaults ?? ""}
${options.commands ?? ""}
${options.localConfig ?? ""}
${options.recoveryBreadcrumbs ?? ""}
`;
}

async function writeProjectLocalConfig(root: string, contents: string): Promise<void> {
  const localDir = join(root, ".station");
  await mkdir(localDir, { recursive: true });
  await writeFile(join(localDir, "config.toml"), contents, "utf8");
}

describe("config loading", () => {
  it("loads the canonical example config", async () => {
    const tempDir = await makeTempDir();
    for (const project of ["web", "api", "mobile", "station"]) {
      await makeProjectRoot(join(tempDir, "projects"), project);
    }
    await writeProjectLocalConfig(
      join(tempDir, "projects", "web"),
      'schema_version = 1\n[commands]\ncheck = "pnpm check"\n',
    );
    const source = await readFile(
      new URL("../../../../examples/config.toml", import.meta.url),
      "utf8",
    );

    const loaded = await loadConfigFromToml(source, {
      configPath: join(tempDir, "config.toml"),
      homeDir: tempDir,
    });

    expect(loaded.projects.map((project) => project.id)).toEqual([
      "web",
      "api",
      "mobile",
      "station",
    ]);
    expect(loaded.diagnostics).toEqual([]);
  });

  it("loads TOML, applies defaults, expands paths, and keeps every configured project", async () => {
    const tempDir = await makeTempDir();
    const roots = {
      web: await makeProjectRoot(tempDir, "web"),
      api: await makeProjectRoot(tempDir, "api"),
      mobile: await makeProjectRoot(tempDir, "mobile"),
      station: await makeProjectRoot(tempDir, "station"),
    };
    const configPath = join(tempDir, "config.toml");
    const toml = baseToml(`
${projectToml("web", roots.web, { aliases: ["frontend", "site"] })}
${projectToml("api", roots.api, {
  aliases: ["backend"],
  defaults: `
[projects.defaults]
harness = "opencode"
layout = "agent-shell"
`,
})}
${projectToml("mobile", roots.mobile)}
${projectToml("station", roots.station)}
`);
    await writeFile(configPath, toml, "utf8");

    const loaded = await loadConfig({ configPath, homeDir: tempDir });

    expect(loaded.configPath).toBe(configPath);
    expect(loaded.projects.map((project) => project.id)).toEqual([
      "web",
      "api",
      "mobile",
      "station",
    ]);
    expect(loaded.config.projects).toHaveLength(4);
    expect(loaded.config.projects[0]?.root).toBe(roots.web);
    expect(loaded.config.observer?.socketPath).toBe(
      join(tempDir, ".local/state/station/observer.sock"),
    );
    expect(loaded.config.observer?.stateDir).toBe(join(tempDir, ".local/state/station"));
    expect(loaded.config.projects.find((project) => project.id === "web")?.defaults).toEqual({
      harness: "codex",
      terminal: "tmux",
      layout: "agent-build-shell",
    });
    expect(loaded.config.projects.find((project) => project.id === "api")?.defaults).toEqual({
      harness: "opencode",
      terminal: "tmux",
      layout: "agent-shell",
    });
    expect(loaded.diagnostics).toEqual([]);
  });

  it("normalizes managed Worktrunk root policy for a project", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      baseToml(
        projectToml("web", root, {
          worktrunk: `
managed_root = ".worktrees"
include_main = false
include_external = false
`,
        }),
      ),
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.projects[0]?.worktrunk).toEqual({
      enabled: true,
      base: "main",
      managedRoot: join(root, ".worktrees"),
      includeMain: false,
      includeExternal: false,
    });
  });

  it("derives project branch and Worktrunk policy defaults from global config", async () => {
    const tempDir = await makeTempDir();
    const webRoot = await makeProjectRoot(tempDir, "web");
    const apiRoot = await makeProjectRoot(tempDir, "api");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

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

[[projects]]
id = "web"
label = "web"
root = ${quoteTomlString(webRoot)}

[[projects]]
id = "api"
label = "api"
root = ${quoteTomlString(apiRoot)}
default_branch = "release"

[projects.worktrunk]
base = "origin/release"
include_main = true
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.defaults.defaultBranch).toBe("main");
    expect(loaded.config.worktree?.worktrunk).toMatchObject({
      managedRoot: join(tempDir, ".worktrees"),
      base: "origin/main",
      includeMain: false,
      includeExternal: false,
    });
    expect(loaded.config.projects.find((project) => project.id === "web")).toMatchObject({
      defaultBranch: "main",
      worktrunk: {
        enabled: true,
        base: "origin/main",
        managedRoot: join(tempDir, ".worktrees", "web"),
        includeMain: false,
        includeExternal: false,
      },
    });
    expect(loaded.config.projects.find((project) => project.id === "api")).toMatchObject({
      defaultBranch: "release",
      worktrunk: {
        enabled: true,
        base: "origin/release",
        managedRoot: join(tempDir, ".worktrees", "api"),
        includeMain: true,
        includeExternal: false,
      },
    });
  });

  it("loads generic global and Claude-specific harness permission modes", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"
harness_permission_mode = "yolo"

[harness.claude]
permission_mode = "auto"

[harness.codex]
permission_mode = "standard"
sandbox_mode = "workspace-write"
approval_policy = "on-request"

${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.defaults.harnessPermissionMode).toBe("yolo");
    expect(loaded.config.harness?.claude).toMatchObject({
      permissionMode: "auto",
    });
    expect(loaded.config.harness?.codex).toMatchObject({
      permissionMode: "standard",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
    });
  });

  it("rejects Claude auto permission mode outside the Claude harness config", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    await expect(
      loadConfigFromToml(
        `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[harness.codex]
permission_mode = "auto"

${projectToml("web", root)}
`,
        { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
      ),
    ).rejects.toMatchObject({
      tag: "ConfigError",
      code: "CONFIG_VALIDATION_FAILED",
    });
  });

  it("rejects auto as a global harness permission mode", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    await expect(
      loadConfigFromToml(
        `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "claude"
layout = "agent-build-shell"
harness_permission_mode = "auto"

${projectToml("web", root)}
`,
        { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
      ),
    ).rejects.toMatchObject({
      tag: "ConfigError",
      code: "CONFIG_VALIDATION_FAILED",
    });
  });

  it("loads optional GitHub repository provider config", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[repository.github]
enabled = true
command = "gh-custom"
timeout_ms = 2500

${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.repository?.github).toEqual({
      enabled: true,
      command: "gh-custom",
      timeoutMs: 2500,
    });
  });

  it("loads generic observer event hooks", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[[hooks.event]]
id = "notify-agent-state"
events = ["worktree.agentStateChanged"]
command = "stn"
args = ["notify", "agent-state"]
timeout_ms = 3000

[hooks.event.filter]
agent_state = "idle"
harness = "codex"
change_source = "harness_event_report"
harness_event_type = "Stop"

${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.hooks?.event).toEqual([
      {
        id: "notify-agent-state",
        events: ["worktree.agentStateChanged"],
        command: "stn",
        args: ["notify", "agent-state"],
        timeoutMs: 3000,
        filter: {
          agentState: "idle",
          harness: "codex",
          changeSource: "harness_event_report",
          harnessEventType: "Stop",
        },
      },
    ]);
  });

  it("rejects retired observer event hook names from TOML", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    await expect(
      loadConfigFromToml(
        `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[[hooks.event]]
id = "retired-provider-hook-events"
events = ["hook.ingested", "hook.spoolDrained"]
command = "stn"

${projectToml("web", root)}
`,
        { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
      ),
    ).rejects.toMatchObject({
      tag: "ConfigError",
      code: "CONFIG_VALIDATION_FAILED",
    });
  });

  it("loads TUI widgets in configured order and normalizes snake_case keys", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[[tui.widgets]]
type = "time"
time_format = "24h"

[[tui.widgets]]
type = "weather"
city = "New York, NY"
label = "NYC"
temperature_unit = "fahrenheit"
refresh_interval_minutes = 15

${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.tui?.widgets).toEqual([
      {
        type: "time",
        timeFormat: "24h",
      },
      {
        type: "weather",
        city: "New York, NY",
        label: "NYC",
        temperatureUnit: "fahrenheit",
        refreshIntervalMinutes: 15,
      },
    ]);
  });

  it("accepts empty and omitted TUI widgets", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const empty = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[tui]
widgets = []

${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );
    const omitted = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[tui]

${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config-empty.toml"), homeDir: tempDir },
    );

    expect(empty.config.tui).toEqual({ widgets: [] });
    expect(omitted.config.tui).toEqual({});
  });

  it("loads the snapshot/clock widget types with snake_case keys", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[[tui.widgets]]
type = "fleet"

[[tui.widgets]]
type = "prs"
enabled = false

[[tui.widgets]]
type = "tz"
time_format = "24h"

[[tui.widgets.zones]]
label = "NYC"
time_zone = "America/New_York"

[[tui.widgets.zones]]
label = "TYO"
time_zone = "Asia/Tokyo"

[[tui.widgets]]
type = "moon"

${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.tui?.widgets).toEqual([
      { type: "fleet" },
      { type: "prs", enabled: false },
      {
        type: "tz",
        timeFormat: "24h",
        zones: [
          { label: "NYC", timeZone: "America/New_York" },
          { label: "TYO", timeZone: "Asia/Tokyo" },
        ],
      },
      { type: "moon" },
    ]);
  });

  it("loads [tui.island] display modes with snake_case keys", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[tui.island]
rest_counts = true
project_rollup = false

${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.tui?.island).toEqual({ restCounts: true, projectRollup: false });
  });

  it.each([
    [
      "unknown widget type",
      `
[[tui.widgets]]
type = "crypto"
`,
    ],
    [
      "weather widget missing city",
      `
[[tui.widgets]]
type = "weather"
`,
    ],
    [
      "weather widget with empty city",
      `
[[tui.widgets]]
type = "weather"
city = ""
`,
    ],
    [
      "weather widget with empty label",
      `
[[tui.widgets]]
type = "weather"
city = "New York, NY"
label = ""
`,
    ],
    [
      "invalid temperature unit",
      `
[[tui.widgets]]
type = "weather"
city = "New York, NY"
temperature_unit = "kelvin"
`,
    ],
    [
      "invalid time format",
      `
[[tui.widgets]]
type = "time"
time_format = "locale"
`,
    ],
    [
      "non-positive refresh interval",
      `
[[tui.widgets]]
type = "weather"
city = "New York, NY"
refresh_interval_minutes = 0
`,
    ],
  ])("degrades a bad [tui] section (%s) to defaults with a diagnostic", async (_name, tuiToml) => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

${tuiToml}
${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    // [tui] is decorative and TUI-only: a typo must not abort the load (which
    // would take down the observer). The section is dropped and surfaced as a
    // warn diagnostic instead of throwing CONFIG_VALIDATION_FAILED.
    expect(loaded.config.tui).toBeUndefined();
    expect(loaded.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONFIG_TUI_SECTION_INVALID",
        severity: "warn",
        message: expect.stringMatching(/widgets|timeFormat|temperatureUnit|refreshIntervalMinutes/),
      }),
    );
  });

  it("normalizes an empty feature flag table without adding production flags", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[feature_flags]

${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.featureFlags).toEqual({});
  });

  it("normalizes resume feature flag and harness resume opt-in", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[feature_flags]
session_resume_agent = true

[harness.codex]
resume = true

${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.featureFlags).toEqual({
      sessionResumeAgent: true,
    });
    expect(loaded.config.harness?.codex?.resume).toBe(true);
  });

  it("rejects unknown feature flag keys", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    await expect(
      loadConfigFromToml(
        `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[feature_flags]
"test.fake" = true

${projectToml("web", root)}
`,
        { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
      ),
    ).rejects.toMatchObject({
      tag: "ConfigError",
      code: "CONFIG_VALIDATION_FAILED",
    });
  });

  it("derives project Worktrunk roots from a global managed root", async () => {
    const tempDir = await makeTempDir();
    const webRoot = await makeProjectRoot(tempDir, "web");
    const apiRoot = await makeProjectRoot(tempDir, "api-service");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[worktree.worktrunk]
managed_root = "~/.worktrees"

${projectToml("web", webRoot, {
  worktrunk: `
include_main = false
include_external = false
`,
})}
${projectToml("api/service", apiRoot)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.worktree?.worktrunk?.managedRoot).toBe(join(tempDir, ".worktrees"));
    expect(loaded.config.projects.find((project) => project.id === "web")?.worktrunk).toEqual({
      enabled: true,
      base: "main",
      managedRoot: join(tempDir, ".worktrees", "web"),
      includeMain: false,
      includeExternal: false,
    });
    expect(
      loaded.config.projects.find((project) => project.id === "api/service")?.worktrunk.managedRoot,
    ).toBe(join(tempDir, ".worktrees", "api_service"));
  });

  it("lets project Worktrunk roots override the global managed root", async () => {
    const tempDir = await makeTempDir();
    const webRoot = await makeProjectRoot(tempDir, "web");
    const apiRoot = await makeProjectRoot(tempDir, "api");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[worktree.worktrunk]
managed_root = "~/.worktrees"

${projectToml("web", webRoot, {
  worktrunk: `
managed_root = "~/custom-web"
`,
})}
${projectToml("api", apiRoot, {
  worktrunk: `
managed_root = "/var/tmp/station-api"
`,
})}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.projects.find((project) => project.id === "web")?.worktrunk).toEqual({
      enabled: true,
      base: "main",
      managedRoot: join(tempDir, "custom-web"),
    });
    expect(loaded.config.projects.find((project) => project.id === "api")?.worktrunk).toEqual({
      enabled: true,
      base: "main",
      managedRoot: "/var/tmp/station-api",
    });
  });

  it("keeps derived Worktrunk managed roots unique when project ID segments would sanitize together", async () => {
    const tempDir = await makeTempDir();
    const apiSlashRoot = await makeProjectRoot(tempDir, "api-slash");
    const apiUnderscoreRoot = await makeProjectRoot(tempDir, "api-underscore");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[worktree.worktrunk]
managed_root = "~/.worktrees"

${projectToml("api/service", apiSlashRoot)}
${projectToml("api_service", apiUnderscoreRoot)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    const slashRoot = loaded.config.projects.find((project) => project.id === "api/service")
      ?.worktrunk.managedRoot;
    const underscoreRoot = loaded.config.projects.find((project) => project.id === "api_service")
      ?.worktrunk.managedRoot;
    expect(basename(slashRoot ?? "")).toMatch(/^api_service-[a-f0-9]{10}$/);
    expect(basename(underscoreRoot ?? "")).toBe("api_service");
    expect(slashRoot).not.toBe(underscoreRoot);
  });

  it("rejects duplicate explicit Worktrunk managed roots", async () => {
    const tempDir = await makeTempDir();
    const apiRoot = await makeProjectRoot(tempDir, "api");
    const webRoot = await makeProjectRoot(tempDir, "web");
    const sharedRoot = join(tempDir, "shared-worktrees");

    await expect(
      loadConfigFromToml(
        baseToml(
          `${projectToml("api", apiRoot, {
            worktrunk: `managed_root = ${quoteTomlString(sharedRoot)}`,
          })}${projectToml("web", webRoot, {
            worktrunk: `managed_root = ${quoteTomlString(sharedRoot)}`,
          })}`,
        ),
        { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
      ),
    ).rejects.toMatchObject({
      tag: "ConfigError",
      code: "CONFIG_DUPLICATE_WORKTREE_MANAGED_ROOT",
      projectId: "web",
    });
  });

  it("rejects duplicate project IDs", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    await expect(
      loadConfigFromToml(baseToml(`${projectToml("web", root)}${projectToml("web", root)}`), {
        configPath: join(tempDir, "config.toml"),
        homeDir: tempDir,
      }),
    ).rejects.toMatchObject({
      tag: "ConfigError",
      code: "CONFIG_DUPLICATE_PROJECT_ID",
      configPath: join(tempDir, "config.toml"),
      projectId: "web",
    });
  });

  it("rejects duplicate aliases", async () => {
    const tempDir = await makeTempDir();
    const webRoot = await makeProjectRoot(tempDir, "web");
    const apiRoot = await makeProjectRoot(tempDir, "api");

    await expect(
      loadConfigFromToml(
        baseToml(
          `${projectToml("web", webRoot, { aliases: ["site"] })}${projectToml("api", apiRoot, {
            aliases: ["site"],
          })}`,
        ),
        {
          configPath: join(tempDir, "config.toml"),
          homeDir: tempDir,
        },
      ),
    ).rejects.toMatchObject({
      tag: "ConfigError",
      code: "CONFIG_DUPLICATE_ALIAS",
      projectId: "api",
    });
  });

  it("rejects aliases that collide with project IDs", async () => {
    const tempDir = await makeTempDir();
    const webRoot = await makeProjectRoot(tempDir, "web");
    const apiRoot = await makeProjectRoot(tempDir, "api");

    await expect(
      loadConfigFromToml(
        baseToml(
          `${projectToml("web", webRoot)}${projectToml("api", apiRoot, { aliases: ["web"] })}`,
        ),
        {
          configPath: join(tempDir, "config.toml"),
          homeDir: tempDir,
        },
      ),
    ).rejects.toMatchObject({
      tag: "ConfigError",
      code: "CONFIG_ALIAS_PROJECT_ID_COLLISION",
      projectId: "api",
    });
  });

  it("rejects project roots that do not exist", async () => {
    const tempDir = await makeTempDir();
    const missingRoot = join(tempDir, "missing");

    await expect(
      loadConfigFromToml(baseToml(projectToml("web", missingRoot)), {
        configPath: join(tempDir, "config.toml"),
        homeDir: tempDir,
      }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      loadConfigFromToml(baseToml(projectToml("web", missingRoot)), {
        configPath: join(tempDir, "config.toml"),
        homeDir: tempDir,
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID_PROJECT_ROOT",
      projectId: "web",
    });
  });

  it("rejects missing required fields", async () => {
    const tempDir = await makeTempDir();

    await expect(
      loadConfigFromToml(
        baseToml(`
[[projects]]
id = "web"
label = "web"

[projects.worktrunk]
enabled = true
`),
        {
          configPath: join(tempDir, "config.toml"),
          homeDir: tempDir,
        },
      ),
    ).rejects.toMatchObject({
      tag: "ConfigError",
      code: "CONFIG_VALIDATION_FAILED",
    });
  });

  it("ignores project-local config unless explicitly enabled", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");
    await writeProjectLocalConfig(
      root,
      `
schema_version = 1

[defaults]
harness = "opencode"
layout = "agent-shell"

[commands]
typecheck = "pnpm typecheck"
`,
    );

    const loaded = await loadConfigFromToml(
      baseToml(
        projectToml("web", root, {
          localConfig: `
[projects.local_config]
enabled = false
path = ".station/config.toml"
`,
        }),
      ),
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.projects[0]?.defaults.harness).toBe("codex");
    expect(loaded.projects[0]?.commands).toBeUndefined();
    expect(loaded.diagnostics).toEqual([]);
  });

  it("merges safe project-local defaults and additive commands when enabled", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");
    await writeProjectLocalConfig(
      root,
      `
schema_version = 1

[defaults]
harness = "opencode"
layout = "agent-shell"

[commands]
test = "pnpm test"
typecheck = "pnpm typecheck"

[display]
group = "work"
sort_order = 10
`,
    );

    const loaded = await loadConfigFromToml(
      baseToml(
        projectToml("web", root, {
          commands: `
[projects.commands]
dev = "pnpm dev"
`,
          localConfig: `
[projects.local_config]
enabled = true
path = ".station/config.toml"
`,
        }),
      ),
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.projects[0]?.defaults).toEqual({
      harness: "opencode",
      terminal: "tmux",
      layout: "agent-shell",
    });
    expect(loaded.projects[0]?.commands).toEqual({
      dev: "pnpm dev",
      test: "pnpm test",
      typecheck: "pnpm typecheck",
    });
    expect(loaded.projects[0]?.display).toEqual({
      group: "work",
      sortOrder: 10,
    });
    expect(loaded.diagnostics).toEqual([]);
  });

  it("rejects disallowed project-local authority without dropping the global project", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");
    await writeProjectLocalConfig(
      root,
      `
schema_version = 1

[defaults]
harness_permission_mode = "yolo"

[[projects]]
id = "shadow"
label = "shadow"
root = "/tmp/shadow"

[harness.codex]
permission_mode = "yolo"
approval_policy = "never"
`,
    );

    const loaded = await loadConfigFromToml(
      baseToml(
        projectToml("web", root, {
          localConfig: `
[projects.local_config]
enabled = true
path = ".station/config.toml"
`,
        }),
      ),
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.projects.map((project) => project.id)).toEqual(["web"]);
    expect(loaded.projects[0]?.defaults.harness).toBe("codex");
    expect(loaded.diagnostics).toHaveLength(1);
    expect(loaded.diagnostics[0]).toMatchObject({
      code: "CONFIG_LOCAL_CONFIG_INVALID",
      projectId: "web",
    });
  });

  it("records invalid project-local config as a diagnostic instead of crashing the load", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");
    await writeProjectLocalConfig(root, "schema_version = 1\n[commands\nbroken = true\n");

    const loaded = await loadConfigFromToml(
      baseToml(
        projectToml("web", root, {
          localConfig: `
[projects.local_config]
enabled = true
path = ".station/config.toml"
`,
        }),
      ),
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.projects.map((project) => project.id)).toEqual(["web"]);
    expect(loaded.diagnostics).toHaveLength(1);
    expect(loaded.diagnostics[0]).toMatchObject({
      code: "CONFIG_LOCAL_CONFIG_PARSE_FAILED",
      projectId: "web",
    });
  });

  it("converts ConfigError to SafeError without stack traces or raw internals", () => {
    const error = new ConfigError({
      code: "CONFIG_VALIDATION_FAILED",
      message: "Config validation failed.",
      configPath: "/tmp/station/config.toml",
      projectId: "web",
      cause: new Error("secret stack detail"),
    });

    const safeError = error.toSafeError();

    expect(SafeErrorSchema.parse(safeError)).toEqual(safeError);
    expect(safeError).toEqual({
      tag: "ConfigError",
      code: "CONFIG_VALIDATION_FAILED",
      message: "Config validation failed.",
      projectId: "web",
    });
    expect(JSON.stringify(safeError)).not.toContain("stack");
    expect(JSON.stringify(safeError)).not.toContain("secret");
  });

  it("normalizes explicit global project recovery breadcrumb config", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      baseToml(
        projectToml("web", root, {
          recoveryBreadcrumbs: `
[projects.recovery_breadcrumbs]
location = "worktree"
path = ".station/recovery.json"
`,
        }),
      ),
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.projects[0]?.recoveryBreadcrumbs).toEqual({
      location: "worktree",
      path: ".station/recovery.json",
    });
  });

  it("rejects project-local recovery breadcrumb authority", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");
    await writeProjectLocalConfig(
      root,
      `
schema_version = 1

[recovery_breadcrumbs]
location = "worktree"
`,
    );

    const loaded = await loadConfigFromToml(
      baseToml(
        projectToml("web", root, {
          localConfig: `
[projects.local_config]
enabled = true
path = ".station/config.toml"
`,
        }),
      ),
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.projects[0]?.recoveryBreadcrumbs).toBeUndefined();
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        code: "CONFIG_LOCAL_CONFIG_INVALID",
        projectId: "web",
      }),
    ]);
  });

  it("normalizes observability retention TOML keys", async () => {
    const tempDir = await makeTempDir();
    const loaded = await loadConfigFromToml(
      `
schema_version = 1
projects = []

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[observability.retention]
max_days = 7
max_total_mb = 128
max_file_mb = 5
max_files_per_component = 3

[observability.retention.components]
observer_max_mb = 50
hook_runner_max_mb = 10

[observability.retention.sqlite]
events_max_days = 14

[observability.retention.debug_bundles]
max_bundles = 5

[observability.retention.hook_spool]
failed_max_items = 100
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.observability?.retention).toMatchObject({
      maxDays: 7,
      maxTotalMb: 128,
      components: {
        observerMaxMb: 50,
        hookRunnerMaxMb: 10,
      },
      sqlite: {
        eventsMaxDays: 14,
      },
      debugBundles: {
        maxBundles: 5,
      },
      hookSpool: {
        failedMaxItems: 100,
      },
    });
  });

  it("normalizes and resolves Worktrunk user config path", async () => {
    const tempDir = await makeTempDir();

    const loaded = await loadConfigFromToml(
      `
schema_version = 1
projects = []

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[worktree.worktrunk]
command = "wt"
config_path = "~/isolated-worktrunk/config.toml"
use_lifecycle_hooks = true
hook_mode = "required-for-mvp"
breadcrumb_location = "provider-native"
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.worktree?.worktrunk).toEqual({
      command: "wt",
      configPath: join(tempDir, "isolated-worktrunk/config.toml"),
      useLifecycleHooks: true,
      hookMode: "required-for-mvp",
      breadcrumbLocation: "provider-native",
    });
  });

  it("reads the native [workspace] section into config.workspace", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[workspace]
scroll_on_output = "shift"
overlay_width_percent = 60
overlay_height_percent = 60
welcome_on_boot = false

[[workspace.automations]]
id = "build"
label = "Build"

[[workspace.automations.steps]]
command = "pnpm build"

${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.workspace.scroll_on_output).toBe("shift");
    expect(loaded.config.workspace.overlay_width_percent).toBe(60);
    expect(loaded.config.workspace.overlay_height_percent).toBe(60);
    expect(loaded.config.workspace.welcome_on_boot).toBe(false);
    expect(loaded.config.workspace.automations).toEqual([
      {
        id: "build",
        label: "Build",
        enabled: true,
        steps: [
          {
            command: "pnpm build",
            split: "right",
            anchor: "previous",
            run: "execute",
            focus: false,
          },
        ],
      },
    ]);
    expect(loaded.diagnostics).toEqual([]);
  });

  it("defaults config.workspace when no [workspace] section is present", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    expect(loaded.config.workspace).toEqual(DEFAULT_WORKSPACE_CONFIG);
    expect(loaded.diagnostics.some((d) => d.code === "CONFIG_WORKSPACE_SECTION_INVALID")).toBe(
      false,
    );
  });

  it("degrades a bad [workspace] section to defaults with a diagnostic", async () => {
    const tempDir = await makeTempDir();
    const root = await makeProjectRoot(tempDir, "web");

    const loaded = await loadConfigFromToml(
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[workspace]
scroll_on_output = "bounce"

${projectToml("web", root)}
`,
      { configPath: join(tempDir, "config.toml"), homeDir: tempDir },
    );

    // TUI-only and best-effort: a bad value must not abort the daemon's load.
    expect(loaded.config.workspace).toEqual(DEFAULT_WORKSPACE_CONFIG);
    expect(loaded.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONFIG_WORKSPACE_SECTION_INVALID",
        severity: "warn",
        message: expect.stringContaining("scroll_on_output"),
      }),
    );
  });
});
