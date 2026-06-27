import type { BuildHarnessLaunchRequest } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { harnessLaunchEnv } from "../../src/launch";

describe("harnessLaunchEnv", () => {
  it("carries a non-empty injected env value", () => {
    const env = harnessLaunchEnv("codex", request(), {
      env: { CODEX_HOME: "/tmp/codex-home" },
      carryEnv: [{ from: "CODEX_HOME" }],
    });

    expect(env).toMatchObject({
      STATION_HARNESS_PROVIDER: "codex",
      CODEX_HOME: "/tmp/codex-home",
    });
  });

  it("falls back to process env when the source omits the key", () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/process-codex-home";
    try {
      const env = harnessLaunchEnv("codex", request(), {
        env: {},
        carryEnv: [{ from: "CODEX_HOME" }],
      });

      expect(env).toMatchObject({
        CODEX_HOME: "/tmp/process-codex-home",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previous;
      }
    }
  });

  it("treats an empty injected value as an intentional unset", () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/process-codex-home";
    try {
      const env = harnessLaunchEnv("codex", request(), {
        env: { CODEX_HOME: "" },
        carryEnv: [{ from: "CODEX_HOME" }],
      });

      expect(env.CODEX_HOME).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previous;
      }
    }
  });

  it("can copy an env value to a different launch key", () => {
    const env = harnessLaunchEnv("cursor", request(), {
      env: { STATION_CURSOR_HOME: "/tmp/cursor-home" },
      carryEnv: [{ from: "STATION_CURSOR_HOME", to: "HOME" }],
    });

    expect(env).toMatchObject({
      STATION_HARNESS_PROVIDER: "cursor",
      HOME: "/tmp/cursor-home",
    });
  });
});

function request(): BuildHarnessLaunchRequest {
  return {
    project: {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "codex",
        terminal: "tmux",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
    worktree: {
      id: "wt_web_task",
      provider: "worktrunk",
      projectId: "web",
      branch: "task",
      path: "/tmp/station/web/task",
      state: "exists",
      source: "worktrunk",
      observedAt: "2026-06-03T12:00:00.000Z",
    },
  };
}
