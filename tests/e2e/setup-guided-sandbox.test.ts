import { spawnSync } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGuidedPty } from "../support/setup-guided";

const sandboxScript = "scripts/setup/setup-guided-sandbox.mjs";

function prepareSandbox(profile: "first-run" | "multi"): string {
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

  it("runs every agent installer through sandbox shims", async () => {
    const root = prepareSandbox("first-run");

    try {
      const result = await runGuidedPty({
        command: join(root, "run-setup"),
        args: [],
        cwd: process.cwd(),
        env: process.env,
        inputs: [
          "1,2,3,4,5",
          "1,2,3,4,5",
          "select:1",
          ...Array.from({ length: 14 }, () => "y" as const),
        ],
        timeoutMs: 45_000,
        rows: 30,
        columns: 100,
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      for (const label of ["Claude Code", "Codex", "Cursor Agent", "OpenCode", "Pi"]) {
        expect(result.stdout).toContain(`Starting: Install ${label}.`);
        expect(result.stdout).toContain(`Finished: Install ${label}.`);
      }
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
