import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@station/cli";
import type { ProviderHookArtifactOwner } from "@station/contracts";
import { describe, expect, it } from "vitest";

describe("Codex hook reconciliation E2E", () => {
  it("repairs owned drift, verifies it, and makes the next run a no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-reconciliation-e2e-"));
    const configPath = await writeConfig(root);
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const launcher = join(root, "bin", "stn-ingress");
    const owner: ProviderHookArtifactOwner = {
      schemaVersion: 1,
      launcher,
      runtimeKind: "compiled",
      version: "0.7.1",
      buildIdentity: "a".repeat(64),
    };
    const options = {
      env: { CODEX_HOME: join(root, "codex-home") },
      providerHookIngressLauncher: launcher,
      providerHookArtifactOwner: owner,
    };

    await expect(
      runCli(["--config", configPath, "hooks", "reconcile", "codex"], options),
    ).resolves.toEqual({
      code: 0,
      output: { provider: "codex", status: "repaired", changed: true, verified: true },
    });

    const installedScript = await readFile(hookScriptPath, "utf8");
    await writeFile(hookScriptPath, `${installedScript}\n# owned drift\n`, "utf8");
    const repaired = await runCli(["--config", configPath, "hooks", "reconcile", "codex"], options);
    expect(repaired).toEqual({
      code: 0,
      output: { provider: "codex", status: "repaired", changed: true, verified: true },
    });
    expect(JSON.stringify(repaired.output)).not.toContain(root);
    await expect(readFile(hookScriptPath, "utf8")).resolves.toContain(launcher);

    await expect(
      runCli(["--config", configPath, "hooks", "doctor", "codex"], options),
    ).resolves.toMatchObject({ code: 0, output: { status: "ok", installed: true } });
    await expect(
      runCli(["--config", configPath, "hooks", "reconcile", "codex"], options),
    ).resolves.toEqual({
      code: 0,
      output: { provider: "codex", status: "healthy", changed: false, verified: true },
    });
  });
});

async function writeConfig(root: string): Promise<string> {
  const configPath = join(root, "config.toml");
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(
    configPath,
    [
      "schema_version = 1",
      "projects = []",
      "",
      "[observer]",
      `socket_path = ${JSON.stringify(join(root, "run", "observer.sock"))}`,
      `state_dir = ${JSON.stringify(join(root, "state"))}`,
      "",
      "[defaults]",
      'worktree_provider = "noop-worktree"',
      'terminal = "noop-terminal"',
      'harness = "codex"',
      'layout = "agent-shell"',
      "",
      "[harness.codex]",
      'command = "codex"',
      "install_hooks = true",
      "",
    ].join("\n"),
  );
  return configPath;
}
