import { readFile } from "node:fs/promises";
import {
  DEFAULT_SCROLLBACK_LINES,
  MAX_SCROLLBACK_LINES,
  ProjectConfigSchema,
  ProjectLocalConfigSchema,
  StationConfigSchema,
  TuiConfigSchema,
  WorkspaceConfigSchema,
} from "@station/config";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const fixtureUrl = (path: string) => new URL(`../fixtures/${path}`, import.meta.url);

async function loadJson(path: string): Promise<Record<string, unknown>> {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(await readFile(fixtureUrl(path), "utf8")));
}

describe("config schemas", () => {
  it("validates parsed config objects without loading TOML or expanding paths", async () => {
    const config = await loadJson("valid-config.json");
    const parsed = StationConfigSchema.parse(config);

    expect(parsed.projects).toHaveLength(2);
    expect(parsed.projects[0]?.root).toBe("~/projects/web");
    expect(parsed.projects[0]?.localConfig).toEqual({
      enabled: true,
      path: ".station/config.toml",
    });
    expect(parsed.projects[0]?.recoveryBreadcrumbs).toEqual({
      location: "external",
    });
  });

  it("exports ProjectConfig as a focused project-level schema", async () => {
    const config = StationConfigSchema.parse(await loadJson("valid-config.json"));

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
    expect(StationConfigSchema.safeParse(await loadJson("invalid-config.json")).success).toBe(
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
    const config = StationConfigSchema.parse(await loadJson("retention-config.json"));

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
      StationConfigSchema.safeParse({
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
    const baseConfig = StationConfigSchema.parse(await loadJson("valid-config.json"));
    const config = StationConfigSchema.parse({
      ...baseConfig,
      featureFlags: {
        sessionResumeAgent: true,
      },
    });

    expect(config.featureFlags).toEqual({
      sessionResumeAgent: true,
    });
    expect(
      StationConfigSchema.safeParse({
        ...config,
        featureFlags: {
          "test.fake": true,
        },
      }).success,
    ).toBe(false);
  });

  it("accepts per-harness resume opt-in", async () => {
    const baseConfig = StationConfigSchema.parse(await loadJson("valid-config.json"));
    const config = StationConfigSchema.parse({
      ...baseConfig,
      harness: {
        codex: {
          resume: true,
        },
      },
    });

    expect(config.harness?.codex?.resume).toBe(true);
  });

  it("validates configured TUI widgets", async () => {
    const baseConfig = StationConfigSchema.parse(await loadJson("valid-config.json"));
    const config = StationConfigSchema.parse({
      ...baseConfig,
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

    // The [tui] section schema is strict: bad widgets are rejected outright.
    expect(TuiConfigSchema.safeParse({ widgets: [{ type: "weather", city: "" }] }).success).toBe(
      false,
    );
    expect(
      TuiConfigSchema.safeParse({ widgets: [{ type: "time", timeFormat: "locale" }] }).success,
    ).toBe(false);

    // But the root config attaches [tui] best-effort: bad widget values degrade
    // to `tui: undefined` rather than failing the whole config parse.
    expect(
      StationConfigSchema.parse({
        ...config,
        tui: { widgets: [{ type: "weather", city: "" }] },
      }).tui,
    ).toBeUndefined();
  });

  it("accepts terminal tmux command config", async () => {
    const baseConfig = StationConfigSchema.parse(await loadJson("valid-config.json"));
    const config = StationConfigSchema.parse({
      ...baseConfig,
      terminal: {
        tmux: {
          command: "/opt/homebrew/bin/tmux",
        },
      },
    });

    expect(config.terminal?.tmux?.command).toBe("/opt/homebrew/bin/tmux");
    expect(
      StationConfigSchema.safeParse({
        ...config,
        terminal: {
          tmux: {
            command: "",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts tmux popup display settings and rejects unsupported values", async () => {
    const config = StationConfigSchema.parse({
      ...(await loadJson("valid-config.json")),
      terminal: { tmux: { popupScope: "client", popupStatusBar: true } },
    });

    expect(config.terminal?.tmux).toMatchObject({
      popupScope: "client",
      popupStatusBar: true,
    });
    expect(
      StationConfigSchema.safeParse({
        ...config,
        terminal: { tmux: { popupScope: "window" } },
      }).success,
    ).toBe(false);
    expect(
      StationConfigSchema.safeParse({
        ...config,
        terminal: { tmux: { popupStatusBar: "yes" } },
      }).success,
    ).toBe(false);
  });

  it("accepts omitted and empty TUI widget config", async () => {
    const config = StationConfigSchema.parse(await loadJson("valid-config.json"));

    expect(config.tui).toBeUndefined();
    expect(
      StationConfigSchema.parse({
        ...config,
        tui: {},
      }).tui,
    ).toEqual({});
    expect(
      StationConfigSchema.parse({
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

describe("workspace config", () => {
  it("fills an empty [workspace] with defaults (10k scrollback, 60% overlay, freeze, welcome on, see-diff)", () => {
    const workspace = WorkspaceConfigSchema.parse({});
    const expectedWatchCommand =
      'base="$(git merge-base origin/main HEAD 2>/dev/null || true)"; [ -n "$base" ] || base=HEAD; { git diff --no-color "$base" -- . || true; git ls-files --others --exclude-standard -- . | while IFS= read -r file; do [ -e "$file" ] || continue; printf "\\n"; git diff --no-color --no-index -- /dev/null "$file" || true; done; }';
    const expectedCommand = [
      "diffnav --unified --watch",
      `--watch-cmd '${expectedWatchCommand}'`,
      "--watch-interval 2s",
    ].join(" ");

    expect(workspace.scroll_on_output).toBe("freeze");
    expect(workspace.scrollback_lines).toBe(DEFAULT_SCROLLBACK_LINES);
    expect(workspace.overlay_width_percent).toBe(60);
    expect(workspace.overlay_height_percent).toBe(60);
    expect(workspace.welcome_on_boot).toBe(true);
    expect(workspace.automations).toEqual([
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

  it("accepts the valid scroll-on-output modes and applies per-step automation defaults", () => {
    const workspace = WorkspaceConfigSchema.parse({
      scroll_on_output: "shift",
      scrollback_lines: 5_000,
      overlay_width_percent: 70,
      overlay_height_percent: 65,
      automations: [{ id: "build", label: "Build", steps: [{ command: "pnpm build" }] }],
    });
    expect(workspace.scroll_on_output).toBe("shift");
    expect(workspace.scrollback_lines).toBe(5_000);
    expect(workspace.overlay_width_percent).toBe(70);
    expect(workspace.overlay_height_percent).toBe(65);
    expect(workspace.automations[0]?.steps[0]).toMatchObject({
      command: "pnpm build",
      split: "right",
      anchor: "previous",
      run: "execute",
      focus: false,
    });
  });

  it("accepts disabled and maximum scrollback depths", () => {
    expect(WorkspaceConfigSchema.parse({ scrollback_lines: 0 }).scrollback_lines).toBe(0);
    expect(
      WorkspaceConfigSchema.parse({ scrollback_lines: MAX_SCROLLBACK_LINES }).scrollback_lines,
    ).toBe(MAX_SCROLLBACK_LINES);
  });

  it("treats an explicit empty automations array as the off switch", () => {
    expect(WorkspaceConfigSchema.parse({ automations: [] }).automations).toEqual([]);
  });

  it("accepts multi-step automations and disabled automation rows", () => {
    const workspace = WorkspaceConfigSchema.parse({
      automations: [
        {
          id: "triage",
          label: "Triage",
          steps: [
            { command: "git diff | diffnav" },
            {
              split: "below",
              anchor: "previous",
              command: "claude review",
              run: "write",
              focus: true,
            },
          ],
        },
        {
          id: "disabled",
          label: "Disabled",
          enabled: false,
          steps: [{ command: "echo disabled" }],
        },
      ],
    });

    expect(workspace.automations).toEqual([
      {
        id: "triage",
        label: "Triage",
        enabled: true,
        steps: [
          {
            split: "right",
            anchor: "previous",
            command: "git diff | diffnav",
            run: "execute",
            focus: false,
          },
          {
            split: "below",
            anchor: "previous",
            command: "claude review",
            run: "write",
            focus: true,
          },
        ],
      },
      {
        id: "disabled",
        label: "Disabled",
        enabled: false,
        steps: [
          {
            split: "right",
            anchor: "previous",
            command: "echo disabled",
            run: "execute",
            focus: false,
          },
        ],
      },
    ]);
  });

  it("rejects an unknown scroll mode, unknown keys, stepless and duplicate automations", () => {
    expect(WorkspaceConfigSchema.safeParse({ scroll_on_output: "bounce" }).success).toBe(false);
    expect(WorkspaceConfigSchema.safeParse({ scrollback_lines: -1 }).success).toBe(false);
    expect(WorkspaceConfigSchema.safeParse({ scrollback_lines: 1.5 }).success).toBe(false);
    expect(
      WorkspaceConfigSchema.safeParse({ scrollback_lines: MAX_SCROLLBACK_LINES + 1 }).success,
    ).toBe(false);
    expect(WorkspaceConfigSchema.safeParse({ overlay_width_percent: 101 }).success).toBe(false);
    expect(WorkspaceConfigSchema.safeParse({ overlay_height_percent: 9 }).success).toBe(false);
    expect(WorkspaceConfigSchema.safeParse({ welcome: true }).success).toBe(false);
    expect(
      WorkspaceConfigSchema.safeParse({ automations: [{ id: "x", label: "X", steps: [] }] })
        .success,
    ).toBe(false);
    expect(
      WorkspaceConfigSchema.safeParse({
        automations: [
          { id: "dup", label: "A", steps: [{ command: "a" }] },
          { id: "dup", label: "B", steps: [{ command: "b" }] },
        ],
      }).success,
    ).toBe(false);
  });
});
