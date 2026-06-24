import { readFile } from "node:fs/promises";
import {
  ParsedStationConfigSchema,
  ProjectConfigSchema,
  ProjectLocalConfigSchema,
  StationConfigSchema,
} from "@station/config";
import { describe, expect, it } from "vitest";

const fixtureUrl = (path: string) => new URL(`../fixtures/${path}`, import.meta.url);

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(fixtureUrl(path), "utf8"));
}

describe("config schemas", () => {
  it("validates parsed config objects without loading TOML or expanding paths", async () => {
    const config = await loadJson("valid-config.json");
    const parsed = ParsedStationConfigSchema.parse(config);

    expect(StationConfigSchema.parse(config)).toEqual(parsed);
    expect(parsed.projects).toHaveLength(2);
    expect(parsed.projects[0]?.root).toBe("~/projects/web");
    expect(parsed.projects[0]?.localConfig).toEqual({
      enabled: true,
      path: ".station/config.toml",
      trust: "explicit",
    });
    expect(parsed.projects[0]?.recoveryBreadcrumbs).toEqual({
      location: "external",
    });
  });

  it("exports ProjectConfig as a focused project-level schema", async () => {
    const config = ParsedStationConfigSchema.parse(await loadJson("valid-config.json"));

    for (const project of config.projects) {
      expect(ProjectConfigSchema.parse(project)).toEqual(project);
    }
  });

  it("validates project-local config supplements without adding projects", async () => {
    const projectLocalConfig = ProjectLocalConfigSchema.parse(
      await loadJson("project-local-config.json"),
    );

    expect(projectLocalConfig.defaults?.harness).toBe("codex");
    expect(projectLocalConfig.commands?.typecheck).toBe("pnpm typecheck");
    expect("projects" in projectLocalConfig).toBe(false);
  });

  it("rejects invalid parsed config objects", async () => {
    expect(ParsedStationConfigSchema.safeParse(await loadJson("invalid-config.json")).success).toBe(
      false,
    );
    expect(
      ProjectLocalConfigSchema.safeParse({
        schemaVersion: 1,
        projects: [{ id: "web" }],
      }).success,
    ).toBe(false);
  });

  it("validates observability retention config", async () => {
    const config = ParsedStationConfigSchema.parse(await loadJson("retention-config.json"));

    expect(config.observability?.retention).toMatchObject({
      maxDays: 7,
      maxTotalMb: 128,
      components: {
        observerMaxMb: 50,
      },
      debugBundles: {
        maxBundles: 5,
      },
    });
    expect(
      ParsedStationConfigSchema.safeParse({
        ...config,
        observability: {
          retention: {
            maxDays: 0,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts production feature flags and rejects unknown flags", async () => {
    const config = ParsedStationConfigSchema.parse({
      ...(await loadJson("valid-config.json")),
      featureFlags: {
        sessionResumeAgent: true,
      },
    });

    expect(config.featureFlags).toEqual({
      sessionResumeAgent: true,
    });
    expect(
      ParsedStationConfigSchema.safeParse({
        ...config,
        featureFlags: {
          "test.fake": true,
        },
      }).success,
    ).toBe(false);
  });

  it("accepts per-harness resume opt-in", async () => {
    const config = ParsedStationConfigSchema.parse({
      ...(await loadJson("valid-config.json")),
      harness: {
        codex: {
          resume: true,
        },
      },
    });

    expect(config.harness?.codex?.resume).toBe(true);
  });

  it("validates configured TUI widgets", async () => {
    const config = ParsedStationConfigSchema.parse({
      ...(await loadJson("valid-config.json")),
      tui: {
        widgets: [
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
        ],
      },
    });

    expect(config.tui?.widgets?.map((widget) => widget.type)).toEqual(["time", "weather"]);
    expect(
      ParsedStationConfigSchema.safeParse({
        ...config,
        tui: {
          widgets: [
            {
              type: "weather",
              city: "",
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      ParsedStationConfigSchema.safeParse({
        ...config,
        tui: {
          widgets: [
            {
              type: "time",
              timeFormat: "locale",
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("accepts terminal tmux command config", async () => {
    const config = ParsedStationConfigSchema.parse({
      ...(await loadJson("valid-config.json")),
      terminal: {
        tmux: {
          command: "/opt/homebrew/bin/tmux",
        },
      },
    });

    expect(config.terminal?.tmux?.command).toBe("/opt/homebrew/bin/tmux");
    expect(
      ParsedStationConfigSchema.safeParse({
        ...config,
        terminal: {
          tmux: {
            command: "",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts omitted and empty TUI widget config", async () => {
    const config = await loadJson("valid-config.json");

    expect(ParsedStationConfigSchema.parse(config).tui).toBeUndefined();
    expect(
      ParsedStationConfigSchema.parse({
        ...config,
        tui: {},
      }).tui,
    ).toEqual({});
    expect(
      ParsedStationConfigSchema.parse({
        ...config,
        tui: {
          widgets: [],
        },
      }).tui,
    ).toEqual({ widgets: [] });
  });

  it("validates explicit project recovery breadcrumb opt-in", () => {
    const project = ProjectConfigSchema.parse({
      id: "web",
      label: "web",
      root: "/tmp/web",
      defaults: {
        harness: "codex",
        terminal: "tmux",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
      recoveryBreadcrumbs: {
        location: "worktree",
        path: ".station/recovery.json",
      },
    });

    expect(project.recoveryBreadcrumbs).toEqual({
      location: "worktree",
      path: ".station/recovery.json",
    });
    expect(
      ProjectConfigSchema.safeParse({
        ...project,
        recoveryBreadcrumbs: {
          location: "shell",
        },
      }).success,
    ).toBe(false);
    expect(
      ProjectConfigSchema.safeParse({
        ...project,
        recoveryBreadcrumbs: {
          location: "worktree",
          path: "",
        },
      }).success,
    ).toBe(false);
  });
});
