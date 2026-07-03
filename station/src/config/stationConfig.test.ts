import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_WORKSPACE_CONFIG, loadStationConfig } from "./stationConfig.js";

// The [workspace] schema, defaults, and validation are owned by @station/config
// and covered there; this suite covers the station-side adapter — pulling the
// section out of the runtime config and degrading gracefully.

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeConfig(extraToml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "station-workspace-"));
  dirs.push(dir);
  const root = join(dir, "web");
  await mkdir(root, { recursive: true });
  const path = join(dir, "config.toml");
  await writeFile(
    path,
    `schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

${extraToml}

[[projects]]
id = "web"
label = "web"
root = ${JSON.stringify(root)}
`,
    "utf8",
  );
  return path;
}

describe("loadStationConfig", () => {
  it("returns silent defaults when the config file is absent", async () => {
    const result = await loadStationConfig({ path: "/definitely/not/here/config.toml" });
    expect(result).toEqual({ config: DEFAULT_WORKSPACE_CONFIG, source: "defaults" });
  });

  it("reads the [workspace] section out of the runtime config", async () => {
    const path = await writeConfig(`[workspace]
scroll_on_output = "shift"
overlay_width_percent = 60
overlay_height_percent = 60
welcome_on_boot = false`);
    const result = await loadStationConfig({ path });
    expect(result.source).toBe("file");
    expect(result.warning).toBeUndefined();
    expect(result.config.scroll_on_output).toBe("shift");
    expect(result.config.overlay_width_percent).toBe(60);
    expect(result.config.overlay_height_percent).toBe(60);
    expect(result.config.welcome_on_boot).toBe(false);
    // An unset automations key still ships the built-in see-diff default.
    expect(result.config.automations.map((automation) => automation.id)).toEqual(["see-diff"]);
  });

  it("defaults the workspace when the config omits [workspace]", async () => {
    const path = await writeConfig("");
    const result = await loadStationConfig({ path });
    expect(result.source).toBe("file");
    expect(result.config).toEqual(DEFAULT_WORKSPACE_CONFIG);
  });

  it("resolves the config path from STATION_CONFIG_PATH", async () => {
    const path = await writeConfig(`[workspace]
scroll_on_output = "follow"`);
    const result = await loadStationConfig({ env: { STATION_CONFIG_PATH: path } });
    expect(result.source).toBe("file");
    expect(result.config.scroll_on_output).toBe("follow");
  });

  it("keeps the TUI alive with a warning when [workspace] has a bad value", async () => {
    const path = await writeConfig(`[workspace]
scroll_on_output = "sideways"`);
    const result = await loadStationConfig({ path });
    // Best-effort: the config still loads (source "file"), the bad section is
    // dropped to defaults, and the typo is surfaced as a warning.
    expect(result.source).toBe("file");
    expect(result.config).toEqual(DEFAULT_WORKSPACE_CONFIG);
    expect(result.warning).toBeDefined();
  });

  it("surfaces unrelated runtime-config failures while falling back to workspace defaults", async () => {
    const path = await writeConfig(`[workspace]
scroll_on_output = "shift"

[observer]
unknown_key = true`);
    const result = await loadStationConfig({ path });

    expect(result.source).toBe("defaults");
    expect(result.config).toEqual(DEFAULT_WORKSPACE_CONFIG);
    expect(result.warning).toContain("Station config is invalid");
    expect(result.warning).toContain("unknownKey");
  });

  it("degrades to defaults with a warning when the config can't be parsed", async () => {
    const path = await writeConfig("[workspace]\nscroll_on_output =");
    const result = await loadStationConfig({ path });
    expect(result.source).toBe("defaults");
    expect(result.config).toEqual(DEFAULT_WORKSPACE_CONFIG);
    expect(result.warning).toBeDefined();
  });
});
