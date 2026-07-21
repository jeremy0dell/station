import { join } from "node:path";
import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import { describe, expect, it } from "vitest";
import {
  createWorktrunkHookExpectation,
  resolveDefaultIngressLauncher,
} from "../../src/worktrunkHookExpectation";

const config: StationConfig = {
  schemaVersion: 1,
  observer: {
    socketPath: "/tmp/station/run/custom.sock",
    stateDir: "/tmp/station/state",
    autoStartFromHooks: false,
  },
  defaults: {
    worktreeProvider: "worktrunk",
    terminal: "noop-terminal",
    harness: "noop-harness",
    layout: "agent-shell",
  },
  projects: [],
  workspace: DEFAULT_WORKSPACE_CONFIG,
};

describe("Worktrunk hook expectation composition", () => {
  it("collects every command input from resolved CLI composition", () => {
    expect(
      createWorktrunkHookExpectation(config, {
        stationConfigPath: "/tmp/station/config.toml",
        ingressLauncher: "/opt/station/stn-ingress",
      }),
    ).toEqual({
      hookBin: "/opt/station/stn-ingress",
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/custom.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      autoStartFromHooks: false,
    });
  });

  it("resolves source and compiled launchers to absolute sibling paths", () => {
    expect(
      resolveDefaultIngressLauncher({ compiled: false, sourceRoot: "/checkout/station" }),
    ).toBe(join("/checkout/station", "bin", "stn-ingress"));
    expect(resolveDefaultIngressLauncher({ compiled: true, execPath: "/opt/station/stn" })).toBe(
      join("/opt/station", "stn-ingress"),
    );
  });
});
