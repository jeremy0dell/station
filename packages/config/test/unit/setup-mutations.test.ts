import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadConfigFromToml,
  planSetupConfigMutation,
  renderSetupConfig,
  type SetupConfigDesiredState,
} from "@station/config";
import { describe, expect, it } from "vitest";

const fixtureRoot = "packages/config/test/fixtures/setup";

const createDesired: SetupConfigDesiredState = {
  defaultHarness: "codex",
  harnesses: [{ id: "codex", command: "codex", installHooks: true }],
  worktrunkCommand: "wt",
  installWorktrunkHooks: true,
};

const updateDesired: SetupConfigDesiredState = {
  defaultHarness: "codex",
  harnesses: [
    { id: "codex", command: "codex", installHooks: true },
    { id: "opencode", command: "opencode", installHooks: true },
  ],
  worktrunkCommand: "wt",
  installWorktrunkHooks: false,
};

describe("setup config mutations", () => {
  it("renders a byte-exact new setup config", async () => {
    const expected = await fixture("create.expected.toml");

    expect(renderSetupConfig(createDesired)).toBe(expected);
    await expect(
      planSetupConfigMutation({
        configPath: "/tmp/station-config.toml",
        homeDir: "/tmp",
        current: { state: "missing" },
        desired: createDesired,
      }),
    ).resolves.toEqual({
      operation: "create",
      path: "/tmp/station-config.toml",
      content: expected,
    });
  });

  it("renders byte-valid zero-project config with explicit hook and harness intent", async () => {
    const desired: SetupConfigDesiredState = {
      defaultHarness: "codex",
      harnesses: [
        { id: "codex", command: "/custom/bin/codex", installHooks: true },
        { id: "pi", command: "pi", installHooks: false },
      ],
      worktrunkCommand: "/custom/bin/wt",
      tmuxCommand: "/custom/bin/tmux",
      installWorktrunkHooks: true,
    };
    const content = renderSetupConfig(desired);
    const loaded = await loadConfigFromToml(content, {
      configPath: "/tmp/station-config.toml",
      homeDir: "/tmp",
    });

    expect(loaded.config.projects).toEqual([]);
    expect(loaded.config.defaults.defaultBranch).toBeUndefined();
    expect(loaded.config.worktree?.worktrunk?.base).toBeUndefined();
    expect(loaded.config.observer?.socketPath).toBeUndefined();
    expect(loaded.config.defaults.harness).toBe("codex");
    expect(Object.keys(loaded.config.harness ?? {})).toEqual(["codex", "pi"]);
    expect(loaded.config.harness?.codex?.installHooks).toBe(true);
    expect(loaded.config.harness?.pi?.installHooks).toBeUndefined();
    expect(content).toContain('command = "/custom/bin/wt"');
    expect(content).toContain('[terminal.tmux]\ncommand = "/custom/bin/tmux"');
    expect(content).toContain("use_lifecycle_hooks = true");
  });

  it("preserves existing source while updating and appending harness state", async () => {
    const before = await fixture("update.before.toml");
    const expected = await fixture("update.expected.toml");

    await expect(
      planSetupConfigMutation({
        configPath: "/tmp/station-config.toml",
        homeDir: "/tmp",
        current: { state: "valid", source: before },
        desired: updateDesired,
      }),
    ).resolves.toEqual({
      operation: "update",
      path: "/tmp/station-config.toml",
      before,
      content: expected,
    });
  });

  it("updates quoted harness tables without matching multiline string contents", async () => {
    const source = [
      "schema_version = 1",
      "projects = []",
      "",
      "[defaults]",
      'worktree_provider = "worktrunk"',
      'terminal = "tmux"',
      "harness = 'codex'",
      'layout = "agent-shell"',
      "",
      '["harness"."codex"]',
      "enabled = true",
      'command = """codex',
      "[harness.opencode]",
      'install_hooks = false"""',
      "",
    ].join("\n");
    const plan = await planSetupConfigMutation({
      configPath: "/tmp/station-config.toml",
      homeDir: "/tmp",
      current: { state: "valid", source },
      desired: updateDesired,
    });

    expect(plan.operation).toBe("update");
    if (plan.operation !== "update") throw new Error("expected update plan");
    expect(plan.content.match(/\["harness"\."codex"\]/g)).toHaveLength(1);
    expect(plan.content.match(/install_hooks = true/g)).toHaveLength(2);
    expect(plan.content.match(/install_hooks = false/g)).toHaveLength(1);
    await expect(
      loadConfigFromToml(plan.content, { configPath: plan.path, homeDir: "/tmp" }),
    ).resolves.toBeDefined();
  });

  it("returns an idempotent no-op for already-covered source", async () => {
    const source = renderSetupConfig(createDesired);
    await expect(
      planSetupConfigMutation({
        configPath: "/tmp/station-config.toml",
        homeDir: "/tmp",
        current: { state: "valid", source },
        desired: createDesired,
      }),
    ).resolves.toEqual({
      operation: "none",
      reason: "Config already includes the selected harness and core defaults.",
    });
  });

  it("blocks source-preserving updates when existing defaults are incompatible", async () => {
    const source = renderSetupConfig(createDesired).replace(
      'worktree_provider = "worktrunk"',
      'worktree_provider = "noop-worktree"',
    );
    await expect(
      planSetupConfigMutation({
        configPath: "/tmp/station-config.toml",
        homeDir: "/tmp",
        current: { state: "valid", source },
        desired: updateDesired,
      }),
    ).resolves.toMatchObject({
      operation: "blocked",
      reason: expect.stringContaining("noop-worktree"),
    });
  });

  it("retains CRLF and an absent final newline", async () => {
    const source = (await fixture("update.before.toml")).trimEnd().replaceAll("\n", "\r\n");
    const plan = await planSetupConfigMutation({
      configPath: "/tmp/station-config.toml",
      homeDir: "/tmp",
      current: { state: "valid", source },
      desired: {
        ...updateDesired,
        harnesses: [{ id: "codex", command: "codex", installHooks: true }],
      },
    });

    expect(plan.operation).toBe("update");
    if (plan.operation !== "update") throw new Error("expected update plan");
    expect(plan.content.replaceAll("\r\n", "")).not.toContain("\n");
    expect(plan.content).toContain("install_hooks = true # setup flips only this value");
    expect(plan.content.endsWith("\n")).toBe(false);
  });
});

function fixture(name: string): Promise<string> {
  return readFile(join(fixtureRoot, name), "utf8");
}
