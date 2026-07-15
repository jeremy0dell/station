import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { loadStationTuiConfig } from "./tuiConfig.js";

describe("loadStationTuiConfig", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("silently omits widgets when the STATION config is absent", async () => {
    await expect(loadStationTuiConfig({ path: "/definitely/not/here/config.toml" })).resolves.toEqual(
      {},
    );
  });

  it("loads [tui.widgets] from the normal STATION config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-tui-config-"));
    dirs.push(dir);
    const projectRoot = join(dir, "project");
    await mkdir(projectRoot);
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
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

[[tui.widgets]]
type = "aqi"
city = "Los Angeles, CA"
label = "LA"
refresh_interval_minutes = 60

[[projects]]
id = "web"
label = "web"
root = "${projectRoot}"

[projects.defaults]
harness = "codex"
terminal = "tmux"
layout = "agent-build-shell"

[projects.worktrunk]
enabled = true
`,
      "utf8",
    );

    await expect(loadStationTuiConfig({ env: { STATION_CONFIG_PATH: configPath } })).resolves.toEqual({
      config: {
        widgets: [
          { type: "time", timeFormat: "24h" },
          {
            type: "weather",
            city: "New York, NY",
            label: "NYC",
            temperatureUnit: "fahrenheit",
          },
          {
            type: "aqi",
            city: "Los Angeles, CA",
            label: "LA",
            refreshIntervalMinutes: 60,
          },
        ],
      },
      configPath,
    });
  });

  it("surfaces a warning when [tui] is invalid and widgets fall back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-tui-config-"));
    dirs.push(dir);
    const projectRoot = join(dir, "project");
    await mkdir(projectRoot);
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[[tui.widgets]]
type = "weather"
label = "Missing city"

[[projects]]
id = "web"
label = "web"
root = "${projectRoot}"
`,
      "utf8",
    );

    const result = await loadStationTuiConfig({ path: configPath });

    expect(result.config).toBeUndefined();
    expect(result.warning).toContain("[tui]");
  });

  it("warns but does not reject when widget config cannot be loaded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-tui-config-"));
    dirs.push(dir);
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, "schema_version = ", "utf8");

    const result = await loadStationTuiConfig({ path: configPath });

    expect(result.config).toBeUndefined();
    expect(result.warning).toContain("widgets disabled");
  });
});
