import {
  assignBackupPaths,
  expectedProviderHookScript,
  hookCommandsForEvents,
  providerHookCommandArgs,
  providerHookCommandLine,
  providerHookScriptOptions,
} from "@station/runtime";
import { describe, expect, it } from "vitest";

describe("provider hook setup helpers", () => {
  it("builds provider-neutral ingress commands and generated scripts", () => {
    const options = providerHookScriptOptions("/tmp/station hook.sh", {
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      autoStartFromHooks: false,
      hookBin: "/usr/local/bin/stn-ingress",
    });

    expect(providerHookCommandArgs("codex", options, "PreToolUse")).toEqual([
      "/usr/local/bin/stn-ingress",
      "--socket",
      "/tmp/station/run/observer.sock",
      "--state-dir",
      "/tmp/station/state",
      "--spool-dir",
      "/tmp/station/state/spool/hooks",
      "--config",
      "/tmp/station/config.toml",
      "--no-auto-start",
      "codex",
      "PreToolUse",
    ]);
    expect(providerHookCommandLine("codex", options, "PreToolUse")).toBe(
      "/usr/local/bin/stn-ingress --socket /tmp/station/run/observer.sock --state-dir /tmp/station/state --spool-dir /tmp/station/state/spool/hooks --config /tmp/station/config.toml --no-auto-start codex PreToolUse",
    );
    expect(
      expectedProviderHookScript({
        provider: "claude",
        options,
        ignoreFailure: true,
        redirectStderr: true,
      }),
    ).toContain("claude > /dev/null 2>&1 || true");
  });

  it("maps hook events to a script path and assigns backup paths", () => {
    expect(hookCommandsForEvents(["SessionStart", "Stop"] as const, "/tmp/hook.sh")).toEqual({
      SessionStart: "/tmp/hook.sh",
      Stop: "/tmp/hook.sh",
    });

    const result: { backupPath?: string; backupPaths?: string[] } = {};
    assignBackupPaths(result, [undefined, "/tmp/config.bak", "/tmp/base.bak"]);

    expect(result).toEqual({
      backupPath: "/tmp/config.bak",
      backupPaths: ["/tmp/config.bak", "/tmp/base.bak"],
    });
  });
});
