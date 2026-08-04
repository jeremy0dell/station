import { spawnSync } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGuidedPty } from "../support/setup-guided";

const sandboxScript = "scripts/setup/setup-guided-sandbox.mjs";

function prepareSandbox(profile: "first-run" | "multi" | "everything-missing"): string {
  const prepared = spawnSync(
    process.execPath,
    [sandboxScript, "--prepare-only", "--skip-build", "--profile", profile],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  expect(prepared.status, prepared.stderr).toBe(0);
  const root = prepared.stdout.match(/^ {2}root:\s+(.+)$/m)?.[1];
  expect(root).toMatch(/stn-setup-sandbox-/);
  if (root === undefined) throw new Error("Setup sandbox did not report its root.");
  return root;
}

describe("manual guided setup sandbox", () => {
  it("completes the real guided flow using only disposable paths and shims", async () => {
    const root = prepareSandbox("multi");

    try {
      const result = await runGuidedPty({
        command: join(root, "run-setup"),
        args: [],
        cwd: process.cwd(),
        env: process.env,
        inputs: ["1,2", "select:1", "n", "n", "y", "y", "y", "n", "n"],
        timeoutMs: 30_000,
        rows: 24,
        columns: 100,
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Select agent CLIs to prepare.");
      expect(result.stdout).toContain("Choose the default agent for the new config.");
      expect(result.stdout).toContain("Selected changes");
      expect(result.stdout).toContain("Setup complete.");

      const configPath = join(root, "home", ".config", "station", "config.toml");
      const config = await readFile(configPath, "utf8");
      expect(config).toContain('harness = "codex"');
      expect(config).toContain("[harness.opencode]");
      expect(await readFile(join(root, "home", ".zshrc"), "utf8")).toBe("# setup sandbox zshrc\n");
      const externalLog = await readFile(join(root, "external-commands.log"), "utf8");
      expect(externalLog).toContain(`${join(root, "bin", "git")} <--version>`);
      for (const invocation of externalLog.trim().split("\n")) {
        expect(invocation.startsWith(`${join(root, "bin")}/`)).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the missing-tools review compact while running every sandbox installer", async () => {
    const root = prepareSandbox("everything-missing");

    try {
      const result = await runGuidedPty({
        command: join(root, "run-setup"),
        args: [],
        cwd: process.cwd(),
        env: process.env,
        inputs: [
          "y",
          "1,2,3,4,5",
          "1,2,3,4,5",
          "select:1",
          ...Array.from({ length: 14 }, () => "y" as const),
        ],
        timeoutMs: 75_000,
        rows: 30,
        columns: 100,
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      const toolConsentOffset = result.stdout.indexOf("Install these required tools?");
      expect(toolConsentOffset).toBeGreaterThan(0);
      const opening = result.stdout.slice(0, toolConsentOffset);
      expect(opening).toContain("Set up Station on this machine.");
      expect(opening).toContain("Checking local tools and Station configuration...");
      expect(opening).toContain("Required tools");
      expect(opening).toContain("Install Worktrunk");
      expect(opening).toContain("Install Hunk");
      expect(opening.match(/Official formula ↗/g)).toHaveLength(4);
      for (const formula of ["worktrunk", "tmux", "bun", "hunk"]) {
        expect(result.rawOutput).toContain(
          `\u001b]8;;https://formulae.brew.sh/formula/${formula}\u001b\\`,
        );
      }
      expect(opening).not.toContain("Agent selection: unresolved");
      expect(opening).not.toContain("STATION state directory");
      expect(opening).not.toContain("MISSING");
      expect(opening).not.toContain("Recommended");
      expect(opening).not.toContain("Actions");
      expect(opening).not.toContain(root);
      expect(result.stdout).toContain("Does not edit shell startup files.");
      expect(result.stdout).toContain("Writes selected settings to ~/.config/station/config.toml");
      expect(result.stdout).toContain("Does not add the current repository as a project.");
      expect(result.stdout).toContain("Adds Worktrunk shell helpers to ~/.zshrc.");
      expect(result.stdout).toContain("Runs: wt -y config shell install zsh");
      expect(result.stdout).toContain("Does not create ~/.zshrc if it is missing.");
      expect(result.stdout).toContain("Assigns tmux prefix + Space to open Station.");
      expect(result.stdout).toContain("user-configured prefix + Space binding is never replaced.");
      expect(result.stdout).toContain("Does not sign in, bypass provider trust");
      expect(result.stdout).toContain("unrelated hooks.");
      for (const label of ["Claude Code", "Codex", "Cursor Agent", "OpenCode", "Pi"]) {
        expect(result.stdout).toContain(`Starting: Install ${label}.`);
        expect(result.stdout).toContain(`Finished: Install ${label}.`);
      }
      expect(result.stdout).not.toContain("Tmux popup binding was not persisted.");
      expect(await readFile(join(root, "home", ".tmux.conf"), "utf8")).toContain(
        join(process.cwd(), "integrations", "terminal", "tmux", "bin", "stn-popup"),
      );
      for (const command of ["claude", "codex", "agent", "opencode", "pi"]) {
        await expect(access(join(root, "bin", command))).resolves.toBeUndefined();
      }
      const config = await readFile(
        join(root, "home", ".config", "station", "config.toml"),
        "utf8",
      );
      for (const harness of ["claude", "codex", "cursor", "opencode", "pi"]) {
        expect(config).toContain(`[harness.${harness}]`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes disposable state after interactive cancellation", async () => {
    const result = await runGuidedPty({
      command: process.execPath,
      args: [sandboxScript, "--skip-build", "--profile", "multi"],
      cwd: process.cwd(),
      env: process.env,
      inputs: ["cancel"],
      timeoutMs: 15_000,
      rows: 24,
      columns: 100,
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Setup cancelled.");
    expect(result.stdout).toContain("Sandbox removed.");
    const root = result.stdout.match(/^ {2}root:\s+(.+)$/m)?.[1];
    if (root === undefined) throw new Error("Setup sandbox did not report its root.");
    await expect(access(root)).rejects.toThrow();
  });
});
