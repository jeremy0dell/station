import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
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
