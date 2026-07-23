import { describe, expect, it } from "vitest";
import { loadConfigFromToml, setHarnessInstallHooksInToml } from "../../src/index.js";

describe("harness install_hooks TOML mutation", () => {
  it("updates a quoted harness table and preserves its comments and unrelated source", async () => {
    const source = configToml([
      "[\"harness\" . 'codex'] # provider table",
      "enabled = true",
      'command = "codex"',
      "install_hooks = false # keep this explanation",
      "",
      "[harness.opencode]",
      'command = "opencode"',
    ]);

    const updated = await setHarnessInstallHooksInToml(source, {
      harness: "codex",
      installHooks: true,
      configPath: "/tmp/config.toml",
      homeDir: "/tmp",
    });

    expect(updated).toBe(
      source.replace(
        "install_hooks = false # keep this explanation",
        "install_hooks = true # keep this explanation",
      ),
    );
    const loaded = await loadConfigFromToml(updated, {
      configPath: "/tmp/config.toml",
      homeDir: "/tmp",
    });
    expect(loaded.config.harness?.codex?.installHooks).toBe(true);
  });

  it.each([
    {
      label: "basic",
      open: 'command = """codex',
      close: '"""',
    },
    {
      label: "literal",
      open: "command = '''codex",
      close: "'''",
    },
    {
      label: "basic with a trailing quote",
      open: 'command = """codex',
      close: '""""',
    },
    {
      label: "literal with a trailing quote",
      open: "command = '''codex",
      close: "''''",
    },
  ])("ignores fake tables inside $label multiline strings", async ({ open, close }) => {
    const fakeTable = "[harness.opencode]\ninstall_hooks = false";
    const source = configToml([
      "[harness.codex]",
      open,
      fakeTable,
      close,
      "",
      "# [harness.opencode] is only a comment",
      "[ 'harness' . \"opencode\" ] # real table",
      'command = "opencode"',
      "",
    ]);

    const updated = await setHarnessInstallHooksInToml(source, {
      harness: "opencode",
      installHooks: true,
      configPath: "/tmp/config.toml",
      homeDir: "/tmp",
    });

    expect(updated).toContain(`${open}\n${fakeTable}\n${close}`);
    expect(updated).toContain(
      '[ \'harness\' . "opencode" ] # real table\ninstall_hooks = true\ncommand = "opencode"',
    );
    expect(updated.match(/install_hooks = true/g)).toHaveLength(1);
    expect(updated.match(/install_hooks = false/g)).toHaveLength(1);
  });

  it("adds the flag idempotently when the harness table does not contain it", async () => {
    const source = configToml(["[harness.codex]", 'command = "codex"', ""]);
    const options = {
      harness: "codex",
      installHooks: true,
      configPath: "/tmp/config.toml",
      homeDir: "/tmp",
    } as const;

    const updated = await setHarnessInstallHooksInToml(source, options);
    const second = await setHarnessInstallHooksInToml(updated, options);

    expect(updated).toContain('[harness.codex]\ninstall_hooks = true\ncommand = "codex"');
    expect(second).toBe(updated);
  });

  it("preserves CRLF and EOF while updating escaped keys", async () => {
    const source = configToml([
      '["har\\u006eess".codex]',
      'command = "codex"',
      '"install_hooks" = false',
    ]).replaceAll("\n", "\r\n");

    const updated = await setHarnessInstallHooksInToml(source, {
      harness: "codex",
      installHooks: true,
      configPath: "/tmp/config.toml",
      homeDir: "/tmp",
    });

    expect(updated).toBe(source.replace('"install_hooks" = false', '"install_hooks" = true'));
    expect(updated.endsWith("\r\n")).toBe(false);
    expect(updated.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("preserves a missing final newline when adding the flag at EOF", async () => {
    const source = configToml(["[harness.codex]"]);

    const updated = await setHarnessInstallHooksInToml(source, {
      harness: "codex",
      installHooks: true,
      configPath: "/tmp/config.toml",
      homeDir: "/tmp",
    });

    expect(updated).toBe(`${source}\ninstall_hooks = true`);
  });

  it("fails without changing a different harness table", async () => {
    const source = configToml(["[harness.codex]", 'command = "codex"', ""]);

    await expect(
      setHarnessInstallHooksInToml(source, {
        harness: "opencode",
        installHooks: true,
        configPath: "/tmp/config.toml",
        homeDir: "/tmp",
      }),
    ).rejects.toMatchObject({
      tag: "HarnessConfigMutationError",
      code: "HARNESS_CONFIG_BLOCK_NOT_FOUND",
    });
  });
});

function configToml(harnessLines: readonly string[]): string {
  return [
    "schema_version = 1",
    "projects = []",
    "",
    "[defaults]",
    'worktree_provider = "worktrunk"',
    'terminal = "tmux"',
    'harness = "codex"',
    'layout = "agent-shell"',
    "",
    ...harnessLines,
  ].join("\n");
}
