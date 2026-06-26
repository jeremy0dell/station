import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_STATION_CONFIG,
  loadStationConfig,
  parseStationConfig,
  resolveStationConfigPath,
} from "./stationConfig.js";

describe("parseStationConfig", () => {
  it("reads a valid scroll_on_output mode", () => {
    expect(parseStationConfig(`scroll_on_output = "follow"`)).toEqual({
      config: {
        scroll_on_output: "follow",
        welcome_on_boot: true,
        automations: DEFAULT_STATION_CONFIG.automations,
      },
    });
  });

  it("defaults an empty file to freeze without a warning", () => {
    expect(parseStationConfig("")).toEqual({
      config: {
        scroll_on_output: "freeze",
        welcome_on_boot: true,
        automations: DEFAULT_STATION_CONFIG.automations,
      },
    });
  });

  it("reads welcome_on_boot and defaults it on", () => {
    expect(parseStationConfig(`welcome_on_boot = false`).config.welcome_on_boot).toBe(false);
    expect(parseStationConfig("").config.welcome_on_boot).toBe(true);
  });

  it("warns and falls back to defaults on an unknown mode", () => {
    const result = parseStationConfig(`scroll_on_output = "sideways"`);
    expect(result.config).toEqual(DEFAULT_STATION_CONFIG);
    expect(result.warning).toContain("scroll_on_output");
  });

  it("rejects unknown keys (strict) rather than ignoring typos", () => {
    const result = parseStationConfig(`scrolls_on_output = "follow"`);
    expect(result.config).toEqual(DEFAULT_STATION_CONFIG);
    expect(result.warning).toContain("invalid fields");
  });

  it("warns on malformed TOML", () => {
    const result = parseStationConfig(`scroll_on_output = `);
    expect(result.config).toEqual(DEFAULT_STATION_CONFIG);
    expect(result.warning).toContain("not valid TOML");
  });

  it("ships the default 'See diff (split right)' automation for an empty file", () => {
    const { config } = parseStationConfig("");
    const expectedWatchCommand =
      'base="$(git merge-base origin/main HEAD 2>/dev/null || true)"; [ -n "$base" ] || base=HEAD; { git diff --no-color "$base" -- . || true; git ls-files --others --exclude-standard -- . | while IFS= read -r file; do [ -e "$file" ] || continue; printf "\\n"; git diff --no-color --no-index -- /dev/null "$file" || true; done; }';
    const expectedCommand = [
      "diffnav --unified --watch",
      `--watch-cmd '${expectedWatchCommand}'`,
      "--watch-interval 2s",
    ].join(" ");
    expect(config.automations).toEqual([
      {
        id: "see-diff",
        label: "See diff (split right)",
        enabled: true,
        steps: [
          {
            split: "right",
            anchor: "origin",
            command: expectedCommand,
            run: "execute",
            focus: true,
          },
        ],
      },
    ]);
  });

  it("parses a multi-step automation, defaulting per-step fields", () => {
    const { config, warning } = parseStationConfig(`
[[automations]]
id = "triage"
label = "Triage"

  [[automations.steps]]
  command = "git diff | diffnav"

  [[automations.steps]]
  split = "below"
  anchor = "previous"
  command = "claude review"
  run = "write"
  focus = true
`);
    expect(warning).toBeUndefined();
    expect(config.automations).toEqual([
      {
        id: "triage",
        label: "Triage",
        enabled: true,
        steps: [
          { split: "right", anchor: "previous", command: "git diff | diffnav", run: "execute", focus: false },
          { split: "below", anchor: "previous", command: "claude review", run: "write", focus: true },
        ],
      },
    ]);
  });

  it("accepts a disabled automation as the configured off switch", () => {
    const { config } = parseStationConfig(`
[[automations]]
id = "see-diff"
label = "See diff (split right)"
enabled = false

  [[automations.steps]]
  command = "git diff | diffnav"
`);
    expect(config.automations).toEqual([
      {
        id: "see-diff",
        label: "See diff (split right)",
        enabled: false,
        steps: [
          { split: "right", anchor: "previous", command: "git diff | diffnav", run: "execute", focus: false },
        ],
      },
    ]);
  });

  it("rejects an automation with no steps and falls back to defaults", () => {
    const result = parseStationConfig(`
[[automations]]
id = "broken"
label = "Broken"
steps = []
`);
    expect(result.config).toEqual(DEFAULT_STATION_CONFIG);
    expect(result.warning).toContain("steps");
  });

  it("rejects duplicate automation ids and falls back to defaults", () => {
    const result = parseStationConfig(`
[[automations]]
id = "dup"
label = "First"
  [[automations.steps]]
  command = "a"

[[automations]]
id = "dup"
label = "Second"
  [[automations.steps]]
  command = "b"
`);
    expect(result.config).toEqual(DEFAULT_STATION_CONFIG);
    expect(result.warning).toContain("duplicate");
  });

  it("treats an explicit empty automations array as the off switch, without warning", () => {
    const result = parseStationConfig(`automations = []`);
    expect(result.warning).toBeUndefined();
    expect(result.config.automations).toEqual([]);
  });
});

describe("resolveStationConfigPath", () => {
  it("honors XDG_CONFIG_HOME", () => {
    expect(resolveStationConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/station/station.toml");
  });

  it("falls back to ~/.config when XDG is unset, blank, or relative", () => {
    expect(resolveStationConfigPath({ XDG_CONFIG_HOME: "  " })).toMatch(/\.config\/station\/station\.toml$/);
    // A relative XDG_CONFIG_HOME must be ignored (XDG spec), not joined to cwd.
    expect(resolveStationConfigPath({ XDG_CONFIG_HOME: "relative/cfg" })).toMatch(
      /\.config\/station\/station\.toml$/,
    );
  });
});

describe("loadStationConfig", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns silent defaults when the file is absent", async () => {
    const result = await loadStationConfig({ path: "/definitely/not/here/station.toml" });
    expect(result).toEqual({ config: DEFAULT_STATION_CONFIG, source: "defaults" });
  });

  it("loads and validates a real file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-config-"));
    dirs.push(dir);
    const path = join(dir, "station.toml");
    await writeFile(path, `scroll_on_output = "shift"\n`, "utf8");
    const result = await loadStationConfig({ path });
    expect(result).toEqual({
      config: {
        scroll_on_output: "shift",
        welcome_on_boot: true,
        automations: DEFAULT_STATION_CONFIG.automations,
      },
      source: "file",
    });
  });
});
