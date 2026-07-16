import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCleanupArgs } from "../../scripts/maintenance/agent-cleanup.mjs";
import {
  isUnder,
  normalizeConfig,
  parseResetArgs,
} from "../../scripts/maintenance/agent-reset.mjs";
import {
  commandFromArgs,
  defaultDevSessionNameForRoot,
  globalOptionsFromArgs,
  isForeignLiveDevPopup,
  parseDevPopupOwnerPid,
  shouldKeepAliveAfterLauncherExit,
  shouldRunDirectTui,
} from "../../scripts/tui-dev.mjs";
import {
  mouseReportingDisableSequence,
  shouldRestartForPath,
} from "../../scripts/tui-watch-runner.mjs";

type TurboConfig = {
  tasks?: {
    build?: {
      inputs?: string[];
      outputs?: string[];
    };
    "build:identity"?: {
      cache?: boolean;
      dependsOn?: string[];
    };
  };
};

describe("agent cleanup/reset scripts", () => {
  it("defaults cleanup and reset to dry-run mode", () => {
    expect(parseCleanupArgs([])).toMatchObject({
      dryRun: true,
      realE2e: true,
      localObserver: true,
      tmux: true,
    });
    expect(parseResetArgs([])).toMatchObject({
      dryRun: true,
      forceWorktrees: false,
      projectId: "station",
    });
  });

  it("parses explicit destructive reset flags", () => {
    expect(
      parseResetArgs(["--yes", "--force-worktrees", "--project-id", "protocol", "--state"]),
    ).toMatchObject({
      dryRun: false,
      forceWorktrees: true,
      projectId: "protocol",
      state: true,
    });
  });

  it("ignores pnpm argument separators", () => {
    expect(parseCleanupArgs(["--", "--yes"])).toMatchObject({
      dryRun: false,
    });
    expect(parseResetArgs(["--", "--yes"])).toMatchObject({
      dryRun: false,
    });
  });

  it("normalizes stale local real config without requiring a default Codex profile", () => {
    const input = `[harness.codex]
profile = "default"
sandbox = "workspace-write"

[worktree.worktrunk]
command = "wt"

[projects.worktrunk]
managed_root = ".worktrees"
include_external = false
`;

    const output = normalizeConfig(input);

    expect(output).toContain('managed_root = "~/.worktrees"');
    expect(output).toContain('sandbox = "workspace-write"');
    expect(output).not.toContain('profile = "default"');
    expect(output).not.toContain('managed_root = ".worktrees"');
    expect(output.indexOf('managed_root = "~/.worktrees"')).toBeLessThan(
      output.indexOf("[projects.worktrunk]"),
    );
  });

  it("adds a global managed root when the worktrunk section is missing", () => {
    expect(normalizeConfig("[projects]\n")).toContain(`[worktree.worktrunk]
managed_root = "~/.worktrees"`);
  });

  it("checks managed roots without prefix false positives", () => {
    expect(isUnder("/tmp/station/.worktrees/branch", "/tmp/station/.worktrees")).toBe(true);
    expect(isUnder("/tmp/station/.worktrees-other/branch", "/tmp/station/.worktrees")).toBe(false);
  });
});

describe("tui dev script", () => {
  it("keeps default tmux popup mode alive after the opener exits", () => {
    expect(commandFromArgs(["--config", "/tmp/station.toml"])).toBeUndefined();
    expect(globalOptionsFromArgs(["--config", "/tmp/station.toml", "popup"])).toEqual([
      "--config",
      "/tmp/station.toml",
    ]);
    expect(shouldRunDirectTui([], { TMUX: "/tmp/tmux-501/default,123,0" })).toBe(false);
    expect(shouldKeepAliveAfterLauncherExit([], { TMUX: "/tmp/tmux-501/default,123,0" })).toBe(
      true,
    );
    expect(
      shouldKeepAliveAfterLauncherExit(["--config", "/tmp/station.toml", "popup"], {
        TMUX: "/tmp/tmux-501/default,123,0",
      }),
    ).toBe(true);
  });

  it("uses a checkout-scoped default dev UI session name", () => {
    const main = defaultDevSessionNameForRoot("/Users/example/Developer/station");
    const worktree = defaultDevSessionNameForRoot("/Users/example/.worktrees/station/tui-layout");

    expect(main).toMatch(/^_station-ui-dev-station-[a-f0-9]{8}$/);
    expect(worktree).toMatch(/^_station-ui-dev-tui-layout-[a-f0-9]{8}$/);
    expect(main).not.toBe(worktree);
  });

  it("detects a live dev popup registered by another checkout", () => {
    expect(parseDevPopupOwnerPid("12345:timestamp:token")).toBe(12345);
    expect(parseDevPopupOwnerPid("not-a-pid:timestamp")).toBeUndefined();

    expect(
      isForeignLiveDevPopup(
        {
          currentRoot: "/worktrees/current",
          root: "/worktrees/other",
          owner: "12345:timestamp:token",
          sessionName: "_station-ui-dev-other",
        },
        (pid) => pid === 12345,
      ),
    ).toBe(true);
    expect(
      isForeignLiveDevPopup(
        {
          currentRoot: "/worktrees/current",
          root: "/worktrees/current",
          owner: "12345:timestamp:token",
          sessionName: "_station-ui-dev-current",
        },
        () => true,
      ),
    ).toBe(false);
    expect(
      isForeignLiveDevPopup(
        {
          currentRoot: "/worktrees/current",
          root: "/worktrees/other",
          owner: "12345:timestamp:token",
          sessionName: "_station-ui-dev-other",
        },
        () => false,
      ),
    ).toBe(false);
  });

  it("does not keep direct TUI or one-shot utility commands alive", () => {
    expect(shouldRunDirectTui([], {})).toBe(true);
    expect(shouldRunDirectTui(["tui"], { TMUX: "/tmp/tmux-501/default,123,0" })).toBe(true);
    expect(shouldKeepAliveAfterLauncherExit(["tui"], { TMUX: "/tmp/tmux-501/default,123,0" })).toBe(
      false,
    );
    expect(
      shouldKeepAliveAfterLauncherExit(["observer", "stop"], {
        TMUX: "/tmp/tmux-501/default,123,0",
      }),
    ).toBe(false);
  });

  it("restarts the dev TUI only after a verified build identity is published", () => {
    expect(shouldRestartForPath(undefined)).toBe(false);
    expect(shouldRestartForPath("/tmp/station/apps/cli/dist/main.js")).toBe(false);
    expect(shouldRestartForPath("/tmp/station/apps/cli/dist/package.json")).toBe(false);
    expect(shouldRestartForPath("/tmp/station/apps/cli/dist/main.d.ts")).toBe(false);
    expect(shouldRestartForPath("/tmp/station/apps/cli/dist/main.js.map")).toBe(false);
    expect(shouldRestartForPath("/tmp/station/packages/runtime/dist/station-build-id")).toBe(true);
  });

  it("resets terminal mouse reporting after TUI child exits", () => {
    expect(mouseReportingDisableSequence).toContain("\u001B[?1000l");
    expect(mouseReportingDisableSequence).toContain("\u001B[?1002l");
    expect(mouseReportingDisableSequence).toContain("\u001B[?1003l");
    expect(mouseReportingDisableSequence).toContain("\u001B[?1005l");
    expect(mouseReportingDisableSequence).toContain("\u001B[?1006l");
    expect(mouseReportingDisableSequence).toContain("\u001B[?1015l");
  });

  it("keeps turbo build watch inputs from reacting to tests", () => {
    const turboConfig = JSON.parse(
      readFileSync(new URL("../../turbo.json", import.meta.url), "utf8"),
    ) as TurboConfig;
    const cliPackage = JSON.parse(
      readFileSync(new URL("../../apps/cli/package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(turboConfig.tasks?.build?.inputs).toEqual(
      expect.arrayContaining([
        "$TURBO_DEFAULT$",
        "!test/**",
        "!tests/**",
        "!src/**/__tests__/**",
        "!**/*.test.ts",
        "!**/*.test.tsx",
      ]),
    );
    expect(turboConfig.tasks?.build?.outputs).toContain("!dist/station-build-id");
    expect(turboConfig.tasks?.["build:identity"]).toMatchObject({
      cache: false,
      dependsOn: ["^build"],
    });
    expect(cliPackage.scripts?.["build:identity"]).toBe("node ../../scripts/build-identity.mjs");
  });
});
